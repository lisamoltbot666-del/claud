import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { hashPassword, verifyPassword } from '../src/auth.js';
import { getConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';

const silent = { log() {}, warn() {}, error() {} };

test('密碼雜湊：驗證正確、錯誤、格式不對', () => {
  const h = hashPassword('secret123');
  assert.ok(h.startsWith('scrypt$'));
  assert.ok(!h.includes('secret123'));
  assert.ok(verifyPassword('secret123', h));
  assert.ok(!verifyPassword('secret124', h));
  assert.ok(!verifyPassword('x', 'plain'));
});

async function startApp(t, env = {}) {
  const store = openDb(':memory:');
  const brand = store.createBrand({ slug: 'a', name: '享運', channel_access_token: 'tok' });
  const pushes = [];
  const lines = { for: () => ({ enabled: true, async push(to, text) { pushes.push({ to, text }); } }) };
  const config = getConfig({ TZ_NAME: 'Asia/Taipei', ADMIN_PASSWORD: 'boss-pass', ...env });
  const server = http.createServer(createApp({ store, lines, config, logger: silent }));
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  // 簡單的瀏覽器：記住 cookie
  const client = () => {
    let cookie = '';
    return async (path, { method = 'GET', body, headers = {} } = {}) => {
      const res = await fetch(base + path, { method, redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body && JSON.stringify(body) });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, headers: res.headers, setCookie: set };
    };
  };
  return { store, brand, base, client, pushes };
}

