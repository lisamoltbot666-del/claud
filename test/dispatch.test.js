import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { getConfig } from '../src/config.js';
import { addDays, today } from '../src/dates.js';
import { openDb } from '../src/db.js';
import { assignDriver, assignManualDriver, dispatchBoard, dispatchText, driverInfoText, listDrivers, saveDriver, setOrderDriverInfo } from '../src/dispatch.js';
import { buildFocusList } from '../src/focus.js';
import { createApp } from '../src/server.js';

const config = getConfig({ TZ_NAME: 'Asia/Taipei', ADMIN_PASSWORD: 'pw', BASIC_AUTH: 'true' });
const T = today('Asia/Taipei');
const silent = { log() {}, warn() {}, error() {} };

function setup() {
  const store = openDb(':memory:');
  const a = store.createBrand({ slug: 'a', name: '享運', channel_access_token: 'tok' });
  const c = store.updateCustomer(store.upsertLineCustomer(a.id, 'U1', { displayName: '小美' }).id, { real_name: '王小美', phone: '0912' });
  const paid = store.createOrder(c.id, { order_date: T, service_date: T, service_time: '06:30', service_type: 'airport', flight_no: 'BR198', pickup: '信義區', dropoff: 'T2', items: '7 人座', amount: 1200, status: 'paid', note: '有兒童座椅' });
  const unpaid = store.createOrder(c.id, { order_date: T, service_date: addDays(T, 1), service_time: '09:00', service_type: 'charter', pickup: '台北車站', amount: 6000, status: 'pending_payment' });
  return { store, a, c, paid, unpaid };
}

test('司機資料：必填、連結 LINE 必須是好友、停用', () => {
  const { store, c } = setup();
  assert.throws(() => saveDriver(store, null, { name: ' ' }), /姓名/);
  const nonFriend = store.createCustomer(c.brand_id, { display_name: '非好友' });
  assert.throws(() => saveDriver(store, null, { name: '王大明', line_customer_id: nonFriend.id }), /LINE 好友/);
  const d = saveDriver(store, null, { name: '王大明', phone: '0933', plate: 'ABC-1234', car_model: 'Alphard' });
  assert.equal(d.active, 1);
  saveDriver(store, d.id, { active: '0' });
  assert.equal(listDrivers(store, { activeOnly: true }).length, 0);
});

test('指派司機：已付款的單變已派車，待付款保留狀態；取消指派還原；今天未派車提醒消失', () => {
  const { store, paid, unpaid } = setup();
  const d = saveDriver(store, null, { name: '王大明', plate: 'ABC-1234' });
  assert.ok(buildFocusList(store, config).items[0].reasons.some((r) => r.code === 'dispatch'));
  assert.equal(assignDriver(store, paid.id, d.id).status, 'shipped');
  assert.equal(assignDriver(store, unpaid.id, d.id).status, 'pending_payment');
  assert.ok(!buildFocusList(store, config).items.some((i) => i.reasons.some((r) => r.code === 'dispatch')));
  assert.equal(assignDriver(store, paid.id, null).status, 'paid');
  saveDriver(store, d.id, { active: 0 });
  assert.throws(() => assignDriver(store, paid.id, d.id), /停用/);
  store.updateOrder(paid.id, { status: 'cancelled' });
  const d2 = saveDriver(store, null, { name: 'B' });
  assert.throws(() => assignDriver(store, paid.id, d2.id), /已取消/);
});

test('派車單與司機資訊內容；派車表依時間排序', () => {
  const { store, paid, unpaid } = setup();
  const d = saveDriver(store, null, { name: '王大明', phone: '0933-111-222', plate: 'ABC-1234', car_model: 'Alphard' });
  assignDriver(store, paid.id, d.id);
  const text = dispatchText(store, paid.id);
  for (const s of ['【派車單】享運', '司機：王大明｜ABC-1234', '06:30｜機場接送', '航班：BR198', '上車：信義區', '目的地：T2', '客人：王小美 0912', '已付款 NT$1,200', '有兒童座椅']) assert.ok(text.includes(s), s);
  assert.match(dispatchText(store, unpaid.id), /尚未付款（NT\$6,000）/);
  const info = driverInfoText(store, paid.id);
  for (const s of ['王小美 您好，這裡是享運', '司機：王大明', '電話：0933-111-222', '車號：ABC-1234（Alphard）']) assert.ok(info.includes(s), s);
  assert.throws(() => driverInfoText(store, unpaid.id), /還沒指派/);
  const board = dispatchBoard(store, { from: T, to: addDays(T, 7) });
  assert.deepEqual(board.map((o) => o.id), [paid.id, unpaid.id]);
  assert.equal(board[0].driver_name, '王大明');
});

