const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS automations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  trigger TEXT NOT NULL,
  steps TEXT NOT NULL,
  runs INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  username TEXT,
  name TEXT,
  follows_me INTEGER,
  tags TEXT NOT NULL DEFAULT '[]',
  vars TEXT NOT NULL DEFAULT '{}',
  waiting TEXT,
  last_interaction_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS contacts_username ON contacts(username);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT,
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS messages_contact ON messages(contact_id, id);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id TEXT NOT NULL,
  automation_id INTEGER NOT NULL,
  position TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '{}',
  run_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_run_at ON jobs(run_at);

CREATE TABLE IF NOT EXISTS processed_events (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function open(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return createStore(db);
}

const parse = (s, fallback) => {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

function rowToAutomation(r) {
  if (!r) return null;
  return { ...r, active: !!r.active, trigger: parse(r.trigger, {}), steps: parse(r.steps, []) };
}

function rowToContact(r) {
  if (!r) return null;
  return {
    ...r,
    follows_me: r.follows_me == null ? null : !!r.follows_me,
    tags: parse(r.tags, []),
    vars: parse(r.vars, {}),
    waiting: parse(r.waiting, null),
  };
}

function createStore(db) {
  return {
    db,

    // ---- automações ----
    listAutomations() {
      return db.prepare('SELECT * FROM automations ORDER BY id DESC').all().map(rowToAutomation);
    },
    activeAutomations() {
      return db.prepare('SELECT * FROM automations WHERE active = 1 ORDER BY id').all().map(rowToAutomation);
    },
    getAutomation(id) {
      return rowToAutomation(db.prepare('SELECT * FROM automations WHERE id = ?').get(Number(id)));
    },
    createAutomation({ name, active = true, trigger, steps }) {
      const r = db.prepare('INSERT INTO automations (name, active, trigger, steps) VALUES (?, ?, ?, ?)')
        .run(name, active ? 1 : 0, JSON.stringify(trigger), JSON.stringify(steps));
      return this.getAutomation(r.lastInsertRowid);
    },
    updateAutomation(id, { name, active, trigger, steps }) {
      db.prepare(`UPDATE automations SET name = ?, active = ?, trigger = ?, steps = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(name, active ? 1 : 0, JSON.stringify(trigger), JSON.stringify(steps), Number(id));
      return this.getAutomation(id);
    },
    deleteAutomation(id) {
      db.prepare('DELETE FROM jobs WHERE automation_id = ?').run(Number(id));
      db.prepare('DELETE FROM automations WHERE id = ?').run(Number(id));
    },
    incrementRuns(id) {
      db.prepare('UPDATE automations SET runs = runs + 1 WHERE id = ?').run(Number(id));
    },

    // ---- contatos ----
    getContact(id) {
      return rowToContact(db.prepare('SELECT * FROM contacts WHERE id = ?').get(String(id)));
    },
    findContactByUsername(username) {
      if (!username) return null;
      return rowToContact(db.prepare('SELECT * FROM contacts WHERE username = ? ORDER BY last_interaction_at DESC LIMIT 1').get(username));
    },
    upsertContact(id, fields = {}) {
      const existing = this.getContact(id);
      if (!existing) {
        db.prepare('INSERT INTO contacts (id, username, name) VALUES (?, ?, ?)')
          .run(String(id), fields.username ?? null, fields.name ?? null);
      }
      const sets = [];
      const vals = [];
      for (const key of ['username', 'name']) {
        if (fields[key] != null) { sets.push(`${key} = ?`); vals.push(fields[key]); }
      }
      if (fields.follows_me != null) { sets.push('follows_me = ?'); vals.push(fields.follows_me ? 1 : 0); }
      sets.push(`last_interaction_at = datetime('now')`);
      db.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).run(...vals, String(id));
      return this.getContact(id);
    },
    saveContactState(contact) {
      db.prepare('UPDATE contacts SET tags = ?, vars = ?, waiting = ?, follows_me = ? WHERE id = ?').run(
        JSON.stringify(contact.tags || []),
        JSON.stringify(contact.vars || {}),
        contact.waiting ? JSON.stringify(contact.waiting) : null,
        contact.follows_me == null ? null : (contact.follows_me ? 1 : 0),
        String(contact.id),
      );
    },
    listContacts(limit = 200) {
      return db.prepare('SELECT * FROM contacts ORDER BY last_interaction_at DESC LIMIT ?').all(limit).map(rowToContact);
    },
    deleteContact(id) {
      db.prepare('DELETE FROM messages WHERE contact_id = ?').run(String(id));
      db.prepare('DELETE FROM jobs WHERE contact_id = ?').run(String(id));
      db.prepare('DELETE FROM contacts WHERE id = ?').run(String(id));
    },

    // ---- histórico de mensagens ----
    logMessage(contactId, direction, kind, text, meta = null) {
      db.prepare('INSERT INTO messages (contact_id, direction, kind, text, meta) VALUES (?, ?, ?, ?, ?)')
        .run(String(contactId), direction, kind, text ?? null, meta ? JSON.stringify(meta) : null);
    },
    listMessages(contactId, afterId = 0) {
      return db.prepare('SELECT * FROM messages WHERE contact_id = ? AND id > ? ORDER BY id').all(String(contactId), Number(afterId))
        .map((m) => ({ ...m, meta: parse(m.meta, null) }));
    },

    // ---- jobs agendados (delays e timeouts) ----
    scheduleJob({ contactId, automationId, position, context = {}, runAt }) {
      db.prepare('INSERT INTO jobs (contact_id, automation_id, position, context, run_at) VALUES (?, ?, ?, ?, ?)')
        .run(String(contactId), Number(automationId), JSON.stringify(position), JSON.stringify(context), runAt);
    },
    takeDueJobs(now = Date.now()) {
      const rows = db.prepare('SELECT * FROM jobs WHERE run_at <= ? ORDER BY run_at LIMIT 50').all(now);
      const del = db.prepare('DELETE FROM jobs WHERE id = ?');
      for (const r of rows) del.run(r.id);
      return rows.map((r) => ({ ...r, position: parse(r.position, []), context: parse(r.context, {}) }));
    },
    cancelJobs(contactId, automationId) {
      db.prepare('DELETE FROM jobs WHERE contact_id = ? AND automation_id = ?').run(String(contactId), Number(automationId));
    },

    // ---- deduplicação de webhooks ----
    markProcessed(eventId) {
      if (!eventId) return true;
      const r = db.prepare('INSERT OR IGNORE INTO processed_events (id) VALUES (?)').run(String(eventId));
      return r.changes > 0;
    },

    stats() {
      const one = (sql) => db.prepare(sql).get().n;
      return {
        automations: one('SELECT COUNT(*) n FROM automations'),
        activeAutomations: one('SELECT COUNT(*) n FROM automations WHERE active = 1'),
        contacts: one('SELECT COUNT(*) n FROM contacts'),
        messagesSent: one(`SELECT COUNT(*) n FROM messages WHERE direction = 'out'`),
        runs: one('SELECT COALESCE(SUM(runs), 0) n FROM automations'),
      };
    },
  };
}

module.exports = { open };
