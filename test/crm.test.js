import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { test } from 'node:test';
import { getConfig } from '../src/config.js';
import { addDays, today } from '../src/dates.js';
import { openDb } from '../src/db.js';
import { buildFocusList, formatFocusSummary, reorderCycle } from '../src/focus.js';
import { verifySignature } from '../src/line.js';
import { ReminderService } from '../src/reminders.js';
import { createApp } from '../src/server.js';
import { WebhookHandler } from '../src/webhook.js';

const silent = { log() {}, warn() {}, error() {} };

function fakeLine() {
  return {
    enabled: true,
    pushes: [],
    replies: [],
    async getProfile(id) { return { displayName: `名-${id}`, pictureUrl: 'https://example.com/p.png' }; },
    async push(to, text) { this.pushes.push({ to, text }); return {}; },
    async reply(token, text) { this.replies.push({ token, text }); return {}; },
    async followerIds() { return ['U1', 'U9']; },
  };
}

const B = 1; // 測試用的第一個品牌 id

function setup(env = {}) {
  const config = getConfig({ TZ_NAME: 'Asia/Taipei', ADMIN_PASSWORD: 'pw', DEFAULT_REORDER_DAYS: '30', ...env });
  const store = openDb(':memory:');
  store.createBrand({ slug: 'shop', name: '測試店', channel_secret: 'sec', channel_access_token: 'tok', bank_info: '000-123' });
  const line = fakeLine();
  const lines = { for: () => line };
  return { config, store, line, lines };
}

const T = today('Asia/Taipei');
const reasonsOf = (focus, customerId) => focus.items.find((i) => i.customer.id === customerId)?.reasons.map((r) => r.code) ?? [];

test('reorderCycle：手動 > 平均間隔 > 預設', () => {
  assert.equal(reorderCycle({ reorder_days: 10 }, [], 30).days, 10);
  assert.equal(reorderCycle({}, ['2026-01-01', '2026-01-21', '2026-02-10'], 30).days, 20);
  assert.equal(reorderCycle({}, ['2026-01-01'], 30).days, 30);
});

test('關懷清單：逾期、今天到期、明天到期、回報匯款', () => {
  const { config, store } = setup();
  const a = store.upsertLineCustomer(B, 'A', { displayName: 'A' });
  const b = store.upsertLineCustomer(B, 'B', { displayName: 'B' });
  const c = store.upsertLineCustomer(B, 'C', { displayName: 'C' });
  const d = store.upsertLineCustomer(B, 'D', { displayName: 'D' });
  store.createOrder(a.id, { order_date: addDays(T, -5), payment_due_date: addDays(T, -2), amount: 100 });
  store.createOrder(b.id, { order_date: T, payment_due_date: T, amount: 100 });
  store.createOrder(c.id, { order_date: T, payment_due_date: addDays(T, 1), amount: 100 });
  const od = store.createOrder(d.id, { order_date: T, payment_due_date: addDays(T, -1), amount: 100 });
  store.reportPayment(od.id, '已匯款 12345');

  const focus = buildFocusList(store, config);
  assert.deepEqual(reasonsOf(focus, a.id), ['payment_overdue']);
  assert.deepEqual(reasonsOf(focus, b.id), ['payment_due_today']);
  assert.deepEqual(reasonsOf(focus, c.id), ['payment_due_tomorrow']);
  assert.deepEqual(reasonsOf(focus, d.id), ['verify_payment']);
  assert.equal(focus.items.at(-1).customer.id, c.id, '優先度低的排後面');
});

test('關懷清單：可邀請再次預約、邀請後一個週期內不再列入、延後', () => {
  const { config, store } = setup();
  const c = store.upsertLineCustomer(B, 'R', { displayName: 'R' });
  store.createOrder(c.id, { order_date: addDays(T, -60), status: 'completed', amount: 500 });
  store.createOrder(c.id, { order_date: addDays(T, -40), status: 'completed', amount: 500 });
  assert.ok(reasonsOf(buildFocusList(store, config), c.id).includes('reorder'));

  store.logReminder({ customerId: c.id, kind: 'reorder', text: 'x' });
  assert.ok(!reasonsOf(buildFocusList(store, config), c.id).includes('reorder'), '剛提醒過不再列入');
  store.run("UPDATE reminders SET sent_at = ? WHERE customer_id = ?", `${addDays(T, -10)}T04:00:00.000Z`, c.id);
  assert.ok(!reasonsOf(buildFocusList(store, config), c.id).includes('reorder'), '10 天前邀請過，週期 20 天內仍不列入');
  store.run("UPDATE reminders SET sent_at = ? WHERE customer_id = ?", `${addDays(T, -21)}T04:00:00.000Z`, c.id);
  assert.ok(reasonsOf(buildFocusList(store, config), c.id).includes('reorder'), '超過一個週期再列入');

  const c2 = store.upsertLineCustomer(B, 'R2', { displayName: 'R2' });
  store.createOrder(c2.id, { order_date: addDays(T, -45), status: 'completed', amount: 500 });
  store.updateCustomer(c2.id, { next_contact_date: addDays(T, 3) });
  assert.deepEqual(reasonsOf(buildFocusList(store, config), c2.id), [], '延後期間不列入');

  store.updateCustomer(c2.id, { next_contact_date: T });
  assert.deepEqual(reasonsOf(buildFocusList(store, config), c2.id), ['scheduled', 'reorder']);
});