test('登入：沒登入會導到登入頁；錯誤密碼；admin 登入；登出', async (t) => {
  const { client } = await startApp(t);
  const c = client();
  assert.equal((await c('/')).status, 302);
  assert.equal((await c('/')).headers.get('location'), '/login');
  assert.equal((await c('/login')).status, 200);
  assert.equal((await c('/style.css')).status, 200);
  assert.equal((await c('/app.js')).status, 302);
  const api401 = await c('/api/focus');
  assert.equal(api401.status, 401);
  assert.equal(api401.data.login, true);
  assert.equal((await c('/api/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } })).status, 401);

  const ok = await c('/api/login', { method: 'POST', body: { username: 'admin', password: 'boss-pass' } });
  assert.equal(ok.status, 200);
  assert.match(ok.setCookie, /HttpOnly/);
  assert.match(ok.setCookie, /SameSite=Lax/);
  assert.equal((await c('/api/status')).data.me.role, 'admin');
  assert.equal((await c('/')).status, 200);

  await c('/api/logout', { method: 'POST' });
  assert.equal((await c('/api/status')).status, 401);
});

test('不接受 HTTP Basic（除非 BASIC_AUTH=true）；跨站請求被擋', async (t) => {
  const { base, client } = await startApp(t);
  const basic = { Authorization: `Basic ${Buffer.from('admin:boss-pass').toString('base64')}` };
  assert.equal((await fetch(`${base}/api/status`, { headers: basic })).status, 401);
  const c = client();
  await c('/api/login', { method: 'POST', body: { username: 'admin', password: 'boss-pass' } });
  const evil = await c('/api/customers', { method: 'POST', body: { brand_id: 1, display_name: 'x' }, headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  const same = await c('/api/customers', { method: 'POST', body: { brand_id: 1, display_name: 'x' }, headers: { origin: base } });
  assert.equal(same.status, 200);
});

test('登入嘗試過多會暫時鎖住', async (t) => {
  const { client } = await startApp(t);
  const c = client();
  for (let i = 0; i < 10; i++) await c('/api/login', { method: 'POST', body: { username: 'admin', password: 'nope' } });
  assert.equal((await c('/api/login', { method: 'POST', body: { username: 'admin', password: 'boss-pass' } })).status, 429);
});

test('客服帳號：權限、操作紀錄、訊息記錄是誰送的、停用後立即登出', async (t) => {
  const { store, brand, client, pushes } = await startApp(t);
  const boss = client();
  await boss('/api/login', { method: 'POST', body: { username: 'admin', password: 'boss-pass' } });
  assert.equal((await boss('/api/users', { method: 'POST', body: { username: 'admin', display_name: 'x', password: '12345678' } })).status, 400);
  assert.equal((await boss('/api/users', { method: 'POST', body: { username: 'amy', display_name: '小艾', password: 'short' } })).status, 400);
  const created = await boss('/api/users', { method: 'POST', body: { username: 'amy', display_name: '小艾', password: 'amy-pass-1' } });
  assert.equal(created.status, 200);
  assert.ok(!('password_hash' in created.data));
  assert.equal((await boss('/api/users', { method: 'POST', body: { username: 'AMY', display_name: 'y', password: '12345678' } })).status, 400, '帳號不分大小寫');

  const amy = client();
  assert.equal((await amy('/api/login', { method: 'POST', body: { username: 'Amy', password: 'amy-pass-1' } })).status, 200);
  assert.equal((await amy('/api/status')).data.me.display_name, '小艾');

  // 客服可以處理客戶與訂單
  const cust = store.upsertLineCustomer(brand.id, 'U1', { displayName: '小美' });
  const order = await amy('/api/orders', { method: 'POST', body: { customer_id: cust.id, amount: 1000, service_date: '2026-12-01' } });
  assert.equal(order.status, 200);
  await amy(`/api/orders/${order.data.id}`, { method: 'PATCH', body: { status: 'paid', flight_no: 'BR1' } });
  await amy(`/api/customers/${cust.id}`, { method: 'PATCH', body: { phone: '0912', note: '' } });
  const sent = await amy(`/api/customers/${cust.id}/send`, { method: 'POST', body: { kind: 'custom', text: '您好' } });
  assert.equal(sent.status, 200);
  assert.equal(pushes.length, 1);
  // 客服不能做管理員的事
  for (const [path, method, body] of [['/api/users', 'GET'], ['/api/brands', 'POST', { name: 'x' }], [`/api/brands/${brand.id}`, 'PATCH', { name: 'x' }], ['/api/import', 'POST', { csv: 'a' }], [`/api/customers/${cust.id}`, 'DELETE'], ['/api/export/backup.db', 'GET'], ['/api/activity', 'GET']]) {
    assert.equal((await amy(path, { method, body })).status, 403, `${method} ${path}`);
  }

  const detail = (await boss(`/api/customers/${cust.id}`)).data;
  assert.equal(detail.messages.at(-1).staff_name, '小艾');
  assert.equal(detail.reminders[0].staff_name, '小艾');
  const actions = detail.activity.map((a) => `${a.user_name}:${a.action}:${a.detail}`);
  assert.ok(actions.some((a) => a.startsWith('小艾:新增訂單:#')));
  assert.ok(actions.some((a) => /小艾:修改訂單:#\d+ 狀態 待付款 → 已付款、航班/.test(a)), actions.join('\n'));
  assert.ok(actions.some((a) => a === '小艾:修改客戶資料:電話'), '只記錄真的有改的欄位');
  const all = (await boss('/api/activity?user=小艾')).data;
  assert.ok(all.some((a) => a.action === '登入'));

  // 客服改自己的密碼
  assert.equal((await amy('/api/me/password', { method: 'POST', body: { current: 'wrong', password: 'new-pass-22' } })).status, 400);
  assert.equal((await amy('/api/me/password', { method: 'POST', body: { current: 'amy-pass-1', password: 'new-pass-22' } })).status, 200);
  assert.equal((await amy('/api/status')).status, 401, '改密碼後要重新登入');
  assert.equal((await amy('/api/login', { method: 'POST', body: { username: 'amy', password: 'new-pass-22' } })).status, 200);

  // 管理員停用帳號 → 立即失效
  await boss(`/api/users/${created.data.id}`, { method: 'PATCH', body: { active: false } });
  assert.equal((await amy('/api/status')).status, 401);
  assert.equal((await amy('/api/login', { method: 'POST', body: { username: 'amy', password: 'new-pass-22' } })).status, 401);
});
