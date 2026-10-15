import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { getConfig } from '../src/config.js';
import { addDays, today } from '../src/dates.js';
import { openDb } from '../src/db.js';
import { dispatchText } from '../src/dispatch.js';
import { buildFocusList } from '../src/focus.js';
import { addPayment, balanceOf, deletePayment, listPayments } from '../src/payments.js';
import { brandInfo, templates } from '../src/reminders.js';
import { buildReport } from '../src/report.js';
import { createApp } from '../src/server.js';

const config = getConfig({ TZ_NAME: 'Asia/Taipei', ADMIN_PASSWORD: 'pw', BASIC_AUTH: 'true' });
const T = today('Asia/Taipei');
const silent = { log() {}, warn() {}, error() {} };

function setup() {
  const store = openDb(':memory:');
  const b = store.createBrand({ slug: 'l', name: '璐米' });
  const c = store.updateCustomer(store.upsertLineCustomer(b.id, 'U1', { displayName: '定緯' }).id, { real_name: '林定緯' });
  const o = store.createOrder(c.id, { order_date: T, service_date: addDays(T, 20), service_type: 'airport', amount: 1100, payment_due_date: addDays(T, -1) });
  return { store, b, c, o };
}

test('訂金、尾款分開記：已收／尾款、收齊自動變已付款、刪除後改回待付款', () => {
  const { store, o } = setup();
  assert.throws(() => addPayment(store, config, o.id, { amount: 0 }), /金額/);
  assert.throws(() => addPayment(store, config, o.id, { amount: 100, method: 'bitcoin' }), /方式/);
  let after = addPayment(store, config, o.id, { amount: 300, method: 'transfer', note: '末五碼 35751' }, '小艾');
  assert.equal(after.status, 'pending_payment');
  assert.equal(after.paid_amount, 300);
  assert.deepEqual(balanceOf(after), { paid: 300, due: 800, recorded: 300 });
  assert.equal(listPayments(store, o.id)[0].kind, 'deposit', '第一筆預設訂金');
  assert.equal(listPayments(store, o.id)[0].created_by, '小艾');

  // 派車單、匯款提醒、關懷清單都改看尾款
  assert.match(dispatchText(store, o.id), /已收訂金 NT\$300，尾款 NT\$800 請現場收款/);
  const c = store.getCustomer(o.customer_id);
  assert.match(templates.payment(c, store.getOrder(o.id), brandInfo(store.getBrand(c.brand_id), config)), /已收到訂金 NT\$300，尾款 NT\$800/);
  const reason = buildFocusList(store, config).items[0].reasons.find((r) => r.code === 'payment_overdue');
  assert.match(reason.detail, /尾款 NT\$800（已收 NT\$300）/);

  after = addPayment(store, config, o.id, { amount: 800, method: 'cash_driver' });
  assert.equal(listPayments(store, o.id)[1].kind, 'balance', '之後預設尾款');
  assert.equal(after.status, 'paid', '收齊自動變已付款');
  assert.ok(after.paid_at);
  const { order } = deletePayment(store, listPayments(store, o.id)[1].id);
  assert.equal(order.status, 'pending_payment', '不足額改回待付款');
  store.updateOrder(o.id, { status: 'cancelled' });
  assert.throws(() => addPayment(store, config, o.id, { amount: 100 }), /取消/);
});

test('報表：已收款含訂金；待收款扣掉訂金；沒有收款紀錄的已付款訂單視為收齊', () => {
  const { store, c, o } = setup();
  addPayment(store, config, o.id, { amount: 300 });
  store.createOrder(c.id, { order_date: T, service_date: addDays(T, 21), amount: 2000, status: 'paid' });
  const r = buildReport(store, { from: T, to: addDays(T, 40), basis: 'service' });
  assert.equal(r.totals.collected, 2300);
  assert.equal(r.totals.receivable, 800);
  assert.equal(r.totals.revenue, 2000, '營業額仍以已付款訂單計');
  assert.equal(r.byBrand[0].receivable, 800);
});

test('API：查看、新增、刪除收款紀錄；CSV 有已收／未收', async () => {
  const { store, o } = setup();
  const server = http.createServer(createApp({ store, config, logger: silent }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { Authorization: `Basic ${Buffer.from('admin:pw').toString('base64')}`, 'Content-Type': 'application/json' };
  const call = async (p, method = 'GET', body) => { const r = await fetch(base + p, { method, headers: auth, body: body && JSON.stringify(body) }); return { status: r.status, data: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }; };
  try {
    assert.equal((await call(`/api/orders/${o.id}/payments`, 'POST', { amount: 'abc' })).status, 400);
    const r = (await call(`/api/orders/${o.id}/payments`, 'POST', { amount: 300, method: 'transfer', paid_on: T })).data;
    assert.equal(r.order.paid_amount, 300);
    assert.equal(r.payments.length, 1);
    assert.equal((await call(`/api/orders/${o.id}/payments`)).data.payments[0].amount, 300);
    assert.equal((await call('/api/orders')).data[0].paid_amount, 300);
    assert.ok((await call('/api/status')).data.paymentMethods.cash_driver);
    const csv = (await call('/api/export/orders.csv')).data;
    assert.match(csv, /"已收","未收"/);
    assert.match(csv, /"1100","300","800"/);
    assert.equal((await call(`/api/payments/${r.payments[0].id}`, 'DELETE')).data.payments.length, 0);
    assert.match(store.listActivity()[0].action, /刪除收款/);
  } finally {
    server.close();
  }
});

test('取消保留訂金：計入營業額、已收款、目標；退款後不計；已取消只能記退款或取消費', async () => {
  const { store, b, o } = setup();
  addPayment(store, config, o.id, { amount: 300 });
  store.updateOrder(o.id, { status: 'cancelled' });
  assert.equal(balanceOf(store.getOrder(o.id)).retained, 300);
  assert.throws(() => addPayment(store, config, o.id, { amount: 100, kind: 'balance' }), /退款.*取消費/);
  assert.throws(() => addPayment(store, config, o.id, { amount: 500, kind: 'refund' }), /不能超過/);
  const range = { from: T, to: addDays(T, 40) };
  let r = buildReport(store, range);
  assert.equal(r.totals.orders, 0);
  assert.equal(r.totals.cancelled, 1);
  assert.equal(r.totals.cancel_retained, 300);
  assert.equal(r.totals.revenue, 300, '保留的訂金算營業額');
  assert.equal(r.totals.collected, 300);
  assert.equal(r.totals.receivable, 0);
  assert.equal(r.byBrand[0].revenue, 300);
  assert.equal(r.series.reduce((a, x) => a + x.revenue, 0), 300);
  const { buildTargets, setTarget } = await import('../src/targets.js');
  setTarget(store, { brandId: b.id, month: o.service_date.slice(0, 7), amount: 10000 });
  assert.equal(buildTargets(store, config, { month: o.service_date.slice(0, 7) }).brands[0].achieved, 300);

  // 另外收取消費、或退款
  addPayment(store, config, o.id, { amount: 200, kind: 'cancel_fee' });
  assert.equal(buildReport(store, range).totals.revenue, 500);
  const after = addPayment(store, config, o.id, { amount: 500, kind: 'refund' });
  assert.equal(after.paid_amount, 0);
  assert.equal(listPayments(store, o.id).at(-1).amount, -500, '退款存成負數');
  r = buildReport(store, range);
  assert.equal(r.totals.revenue, 0);
  assert.equal(r.totals.cancel_retained, 0);
});