test('關懷清單：新好友未下單、未回覆訊息', () => {
  const { config, store } = setup();
  const c = store.upsertLineCustomer(B, 'N', { displayName: 'N' });
  assert.deepEqual(reasonsOf(buildFocusList(store, config), c.id), ['new_friend']);
  store.addMessage(c.id, 'in', '請問有貨嗎');
  assert.deepEqual(reasonsOf(buildFocusList(store, config), c.id), ['unreplied', 'new_friend']);
  store.markHandled(c.id);
  assert.deepEqual(reasonsOf(buildFocusList(store, config), c.id), ['new_friend']);
});

test('Webhook：加好友自動建檔、封鎖、匯款回報、查訂單', async () => {
  const { store, line, lines } = setup();
  const quiet = new WebhookHandler({ store, lines, logger: silent });
  await quiet.handle(store.getBrand(B), { events: [{ type: 'message', source: { type: 'user', userId: 'UQ' }, replyToken: 'rq', message: { type: 'text', text: '查訂單' } }] });
  assert.equal(line.replies.length, 0, '預設不自動回覆客人');
  assert.equal(store.listMessages(store.getCustomerByLineId(B, 'UQ').id).length, 1, '但訊息照常記錄');

  const wh = new WebhookHandler({ store, lines, logger: silent, autoReply: true });
  const brand = store.getBrand(B);
  const src = { type: 'user', userId: 'U1' };

  await wh.handle(brand, { events: [{ type: 'follow', source: src, replyToken: 'r0' }] });
  let c = store.getCustomerByLineId(B, 'U1');
  assert.equal(c.display_name, '名-U1');
  assert.equal(c.is_friend, 1);

  const o = store.createOrder(c.id, { order_date: T, payment_due_date: T, amount: 880 });
  await wh.handle(brand, { events: [{ type: 'message', source: src, replyToken: 'r1', message: { type: 'text', text: '我已匯款，末五碼 54321' } }] });
  assert.match(store.getOrder(o.id).payment_report, /54321/);
  assert.match(line.replies[0].text, /收到您的匯款通知/);
  c = store.getCustomerByLineId(B, 'U1');
  assert.ok(!c.last_handled_at, '自動回覆不算客服已處理');

  await wh.handle(brand, { events: [{ type: 'message', source: src, replyToken: 'r2', message: { type: 'text', text: '查訂單' } }] });
  assert.match(line.replies[1].text, /NT\$880｜待付款/);
  assert.equal(store.listMessages(c.id).length, 4);

  await wh.handle(brand, { events: [{ type: 'unfollow', source: src }] });
  assert.equal(store.getCustomerByLineId(B, 'U1').is_friend, 0);
});

test('提醒：推播、非好友失敗、自動匯款提醒一天一次、每日摘要推給客服', async () => {
  const { config, store, line, lines } = setup({ AUTO_PAYMENT_REMINDER: 'true', STAFF_LINE_USER_IDS: 'STAFF1' });
  const svc = new ReminderService({ store, lines, config, logger: silent });
  const c = store.upsertLineCustomer(B, 'P', { displayName: '小美' });
  const o = store.createOrder(c.id, { order_date: T, payment_due_date: T, amount: 1200, items: '滴雞精' });

  const preview = svc.preview({ customerId: c.id, kind: 'payment', orderId: o.id });
  assert.match(preview, /小美/);
  assert.match(preview, /NT\$1200/);
  assert.match(preview, /000-123/);

  const manual = store.createCustomer(B, { display_name: '電話客' });
  await assert.rejects(svc.send({ customerId: manual.id, kind: 'care' }), /不是 LINE 好友/);

  const report = await svc.runDaily();
  assert.equal(report.paymentSent, 1);
  assert.equal(report.staffNotified, 1);
  assert.equal(line.pushes.find((p) => p.to === 'STAFF1').text.includes('小美'), true);
  assert.equal(await svc.autoPaymentReminders(), 0, '同一天不重複提醒');
});

