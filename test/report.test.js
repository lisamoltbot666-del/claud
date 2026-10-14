import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { buildReport } from '../src/report.js';

function setup() {
  const store = openDb(':memory:');
  const a = store.createBrand({ slug: 'a', name: '享運' });
  const b = store.createBrand({ slug: 'b', name: '首席' });
  const old = store.createCustomer(a.id, { display_name: '老客' });
  const fresh = store.createCustomer(a.id, { display_name: '新客' });
  const other = store.createCustomer(b.id, { display_name: '首席客' });
  const o = (c, date, amount, status, service_type = 'airport') => store.createOrder(c.id, { order_date: date, service_date: date, amount, status, service_type });
  o(old, '2026-08-10', 1000, 'completed');              // 期間前的訂單 → 老客算回頭客
  o(old, '2026-10-05', 1200, 'completed');
  o(old, '2026-10-20', 800, 'pending_payment');          // 待收款
  o(fresh, '2026-10-07', 3000, 'shipped', 'charter');
  o(fresh, '2026-10-08', 500, 'cancelled');              // 取消不計
  o(other, '2026-10-09', 2000, 'paid');
  store.createOrder(other.id, { order_date: '2026-10-11', amount: 700, status: 'paid' }); // 沒有用車日 → 用下單日
  return { store, a, b, old, fresh };
}

test('期間統計：營業額、待收款、取消、客單價、回頭客', () => {
  const { store } = setup();
  const r = buildReport(store, { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(r.totals.revenue, 1200 + 3000 + 2000 + 700);
  assert.equal(r.totals.paid_orders, 4);
  assert.equal(r.totals.receivable, 800);
  assert.equal(r.totals.orders, 5);
  assert.equal(r.totals.cancelled, 1);
  assert.equal(r.totals.avg_order, Math.round(6900 / 4));
  assert.equal(r.totals.customers, 3);
  assert.equal(r.totals.repeat_customers, 1);
  assert.equal(r.totals.new_customers, 2);
  assert.equal(Math.round(r.totals.repeat_rate * 100), 33);
});

test('品牌篩選、各品牌、各服務、前幾名', () => {
  const { store, a, b, fresh } = setup();
  const r = buildReport(store, { from: '2026-10-01', to: '2026-10-31', brandId: a.id });
  assert.equal(r.totals.revenue, 4200);
  assert.deepEqual(r.byBrand.map((x) => x.brand_id), [a.id]);
  const all = buildReport(store, { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(all.byBrand.map((x) => [x.brand_id, x.revenue, x.repeat_customers]), [[a.id, 4200, 1], [b.id, 2700, 0]]);
  assert.deepEqual(all.byService.map((s) => [s.label, s.revenue]), [['機場接送', 3200], ['包車', 3000], ['未分類', 700]], '沒填服務類型的歸在未分類');
  assert.equal(all.topCustomers[0].customer_id, fresh.id);
});

test('近 12 個月：月份連續、跨年、沒有資料的月份為 0；日期反向會自動對調', () => {
  const { store } = setup();
  const r = buildReport(store, { from: '2026-10-31', to: '2026-10-01' });
  assert.equal(r.from, '2026-10-01');
  assert.equal(r.monthly.length, 12);
  assert.equal(r.monthly[0].month, '2025-11');
  assert.equal(r.monthly.at(-1).month, '2026-10');
  assert.equal(r.monthly.find((m) => m.month === '2026-08').revenue, 1000);
  assert.equal(r.monthly.find((m) => m.month === '2026-09').revenue, 0);
  assert.equal(r.monthly.at(-1).revenue, 6900);
  assert.throws(() => buildReport(store, { from: 'x', to: '2026-10-01' }), /日期/);
});
