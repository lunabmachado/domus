// Motor de automações: casa eventos com gatilhos e executa os passos do fluxo.
//
// Um fluxo é uma lista de passos. Passos "condição" e "aguardar resposta" têm
// sub-listas (then / else / onTimeout), que podem conter outras condições —
// aninhamento ilimitado. A posição atual no fluxo é um caminho, ex.:
//   [2, 'then', 0, 'else', 1]  →  passo 2 → ramo "então" → passo 0 → ramo "senão" → passo 1
// Esse caminho é salvo no banco para retomar depois de um atraso ou de uma resposta.

const MAX_STEPS_PER_RUN = 200;
const BRANCH_KEYS = ['then', 'else', 'onTimeout'];

function normalize(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function matchesKeywords(text, keywords = [], mode = 'contains') {
  if (mode === 'any') return true;
  const t = normalize(text);
  const words = keywords.map(normalize).filter(Boolean);
  if (!words.length) return false;
  if (mode === 'exact') return words.some((w) => t === w);
  // "contains": palavra inteira, para "eu" não casar com "eureka"
  return words.some((w) => {
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(t);
  });
}

function triggerMatches(trigger, event) {
  if (!trigger) return false;
  const type = event.type === 'postback' ? 'dm' : event.type;
  if (trigger.type !== type) return false;
  if (trigger.type === 'comment' && trigger.mediaId && trigger.mediaId !== event.mediaId) return false;
  if (trigger.type === 'story_mention') return true;
  return matchesKeywords(event.text, trigger.keywords, trigger.match || 'contains');
}

function renderTemplate(text, contact, ctx) {
  return String(text ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    if (key === 'username') return contact.username ? `@${contact.username}` : '';
    if (key === 'name') return contact.name || contact.username || '';
    if (key === 'last_reply') return ctx.lastReply ?? '';
    if (key === 'trigger_text') return ctx.triggerText ?? '';
    if (key.startsWith('var.')) return contact.vars?.[key.slice(4)] ?? '';
    return '';
  });
}

// ---------- navegação pelo caminho ----------

function listAt(steps, prefix) {
  let list = steps;
  for (let i = 0; i < prefix.length; i += 2) {
    const step = list?.[prefix[i]];
    list = step?.[prefix[i + 1]];
  }
  return Array.isArray(list) ? list : [];
}

// Avança para o próximo passo, subindo de nível quando um ramo termina.
// O ramo "se não responder" (onTimeout) é terminal: ao acabar, encerra o fluxo.
function nextPosition(steps, position) {
  let pos = [...position];
  pos[pos.length - 1] += 1;
  for (;;) {
    const prefix = pos.slice(0, -1);
    const idx = pos[pos.length - 1];
    if (idx < listAt(steps, prefix).length) return pos;
    if (prefix.length === 0) return null; // fim do fluxo
    // o ramo "se não responder" encerra o fluxo (o resto pressupõe uma resposta)
    if (prefix[prefix.length - 1] === 'onTimeout') return null;
    // sai do ramo: volta para o passo pai e vai para o seguinte
    pos = prefix.slice(0, -1);
    pos[pos.length - 1] += 1;
  }
}

function resolvePosition(steps, position) {
  // garante que a posição aponta para um passo existente (ou avança até achar)
  if (!position) return null;
  const prefix = position.slice(0, -1);
  const idx = position[position.length - 1];
  if (idx < listAt(steps, prefix).length) return position;
  return nextPosition(steps, [...prefix, idx - 1]);
}

// ---------- condições ----------

async function evaluateRule(rule, contact, ctx, helpers) {
  const op = rule.op;
  let value;
  switch (rule.field) {
    case 'follows_me': {
      const follows = await helpers.followsMe(contact);
      return op === 'is_false' ? follows !== true : follows === true;
    }
    case 'tag': {
      const has = (contact.tags || []).map(normalize).includes(normalize(rule.value));
      return op === 'not_has' ? !has : has;
    }
    case 'last_reply': value = ctx.lastReply; break;
    case 'trigger_text': value = ctx.triggerText; break;
    case 'username': value = contact.username; break;
    case 'var': value = contact.vars?.[rule.name]; break;
    default: return false;
  }
  const a = normalize(value);
  const b = normalize(rule.value);
  switch (op) {
    case 'contains': return b.split(',').map((s) => s.trim()).filter(Boolean).some((w) => a.includes(w));
    case 'not_contains': return !b.split(',').map((s) => s.trim()).filter(Boolean).some((w) => a.includes(w));
    case 'equals': return a === b;
    case 'not_equals': return a !== b;
    case 'starts_with': return a.startsWith(b);
    case 'is_empty': return a === '';
    case 'not_empty': return a !== '';
    case 'gt': return Number(String(value).replace(',', '.')) > Number(String(rule.value).replace(',', '.'));
    case 'lt': return Number(String(value).replace(',', '.')) < Number(String(rule.value).replace(',', '.'));
    case 'is_email': return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? '').trim());
    case 'is_number': return String(value ?? '').trim() !== '' && !Number.isNaN(Number(String(value).replace(',', '.')));
    default: return false;
  }
}

