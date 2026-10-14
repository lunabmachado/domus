const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { createEngine, matchesKeywords, nextPosition } = require('../src/engine');
const { parseWebhook, verifySignature } = require('../src/webhook');
const crypto = require('node:crypto');

function setup({ configured = false, profile = {} } = {}) {
  const store = open(':memory:');
  const sent = [];
  const ig = {
    configured,
    sendMessage: async (id, msg) => sent.push({ to: id, ...msg }),
    sendPrivateReply: async (commentId, msg) => sent.push({ comment: commentId, ...msg }),
    replyToComment: async (commentId, text) => sent.push({ publicReply: commentId, text }),
    getUserProfile: async () => profile,
  };
  const engine = createEngine({ store, ig, log: {} });
  const outbox = (id) => store.listMessages(id).filter((m) => m.direction === 'out').map((m) => m.text);
  return { store, engine, sent, outbox };
}

let n = 0;
const ev = (o) => ({ eventId: `e${n++}`, contactId: 'sim_ana', username: 'ana', ...o });

test('palavra-chave: inteira, sem acento e sem diferenciar maiúsculas', () => {
  assert.ok(matchesKeywords('Quero o LINK por favor', ['link']));
  assert.ok(matchesKeywords('promoção!', ['promocao']));
  assert.ok(!matchesKeywords('linkedin', ['link']));
  assert.ok(matchesKeywords('eu', ['eu'], 'exact'));
  assert.ok(!matchesKeywords('eu quero', ['eu'], 'exact'));
});

test('nextPosition sobe de nível ao terminar um ramo', () => {
  const steps = [
    { type: 'condition', then: [{ type: 'message' }, { type: 'condition', else: [{ type: 'message' }] }] },
    { type: 'message' },
  ];
  assert.deepEqual(nextPosition(steps, [0, 'then', 0]), [0, 'then', 1]);
  assert.deepEqual(nextPosition(steps, [0, 'then', 1, 'else', 0]), [1]);
  assert.equal(nextPosition(steps, [1]), null);
});

test('comentário dispara DM com condicional aninhada', async () => {
  const { store, engine, outbox } = setup();
  store.createAutomation({
    name: 'Link',
    trigger: { type: 'comment', keywords: ['link'], match: 'contains' },
    steps: [
      { type: 'message', text: 'Oi {{username}}!' },
      {
        type: 'condition', match: 'all', rules: [{ field: 'follows_me', op: 'is_true' }],
        then: [{ type: 'message', text: 'Aqui está o link' }],
        else: [
          { type: 'message', text: 'Me segue primeiro' },
          {
            type: 'condition', rules: [{ field: 'tag', op: 'has', value: 'vip' }],
            then: [{ type: 'message', text: 'Mas como você é VIP, toma o link' }],
            else: [{ type: 'add_tag', tag: 'nao_segue' }],
          },
        ],
      },
      { type: 'message', text: 'Fim' },
    ],
  });

  await engine.handleEvent(ev({ type: 'comment', text: 'quero o link', commentId: 'c1' }));
  assert.deepEqual(outbox('sim_ana'), ['Oi @ana!', 'Me segue primeiro', 'Fim']);
  assert.deepEqual(store.getContact('sim_ana').tags, ['nao_segue']);
});

test('aguardar resposta salva variável e continua no ramo certo', async () => {
  const { store, engine, outbox } = setup();
  store.createAutomation({
    name: 'Quiz',
    trigger: { type: 'dm', keywords: ['quiz'] },
    steps: [
      { type: 'message', text: 'Você é iniciante ou avançado?', buttons: [{ title: 'Iniciante' }, { title: 'Avançado' }] },
      { type: 'wait_reply', saveAs: 'nivel' },
      {
        type: 'condition', rules: [{ field: 'last_reply', op: 'contains', value: 'inic' }],
        then: [{ type: 'message', text: 'Curso básico' }],
        else: [{ type: 'message', text: 'Curso avançado para {{var.nivel}}' }],
      },
    ],
  });

  await engine.handleEvent(ev({ type: 'dm', text: 'QUIZ' }));
  assert.ok(store.getContact('sim_ana').waiting);
  await engine.handleEvent(ev({ type: 'postback', text: 'Avançado', payload: 'Avançado' }));
  assert.deepEqual(outbox('sim_ana'), ['Você é iniciante ou avançado?', 'Curso avançado para Avançado']);
  assert.equal(store.getContact('sim_ana').vars.nivel, 'Avançado');
  assert.equal(store.getContact('sim_ana').waiting, null);
});

