import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { getConfig } from '../src/config.js';
import { addDays, today } from '../src/dates.js';
import { openDb } from '../src/db.js';
import { buildFocusList, formatFocusSummary } from '../src/focus.js';
import { ReminderService } from '../src/reminders.js';
import { bootstrapBrandFromEnv, createApp, ensureInitialBrands } from '../src/server.js';

const silent = { log() {}, warn() {}, error() {} };
const T = today('Asia/Taipei');
const config = getConfig({ TZ_NAME: 'Asia/Taipei', ADMIN_PASSWORD: 'pw' });

// 每個 token 一個假的 LINE client，記錄是用哪個品牌的帳號發出
function fakeLines() {
  const clients = new Map();
  return {
    clients,
    for(brand) {
      const token = brand?.channel_access_token || '';
      if (!clients.has(token)) {
        clients.set(token, {
          enabled: Boolean(token), pushes: [], replies: [],
          async getProfile(id) { return { displayName: `名-${id}` }; },
          async push(to, text) { this.pushes.push({ to, text }); },
          async reply(_t, text) { this.replies.push(text); },
          async followerIds() { return []; },
        });
      }
      return clients.get(token);
    },
  };
}

function twoBrands() {
  const store = openDb(':memory:');
  const a = store.createBrand({ slug: 'alpha', name: 'A 品牌', channel_secret: 'secA', channel_access_token: 'tokA', bank_info: 'A 銀行 111' });
  const b = store.createBrand({ slug: 'beta', name: 'B 品牌', channel_secret: 'secB', channel_access_token: 'tokB', bank_info: 'B 銀行 222' });
  return { store, a, b };
}