async function evaluateCondition(step, contact, ctx, helpers) {
  const rules = step.rules || [];
  if (!rules.length) return true;
  const results = [];
  for (const rule of rules) results.push(await evaluateRule(rule, contact, ctx, helpers));
  return step.match === 'any' ? results.some(Boolean) : results.every(Boolean);
}

// ---------- motor ----------

function createEngine({ store, ig, log = console }) {
  const isSimulated = (contact) => String(contact.id).startsWith('sim_') || !ig.configured;

  async function followsMe(contact) {
    if (contact.follows_me != null) return contact.follows_me;
    if (isSimulated(contact)) return false;
    try {
      const p = await ig.getUserProfile(contact.id);
      contact.follows_me = !!p.is_user_follow_business;
      if (p.username && !contact.username) contact.username = p.username;
      store.saveContactState(contact);
      return contact.follows_me;
    } catch (err) {
      log.warn?.(`[engine] não consegui ler o perfil de ${contact.id}: ${err.message}`);
      return false;
    }
  }

  async function deliver(contact, msg, ctx) {
    const kind = msg.imageUrl ? 'image' : 'text';
    const viaPrivateReply = Boolean(ctx.commentId && !ctx.privateReplySent);
    store.logMessage(contact.id, 'out', kind, msg.imageUrl || msg.text, {
      buttons: msg.buttons?.length ? msg.buttons : undefined,
      privateReply: viaPrivateReply || undefined,
      simulated: isSimulated(contact) || undefined,
    });
    if (viaPrivateReply) ctx.privateReplySent = true;
    if (isSimulated(contact)) return;
    try {
      if (viaPrivateReply) await ig.sendPrivateReply(ctx.commentId, msg);
      else await ig.sendMessage(contact.id, msg);
    } catch (err) {
      store.logMessage(contact.id, 'out', 'error', err.message);
      log.error?.(`[engine] falha ao enviar para ${contact.id}: ${err.message}`);
    }
  }

  async function run(automation, contact, position, ctx) {
    const steps = automation.steps || [];
    let pos = resolvePosition(steps, position);
    let guard = 0;

    while (pos && guard++ < MAX_STEPS_PER_RUN) {
      const prefix = pos.slice(0, -1);
      const idx = pos[pos.length - 1];
      const step = listAt(steps, prefix)[idx];
      if (!step) break;

      switch (step.type) {
        case 'message': {
          const text = renderTemplate(step.text, contact, ctx);
          if (text.trim() || step.imageUrl) {
            await deliver(contact, {
              text,
              imageUrl: step.imageUrl || undefined,
              buttons: (step.buttons || []).filter((b) => b?.title),
            }, ctx);
          }
          break;
        }
        case 'comment_reply': {
          if (ctx.commentId) {
            const text = renderTemplate(step.text, contact, ctx);
            store.logMessage(contact.id, 'out', 'comment_reply', text, { simulated: isSimulated(contact) || undefined });
            if (!isSimulated(contact)) {
              try { await ig.replyToComment(ctx.commentId, text); } catch (err) {
                store.logMessage(contact.id, 'out', 'error', err.message);
              }
            }
          }
          break;
        }
        case 'condition': {
          const ok = await evaluateCondition(step, contact, ctx, { followsMe });
          const branch = ok ? 'then' : 'else';
          const branchSteps = step[branch] || [];
          if (branchSteps.length) { pos = [...prefix, idx, branch, 0]; continue; }
          break;
        }
        case 'add_tag':
          if (step.tag && !contact.tags.includes(step.tag)) contact.tags.push(step.tag);
          store.saveContactState(contact);
          break;
        case 'remove_tag':
          contact.tags = contact.tags.filter((t) => normalize(t) !== normalize(step.tag));
          store.saveContactState(contact);
          break;
        case 'set_var':
          if (step.name) contact.vars[step.name] = renderTemplate(step.value, contact, ctx);
          store.saveContactState(contact);
          break;
        case 'delay': {
          const next = nextPosition(steps, pos);
          if (!next) return;
          const ms = Math.max(1, Number(step.seconds) || 0) * 1000;
          store.scheduleJob({ contactId: contact.id, automationId: automation.id, position: next, context: { ...ctx, kind: 'resume' }, runAt: Date.now() + ms });
          return;
        }
        case 'wait_reply': {
          const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          contact.waiting = {
            automationId: automation.id,
            position: nextPosition(steps, pos),
            saveAs: step.saveAs || null,
            ctx,
            token,
          };
          store.saveContactState(contact);
          const minutes = Number(step.timeoutMinutes) || 0;
          if (minutes > 0 && step.onTimeout?.length) {
            store.scheduleJob({
              contactId: contact.id,
              automationId: automation.id,
              position: [...prefix, idx, 'onTimeout', 0],
              context: { ...ctx, kind: 'timeout', token },
              runAt: Date.now() + minutes * 60_000,
            });
          }
          return;
        }
        case 'end':
          return;
        default:
          log.warn?.(`[engine] tipo de passo desconhecido: ${step.type}`);
      }
      pos = nextPosition(steps, pos);
    }
  }

  // Liga o contato que comentou (id do comentário) ao contato que responde por DM,
  // caso o Instagram use ids diferentes para a mesma pessoa.
  async function linkByUsername(contact) {
    if (contact.waiting || isSimulated(contact)) return contact;
    if (!contact.username) {
      try {
        const p = await ig.getUserProfile(contact.id);
        contact = store.upsertContact(contact.id, {
          username: p.username, name: p.name, follows_me: p.is_user_follow_business,
        });
      } catch { return contact; }
    }
    const other = store.findContactByUsername(contact.username);
    if (other && other.id !== contact.id && other.waiting) {
      contact.waiting = other.waiting;
      contact.tags = [...new Set([...other.tags, ...contact.tags])];
      contact.vars = { ...other.vars, ...contact.vars };
      other.waiting = null;
      store.saveContactState(other);
      store.saveContactState(contact);
    }
    return contact;
  }

  async function handleEvent(event) {
    if (event.eventId && !store.markProcessed(event.eventId)) return { skipped: 'duplicado' };

    let contact = store.upsertContact(event.contactId, { username: event.username, name: event.name });
    store.logMessage(contact.id, 'in', event.type, event.text ?? '', {
      payload: event.payload, mediaId: event.mediaId, commentId: event.commentId,
    });

    const isReply = ['dm', 'postback', 'story_reply'].includes(event.type);
    if (isReply) contact = await linkByUsername(contact);

    // 1) Contato estava aguardando uma resposta → continua o fluxo
    if (isReply && contact.waiting) {
      const w = contact.waiting;
      const automation = store.getAutomation(w.automationId);
      contact.waiting = null;
      if (w.saveAs) contact.vars[w.saveAs] = event.text ?? '';
      store.saveContactState(contact);
      store.cancelJobs(contact.id, w.automationId);
      if (automation && w.position) {
        const ctx = { ...w.ctx, lastReply: event.text ?? '', lastPayload: event.payload };
        await run(automation, contact, w.position, ctx);
      }
      return { resumed: w.automationId };
    }

    // 2) Procura a primeira automação ativa cujo gatilho combina
    const automation = store.activeAutomations().find((a) => triggerMatches(a.trigger, event));
    if (!automation) return { matched: null };

    store.incrementRuns(automation.id);
    const ctx = {
      triggerType: event.type,
      triggerText: event.text ?? '',
      lastReply: event.text ?? '',
      commentId: event.type === 'comment' ? event.commentId : undefined,
      mediaId: event.mediaId,
    };
    await run(automation, contact, [0], ctx);
    return { matched: automation.id };
  }

  async function processDueJobs(now = Date.now()) {
    const jobs = store.takeDueJobs(now);
    for (const job of jobs) {
      const automation = store.getAutomation(job.automation_id);
      const contact = store.getContact(job.contact_id);
      if (!automation || !contact) continue;
      const { kind, token, ...ctx } = job.context;
      if (kind === 'timeout') {
        if (!contact.waiting || contact.waiting.token !== token) continue; // já respondeu
        contact.waiting = null;
        store.saveContactState(contact);
      }
      try {
        await run(automation, contact, job.position, ctx);
      } catch (err) {
        log.error?.(`[engine] erro no job ${job.id}: ${err.message}`);
      }
    }
    return jobs.length;
  }

  return { handleEvent, processDueJobs, run };
}

module.exports = {
  createEngine,
  matchesKeywords,
  triggerMatches,
  nextPosition,
  renderTemplate,
  normalize,
  BRANCH_KEYS,
};
