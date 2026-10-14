// Painel do Domus — JavaScript puro, sem build.

// ---------- utilitários ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.errors?.join(' ') || data?.error || `Erro ${res.status}`);
  return data;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2600);
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const app = document.getElementById('app');
let pollTimer = null;

// ---------- vocabulário ----------
const TRIGGERS = {
  comment: 'Comentou em um post/reel',
  dm: 'Enviou mensagem no direct',
  story_reply: 'Respondeu um story',
  story_mention: 'Mencionou você no story',
};
const MATCH = { contains: 'Contém a palavra', exact: 'É exatamente', any: 'Qualquer texto' };

const STEP_TYPES = {
  message: 'Enviar mensagem',
  condition: 'Condição (se / senão)',
  wait_reply: 'Aguardar resposta',
  delay: 'Esperar um tempo',
  comment_reply: 'Responder o comentário (público)',
  add_tag: 'Adicionar etiqueta',
  remove_tag: 'Remover etiqueta',
  set_var: 'Salvar campo',
  end: 'Encerrar fluxo',
};

const FIELDS = {
  last_reply: 'Última resposta',
  trigger_text: 'Texto do gatilho',
  follows_me: 'Segue minha conta',
  tag: 'Etiqueta',
  var: 'Campo salvo',
  username: 'Usuário (@)',
};
const TEXT_OPS = {
  contains: 'contém', not_contains: 'não contém', equals: 'é igual a', not_equals: 'é diferente de',
  starts_with: 'começa com', is_empty: 'está vazio', not_empty: 'não está vazio',
  gt: 'é maior que', lt: 'é menor que', is_email: 'é um e-mail', is_number: 'é um número',
};
const OPS_BY_FIELD = {
  follows_me: { is_true: 'sim', is_false: 'não' },
  tag: { has: 'tem', not_has: 'não tem' },
};
const NO_VALUE_OPS = ['is_true', 'is_false', 'is_empty', 'not_empty', 'is_email', 'is_number'];

function newStep(type) {
  switch (type) {
    case 'message': return { type, text: '', buttons: [] };
    case 'condition': return { type, match: 'all', rules: [{ field: 'last_reply', op: 'contains', value: '' }], then: [], else: [] };
    case 'wait_reply': return { type, saveAs: '', timeoutMinutes: 0, onTimeout: [] };
    case 'delay': return { type, seconds: 60, unit: 'minutes' };
    case 'comment_reply': return { type, text: 'Te mandei no direct! 💌' };
    case 'add_tag': case 'remove_tag': return { type, tag: '' };
    case 'set_var': return { type, name: '', value: '' };
    default: return { type };
  }
}

const TEMPLATES = [
  {
    label: 'Comentou "EU QUERO" → recebe o link no direct',
    data: {
      name: 'Link por comentário',
      active: true,
      trigger: { type: 'comment', keywords: ['eu quero', 'link'], match: 'contains' },
      steps: [
        { type: 'comment_reply', text: 'Te mandei no direct, {{username}}! 💌' },
        { type: 'message', text: 'Oi {{name}}! Que bom que você quer 😍 Toca no botão para eu te mandar o link:', buttons: [{ title: 'Quero o link' }] },
        { type: 'wait_reply', saveAs: '', timeoutMinutes: 0, onTimeout: [] },
        {
          type: 'condition', match: 'all', rules: [{ field: 'follows_me', op: 'is_true', value: '' }],
          then: [{ type: 'message', text: 'Aqui está: https://seu-link.com 🚀', buttons: [] }],
          else: [
            { type: 'message', text: 'Esse conteúdo é exclusivo para quem me segue 💜 Me segue e toca no botão de novo!', buttons: [{ title: 'Já segui' }] },
            { type: 'wait_reply', saveAs: '', timeoutMinutes: 0, onTimeout: [] },
            { type: 'message', text: 'Aqui está: https://seu-link.com 🚀', buttons: [] },
          ],
        },
      ],
    },
  },
  {
    label: 'Qualificação de lead com perguntas',
    data: {
      name: 'Qualificar lead',
      active: true,
      trigger: { type: 'dm', keywords: ['mentoria', 'consultoria'], match: 'contains' },
      steps: [
        { type: 'message', text: 'Oi! Para te indicar o melhor caminho: qual é o seu momento hoje?', buttons: [{ title: 'Começando' }, { title: 'Já faturo' }] },
        { type: 'wait_reply', saveAs: 'momento', timeoutMinutes: 1440, onTimeout: [{ type: 'message', text: 'Oi, ainda está por aí? 👀', buttons: [] }] },
        {
          type: 'condition', match: 'all', rules: [{ field: 'last_reply', op: 'contains', value: 'começando' }],
          then: [
            { type: 'add_tag', tag: 'iniciante' },
            { type: 'message', text: 'Perfeito! Meu material gratuito é ideal para você: https://seu-link.com', buttons: [] },
          ],
          else: [
            { type: 'add_tag', tag: 'avancado' },
            { type: 'message', text: 'Show! Qual seu e-mail para eu te mandar os detalhes da mentoria?', buttons: [] },
            { type: 'wait_reply', saveAs: 'email', timeoutMinutes: 0, onTimeout: [] },
            {
              type: 'condition', match: 'all', rules: [{ field: 'last_reply', op: 'is_email', value: '' }],
              then: [{ type: 'message', text: 'Anotado: {{var.email}} ✅ Em breve te chamo!', buttons: [] }],
              else: [{ type: 'message', text: 'Hmm, isso não parece um e-mail. Me chama de novo com "mentoria" quando quiser 😉', buttons: [] }],
            },
          ],
        },
      ],
    },
  },
];

