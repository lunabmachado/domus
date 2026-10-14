const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const config = require('./config');
const { open } = require('./db');
const { createInstagramClient } = require('./instagram');
const { createEngine } = require('./engine');
const { verifySignature, parseWebhook } = require('./webhook');

const TRIGGER_TYPES = ['comment', 'dm', 'story_reply', 'story_mention'];

function validateAutomation(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['Corpo inválido'];
  if (!String(body.name || '').trim()) errors.push('Dê um nome à automação.');
  const t = body.trigger || {};
  if (!TRIGGER_TYPES.includes(t.type)) errors.push('Escolha um tipo de gatilho válido.');
  if (t.type !== 'story_mention' && t.match !== 'any' && !(t.keywords || []).some((k) => String(k).trim())) {
    errors.push('Informe pelo menos uma palavra-chave (ou escolha "qualquer mensagem").');
  }
  if (!Array.isArray(body.steps) || !body.steps.length) errors.push('Adicione pelo menos um passo.');
  return errors;
}

function basicAuth(password) {
  return (req, res, next) => {
    if (!password) return next();
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const [, pass] = Buffer.from(encoded, 'base64').toString().split(/:(.*)/s);
      const a = Buffer.from(String(pass ?? ''));
      const b = Buffer.from(password);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Domus"').status(401).send('Autenticação necessária');
  };
}

function createApp({ cfg = config, store, ig, engine, log = console }) {
  const app = express();

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // ---- Webhook do Instagram ----
  app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === cfg.webhookVerifyToken && cfg.webhookVerifyToken) {
      return res.status(200).send(req.query['hub.challenge']);
    }
    res.sendStatus(403);
  });

  app.post('/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    const raw = req.body instanceof Buffer ? req.body : Buffer.from('');
    if (!verifySignature(raw, req.get('x-hub-signature-256'), cfg.metaAppSecret)) {
      return res.sendStatus(401);
    }
    res.sendStatus(200); // responde rápido; a Meta reenvia se demorar
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return; }
    const events = parseWebhook(body, { ownIds: [cfg.igUserId] });
    (async () => {
      for (const ev of events) {
        try { await engine.handleEvent(ev); } catch (err) { log.error(`[webhook] ${err.stack || err.message}`); }
      }
    })();
  });

  // ---- Painel ----
  const auth = basicAuth(cfg.adminPassword);
  app.use('/api', auth, express.json({ limit: '1mb' }));

  app.get('/api/status', (_req, res) => {
    res.json({
      instagramConfigured: ig.configured,
      webhookSecretConfigured: Boolean(cfg.metaAppSecret),
      verifyTokenConfigured: Boolean(cfg.webhookVerifyToken),
      passwordProtected: Boolean(cfg.adminPassword),
      stats: store.stats(),
    });
  });

  app.get('/api/automations', (_req, res) => res.json(store.listAutomations()));
  app.get('/api/automations/:id', (req, res) => {
    const a = store.getAutomation(req.params.id);
    return a ? res.json(a) : res.sendStatus(404);
  });
  app.post('/api/automations', (req, res) => {
    const errors = validateAutomation(req.body);
    if (errors.length) return res.status(400).json({ errors });
    res.status(201).json(store.createAutomation(req.body));
  });
  app.put('/api/automations/:id', (req, res) => {
    if (!store.getAutomation(req.params.id)) return res.sendStatus(404);
    const errors = validateAutomation(req.body);
    if (errors.length) return res.status(400).json({ errors });
    res.json(store.updateAutomation(req.params.id, req.body));
  });
  app.patch('/api/automations/:id/active', (req, res) => {
    const a = store.getAutomation(req.params.id);
    if (!a) return res.sendStatus(404);
    res.json(store.updateAutomation(a.id, { ...a, active: Boolean(req.body?.active) }));
  });
  app.delete('/api/automations/:id', (req, res) => {
    store.deleteAutomation(req.params.id);
    res.sendStatus(204);
  });

  app.get('/api/contacts', (_req, res) => res.json(store.listContacts()));
  app.get('/api/contacts/:id/messages', (req, res) => {
    const contact = store.getContact(req.params.id);
    if (!contact) return res.sendStatus(404);
    res.json({ contact, messages: store.listMessages(req.params.id, req.query.after) });
  });
  app.delete('/api/contacts/:id', (req, res) => {
    store.deleteContact(req.params.id);
    res.sendStatus(204);
  });

  app.get('/api/media', async (_req, res) => {
    if (!ig.configured) return res.json({ data: [] });
    try { res.json(await ig.listMedia(30)); } catch (err) { res.status(502).json({ error: err.message }); }
  });

  // Simulador: dispara eventos falsos sem tocar no Instagram
  app.post('/api/simulate', async (req, res) => {
    const { type = 'dm', text = '', username = 'cliente_teste', mediaId, follows } = req.body || {};
    const contactId = `sim_${String(username).replace(/[^\w.]/g, '') || 'cliente'}`;
    const before = store.getContact(contactId);
    if (follows != null) {
      store.upsertContact(contactId, { username, follows_me: Boolean(follows) });
    }
    const eventId = `sim:${Date.now()}:${Math.random()}`;
    const result = await engine.handleEvent({
      type, text, username, contactId, mediaId: mediaId || undefined,
      commentId: type === 'comment' ? `simcomment_${Date.now()}` : undefined,
      eventId,
    });
    res.json({ contactId, created: !before, result });
  });

  app.use(auth, express.static(path.join(__dirname, '..', 'public')));

  return app;
}

if (require.main === module) {
  const store = open(config.dbPath);
  const ig = createInstagramClient({
    accessToken: config.igAccessToken,
    igUserId: config.igUserId,
    apiVersion: config.igApiVersion,
  });
  const engine = createEngine({ store, ig });
  const app = createApp({ store, ig, engine });

  setInterval(() => {
    engine.processDueJobs().catch((err) => console.error('[jobs]', err));
  }, 5000).unref();

  app.listen(config.port, () => {
    console.log(`Domus rodando em http://localhost:${config.port}`);
    if (!ig.configured) console.log('Instagram ainda não configurado: tudo roda em modo simulação.');
    if (!config.adminPassword) console.log('ATENÇÃO: defina ADMIN_PASSWORD antes de colocar no ar.');
  });
}

module.exports = { createApp, validateAutomation };
