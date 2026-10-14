import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { search } from '../src/search.js';

const config = getConfig({ TZ_NAME: 'Asia/Taipei' });

function setup() {
  const store = openDb(':memory:');
  const a = store.createBrand({ slug: 'a', name: '享運' });
  const b = store.createBrand({ slug: 'b', name: '首席' });
  const mei = store.updateCustomer(store.upsertLineCustomer(a.id, 'U1', { displayName: '小美' }).id, { real_name: '王小美', phone: '0912-345-678', tags: 'VIP', note: '喜歡安靜' });
  const chen = store.updateCustomer(store.createCustomer(b.id, { display_name: '陳先生' }).id, { phone: '+886 922 000 111' });
  const o1 = store.createOrder(mei.id, { order_date: '2026-10-01', service_date: '2026-10-20', service_time: '06:30', flight_no: 'BR198', pickup: '信義區松仁路', dropoff: '桃園機場T2', amount: 1200, status: 'paid' });
  const o2 = store.createOrder(chen.id, { order_date: '2026-10-02', service_date: '2026-10-21', pickup: '台北車站', dropoff: '九份', items: '九人座', amount: 6000, status: 'paid' });
  store.createOrder(chen.id, { order_date: '2026-09-01', service_date: '2026-09-05', pickup: '板橋', amount: 800, status: 'completed' });
  store.addMessage(mei.id, 'in', '請問 10/20 可以改成 7 點嗎');
  return { store, a, b, mei, chen, o1, o2 };
}

test('搜尋客戶：姓名、LINE 名稱、標籤、備註；電話不論寫法', () => {
  const { store, mei, chen } = setup();
  assert.deepEqual(search(store, config, { q: '小美' }).customers.map((c) => c.id), [mei.id]);
  assert.deepEqual(search(store, config, { q: 'vip' }).customers.map((c) => c.id), [mei.id]);
  assert.deepEqual(search(store, config, { q: '安靜' }).customers.map((c) => c.id), [mei.id]);
  assert.deepEqual(search(store, config, { q: '0912345678' }).customers.map((c) => c.id), [mei.id]);
  assert.deepEqual(search(store, config, { q: '0922-000-111' }).customers.map((c) => c.id), [chen.id], '+886 與 0 開頭視為相同');
  assert.deepEqual(search(store, config, { q: '345' }).customers.map((c) => c.id), [mei.id]);
});

test('搜尋訂單：航班、地點、車型、訂單號、客戶電話；日期範圍', () => {
  const { store, o1, o2 } = setup();
  assert.deepEqual(search(store, config, { q: 'br198' }).orders.map((o) => o.id), [o1.id]);
  assert.deepEqual(search(store, config, { q: '九份' }).orders.map((o) => o.id), [o2.id]);
  assert.deepEqual(search(store, config, { q: '九人座' }).orders.map((o) => o.id), [o2.id]);
  assert.deepEqual(search(store, config, { q: `#${o2.id}` }).orders.map((o) => o.id), [o2.id]);
  assert.equal(search(store, config, { q: '0922000111' }).orders.length, 2, '用電話找到該客戶所有訂單');
  // 只給日期：當天的所有行程，依時間排序
  assert.deepEqual(search(store, config, { from: '2026-10-20' }).orders.map((o) => o.id), [o1.id]);
  assert.deepEqual(search(store, config, { from: '2026-10-20', to: '2026-10-31' }).orders.map((o) => o.id), [o1.id, o2.id]);
  // 關鍵字＋日期
  assert.equal(search(store, config, { q: '陳先生', from: '2026-09-01', to: '2026-09-30' }).orders.length, 1);
});

test('搜尋對話、品牌篩選、空白查詢、特殊字元', () => {
  const { store, a, b } = setup();
  assert.equal(search(store, config, { q: '改成' }).messages.length, 1);
  assert.equal(search(store, config, { q: '改成', from: '2020-01-01' }).messages.length, 0, '日期範圍外');
  assert.equal(search(store, config, { q: '小美', brandId: b.id }).customers.length, 0);
  assert.equal(search(store, config, { q: '小美', brandId: a.id }).customers.length, 1);
  assert.deepEqual(search(store, config, {}), { q: '', from: '', to: '', customers: [], orders: [], messages: [] });
  assert.equal(search(store, config, { q: '%' }).customers.length, 0, '% 不當萬用字元');
  assert.equal(search(store, config, { q: "'; DROP TABLE customers; --" }).customers.length, 0);
  assert.equal(store.listCustomers().length, 2);
});