// ---------- navegação ----------
document.querySelectorAll('nav button').forEach((b) => {
  b.addEventListener('click', () => go(b.dataset.view));
});

function go(view, arg) {
  clearInterval(pollTimer);
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view || (view === 'editor' && b.dataset.view === 'automations') || (view === 'conversation' && b.dataset.view === 'contacts')));
  app.replaceChildren();
  ({ automations: viewAutomations, editor: viewEditor, simulator: viewSimulator, contacts: viewContacts, conversation: viewConversation, settings: viewSettings })[view](arg);
}

// ---------- lista de automações ----------
function triggerSummary(t) {
  const base = TRIGGERS[t.type] || t.type;
  if (t.type === 'story_mention' || t.match === 'any') return `${base} · qualquer texto`;
  return `${base} · ${MATCH[t.match || 'contains'].toLowerCase()}: ${(t.keywords || []).join(', ')}`;
}

async function viewAutomations() {
  const list = await api('GET', '/api/automations');
  app.append(
    h('div', { class: 'spread' },
      h('div', {}, h('h1', {}, 'Automações'), h('div', { class: 'muted' }, 'Quando algo acontecer no seu Instagram, o Domus responde sozinho.')),
      h('button', { class: 'btn primary', onClick: () => go('editor') }, '+ Nova automação'),
    ),
  );

  if (!list.length) {
    app.append(h('div', { class: 'card empty' },
      h('p', {}, 'Nenhuma automação ainda. Comece do zero ou use um modelo:'),
      h('div', { class: 'row', style: 'justify-content:center' },
        TEMPLATES.map((t) => h('button', { class: 'btn', onClick: () => go('editor', { template: t.data }) }, t.label))),
    ));
    return;
  }

  app.append(h('div', { class: 'list' }, list.map((a) => h('div', { class: 'card spread', style: 'margin:0' },
    h('div', {},
      h('div', { class: 'row' }, h('strong', {}, a.name), h('span', { class: a.active ? 'pill' : 'pill off' }, a.active ? 'ativa' : 'pausada')),
      h('div', { class: 'muted', style: 'font-size:13px' }, triggerSummary(a.trigger), ` · ${a.runs} execuções`),
    ),
    h('div', { class: 'row' },
      h('label', { class: 'switch', title: 'Ativar/pausar' },
        h('input', { type: 'checkbox', checked: a.active, onChange: async (e) => { await api('PATCH', `/api/automations/${a.id}/active`, { active: e.target.checked }); go('automations'); } }),
        h('span')),
      h('button', { class: 'btn small', onClick: () => go('editor', { id: a.id }) }, 'Editar'),
      h('button', { class: 'btn small', onClick: () => go('editor', { template: { ...clone(a), name: `${a.name} (cópia)` } }) }, 'Duplicar'),
      h('button', { class: 'btn small danger', onClick: async () => { if (confirm(`Excluir "${a.name}"?`)) { await api('DELETE', `/api/automations/${a.id}`); go('automations'); } } }, 'Excluir'),
    ),
  ))));

  app.append(h('h2', {}, 'Modelos'), h('div', { class: 'row' },
    TEMPLATES.map((t) => h('button', { class: 'btn', onClick: () => go('editor', { template: t.data }) }, t.label))));
}

