// Cliente mínimo da Instagram Graph API (Instagram API com login do Instagram).
// Docs: https://developers.facebook.com/docs/instagram-platform

function createInstagramClient({ accessToken, igUserId, apiVersion = 'v21.0', fetchImpl = fetch }) {
  const base = `https://graph.instagram.com/${apiVersion}`;
  const configured = Boolean(accessToken && igUserId);

  async function call(method, path, { query, body } = {}) {
    if (!configured) throw new Error('Instagram não configurado (IG_ACCESS_TOKEN / IG_USER_ID).');
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
    const res = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      const msg = data.error?.message || `HTTP ${res.status}`;
      const err = new Error(`Instagram API: ${msg}`);
      err.details = data.error;
      throw err;
    }
    return data;
  }

  function buildMessage({ text, buttons, imageUrl }) {
    if (imageUrl) {
      return { attachment: { type: 'image', payload: { url: imageUrl } } };
    }
    const message = { text };
    if (buttons?.length) {
      message.quick_replies = buttons.slice(0, 13).map((b) => ({
        content_type: 'text',
        title: String(b.title).slice(0, 20),
        payload: String(b.payload || b.title),
      }));
    }
    return message;
  }

  return {
    configured,

    // DM normal (precisa de janela de 24h aberta: o usuário interagiu nas últimas 24h)
    sendMessage(recipientId, msg) {
      return call('POST', `/${igUserId}/messages`, {
        body: { recipient: { id: recipientId }, message: buildMessage(msg) },
      });
    },

    // "Resposta privada": DM enviada para quem comentou (1 por comentário, até 7 dias)
    sendPrivateReply(commentId, msg) {
      return call('POST', `/${igUserId}/messages`, {
        body: { recipient: { comment_id: commentId }, message: buildMessage(msg) },
      });
    },

    // Resposta pública no comentário
    replyToComment(commentId, text) {
      return call('POST', `/${commentId}/replies`, { query: { message: text } });
    },

    // Perfil de quem conversa com você (inclui se segue a sua conta)
    getUserProfile(igsid) {
      return call('GET', `/${igsid}`, {
        query: { fields: 'name,username,is_user_follow_business,is_business_follow_user' },
      });
    },

    listMedia(limit = 25) {
      return call('GET', `/${igUserId}/media`, {
        query: { fields: 'id,caption,media_type,permalink,thumbnail_url,media_url,timestamp', limit: String(limit) },
      });
    },
  };
}

module.exports = { createInstagramClient };
