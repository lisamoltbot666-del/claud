import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getConfig } from '../src/config.js';
import { addDays, today } from '../src/dates.js';
import { openDb } from '../src/db.js';
import { buildFocusList, formatFocusSummary } from '../src/focus.js';
import { buildRepurchaseList, customerStats, parseItems } from '../src/profile.js';

const config = getConfig({ TZ_NAME: 'Asia/Taipei' });
const T = today('Asia/Taipei');

test('parseItems：拆品項、去掉數量', () => {
  assert.deepEqual(parseItems('滴雞精 x10、禮盒*2, 豆漿 × 3盒'), ['滴雞精', '禮盒', '豆漿']);
  assert.deepEqual(parseItems(''), []);
});

test('customerStats：次數、消費、客單價、回購日、常買、分類', () => {
  const c = { id: 1 };
  const orders = [
    { id: 1, order_date: addDays(T, -50), status: 'completed', amount: 1000, items: '滴雞精 x10' },
    { id: 2, order_date: addDays(T, -30), status: 'completed', amount: 2000, items: '滴雞精 x20、禮盒' },
    { id: 3, order_date: addDays(T, -10), status: 'cancelled', amount: 9999, items: '取消的' },
    { id: 4, order_date: addDays(T, -10), status: 'pending_payment', amount: 500, items: '禮盒' },
  ];
  const st = customerStats(c, orders, config, T);
  assert.equal(st.orderCount, 3);
  assert.equal(st.paidCount, 2);
  assert.equal(st.totalSpent, 3000);
  assert.equal(st.avgOrder, 1500);
  assert.equal(st.pendingAmount, 500);
  assert.equal(st.firstOrderDate, addDays(T, -50));
  assert.equal(st.lastOrderDate, addDays(T, -10));
  assert.equal(st.lastItems, '禮盒');
  assert.equal(st.cycle.days, 20);
  assert.equal(st.nextReorderDate, addDays(T, 10));
  assert.equal(st.daysUntilReorder, 10);
  assert.deepEqual(st.topItems.map((i) => i.name), ['滴雞精', '禮盒']);
  assert.equal(st.segment, 'repeat');

  assert.equal(customerStats(c, [], config, T).segment, 'none');
  assert.equal(customerStats(c, [orders[0]], config, T).segment, 'first');
  assert.equal(customerStats(c, [{ id: 9, order_date: addDays(T, -200), status: 'completed', amount: 1 }], config, T).segment, 'dormant');
});

test('回購名單篩選、關懷清單附消費紀錄、生日', () => {
  const store = openDb(':memory:');
  const due = store.upsertLineCustomer('A', { displayName: '到期' });
  store.createOrder(due.id, { order_date: addDays(T, -40), status: 'completed', amount: 800, items: '豆漿' });
  const soon = store.upsertLineCustomer('B', { displayName: '快到' });
  store.createOrder(soon.id, { order_date: addDays(T, -25), status: 'completed', amount: 800 });
  const later = store.upsertLineCustomer('C', { displayName: '還早' });
  store.createOrder(later.id, { order_date: addDays(T, -1), status: 'completed', amount: 800 });
  store.upsertLineCustomer('D', { displayName: '沒買過' });

  const names = (filter) => buildRepurchaseList(store, config, { filter }).rows.map((r) => r.customer.display_name);
  assert.deepEqual(names('due'), ['到期']);
  assert.deepEqual(names('soon'), ['快到']);
  assert.deepEqual(names('all'), ['到期', '快到', '還早']);

  const focus = buildFocusList(store, config);
  const item = focus.items.find((i) => i.customer.id === due.id);
  assert.equal(item.stats.totalSpent, 800);
  assert.match(item.reasons[0].detail, /上次買：豆漿/);
  assert.match(formatFocusSummary(focus, { shopName: 'X' }), /到期：該回購了（購買 1 次，累積 NT\$800，上次：豆漿）/);

  store.updateCustomer(later.id, { birthday: `1990-${T.slice(5)}` });
  assert.ok(buildFocusList(store, config).items.find((i) => i.customer.id === later.id).reasons.some((r) => r.code === 'birthday'));
});
