// Minimalny klient REST API Discorda (fetch) z obsługą limitów zapytań (429).

const API = 'https://discord.com/api/v10';

export class DiscordError extends Error {
  constructor(status, body) {
    super(body?.message ?? `Discord API ${status}`);
    this.status = status;
    this.code = body?.code ?? null;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createRest(token, { fetchImpl = fetch, base = API } = {}) {
  // files: [{ name, content, type? }] — wysyłane jako multipart (np. zapis ticketu w .txt).
  async function request(method, path, { body, reason, query, files } = {}) {
    const url = new URL(base + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const headers = {
      Authorization: `Bot ${token}`,
      'User-Agent': 'DiscordBot (https://github.com/E7Que/Entuzjasci-Hopkostki, 2.0)',
    };
    if (reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(reason.slice(0, 512));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let payload;
      if (files?.length) {
        payload = new FormData();
        payload.append('payload_json', JSON.stringify(body ?? {}));
        files.forEach((f, i) => payload.append(`files[${i}]`, new Blob([f.content], { type: f.type ?? 'text/plain; charset=utf-8' }), f.name));
      } else if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const res = await fetchImpl(url, { method, headers, body: payload });
      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        const wait = Math.ceil((data.retry_after ?? 1) * 1000);
        if (wait > 10_000) throw new DiscordError(429, data);
        await sleep(wait);
        continue;
      }
      if (res.status === 204) return null;
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new DiscordError(res.status, data);
      return data;
    }
    throw new DiscordError(429, { message: 'Too many requests' });
  }

  return {
    request,
    get: (path, options) => request('GET', path, options),
    post: (path, body, options) => request('POST', path, { ...options, body }),
    put: (path, body, options) => request('PUT', path, { ...options, body }),
    patch: (path, body, options) => request('PATCH', path, { ...options, body }),
    delete: (path, options) => request('DELETE', path, options),
  };
}

export function avatarUrl(user, size = 256) {
  if (user?.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=${size}`;
  const index = /^\d+$/.test(user?.id ?? '') ? Number((BigInt(user.id) >> 22n) % 6n) : 0;
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

export function guildIconUrl(guild, size = 128) {
  return guild?.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=${size}` : null;
}

export function messageUrl(guildId, channelId, messageId) {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

// Emoji do reakcji: zwykłe (🫓) albo własne (<:nazwa:id>) -> format ścieżki API.
export function reactionPath(emoji) {
  const custom = /^<a?:(\w+):(\d+)>$/.exec(String(emoji).trim());
  return encodeURIComponent(custom ? `${custom[1]}:${custom[2]}` : String(emoji).trim());
}
