import crypto from 'node:crypto';

// 後台登入：每位客服各自的帳號密碼，登入後以 HttpOnly cookie 維持登入狀態。
// 老闆帳號固定為 admin，密碼是環境變數 ADMIN_PASSWORD（忘記其他帳號密碼時可用它重設）。

export const ROLES = { admin: '管理員', staff: '客服' };
export const SESSION_COOKIE = 'crm_session';
const SESSION_DAYS = 30;
const OWNER = { id: 0, username: 'admin', display_name: '管理員', role: 'admin', active: 1 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const safeEqual = (a, b) => crypto.timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)));
const publicUser = (u) => (u ? { id: u.id, username: u.username, display_name: u.display_name, role: u.role, active: u.active, last_login_at: u.last_login_at ?? null, created_at: u.created_at ?? null } : null);

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export class Auth {
  constructor({ store, config }) {
    this.store = store;
    this.config = config;
    this.failures = new Map(); // ip 或 user:帳號 → [時間戳]
  }

  // ---------- 帳號 ----------
  listUsers() {
    return this.store.all('SELECT * FROM users ORDER BY active DESC, id').map(publicUser);
  }

  getUser(id) {
    if (id === 0) return OWNER;
    return this.store.get('SELECT * FROM users WHERE id = ?', id);
  }

  validate({ username, display_name: name, password, role }, { requirePassword }) {
    if (username !== undefined && !/^[a-zA-Z0-9._-]{2,30}$/.test(username)) throw new Error('帳號只能用英文、數字、. _ -，2–30 個字');
    if (username !== undefined && username.toLowerCase() === 'admin') throw new Error('admin 是老闆帳號保留名稱');
    if (name !== undefined && !String(name).trim()) throw new Error('請輸入顯示名稱');
    if ((requirePassword || password) && String(password ?? '').length < 8) throw new Error('密碼至少 8 個字');
    if (role !== undefined && !ROLES[role]) throw new Error('角色不正確');
  }

  createUser({ username, display_name: name, password, role = 'staff' }) {
    username = String(username ?? '').trim();
    this.validate({ username, display_name: name, password, role }, { requirePassword: true });
    if (this.store.get('SELECT id FROM users WHERE username = ? COLLATE NOCASE', username)) throw new Error(`帳號「${username}」已經有人使用`);
    const r = this.store.run('INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?)', username, String(name).trim(), hashPassword(password), role);
    return publicUser(this.getUser(Number(r.lastInsertRowid)));
  }

  updateUser(id, { display_name: name, password, role, active }) {
    const u = this.getUser(id);
    if (!u || id === 0) throw new Error('找不到帳號');
    this.validate({ display_name: name, password, role }, { requirePassword: false });
    if (name !== undefined) this.store.run('UPDATE users SET display_name = ? WHERE id = ?', String(name).trim(), id);
    if (role !== undefined) this.store.run('UPDATE users SET role = ? WHERE id = ?', role, id);
    if (active !== undefined) this.store.run('UPDATE users SET active = ? WHERE id = ?', active ? 1 : 0, id);
    if (password) this.store.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), id);
    // 停用或改密碼後，讓這個帳號所有裝置重新登入
    if (password || active === false || active === 0) this.store.run('DELETE FROM sessions WHERE user_id = ?', id);
    return publicUser(this.getUser(id));
  }

  // ---------- 登入 ----------
  // 同一 IP 15 分鐘內錯 10 次、或同一帳號錯 20 次（不論 IP；IP 可被 X-Forwarded-For 偽造）就暫時鎖住
  recentFailures(key) {
    const now = Date.now();
    const recent = (this.failures.get(key) || []).filter((t) => now - t < 15 * 60_000);
    if (recent.length) this.failures.set(key, recent);
    else this.failures.delete(key);
    return recent;
  }

  tooManyFailures(ip, username = '') {
    return this.recentFailures(ip).length >= 10 || this.recentFailures(`user:${username}`).length >= 20;
  }

  recordFailure(key) {
    // 攻擊者換一堆 IP 時不讓記錄無限長大
    if (this.failures.size > 10_000) for (const k of [...this.failures.keys()]) this.recentFailures(k);
    this.failures.set(key, [...this.recentFailures(key), Date.now()]);
  }

  checkCredentials(username, password) {
    username = String(username ?? '').trim();
    if (username.toLowerCase() === 'admin') {
      return this.config.adminPassword && safeEqual(password, this.config.adminPassword) ? OWNER : null;
    }
    const u = this.store.get('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND active = 1', username);
    return u && verifyPassword(password, u.password_hash) ? u : null;
  }

  login(username, password, ip) {
    const account = String(username ?? '').trim().toLowerCase();
    if (this.tooManyFailures(ip, account)) throw Object.assign(new Error('嘗試次數過多，請 15 分鐘後再試'), { status: 429 });
    const user = this.checkCredentials(username, password);
    if (!user) {
      this.recordFailure(ip);
      this.recordFailure(`user:${account}`);
      throw Object.assign(new Error('帳號或密碼錯誤'), { status: 401 });
    }
    this.failures.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
    this.store.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(token), user.id, expires);
    if (user.id) this.store.run('UPDATE users SET last_login_at = ? WHERE id = ?', new Date().toISOString(), user.id);
    this.store.run('DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString());
    return { token, user: publicUser(user) };
  }

  logout(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) this.store.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  }

  // 由請求找出登入者：cookie session；設定 BASIC_AUTH=true 時也接受 HTTP Basic（給程式或測試用）
  userFromRequest(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) {
      const s = this.store.get('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?', sha256(token), new Date().toISOString());
      if (s) {
        const u = this.getUser(s.user_id);
        if (u && u.active) return publicUser(u);
      }
    }
    if (this.config.basicAuth) {
      const m = (req.headers.authorization || '').match(/^Basic (.+)$/);
      if (m) {
        const [user, pass = ''] = Buffer.from(m[1], 'base64').toString().split(/:(.*)/s);
        const u = this.checkCredentials(user, pass);
        if (u) return publicUser(u);
      }
    }
    return null;
  }

  sessionCookie(token, req) {
    const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted;
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
  }

  clearCookie() {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }
}
