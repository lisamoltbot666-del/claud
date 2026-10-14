import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { findDuplicates, mergeCustomers } from '../src/merge.js';

function setup() {
  const store = openDb(':memory:');
  const a = store.createBrand({ slug: 'a', name: '享運' });
  const b = store.createBrand({ slug: 'b', name: '首席' });
  // 先從舊系統匯入（沒有 LINE），後來客人在 LINE 傳訊息（有 LINE、只有暱稱）
  const imported = store.createCustomer(a.id, { display_name: '王小美', real_name: '王小美', phone: '0912-345-678', tags: 'VIP', note: '舊系統備註' });
  const line = store.updateCustomer(store.upsertLineCustomer(a.id, 'U1', { displayName: '小美', pictureUrl: 'https://p/1.png' }).id, { phone: '+886912345678', tags: '團購', note: 'LINE 備註' });
  store.createOrder(imported.id, { order_date: '2026-01-01', amount: 1000, status: 'completed' });
  store.createOrder(imported.id, { order_date: '2026-03-01', amount: 1500, status: 'completed' });
  store.createOrder(line.id, { order_date: '2026-10-01', amount: 800, status: 'paid' });
  store.addMessage(line.id, 'in', '你好');
  store.logReminder({ customerId: imported.id, kind: 'reorder', text: 'x' });
  return { store, a, b, imported, line };
}

test('找出可能重複的客戶：電話相同（不同寫法）、同品牌才算', () => {
  const { store, a, b, imported, line } = setup();
  store.createCustomer(b.id, { display_name: '王小美', phone: '0912345678' }); // 別的品牌，不算
  const groups = findDuplicates(store, { brandId: a.id });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map((c) => c.id), [line.id, imported.id], 'LINE 好友排第一（建議保留）');
  assert.deepEqual(findDuplicates(store, { customerId: imported.id })[0].map((c) => c.id).sort(), [imported.id, line.id].sort());
  assert.equal(findDuplicates(store).length, 1, '不分品牌查詢時也不會跨品牌配對');
});

test('合併：訂單、對話、提醒搬過來，空白欄位補上，標籤和備註合併，LINE 連結保留', () => {
  const { store, imported, line } = setup();
  store.setStaff(imported.id, true);
  const merged = mergeCustomers(store, imported.id, line.id); // 保留匯入那筆，把 LINE 那筆併進來
  assert.equal(store.getCustomer(line.id), undefined);
  assert.equal(merged.line_user_id, 'U1', 'LINE userId 移過來，之後 LINE 訊息會進到這筆');
  assert.equal(merged.is_friend, 1);
  assert.equal(merged.picture_url, 'https://p/1.png');
  assert.equal(merged.real_name, '王小美');
  assert.equal(merged.display_name, '王小美', '已有的不覆蓋');
  assert.equal(merged.tags, 'VIP,團購');
  assert.equal(merged.note, '舊系統備註\nLINE 備註');
  assert.equal(store.listOrders({ customerId: imported.id }).length, 3);
  assert.equal(store.listMessages(imported.id).length, 1);
  assert.ok(merged.last_inbound_at);
  assert.equal(store.listReminders(imported.id).length, 1);
  assert.deepEqual(store.staffIds(), [imported.id]);
  // 之後 LINE 傳來的訊息會對應到合併後的這筆
  assert.equal(store.getCustomerByLineId(merged.brand_id, 'U1').id, imported.id);
  assert.equal(findDuplicates(store).length, 0);
});

test('不能合併：自己、不同品牌、兩個不同 LINE 帳號', () => {
  const { store, a, b, imported, line } = setup();
  assert.throws(() => mergeCustomers(store, imported.id, imported.id), /自己/);
  const other = store.createCustomer(b.id, { display_name: 'x' });
  assert.throws(() => mergeCustomers(store, imported.id, other.id), /不同品牌/);
  const line2 = store.upsertLineCustomer(a.id, 'U2', { displayName: '另一人' });
  assert.throws(() => mergeCustomers(store, line.id, line2.id), /不同的 LINE/);
  assert.equal(store.listOrders({ customerId: imported.id }).length, 2, '失敗時不動資料');
});
