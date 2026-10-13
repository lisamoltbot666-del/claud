import crypto from 'node:crypto';

const API = 'https://api.line.me/v2/bot';

// 驗證 LINE Webhook 簽章（x-line-signature）
export function verifySignature(channelSecret, rawBody, signature) {
  if (!channelSecret || !signature) return false;
  const expected = crypto.createHmac('sha256', channelSecret).update(rawBody).digest();
  let given;
  try {
    given = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export class LineClient {
  constructor(token, fetchImpl = globalThis.fetch) {
    this.token = token;
    this.fetch = fetchImpl;
  }

  get enabled() {
    return Boolean(this.token);
  }

  async call(method, pathname, body) {
    if (!this.token) throw new Error('尚未設定 LINE_CHANNEL_ACCESS_TOKEN');
    const res = await this.fetch(`${API}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`LINE API ${res.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  }

  getProfile(userId) {
    return this.call('GET', `/profile/${encodeURIComponent(userId)}`);
  }

  reply(replyToken, text) {
    return this.call('POST', '/message/reply', { replyToken, messages: [{ type: 'text', text }] });
  }

  push(to, text) {
    return this.call('POST', '/message/push', { to, messages: [{ type: 'text', text: text.slice(0, 5000) }] });
  }

  // 取得所有好友 userId（僅限「認證 / 進階帳號」可用）
  async followerIds() {
    const ids = [];
    let start;
    do {
      const qs = new URLSearchParams({ limit: '1000', ...(start ? { start } : {}) });
      const data = await this.call('GET', `/followers/ids?${qs}`);
      ids.push(...(data.userIds || []));
      start = data.next;
    } while (start);
    return ids;
  }
}

// 每個品牌用自己的 Channel access token；依 token 快取 client
export class LineRegistry {
  constructor(factory = (token) => new LineClient(token)) {
    this.factory = factory;
    this.cache = new Map();
  }

  for(brand) {
    const token = brand?.channel_access_token || '';
    if (!this.cache.has(token)) this.cache.set(token, this.factory(token));
    return this.cache.get(token);
  }
}
