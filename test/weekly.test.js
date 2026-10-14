import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { getConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { ReminderService } from '../src/reminders.js';
import { createApp } from '../src/server.js';
import { buildWeekly, weekRange } from '../src/weekly.js';

const config = getConfig({ TZ_NAME: 'Asia/Taipei', ADMIN_PASSWORD: 'pw', BASIC_AUTH: 'true' });
const NOW = new Date('2026-10-14T04:00:00Z'); // 台灣 10/14（三）中午
const silent = { log() {}, warn() {}, error() {} };

function setup() {
  const store = openDb(':memory:');
  const a = store.createBrand({ slug: 'a', name: '享運', channel_access_token: 'tok' });
  const b = store.createBrand({ slug: 'b', name: '首席', channel_access_token: 'tok' });
  const c = store.createCustomer(a.id, { display_name: '小美' });
  const o = (date, amount, status, extra = {}) => store.createOrder(c.id, { order_date: date, service_date: date, amount, status, ...extra });
  o('2026-09-29', 10000, 'completed'); // 前一週
  o('2026-10-06', 4000, 'completed'); // 上週
  o('2026-10-13', 2000, 'paid'); // 本週，還沒派司機
  o('2026-10-20', 3000, 'pending_payment', { payment_due_date: '2026-10-01' }); // 逾期未付款
  const boss = store.upsertLineCustomer(b.id, 'UBOSS', { displayName: '老闆' });
  const line = { pushes: [], async push(to, text) { this.pushes.push({ to, text }); return {}; } };
  const lines = { for: () => line };
  return { store, a, b, c, boss, line, lines };
}

test('週期：上週一到週日、前一週、本週', () => {
  assert.deepEqual(weekRange('Asia/Taipei', NOW), { weekKey: '2026-10-12', from: '2026-10-05', to: '2026-10-11', prevFrom: '2026-09-28', prevTo: '2026-10-04', nextFrom: '2026-10-12', nextTo: '2026-10-18' });
  // 星期一當天、星期日當天
  assert.equal(weekRange('Asia/Taipei', new Date('2026-10-12T01:00:00Z')).from, '2026-10-05');
  assert.equal(weekRange('Asia/Taipei', new Date('2026-10-18T15:00:00Z')).weekKey, '2026-10-12');
});

test('週報：和前一週比較、各品牌、營運建議', () => {
  const { store, a } = setup();
  const w = buildWeekly(store, config, { now: NOW });
  assert.equal(w.totals.revenue, 4000);
  assert.equal(w.prevTotals.revenue, 10000);
  assert.equal(w.brands.find((x) => x.brand_id === a.id).prevRevenue, 10000);
  assert.equal(w.upcoming.no_driver, 1);
  assert.equal(w.overdue.n, 1);
  const s = w.suggestions.join('\n');
  assert.match(s, /營業額比前一週少 60%/);
  assert.match(s, /享運 營業額下滑 60%/);
  assert.match(s, /1 筆訂單已過匯款期限（共 NT\$3,000）/);
  assert.match(s, /本週有 1 趟行程還沒派司機/);
  for (const t of ['上週營運週報（10/5–10/11）', '營業額 NT$4,000（▼60%）', '・享運 NT$4,000（▼60%）', '💡 營運建議：', '1. ']) assert.ok(w.text.includes(t), t);
  assert.ok(!w.text.includes('・首席'), '沒有數字的品牌不列');
  // 只看單一品牌
  const only = buildWeekly(store, config, { now: NOW, brandIds: [store.listBrands()[1].id] });
  assert.equal(only.totals.revenue, 0);
  assert.match(only.suggestions[0], /沒有訂單也沒有新詢問/);
});

test('週報接收人：只推給設定的人，且不列入客戶分析', async () => {
  const { store, boss, line, lines } = setup();
  const svc = new ReminderService({ store, lines, config, logger: silent });
  assert.equal((await svc.sendWeekly(NOW)).sent, 0);
  store.setWeekly(boss.id, true);
  assert.ok(store.internalIds().has(boss.id));
  const r = await svc.sendWeekly(NOW);
  assert.equal(r.sent, 1);
  assert.equal(line.pushes[0].to, 'UBOSS');
  assert.match(line.pushes[0].text, /上週營運週報/);
  store.setWeekly(boss.id, false);
  assert.equal(svc.weeklyTargets().length, 0);
});

test('API：查看週報、設定接收人、手動推播（限管理員）', async () => {
  const { store, c, boss, lines, line } = setup();
  const server = http.createServer(createApp({ store, lines, config, logger: silent }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { Authorization: `Basic ${Buffer.from('admin:pw').toString('base64')}`, 'Content-Type': 'application/json' };
  const call = async (p, method = 'GET', body) => { const r = await fetch(base + p, { method, headers: auth, body: body && JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
  try {
    const w = await call('/api/weekly');
    assert.equal(w.status, 200);
    assert.ok(w.data.text.includes('營運建議'));
    assert.deepEqual(w.data.recipients, []);
    assert.equal((await call('/api/weekly/send', 'POST')).status, 400, '沒有接收人');
    assert.equal((await call(`/api/customers/${c.id}/weekly`, 'POST', { weekly: true })).status, 400, '非 LINE 好友不能設');
    assert.equal((await call(`/api/customers/${boss.id}/weekly`, 'POST', { weekly: true })).status, 200);
    assert.equal((await call(`/api/customers/${boss.id}`)).data.customer.is_weekly, true);
    assert.equal((await call('/api/weekly')).data.recipients[0].id, boss.id);
    assert.equal((await call('/api/weekly/send', 'POST')).data.sent, 1);
    assert.equal(line.pushes.length, 1);
    const push = line.push;
    line.push = async () => { throw new Error('LINE 額度已用完'); };
    const fail = await call('/api/weekly/send', 'POST');
    assert.equal(fail.status, 502);
    assert.match(fail.data.error, /LINE 額度已用完/);
    line.push = push;
    // 客服帳號不能看週報
    assert.equal((await call('/api/users', 'POST', { username: 'amy', display_name: 'Amy', password: 'password1' })).status, 200);
    const r = await fetch(`${base}/api/weekly`, { headers: { Authorization: `Basic ${Buffer.from('amy:password1').toString('base64')}` } });
    assert.equal(r.status, 403);
  } finally {
    server.close();
  }
});
