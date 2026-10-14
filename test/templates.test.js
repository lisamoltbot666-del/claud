import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getConfig } from '../src/config.js';
import { addDays, today } from '../src/dates.js';
import { openDb } from '../src/db.js';
import { listTemplates, renderTemplate, saveTemplate, seedTemplates } from '../src/templates.js';

const config = getConfig({ TZ_NAME: 'Asia/Taipei' });
const T = today('Asia/Taipei');

function setup() {
  const store = openDb(':memory:');
  const a = store.createBrand({ slug: 'a', name: '享運', bank_info: '台銀 004-123' });
  const b = store.createBrand({ slug: 'b', name: '首席' });
  const c = store.updateCustomer(store.upsertLineCustomer(a.id, 'U1', { displayName: '小美' }).id, { real_name: '王小美', phone: '0912' });
  return { store, a, b, c };
}

test('預設範本只建立一次；刪光後重啟不會再長回來', () => {
  const { store } = setup();
  seedTemplates(store);
  assert.equal(listTemplates(store).length, 3);
  seedTemplates(store);
  assert.equal(listTemplates(store).length, 3);
  store.run('DELETE FROM reply_templates');
  seedTemplates(store);
  assert.equal(listTemplates(store).length, 0);
});

test('依品牌列出：該品牌的＋共用的', () => {
  const { store, a, b } = setup();
  saveTemplate(store, null, { title: '共用', body: 'x' }, '小艾');
  saveTemplate(store, null, { title: '享運專用', body: 'y', brand_id: a.id }, '小艾');
  saveTemplate(store, null, { title: '首席專用', body: 'z', brand_id: b.id }, '小艾');
  assert.deepEqual(listTemplates(store, { brandId: a.id }).map((t) => t.title), ['享運專用', '共用']);
  assert.equal(listTemplates(store).length, 3);
  assert.throws(() => saveTemplate(store, null, { title: '', body: 'x' }), /名稱/);
  assert.throws(() => saveTemplate(store, null, { title: 'x', body: ' ' }), /內容/);
  assert.throws(() => saveTemplate(store, 999, { title: 'x', body: 'y' }), /找不到/);
});

test('套用範本：帶入客戶、品牌、即將到來的行程；缺的欄位會提示', () => {
  const { store, a, b, c } = setup();
  store.createOrder(c.id, { order_date: addDays(T, -30), service_date: addDays(T, -20), amount: 999, status: 'completed' });
  const next = store.createOrder(c.id, { order_date: T, service_date: addDays(T, 3), service_time: '06:30', service_type: 'airport', flight_no: 'BR198', pickup: '信義區', dropoff: 'T2', amount: 1200, payment_due_date: addDays(T, 1) });
  const tpl = saveTemplate(store, null, { title: '確認', body: '{姓名}（{LINE名稱}）您好，{品牌} 已預約 {用車日} {時間} {服務} {訂單編號}：{上車地點}→{目的地} ✈{航班}，{金額}，請於 {匯款期限} 前匯款到 {匯款資訊}。{不存在}' }, 'x');
  const r = renderTemplate(store, config, { templateId: tpl.id, customerId: c.id });
  assert.equal(r.orderId, next.id, '預設用即將到來的行程');
  assert.match(r.text, /^王小美（小美）您好，享運 已預約 \d+\/\d+（.） 06:30 機場接送 #\d+：信義區→T2 ✈BR198，NT\$1,200，請於 \d+\/\d+（.） 前匯款到 台銀 004-123。\{不存在\}$/);
  assert.deepEqual(r.missing, []);

  // 指定舊訂單：沒有的欄位列在 missing
  const old = store.listOrders({ customerId: c.id }).find((o) => o.amount === 999);
  const r2 = renderTemplate(store, config, { templateId: tpl.id, customerId: c.id, orderId: old.id });
  assert.ok(r2.missing.includes('航班'));
  assert.match(r2.text, /NT\$999/);

  // 其他品牌的專用範本不能套用
  const other = saveTemplate(store, null, { title: 'b', body: 'x', brand_id: b.id }, 'x');
  assert.throws(() => renderTemplate(store, config, { templateId: other.id, customerId: c.id }), /其他品牌/);
  assert.equal(a.id, c.brand_id);
});