// ---------- editor ----------
async function viewEditor(arg = {}) {
  let draft;
  if (arg.id) draft = await api('GET', `/api/automations/${arg.id}`);
  else if (arg.template) draft = clone(arg.template);
  else draft = { name: '', active: true, trigger: { type: 'comment', keywords: [], match: 'contains' }, steps: [newStep('message')] };
  delete draft.runs; delete draft.created_at; delete draft.updated_at;
  const editingId = arg.id;

  let media = [];
  api('GET', '/api/media').then((r) => { media = r?.data || []; if (media.length) render(); }).catch(() => {});

  const container = h('div');
  app.append(container);

  function render() {
    container.replaceChildren(
      h('div', { class: 'spread' },
        h('h1', {}, editingId ? 'Editar automação' : 'Nova automação'),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onClick: () => go('automations') }, 'Cancelar'),
          h('button', { class: 'btn primary', onClick: save }, 'Salvar'),
        ),
      ),
      h('div', { class: 'card' },
        h('label', {}, 'Nome'),
        h('input', { type: 'text', value: draft.name, placeholder: 'Ex.: Link do e-book por comentário', onInput: (e) => { draft.name = e.target.value; } }),
        h('div', { class: 'check' },
          h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: draft.active, onChange: (e) => { draft.active = e.target.checked; } }), h('span')),
          'Automação ativa'),
      ),
      h('h2', {}, '1. Gatilho — quando isso acontecer…'),
      triggerEditor(),
      h('h2', {}, '2. Ações — faça isso…'),
      h('p', { class: 'muted', style: 'margin-top:0;font-size:13px' },
        'Use {{name}}, {{username}}, {{last_reply}} ou {{var.nome_do_campo}} dentro das mensagens. Condições podem ter outras condições dentro, quantas vezes quiser.'),
      stepsEditor(draft.steps, render),
    );
  }

  function triggerEditor() {
    const t = draft.trigger;
    const card = h('div', { class: 'card' },
      h('label', {}, 'Tipo de gatilho'),
      h('select', { onChange: (e) => { t.type = e.target.value; render(); } },
        Object.entries(TRIGGERS).map(([k, v]) => h('option', { value: k, selected: t.type === k }, v))),
    );
    if (t.type !== 'story_mention') {
      card.append(
        h('label', {}, 'Condição do texto'),
        h('select', { onChange: (e) => { t.match = e.target.value; render(); } },
          Object.entries(MATCH).map(([k, v]) => h('option', { value: k, selected: (t.match || 'contains') === k }, v))),
      );
      if (t.match !== 'any') {
        card.append(
          h('label', {}, 'Palavras-chave (separadas por vírgula)'),
          h('input', { type: 'text', value: (t.keywords || []).join(', '), placeholder: 'eu quero, link, preço',
            onInput: (e) => { t.keywords = e.target.value.split(',').map((s) => s.trim()).filter(Boolean); } }),
        );
      }
    }
    if (t.type === 'comment') {
      card.append(h('label', {}, 'Em qual publicação? (vazio = qualquer uma)'));
      if (media.length) {
        card.append(h('select', { onChange: (e) => { t.mediaId = e.target.value || undefined; } },
          h('option', { value: '' }, 'Qualquer publicação'),
          media.map((m) => h('option', { value: m.id, selected: t.mediaId === m.id },
            `${new Date(m.timestamp).toLocaleDateString('pt-BR')} · ${(m.caption || m.media_type).slice(0, 60)}`))));
      } else {
        card.append(h('input', { type: 'text', value: t.mediaId || '', placeholder: 'ID da publicação (opcional)',
          onInput: (e) => { t.mediaId = e.target.value.trim() || undefined; } }));
      }
    }
    return card;
  }

  async function save() {
    try {
      if (editingId) await api('PUT', `/api/automations/${editingId}`, draft);
      else await api('POST', '/api/automations', draft);
      toast('Automação salva ✅');
      go('automations');
    } catch (err) { toast(err.message); }
  }

  render();
}