test('摘要格式', () => {
  assert.match(formatFocusSummary({ date: T, items: [] }), /沒有需要特別關心/);
});

test('簽章驗證', () => {
  const body = Buffer.from('{"events":[]}');
  const sig = crypto.createHmac('sha256', 'sec').update(body).digest('base64');
  assert.ok(verifySignature('sec', body, sig));
  assert.ok(!verifySignature('sec', body, 'bad'));
  assert.ok(!verifySignature('other', body, sig));
});

test('HTTP：後台需登入、webhook 驗簽、API 流程', async (t) => {
  const { config, store, line, lines } = setup();
  const server = http.createServer(createApp({ store, lines, config, logger: silent }));
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const auth = { Authorization: `Basic ${Buffer.from('admin:pw').toString('base64')}` };
  const call = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + path, { method, headers: { ...auth, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: res.status, data: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
  };

  assert.equal((await fetch(`${base}/api/focus`)).status, 401);
  assert.equal((await fetch(`${base}/webhook`, { method: 'POST', body: '{}', headers: { 'x-line-signature': 'x' } })).status, 401);

  const payload = JSON.stringify({ events: [{ type: 'message', source: { type: 'user', userId: 'U7' }, replyToken: 'r', message: { type: 'text', text: '哈囉' } }] });
  const sig = crypto.createHmac('sha256', 'sec').update(payload).digest('base64');
  assert.equal((await fetch(`${base}/webhook/nope`, { method: 'POST', body: payload, headers: { 'x-line-signature': sig } })).status, 404);
  assert.equal((await fetch(`${base}/webhook/shop`, { method: 'POST', body: payload, headers: { 'x-line-signature': sig } })).status, 200);
  await new Promise((r) => setTimeout(r, 50));

  const customers = (await call('/api/customers')).data;
  assert.equal(customers.length, 1);
  const id = customers[0].id;

  const order = (await call('/api/orders', { method: 'POST', body: { customer_id: id, amount: '990', items: '禮盒' } })).data;
  assert.equal(order.amount, 990);
  assert.equal(order.payment_due_date, addDays(T, 3));

  const focus = (await call('/api/focus')).data;
  assert.deepEqual(focus.items[0].reasons.map((r) => r.code), ['unreplied']);

  const paid = (await call(`/api/orders/${order.id}`, { method: 'PATCH', body: { status: 'paid', notify: true } })).data;
  assert.equal(paid.notified, true);
  assert.ok(paid.order.paid_at);
  assert.match(line.pushes.at(-1).text, /已收到您訂單/);

  assert.equal((await call(`/api/orders/${order.id}`, { method: 'PATCH', body: { status: 'nope' } })).status, 400);

  const sync = (await call(`/api/brands/${B}/sync-followers`, { method: 'POST' })).data;
  assert.deepEqual(sync, { total: 2, added: 2 });

  store.updateCustomer(id, { note: '=HYPERLINK("x")' });
  const csv = (await call('/api/export/customers.csv')).data;
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);

  const backup = await fetch(`${base}/api/export/backup.db`, { headers: auth });
  assert.equal(backup.status, 200);
  assert.equal(Buffer.from(await backup.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal((await fetch(`${base}/api/export/backup.db`)).status, 401, '備份需要登入');
});

test('回訪邀請依分群與服務類型：首次機場接送、回頭客（依平均週期）、沉睡、尚未用車', () => {
  const { config, store, lines } = setup();
  const svc = new ReminderService({ store, lines, config, logger: silent });

  const first = store.upsertLineCustomer(B, 'F1', { displayName: '首次' });
  store.createOrder(first.id, { order_date: addDays(T, -40), service_date: addDays(T, -35), service_type: 'airport', status: 'completed', amount: 1200 });
  const f = svc.preview({ customerId: first.id, kind: 'reorder' });
  assert.match(f, /第一次搭乘我們的機場接送！35 天前的行程還順利嗎/, '以用車日計算天數');
  assert.match(f, /下次出國或回國需要接送/);

  const rep = store.upsertLineCustomer(B, 'R1', { displayName: '老客' });
  store.createOrder(rep.id, { order_date: addDays(T, -50), status: 'completed', amount: 3000, service_type: 'charter' });
  store.createOrder(rep.id, { order_date: addDays(T, -25), status: 'completed', amount: 3000, service_type: 'charter' });
  const r = svc.preview({ customerId: rep.id, kind: 'reorder' });
  assert.match(r, /每 25 天會找我們一次，距離上次的包車已經 25 天了/);

  const sleep = store.upsertLineCustomer(B, 'D1', { displayName: '沉睡' });
  store.createOrder(sleep.id, { order_date: addDays(T, -120), status: 'completed', amount: 2000, service_type: 'rental' });
  const d = svc.preview({ customerId: sleep.id, kind: 'reorder' });
  assert.match(d, /好久不見/);
  assert.match(d, /上次的租車自駕已經 120 天/);

  const upcoming = store.upsertLineCustomer(B, 'U1', { displayName: '預約中' });
  store.createOrder(upcoming.id, { order_date: T, service_date: addDays(T, 10), status: 'paid', amount: 1200 });
  const u = svc.preview({ customerId: upcoming.id, kind: 'reorder' });
  assert.doesNotMatch(u, /天前|-\d/, '行程還沒到，不寫天數');
});

test('行程確認：範本、明天用車列入清單、自動推播一次、今天未派車', async () => {
  const { config, store, line, lines } = setup({ AUTO_TRIP_REMINDER: 'true' });
  const svc = new ReminderService({ store, lines, config, logger: silent });
  const c = store.upsertLineCustomer(B, 'T1', { displayName: '小美' });
  const tomorrow = addDays(T, 1);
  const o = store.createOrder(c.id, {
    order_date: T, service_date: tomorrow, service_time: '05:30', service_type: 'airport', status: 'paid', amount: 1200,
    flight_no: 'BR198', pickup: '台北市信義區松仁路 100 號', dropoff: '桃園機場第二航廈', items: '7 人座',
  });

  const text = svc.preview({ customerId: c.id, kind: 'trip', orderId: o.id });
  assert.match(text, /提醒您明天 \d+\/\d+（.）的機場接送行程（訂單 #\d+）/);
  assert.match(text, /05:30/);
  assert.match(text, /航班：BR198/);
  assert.match(text, /上車地點：台北市信義區/);
  assert.match(text, /目的地：桃園機場第二航廈/);
  assert.match(text, /航班、時間或地點有異動/);

  assert.ok(reasonsOf(buildFocusList(store, config), c.id).includes('trip_tomorrow'));
  const report = await svc.runDaily();
  assert.equal(report.tripSent, 1);
  assert.match(line.pushes[0].text, /BR198/);
  assert.ok(!reasonsOf(buildFocusList(store, config), c.id).includes('trip_tomorrow'), '傳過就不再列入');
  assert.equal(await svc.autoTripReminders(), 0, '同一筆不重複傳');

  const rental = store.createOrder(c.id, { order_date: T, service_date: T, service_time: '10:00', service_type: 'rental', status: 'paid', amount: 4000, pickup: '高鐵左營站', return_date: addDays(T, 3), dropoff: '高鐵左營站' });
  const rt = svc.preview({ customerId: c.id, kind: 'trip', orderId: rental.id });
  assert.match(rt, /今天 .*租車自駕/);
  assert.match(rt, /取車：.*10:00｜高鐵左營站/);
  assert.match(rt, /還車：/);
  assert.match(rt, /駕照/);
  assert.ok(reasonsOf(buildFocusList(store, config), c.id).includes('dispatch'), '今天用車未派車');
  store.updateOrder(rental.id, { status: 'shipped' });
  assert.ok(!reasonsOf(buildFocusList(store, config), c.id).includes('dispatch'));
});

test('新訂單匯款期限：最晚在用車前一天', async () => {
  const { config, store, lines } = setup();
  const app = createApp({ store, lines, config, logger: silent });
  const server = http.createServer(app).listen(0);
  const auth = { Authorization: `Basic ${Buffer.from('admin:pw').toString('base64')}`, 'Content-Type': 'application/json' };
  const c = store.upsertLineCustomer(B, 'P1', { displayName: 'P' });
  const post = async (body) => (await fetch(`http://localhost:${server.address().port}/api/orders`, { method: 'POST', headers: auth, body: JSON.stringify({ customer_id: c.id, amount: 1000, ...body }) })).json();
  try {
    assert.equal((await post({ service_date: addDays(T, 30) })).payment_due_date, addDays(T, 3));
    assert.equal((await post({ service_date: addDays(T, 2) })).payment_due_date, addDays(T, 1));
    assert.equal((await post({ service_date: T })).payment_due_date, T);
    assert.match((await post({ service_type: 'boat' })).error, /未知的服務類型/);
  } finally {
    server.close();
  }
});