test('delay e timeout são executados pelos jobs', async () => {
  const { store, engine, outbox } = setup();
  store.createAutomation({
    name: 'Delay',
    trigger: { type: 'dm', match: 'any' },
    steps: [
      { type: 'message', text: 'A' },
      { type: 'delay', seconds: 60 },
      { type: 'message', text: 'B' },
      { type: 'wait_reply', timeoutMinutes: 10, onTimeout: [{ type: 'message', text: 'Sumiu?' }] },
      { type: 'message', text: 'Respondeu' },
    ],
  });
  await engine.handleEvent(ev({ type: 'dm', text: 'oi' }));
  assert.deepEqual(outbox('sim_ana'), ['A']);
  await engine.processDueJobs(Date.now() + 61_000);
  assert.deepEqual(outbox('sim_ana'), ['A', 'B']);
  await engine.processDueJobs(Date.now() + 11 * 60_000);
  assert.deepEqual(outbox('sim_ana'), ['A', 'B', 'Sumiu?']);
});

test('primeira mensagem de um comentário vai como resposta privada', async () => {
  const { store, engine, sent } = setup({ configured: true });
  store.createAutomation({
    name: 'Privada',
    trigger: { type: 'comment', match: 'any' },
    steps: [
      { type: 'comment_reply', text: 'Te mandei no direct!' },
      { type: 'message', text: 'Oi', buttons: [{ title: 'Quero' }] },
      { type: 'wait_reply' },
      { type: 'message', text: 'Link: x' },
    ],
  });
  await engine.handleEvent({ eventId: 'x1', type: 'comment', contactId: '123', username: 'bia', text: 'eu', commentId: 'c9' });
  await engine.handleEvent({ eventId: 'x2', type: 'postback', contactId: '123', text: 'Quero' });
  assert.deepEqual(sent, [
    { publicReply: 'c9', text: 'Te mandei no direct!' },
    { comment: 'c9', text: 'Oi', imageUrl: undefined, buttons: [{ title: 'Quero' }] },
    { to: '123', text: 'Link: x', imageUrl: undefined, buttons: [] },
  ]);
});

test('DM de id diferente é ligada ao comentário pelo username', async () => {
  const { store, engine, sent } = setup({ configured: true, profile: { username: 'bia' } });
  store.createAutomation({
    name: 'Ligação',
    trigger: { type: 'comment', match: 'any' },
    steps: [{ type: 'message', text: 'Oi' }, { type: 'wait_reply' }, { type: 'message', text: 'Continuou' }],
  });
  await engine.handleEvent({ eventId: 'y1', type: 'comment', contactId: 'cid', username: 'bia', text: 'x', commentId: 'c1' });
  await engine.handleEvent({ eventId: 'y2', type: 'dm', contactId: 'igsid', text: 'oi' });
  assert.equal(sent.at(-1).to, 'igsid');
  assert.equal(sent.at(-1).text, 'Continuou');
});

test('eventos duplicados são ignorados', async () => {
  const { store, engine, outbox } = setup();
  store.createAutomation({ name: 'x', trigger: { type: 'dm', match: 'any' }, steps: [{ type: 'message', text: 'oi' }] });
  const e = ev({ type: 'dm', text: 'a' });
  await engine.handleEvent(e);
  await engine.handleEvent(e);
  assert.equal(outbox('sim_ana').length, 1);
});

test('parseWebhook entende comentários, DMs, botões e ignora ecos', () => {
  const events = parseWebhook({
    object: 'instagram',
    entry: [{
      id: 'me',
      changes: [
        { field: 'comments', value: { id: 'c1', text: 'link', from: { id: 'u1', username: 'ana' }, media: { id: 'm1' } } },
        { field: 'comments', value: { id: 'c2', text: 'resposta', from: { id: 'me', username: 'eu' }, media: { id: 'm1' } } },
      ],
      messaging: [
        { sender: { id: 'u2' }, message: { mid: 'a', text: 'oi' } },
        { sender: { id: 'u2' }, message: { mid: 'b', text: 'Sim', quick_reply: { payload: 'SIM' } } },
        { sender: { id: 'me' }, message: { mid: 'c', text: 'eco', is_echo: true } },
        { sender: { id: 'u3' }, message: { mid: 'd', text: 'lindo', reply_to: { story: { id: 's' } } } },
      ],
    }],
  });
  assert.deepEqual(events.map((e) => e.type), ['comment', 'dm', 'postback', 'story_reply']);
  assert.equal(events[0].mediaId, 'm1');
  assert.equal(events[2].payload, 'SIM');
});

test('verifySignature valida o HMAC da Meta', () => {
  const body = Buffer.from('{"a":1}');
  const sig = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(body).digest('hex');
  assert.ok(verifySignature(body, sig, 's3cret'));
  assert.ok(!verifySignature(body, sig, 'outro'));
  assert.ok(!verifySignature(body, undefined, 's3cret'));
});