function stepsEditor(steps, rerender) {
  const wrap = h('div', { class: 'steps' });
  steps.forEach((step, i) => wrap.append(stepEditor(step, i, steps, rerender)));
  wrap.append(addStepButton(steps, rerender));
  return wrap;
}

function addStepButton(steps, rerender) {
  const box = h('div', { class: 'add-step' });
  const toggle = h('button', { class: 'btn small', onClick: () => { menu.hidden = !menu.hidden; } }, '+ Adicionar passo');
  const menu = h('div', { class: 'add-menu', hidden: true },
    Object.entries(STEP_TYPES).map(([k, v]) => h('button', { class: 'btn small', onClick: () => { steps.push(newStep(k)); rerender(); } }, v)));
  box.append(toggle, menu);
  return box;
}

function stepEditor(step, i, steps, rerender) {
  const head = h('div', { class: 'step-head' },
    h('span', { class: 'step-title' }, `${i + 1}. ${STEP_TYPES[step.type] || step.type}`),
    h('div', { class: 'row' },
      h('button', { class: 'btn small ghost', title: 'Subir', disabled: i === 0, onClick: () => { [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]]; rerender(); } }, '↑'),
      h('button', { class: 'btn small ghost', title: 'Descer', disabled: i === steps.length - 1, onClick: () => { [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]]; rerender(); } }, '↓'),
      h('button', { class: 'btn small ghost danger', title: 'Remover', onClick: () => { steps.splice(i, 1); rerender(); } }, '✕'),
    ),
  );
  const body = h('div');
  const set = (k) => (e) => { step[k] = e.target.type === 'number' ? Number(e.target.value) : e.target.value; };

  switch (step.type) {
    case 'message': {
      step.buttons ||= [];
      body.append(
        h('textarea', { placeholder: 'Escreva a mensagem…', onInput: set('text') }, step.text || ''),
        h('label', {}, 'Imagem (URL, opcional — se preenchida, envia a imagem no lugar do texto)'),
        h('input', { type: 'url', value: step.imageUrl || '', placeholder: 'https://…', onInput: set('imageUrl') }),
        h('label', {}, 'Botões de resposta rápida (até 13, máx. 20 caracteres)'),
        h('div', { class: 'buttons-edit' },
          step.buttons.map((b, bi) => h('div', { class: 'row' },
            h('input', { type: 'text', value: b.title, maxlength: 20, onInput: (e) => { b.title = e.target.value; } }),
            h('button', { class: 'btn small ghost danger', onClick: () => { step.buttons.splice(bi, 1); rerender(); } }, '✕'))),
          step.buttons.length < 13 && h('button', { class: 'btn small', onClick: () => { step.buttons.push({ title: '' }); rerender(); } }, '+ Botão'),
        ),
      );
      break;
    }
    case 'comment_reply':
      body.append(h('textarea', { onInput: set('text') }, step.text || ''),
        h('div', { class: 'muted', style: 'font-size:12px' }, 'Só funciona em automações de comentário.'));
      break;
    case 'condition':
      body.append(conditionEditor(step, rerender));
      break;
    case 'wait_reply':
      body.append(
        h('div', { class: 'muted', style: 'font-size:13px' }, 'Pausa o fluxo até a pessoa responder no direct (ou tocar num botão). A resposta fica em {{last_reply}}.'),
        h('div', { class: 'grid2' },
          h('div', {}, h('label', {}, 'Salvar a resposta no campo (opcional)'),
            h('input', { type: 'text', value: step.saveAs || '', placeholder: 'ex.: email', onInput: set('saveAs') })),
          h('div', {}, h('label', {}, 'Se não responder em (minutos, 0 = esperar para sempre)'),
            h('input', { type: 'number', min: 0, value: step.timeoutMinutes || 0, onInput: (e) => { step.timeoutMinutes = Number(e.target.value); }, onChange: rerender })),
        ),
      );
      if (step.timeoutMinutes > 0) {
        step.onTimeout ||= [];
        body.append(h('div', { class: 'branch onTimeout' },
          h('div', { class: 'branch-label' }, 'Se não responder a tempo (depois o fluxo termina)'),
          stepsEditor(step.onTimeout, rerender)));
      }
      break;
    case 'delay': {
      const units = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };
      const unit = step.unit || 'seconds';
      const amount = Math.round((step.seconds || 0) / units[unit]);
      const update = (a, u) => { step.unit = u; step.seconds = Math.max(1, a) * units[u]; };
      body.append(h('div', { class: 'row' },
        h('input', { type: 'number', min: 1, value: amount, style: 'width:120px', onInput: (e) => update(Number(e.target.value), step.unit || 'seconds') }),
        h('select', { style: 'width:auto', onChange: (e) => { update(amount, e.target.value); rerender(); } },
          Object.entries({ seconds: 'segundos', minutes: 'minutos', hours: 'horas', days: 'dias' })
            .map(([k, v]) => h('option', { value: k, selected: unit === k }, v)))));
      break;
    }
    case 'add_tag': case 'remove_tag':
      body.append(h('input', { type: 'text', value: step.tag || '', placeholder: 'ex.: cliente_vip', onInput: set('tag') }));
      break;
    case 'set_var':
      body.append(h('div', { class: 'grid2' },
        h('div', {}, h('label', {}, 'Campo'), h('input', { type: 'text', value: step.name || '', onInput: set('name') })),
        h('div', {}, h('label', {}, 'Valor'), h('input', { type: 'text', value: step.value || '', onInput: set('value') }))));
      break;
    case 'end':
      body.append(h('div', { class: 'muted' }, 'O fluxo para aqui.'));
      break;
  }
  return h('div', { class: `step t-${step.type}` }, head, body);
}