test('HTTP：LINE 傳派車單給司機、傳司機資訊給客人；司機不出現在關懷清單', async (t) => {
  const { store, a, paid } = setup();
  const pushes = [];
  const lines = { for: () => ({ enabled: true, async push(to, text) { pushes.push({ to, text }); } }) };
  const server = http.createServer(createApp({ store, lines, config, logger: silent }));
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const auth = { Authorization: `Basic ${Buffer.from('admin:pw').toString('base64')}`, 'Content-Type': 'application/json' };
  const call = async (p, method = 'GET', body) => { const r = await fetch(base + p, { method, headers: auth, body: body && JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };

  const driverLine = store.upsertLineCustomer(a.id, 'UDRIVER', { displayName: '大明' });
  const d = (await call('/api/drivers', 'POST', { name: '王大明', plate: 'ABC-1234', line_customer_id: driverLine.id })).data;
  assert.equal((await call(`/api/orders/${paid.id}/dispatch/driver`, 'POST', {})).status, 400, '還沒指派');
  assert.equal((await call(`/api/orders/${paid.id}/driver`, 'POST', { driver_id: d.id })).data.status, 'shipped');
  const info = (await call(`/api/orders/${paid.id}/dispatch`)).data;
  assert.equal(info.canPushDriver, true);
  assert.equal((await call(`/api/orders/${paid.id}/dispatch/driver`, 'POST', { text: info.text })).status, 200);
  assert.equal((await call(`/api/orders/${paid.id}/dispatch/customer`, 'POST', {})).status, 200);
  assert.deepEqual(pushes.map((p) => p.to), ['UDRIVER', 'U1']);
  assert.match(pushes[0].text, /派車單/);
  assert.match(pushes[1].text, /司機：王大明/);
  assert.ok(store.getOrder(paid.id).dispatched_at);
  const focus = (await call('/api/focus')).data;
  assert.ok(!focus.items.some((i) => i.customer.id === driverLine.id), '司機的 LINE 不當成客戶');
  const customers = (await call('/api/customers')).data;
  assert.equal(customers.find((c) => c.id === driverLine.id).is_driver, true);
  const board = (await call(`/api/dispatch?from=${T}&to=${addDays(T, 3)}`)).data;
  assert.equal(board.orders.length, 2);
});

test('客戶紀錄保留當時的司機與車輛；司機換車後舊訂單不變；可用車號搜尋', async () => {
  const { store, c, paid, unpaid } = setup();
  const { driverHistory } = await import('../src/dispatch.js');
  const { search } = await import('../src/search.js');
  const d = saveDriver(store, null, { name: '王大明', phone: '0933', plate: 'ABC-1234', car_model: 'Alphard' });
  assignDriver(store, paid.id, d.id);
  store.updateOrder(paid.id, { status: 'completed' });
  saveDriver(store, d.id, { plate: 'XYZ-9999', car_model: 'Previa' }); // 司機換車
  assignDriver(store, unpaid.id, d.id);

  const orders = store.listOrders({ customerId: c.id });
  const old = orders.find((o) => o.id === paid.id);
  assert.deepEqual([old.driver_name, old.driver_plate, old.driver_car, old.driver_phone], ['王大明', 'ABC-1234', 'Alphard', '0933']);
  assert.equal(orders.find((o) => o.id === unpaid.id).driver_plate, 'XYZ-9999');

  const hist = driverHistory(store, c.id);
  assert.deepEqual(hist.map((h) => [h.name, h.plate, h.trips]).sort(), [['王大明', 'ABC-1234', 1], ['王大明', 'XYZ-9999', 1]]);
  assert.deepEqual(search(store, config, { q: 'ABC-1234' }).orders.map((o) => o.id), [paid.id]);

  assignDriver(store, unpaid.id, null);
  assert.equal(store.getOrder(unpaid.id).driver_plate_snap, null, '取消指派會清掉');
  assert.equal(driverHistory(store, c.id).length, 1);
});

test('直接輸入司機與車輛：新司機自動加入名單、電話相同沿用；本趟換車不影響名單', () => {
  const { store, paid, unpaid } = setup();
  assert.throws(() => assignManualDriver(store, paid.id, { name: ' ' }), /姓名/);
  const o = assignManualDriver(store, paid.id, { name: '陳司機', phone: '0988-111-222', plate: 'RBC-5678', car_model: 'Alphard 白' });
  assert.equal(o.status, 'shipped');
  assert.equal(o.driver_plate_snap, 'RBC-5678');
  assert.equal(listDrivers(store).length, 1, '加入名單');
  // 同一支電話（格式不同）→ 沿用原本的司機，但本趟車號用新輸入的
  const o2 = assignManualDriver(store, unpaid.id, { name: '陳司機', phone: '0988111222', plate: 'XYZ-0001' });
  assert.equal(o2.driver_id, o.driver_id);
  assert.equal(listDrivers(store).length, 1);
  assert.equal(o2.driver_plate_snap, 'XYZ-0001');
  assert.equal(listDrivers(store)[0].plate, 'RBC-5678', '名單不被覆蓋');
  // 只改本趟
  setOrderDriverInfo(store, paid.id, { plate: 'TMP-9999', car_model: 'Granvia' });
  assert.match(dispatchText(store, paid.id), /陳司機｜TMP-9999/);
  assert.match(driverInfoText(store, paid.id), /車號：TMP-9999（Granvia）/);
  assert.match(driverInfoText(store, paid.id), /電話：0988-111-222/);
  assert.equal(listDrivers(store)[0].plate, 'RBC-5678');
  assert.throws(() => setOrderDriverInfo(store, store.createOrder(paid.customer_id, { order_date: T, amount: 1 }).id, { plate: 'A' }), /先指派/);
});
