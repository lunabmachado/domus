// Converte o payload de webhook do Instagram em eventos simples para o motor.
const crypto = require('node:crypto');

function verifySignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret) return true; // sem segredo configurado, não dá para validar
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const received = signatureHeader.slice('sha256='.length);
  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

function parseWebhook(body, { ownIds = [] } = {}) {
  const events = [];
  if (body?.object !== 'instagram') return events;
  const own = new Set(ownIds.filter(Boolean).map(String));

  for (const entry of body.entry || []) {
    own.add(String(entry.id));

    for (const change of entry.changes || []) {
      if (change.field !== 'comments') continue;
      const v = change.value || {};
      if (!v.from?.id || own.has(String(v.from.id))) continue; // ignora os próprios comentários
      events.push({
        type: 'comment',
        eventId: `comment:${v.id}`,
        contactId: String(v.from.id),
        username: v.from.username,
        text: v.text || '',
        commentId: v.id,
        mediaId: v.media?.id,
      });
    }

    for (const m of entry.messaging || []) {
      const senderId = m.sender?.id && String(m.sender.id);
      if (!senderId || own.has(senderId)) continue;

      if (m.postback) {
        events.push({
          type: 'postback',
          eventId: `msg:${m.postback.mid}`,
          contactId: senderId,
          text: m.postback.title || m.postback.payload || '',
          payload: m.postback.payload,
        });
        continue;
      }

      const msg = m.message;
      if (!msg || msg.is_echo || msg.is_deleted) continue;

      const mention = (msg.attachments || []).find((a) => a.type === 'story_mention');
      if (mention) {
        events.push({ type: 'story_mention', eventId: `msg:${msg.mid}`, contactId: senderId, text: '' });
        continue;
      }

      events.push({
        type: msg.reply_to?.story ? 'story_reply' : (msg.quick_reply ? 'postback' : 'dm'),
        eventId: `msg:${msg.mid}`,
        contactId: senderId,
        text: msg.text || '',
        payload: msg.quick_reply?.payload,
      });
    }
  }
  return events;
}

module.exports = { verifySignature, parseWebhook };