function conditionEditor(step, rerender) {
  step.rules ||= [];
  step.then ||= [];
  step.else ||= [];
  const rulesBox = h('div');
  step.rules.forEach((rule, ri) => {
    const ops = OPS_BY_FIELD[rule.field] || TEXT_OPS;
    if (!ops[rule.op]) rule.op = Object.keys(ops)[0];
    const needsValue = !NO_VALUE_OPS.includes(rule.op);
    rulesBox.append(h('div', { class: `rule${rule.field === 'var' ? ' with-name' : ''}` },
      h('select', { onChange: (e) => { rule.field = e.target.value; rerender(); } },
        Object.entries(FIELDS).map(([k, v]) => h('option', { value: k, selected: rule.field === k }, v))),
      rule.field === 'var' && h('input', { type: 'text', value: rule.name || '', placeholder: 'nome do campo', onInput: (e) => { rule.name = e.target.value; } }),
      h('select', { onChange: (e) => { rule.op = e.target.value; rerender(); } },
        Object.entries(ops).map(([k, v]) => h('option', { value: k, selected: rule.op === k }, v))),
      needsValue
        ? h('input', { type: 'text', value: rule.value || '', placeholder: rule.op.includes('contains') ? 'valor (vírgula = qualquer um)' : 'valor', onInput: (e) => { rule.value = e.target.value; } })
        : h('span'),
      h('button', { class: 'btn small ghost danger', onClick: () => { step.rules.splice(ri, 1); rerender(); } }, '✕'),
    ));
  });

  return h('div', {},
    h('div', { class: 'row', style: 'margin-bottom:8px' }, 'Se',
      h('select', { style: 'width:auto', onChange: (e) => { step.match = e.target.value; } },
        h('option', { value: 'all', selected: step.match !== 'any' }, 'todas as regras'),
        h('option', { value: 'any', selected: step.match === 'any' }, 'qualquer regra')),
      'for verdadeira:'),
    rulesBox,
    h('button', { class: 'btn small', onClick: () => { step.rules.push({ field: 'last_reply', op: 'contains', value: '' }); rerender(); } }, '+ Regra'),
    h('div', { class: 'branch then' }, h('div', { class: 'branch-label' }, 'Então'), stepsEditor(step.then, rerender)),
    h('div', { class: 'branch else' }, h('div', { class: 'branch-label' }, 'Senão'), stepsEditor(step.else, rerender)),
  );
}