test('舊版單一品牌資料庫自動遷移到「預設品牌」，資料不遺失', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY AUTOINCREMENT, line_user_id TEXT UNIQUE, display_name TEXT, picture_url TEXT, status_message TEXT,
    real_name TEXT, phone TEXT, address TEXT, tags TEXT, note TEXT, reorder_days INTEGER, next_contact_date TEXT, is_friend INTEGER NOT NULL DEFAULT 1,
    followed_at TEXT, unfollowed_at TEXT, last_inbound_at TEXT, last_handled_at TEXT, created_at TEXT NOT NULL DEFAULT 'x', updated_at TEXT NOT NULL DEFAULT 'x');
    CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE, items TEXT,
    amount INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending_payment', order_date TEXT NOT NULL, payment_due_date TEXT, payment_report TEXT,
    payment_reported_at TEXT, paid_at TEXT, shipped_at TEXT, note TEXT, created_at TEXT NOT NULL DEFAULT 'x', updated_at TEXT NOT NULL DEFAULT 'x');
    INSERT INTO customers (line_user_id, display_name, phone) VALUES ('U1', '老客人', '0912');
    INSERT INTO orders (customer_id, amount, order_date) VALUES (1, 500, '2026-01-01');`);
  old.close();

  const store = openDb(file);
  const brand = store.getBrandBySlug('default');
  assert.equal(brand.name, '預設品牌');
  const c = store.getCustomerByLineId(brand.id, 'U1');
  assert.equal(c.phone, '0912');
  assert.equal(store.listOrders({ customerId: c.id })[0].amount, 500);
  assert.equal(store.listOrders({ brandId: brand.id }).length, 1);

  // .env 的金鑰會補到遷移出來的預設品牌
  bootstrapBrandFromEnv(store, getConfig({ LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', SHOP_NAME: '我的店' }));
  assert.equal(store.getBrand(brand.id).channel_secret, 's');
  assert.equal(store.getBrand(brand.id).name, '我的店');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('全新安裝：用 .env 建立第一個品牌', () => {
  const store = openDb(':memory:');
  assert.equal(bootstrapBrandFromEnv(store, getConfig({})), null);
  bootstrapBrandFromEnv(store, getConfig({ LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', SHOP_NAME: '小店' }));
  assert.deepEqual(store.listBrands().map((b) => [b.slug, b.name]), [['default', '小店']]);
});

test('同一個 userId 在不同品牌是不同客戶；訊息、範本、推播都用各自品牌', async () => {
  const { store, a, b } = twoBrands();
  const lines = fakeLines();
  const ca = store.upsertLineCustomer(a.id, 'U1', { displayName: '小美' });
  const cb = store.upsertLineCustomer(b.id, 'U1', { displayName: '小美' });
  assert.notEqual(ca.id, cb.id);

  const svc = new ReminderService({ store, lines, config, logger: silent });
  const oa = store.createOrder(ca.id, { order_date: T, payment_due_date: T, amount: 100 });
  const preview = svc.preview({ customerId: ca.id, kind: 'payment', orderId: oa.id });
  assert.match(preview, /A 品牌/);
  assert.match(preview, /A 銀行 111/);
  assert.doesNotMatch(preview, /B 品牌|B 銀行/);

  await svc.send({ customerId: cb.id, kind: 'care' });
  assert.equal(lines.for(b).pushes.length, 1);
  assert.match(lines.for(b).pushes[0].text, /B 品牌/);
  assert.equal(lines.for(a).pushes.length, 0);
});

test('關懷清單可依品牌篩選；摘要依品牌分段；客服不列入並由自己品牌的帳號收到通知', async () => {
  const { store, a, b } = twoBrands();
  const lines = fakeLines();
  const ca = store.upsertLineCustomer(a.id, 'UA', { displayName: 'A客' });
  const cb = store.upsertLineCustomer(b.id, 'UB', { displayName: 'B客' });
  store.createOrder(ca.id, { order_date: T, payment_due_date: addDays(T, -1), amount: 100 });
  store.createOrder(cb.id, { order_date: T, payment_due_date: T, amount: 200 });
  const staff = store.upsertLineCustomer(b.id, 'USTAFF', { displayName: '客服小王' });
  store.setStaff(staff.id, true);

  const all = buildFocusList(store, config);
  assert.deepEqual(all.items.map((i) => i.customer.display_name).sort(), ['A客', 'B客']);
  assert.deepEqual(buildFocusList(store, config, new Date(), { brandId: b.id }).items.map((i) => i.customer.display_name), ['B客']);

  const summary = formatFocusSummary(all, { brands: store.listBrands() });
  assert.ok(summary.indexOf('━━ A 品牌（1）') < summary.indexOf('A客'));
  assert.ok(summary.indexOf('━━ B 品牌（1）') < summary.indexOf('B客'));

  const svc = new ReminderService({ store, lines, config, logger: silent });
  const r = await svc.runDaily();
  assert.equal(r.staffNotified, 1);
  assert.deepEqual(lines.for(b).pushes.map((p) => p.to), ['USTAFF']);
});

test('HTTP：品牌管理、金鑰不外洩、各品牌 Webhook 用各自的 secret', async (t) => {
  const { store, a, b } = twoBrands();
  const lines = fakeLines();
  const server = http.createServer(createApp({ store, lines, config, logger: silent }));
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const auth = { Authorization: `Basic ${Buffer.from('admin:pw').toString('base64')}` };
  const call = async (p, { method = 'GET', body } = {}) => {
    const res = await fetch(base + p, { method, headers: { ...auth, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };

  const brands = (await call('/api/brands')).data;
  assert.equal(brands.length, 2);
  assert.ok(!JSON.stringify(brands).includes('tokA') && !JSON.stringify(brands).includes('secA'));
  assert.equal(brands[0].has_token, true);

  // 金鑰留空 = 不修改
  await call(`/api/brands/${a.id}`, { method: 'PATCH', body: { name: 'A 品牌改名', channel_access_token: '' } });
  assert.equal(store.getBrand(a.id).channel_access_token, 'tokA');
  assert.equal(store.getBrand(a.id).name, 'A 品牌改名');
  assert.equal((await call('/api/brands', { method: 'POST', body: { name: 'C', slug: 'alpha' } })).status, 400);

  const payload = JSON.stringify({ events: [{ type: 'follow', source: { type: 'user', userId: 'U9' } }] });
  const sign = (secret) => crypto.createHmac('sha256', secret).update(payload).digest('base64');
  assert.equal((await fetch(`${base}/webhook/beta`, { method: 'POST', body: payload, headers: { 'x-line-signature': sign('secA') } })).status, 401);
  assert.equal((await fetch(`${base}/webhook/beta`, { method: 'POST', body: payload, headers: { 'x-line-signature': sign('secB') } })).status, 200);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(store.getCustomerByLineId(b.id, 'U9'));
  assert.equal(store.getCustomerByLineId(a.id, 'U9'), undefined);

  assert.equal((await call(`/api/customers?brand=${a.id}`)).data.length, 0);
  assert.equal((await call(`/api/customers?brand=${b.id}`)).data.length, 1);
  assert.equal((await call('/api/customers', { method: 'POST', body: { display_name: 'x' } })).status, 400, '新增客戶必須指定品牌');
  assert.equal((await call(`/api/brands/${b.id}`, { method: 'DELETE' })).status, 400, '有客戶的品牌不能刪');
});

test('INITIAL_BRANDS：自動建立品牌，只建立一次，刪除或改名後不會被蓋回來', () => {
  const store = openDb(':memory:');
  const cfg = getConfig({ INITIAL_BRANDS: 'xiangyun:享運:#e8590c, lumi:璐米 ,bad slug!:壞' });
  assert.deepEqual(cfg.initialBrands[1], { slug: 'lumi', name: '璐米' });
  ensureInitialBrands(store, cfg, silent);
  const brands = store.listBrands();
  assert.deepEqual(brands.map((b) => [b.slug, b.name]), [['xiangyun', '享運'], ['lumi', '璐米'], ['bad-slug', '壞']]);
  assert.equal(brands[0].color, '#e8590c');

  store.updateBrand(brands[0].id, { name: '享運旗艦' });
  store.deleteBrand(brands[1].id);
  assert.equal(ensureInitialBrands(store, cfg, silent).length, 0);
  assert.deepEqual(store.listBrands().map((b) => b.name), ['享運旗艦', '壞']);
});

test('轉送：已驗證的 Webhook 原封不動轉給舊系統；舊系統掛掉也不影響本系統', async (t) => {
  // 模擬舊系統（例如 Cloudflare Worker）：記錄收到的內容與簽章
  const received = [];
  const old = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { received.push({ path: req.url, body: Buffer.concat(chunks), sig: req.headers['x-line-signature'], fwd: req.headers['x-crm-forwarded'] }); res.end('ok'); });
  });
  await new Promise((r) => old.listen(0, r));
  t.after(() => old.close());

  const { store, a, b } = twoBrands();
  const lines = fakeLines();
  // 開啟自動回覆，確認有轉送的品牌仍不回覆
  const server = http.createServer(createApp({ store, lines, config: { ...config, autoReply: true }, logger: silent }));
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const auth = { Authorization: `Basic ${Buffer.from('admin:pw').toString('base64')}`, 'Content-Type': 'application/json' };
  const patch = (id, body) => fetch(`${base}/api/brands/${id}`, { method: 'PATCH', headers: auth, body: JSON.stringify(body) });

  // 設定驗證
  assert.equal((await patch(a.id, { forward_url: 'ftp://x' })).status, 400);
  assert.equal((await patch(a.id, { forward_url: `${base}/webhook/alpha` })).status, 400, '不能轉給自己');
  assert.equal((await patch(a.id, { forward_url: `http://localhost:${old.address().port}/api/bookings?lineWebhook=ALPHA` })).status, 200);
  assert.equal((await patch(b.id, { forward_url: 'http://127.0.0.1:1/down' })).status, 200);

  const payload = JSON.stringify({ events: [{ type: 'message', source: { type: 'user', userId: 'U5' }, replyToken: 'r', message: { type: 'text', text: '你好 😊' } }] });
  const sign = (secret) => crypto.createHmac('sha256', secret).update(payload).digest('base64');
  const post = (slug, sig, extra = {}) => fetch(`${base}/webhook/${slug}`, { method: 'POST', body: payload, headers: { 'x-line-signature': sig, ...extra } });

  assert.equal((await post('alpha', sign('secA'))).status, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(received.length, 1);
  assert.equal(received[0].path, '/api/bookings?lineWebhook=ALPHA', '網址參數保留');
  assert.equal(received[0].body.toString(), payload, '內容一字不差');
  assert.equal(received[0].sig, sign('secA'), '簽章原樣帶過去，舊系統可照常驗證');
  assert.ok(store.getCustomerByLineId(a.id, 'U5'), '本系統照常建檔');

  // 有轉送的品牌不使用 replyToken（留給原本系統回覆），但仍記錄匯款回報
  const ca = store.getCustomerByLineId(a.id, 'U5');
  const order = store.createOrder(ca.id, { order_date: '2026-10-15', payment_due_date: '2026-10-16', amount: 1000 });
  const paid = JSON.stringify({ events: [{ type: 'message', source: { type: 'user', userId: 'U5' }, replyToken: 'r2', message: { type: 'text', text: '已匯款 末五碼 12345' } }] });
  await fetch(`${base}/webhook/alpha`, { method: 'POST', body: paid, headers: { 'x-line-signature': crypto.createHmac('sha256', 'secA').update(paid).digest('base64') } });
  await new Promise((r) => setTimeout(r, 100));
  assert.match(store.getOrder(order.id).payment_report, /12345/);
  assert.equal(lines.for(a).replies.length, 0, '不搶原本系統的回覆');
  received.length = 1;

  assert.equal((await post('alpha', 'bad')).status, 401);
  assert.equal((await post('alpha', sign('secA'), { 'x-crm-forwarded': '1' })).status, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(received.length, 1, '簽章錯誤或已轉送過的請求不再轉送');

  // 舊系統連不上：本系統照常處理，並記錄失敗
  assert.equal((await post('beta', sign('secB'))).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(store.getCustomerByLineId(b.id, 'U5'));
  const brands = await (await fetch(`${base}/api/brands`, { headers: auth })).json();
  const [sa, sb] = [brands.find((x) => x.id === a.id).forward_status, brands.find((x) => x.id === b.id).forward_status];
  assert.equal(sa.ok, true);
  assert.equal(sb.ok, false);
  assert.ok(sb.error);

  // 清空 = 不再轉送
  await patch(a.id, { forward_url: '' });
  assert.equal(store.getBrand(a.id).forward_url, null);
});