// ---------- conversa (simulador e contatos) ----------
function renderChat(chat, messages, onQuickReply) {
  chat.replaceChildren();
  messages.forEach((m, idx) => {
    if (m.kind === 'error') { chat.append(h('div', { class: 'bubble error' }, `Erro: ${m.text}`)); return; }
    const labels = {
      comment: '💬 comentário', story_reply: '📷 resposta ao story', story_mention: '📷 menção no story',
      postback: '🔘 botão', comment_reply: '💬 resposta pública', image: '🖼 imagem',
    };
    const tag = labels[m.kind] || (m.meta?.privateReply ? '✉️ resposta privada' : null);
    chat.append(h('div', { class: `bubble ${m.direction}` }, tag && h('span', { class: 'tag' }, tag), m.text || ''));
    const isLast = idx === messages.length - 1;
    if (m.direction === 'out' && m.meta?.buttons?.length) {
      chat.append(h('div', { class: 'qr' }, m.meta.buttons.map((b) => h('button', {
        disabled: !onQuickReply || !isLast, onClick: () => onQuickReply(b.title),
      }, b.title))));
    }
  });
  chat.scrollTop = chat.scrollHeight;
}

async function viewSimulator() {
  const state = { type: 'comment', username: 'cliente_teste', text: '', follows: false };
  const chat = h('div', { class: 'chat' });
  const contactId = () => `sim_${state.username.replace(/[^\w.]/g, '') || 'cliente'}`;

  async function refresh() {
    try {
      const r = await api('GET', `/api/contacts/${encodeURIComponent(contactId())}/messages`);
      renderChat(chat, r.messages, (title) => send('postback', title));
      info.textContent = `Etiquetas: ${r.contact.tags.join(', ') || '—'} · Campos: ${JSON.stringify(r.contact.vars)}${r.contact.waiting ? ' · ⏳ aguardando resposta' : ''}`;
    } catch { chat.replaceChildren(h('div', { class: 'empty' }, 'Envie um evento para começar a conversa.')); info.textContent = ''; }
  }

  async function send(type = state.type, text = state.text) {
    try {
      const r = await api('POST', '/api/simulate', { type, text, username: state.username, follows: state.follows });
      if (!r.result.matched && !r.result.resumed) toast('Nenhuma automação ativa combinou com esse evento.');
      textInput.value = ''; state.text = '';
      // depois de um comentário, a conversa segue no direct
      if (type === 'comment' || type === 'story_mention') { state.type = 'dm'; typeSelect.value = 'dm'; }
      refresh();
    } catch (err) { toast(err.message); }
  }

  const typeSelect = h('select', { onChange: (e) => { state.type = e.target.value; } },
    Object.entries({ ...TRIGGERS, dm: 'Mensagem no direct' }).map(([k, v]) => h('option', { value: k, selected: state.type === k }, v)));
  const textInput = h('input', { type: 'text', placeholder: 'Texto do comentário ou mensagem', onInput: (e) => { state.text = e.target.value; }, onKeydown: (e) => { if (e.key === 'Enter') send(); } });
  const info = h('div', { class: 'muted', style: 'font-size:13px;margin-top:8px' });

  app.append(
    h('h1', {}, 'Simulador'),
    h('p', { class: 'muted' }, 'Teste suas automações sem usar o Instagram de verdade. Nada é enviado para ninguém.'),
    h('div', { class: 'grid2' },
      h('div', { class: 'card' },
        h('label', {}, 'Usuário fictício'),
        h('input', { type: 'text', value: state.username, onInput: (e) => { state.username = e.target.value; refresh(); } }),
        h('div', { class: 'check' }, h('input', { type: 'checkbox', onChange: (e) => { state.follows = e.target.checked; } }), 'Esse usuário me segue'),
        h('label', {}, 'O que ele faz'),
        typeSelect,
        h('label', {}, 'Texto'),
        textInput,
        h('div', { class: 'row', style: 'margin-top:12px' },
          h('button', { class: 'btn primary', onClick: () => send() }, 'Enviar evento'),
          h('button', { class: 'btn', onClick: async () => { await api('DELETE', `/api/contacts/${encodeURIComponent(contactId())}`); state.type = 'comment'; typeSelect.value = 'comment'; refresh(); } }, 'Zerar conversa')),
      ),
      h('div', {}, chat, info),
    ),
  );
  refresh();
  pollTimer = setInterval(refresh, 3000); // mostra mensagens que chegam depois de "esperar um tempo"
}

async function viewContacts() {
  const contacts = await api('GET', '/api/contacts');
  app.append(h('h1', {}, 'Contatos'), h('p', { class: 'muted' }, 'Todo mundo que interagiu com suas automações.'));
  if (!contacts.length) { app.append(h('div', { class: 'card empty' }, 'Ainda não há contatos.')); return; }
  app.append(h('div', { class: 'card', style: 'overflow-x:auto' }, h('table', {},
    h('tr', {}, h('th', {}, 'Usuário'), h('th', {}, 'Segue?'), h('th', {}, 'Etiquetas'), h('th', {}, 'Campos'), h('th', {}, 'Última interação')),
    contacts.map((c) => h('tr', { style: 'cursor:pointer', onClick: () => go('conversation', c.id) },
      h('td', {}, c.username ? `@${c.username}` : c.id, String(c.id).startsWith('sim_') ? h('span', { class: 'pill off', style: 'margin-left:6px' }, 'teste') : null),
      h('td', {}, c.follows_me == null ? '—' : c.follows_me ? 'sim' : 'não'),
      h('td', {}, c.tags.join(', ') || '—'),
      h('td', {}, Object.entries(c.vars).map(([k, v]) => `${k}: ${v}`).join(' · ') || '—'),
      h('td', {}, c.last_interaction_at ? new Date(`${c.last_interaction_at}Z`).toLocaleString('pt-BR') : '—'),
    )),
  )));
}

async function viewConversation(id) {
  const r = await api('GET', `/api/contacts/${encodeURIComponent(id)}/messages`);
  const chat = h('div', { class: 'chat' });
  app.append(
    h('div', { class: 'spread' },
      h('h1', {}, r.contact.username ? `@${r.contact.username}` : id),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onClick: () => go('contacts') }, 'Voltar'),
        h('button', { class: 'btn danger', onClick: async () => { if (confirm('Apagar contato e histórico?')) { await api('DELETE', `/api/contacts/${encodeURIComponent(id)}`); go('contacts'); } } }, 'Apagar'))),
    chat,
  );
  renderChat(chat, r.messages);
}

async function viewSettings() {
  const s = await api('GET', '/api/status');
  const item = (ok, text) => h('div', { class: 'check' }, h('span', { class: ok ? 'ok' : 'bad' }, ok ? '✔' : '✖'), text);
  const webhookUrl = `${location.origin}/webhook`;
  app.append(
    h('h1', {}, 'Configuração'),
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Status'),
      item(s.instagramConfigured, s.instagramConfigured ? 'Instagram conectado' : 'Instagram não conectado — tudo roda em modo simulação (IG_ACCESS_TOKEN e IG_USER_ID no .env)'),
      item(s.webhookSecretConfigured, 'META_APP_SECRET definido (valida que os webhooks vieram da Meta)'),
      item(s.verifyTokenConfigured, 'WEBHOOK_VERIFY_TOKEN definido'),
      item(s.passwordProtected, 'Painel protegido por senha (ADMIN_PASSWORD)'),
      h('h2', {}, 'Números'),
      h('div', { class: 'row' },
        h('span', { class: 'pill' }, `${s.stats.activeAutomations}/${s.stats.automations} automações ativas`),
        h('span', { class: 'pill' }, `${s.stats.runs} execuções`),
        h('span', { class: 'pill' }, `${s.stats.contacts} contatos`),
        h('span', { class: 'pill' }, `${s.stats.messagesSent} mensagens enviadas`)),
      h('h2', {}, 'Webhook para colar no painel da Meta'),
      h('p', {}, 'URL de callback: ', h('code', {}, webhookUrl)),
      h('p', {}, 'Token de verificação: o mesmo valor de ', h('code', {}, 'WEBHOOK_VERIFY_TOKEN'), '.'),
      h('p', {}, 'Campos para assinar: ', h('code', {}, 'comments'), ' ', h('code', {}, 'messages'), ' ', h('code', {}, 'messaging_postbacks')),
      h('p', { class: 'muted' }, 'O passo a passo completo está no README do projeto.'),
    ),
  );
}

go('automations');
