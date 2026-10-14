import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { getConfig } from '../src/config.js';
import { addDays, today } from '../src/dates.js';
import { openDb } from '../src/db.js';
import { buildFocusList } from '../src/focus.js';
import { guessMapping, mapServiceType, mapStatus, parseCsv, parseDateTime, parseTime, runImport } from '../src/importer.js';
import { createApp } from '../src/server.js';

const config = getConfig({ TZ_NAME: 'Asia/Taipei', ADMIN_PASSWORD: 'pw' });
const T = today('Asia/Taipei');
const silent = { log() {}, warn() {}, error() {} };

function setup() {
  const store = openDb(':memory:');
  const shouxi = store.createBrand({ slug: 'shouxi', name: '首席' });
  const xy = store.createBrand({ slug: 'xiangyun', name: '享運' });
  return { store, shouxi, xy };
}

test('CSV 解析：BOM、引號、逗號、換行、Tab', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi""\nok"\n\n'), [['a', 'b'], ['x, y', 'say "hi"\nok']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
});

test('日期、時間、服務類型、狀態的各種寫法', () => {
  assert.deepEqual(parseDateTime('2026-07-10 06:30'), { date: '2026-07-10', time: '06:30' });
  assert.deepEqual(parseDateTime('2026/7/3'), { date: '2026-07-03', time: null });
  assert.deepEqual(parseDateTime('115/03/05 下午 2:15'), { date: '2026-03-05', time: '14:15' });
  assert.deepEqual(parseDateTime('4/17/2026 10:00pm'), { date: '2026-04-17', time: '22:00' });
  assert.deepEqual(parseDateTime('2026-04-17T01:30:00.000Z'), { date: '2026-04-17', time: '09:30' });
  assert.equal(parseDateTime('明天'), null);
  assert.equal(parseTime('上午 12:05'), '00:05');
  assert.equal(mapServiceType('p2p'), 'airport');
  assert.equal(mapServiceType('包車旅遊'), 'charter');
  assert.equal(mapServiceType('自駕租車'), 'rental');
  assert.equal(mapStatus('cancelled', '', '2020-01-01', T), 'cancelled');
  assert.equal(mapStatus('new', '', '2020-01-01', T), 'completed', '過去的單視為完成');
  assert.equal(mapStatus('confirmed', 'paid', addDays(T, 3), T), 'paid');
  assert.equal(mapStatus('待確認', '未付', addDays(T, 3), T), 'pending_payment');
  assert.equal(mapStatus('confirmed', 'unpaid', addDays(T, 3), T), 'pending_payment');
  assert.equal(mapStatus('確認', '部分付', addDays(T, 3), T), 'pending_payment');
});

test('首席後台匯出的 CSV：自動對應欄位、建立客戶與訂單、不觸發催款、重複匯入不重建', () => {
  const { store, shouxi } = setup();
  // 首席 admin.html「匯出全部訂單 CSV」的欄位
  const csv = [
    'id,created_at,status,mode,duration,name,phone,line_id,from_addr,to_addr,depart_at,car_type_name,stops,stops_json,quote_total,payment_status,paid_at,invoice_no,driver_name,plate,note,internal_notes',
    `"101","2026-03-01 10:00:00","done","airport","","陳先生","0912-345-678","","台北市大安區","桃園機場T2","2026-03-05 06:30","五人座","0","","1500","paid","","","","","",""`,
    `"102","2026-05-01 10:00:00","done","charter","8","陳先生","+886 912 345 678","","台北車站","九份","2026-05-10 09:00","九人座","0","","6000","paid","","","","","",""`,
    `"103","${T} 09:00:00","new","p2p","","林小姐","0922000111","","板橋","台中","${addDays(T, 5)} 14:00","七人座","0","","3200","unpaid","","","","","",""`,
    `"104","2026-01-01 10:00:00","cancelled","airport","","林小姐","0922000111","","桃園機場","板橋","2026-01-05 22:00","五人座","0","","1300","","","","","","",""`,
  ].join('\n');
  const preview = runImport(store, config, { csv, brandId: shouxi.id, dryRun: true });
  assert.equal(preview.mapping.real_name, 'name');
  assert.equal(preview.mapping.service_date, 'depart_at');
  assert.equal(preview.mapping.amount, 'quote_total');
  assert.equal(preview.mapping.external_id, 'id');
  assert.deepEqual(preview.stats, { rows: 4, customersCreated: 2, customersMatched: 0, ordersCreated: 4, ordersSkipped: 0, errors: [] });
  assert.equal(store.listCustomers().length, 0, '預覽不寫入');

  runImport(store, config, { csv, brandId: shouxi.id, dryRun: false });
  const customers = store.listCustomers({ brandId: shouxi.id });
  assert.equal(customers.length, 2, '電話寫法不同仍視為同一人');
  const chen = customers.find((c) => c.real_name === '陳先生');
  const orders = store.listOrders({ customerId: chen.id });
  assert.equal(orders.length, 2);
  const o = orders.find((x) => x.service_date === '2026-03-05');
  assert.equal(o.service_time, '06:30');
  assert.equal(o.service_type, 'airport');
  assert.equal(o.pickup, '台北市大安區');
  assert.equal(o.amount, 1500);
  assert.equal(o.status, 'completed');
  assert.equal(o.items, '五人座');
  const future = store.listOrders({ brandId: shouxi.id }).find((x) => x.amount === 3200);
  assert.equal(future.status, 'pending_payment');
  assert.equal(future.payment_due_date, null, '匯入的單不設匯款期限');
  assert.equal(store.listOrders({ brandId: shouxi.id }).find((x) => x.amount === 1300).status, 'cancelled');

  // 關懷清單不會因為匯入而出現催款
  assert.ok(!buildFocusList(store, config).items.some((i) => i.reasons.some((r) => r.code.startsWith('payment'))));

  const again = runImport(store, config, { csv, brandId: shouxi.id, dryRun: false });
  assert.equal(again.stats.ordersCreated, 0);
  assert.equal(again.stats.ordersSkipped, 4);
  assert.equal(again.stats.customersMatched, 2);
});

test('Airtable 匯出（沒有訂單編號）＋品牌欄位；對應到同步進來的好友', () => {
  const { store, xy } = setup();
  const friend = store.upsertLineCustomer(xy.id, 'Ufriend', { displayName: '小美' }); // 同步好友進來的
  const csv = [
    '品牌,客戶,LINE名稱,電話,出發日期時間,類型,出發地,目的地,航班編號,報價金額,訂單狀態',
    '享運,王小美,小美,0911222333,2026/4/17 10:00,機場接送,信義區,T2,BR198,"NT$1,200",完成',
    '享運,王小美,小美,0911222333,2026/4/17 10:00,機場接送,信義區,T2,BR198,"NT$1,200",完成',
    '不存在品牌,某人,,,2026/4/18 10:00,包車,,,,100,完成',
    '享運,,,,,,,,,,',
  ].join('\n');
  const r = runImport(store, config, { csv, dryRun: false });
  assert.equal(r.mapping.brand, '品牌');
  assert.equal(r.mapping.real_name, '客戶');
  assert.equal(r.stats.customersCreated, 0);
  assert.equal(r.stats.customersMatched, 1, '用 LINE 名稱對應到好友');
  assert.equal(r.stats.ordersCreated, 1);
  assert.equal(r.stats.ordersSkipped, 1, '同一份檔案內重複的列只建一次');
  assert.deepEqual(r.stats.errors.map((e) => e.row), [4, 5]);
  const c = store.getCustomer(friend.id);
  assert.equal(c.real_name, '王小美', '補上空白欄位');
  assert.equal(c.phone, '0911222333');
  const o = store.listOrders({ customerId: friend.id })[0];
  assert.equal(o.flight_no, 'BR198');
  assert.equal(o.amount, 1200);

  assert.throws(() => runImport(store, config, { csv: '姓名,電話\n甲,0900', dryRun: true }), /品牌/);
  assert.throws(() => runImport(store, config, { csv: '用車日,金額\n2026-01-01,1', brandId: xy.id, dryRun: true }), /姓名/);
});

test('HTTP：匯入 API 需登入、範本可下載', async (t) => {
  const { store, xy } = setup();
  const server = http.createServer(createApp({ store, lines: { for: () => ({ enabled: false }) }, config, logger: silent }));
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const auth = { Authorization: `Basic ${Buffer.from('admin:pw').toString('base64')}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/api/import`, { method: 'POST', body: '{}' })).status, 401);
  const tpl = await (await fetch(`${base}/api/import/template.csv`, { headers: auth })).text();
  assert.match(tpl, /品牌.*用車日.*金額/);
  // 範本本身可以直接匯入
  const res = await fetch(`${base}/api/import`, { method: 'POST', headers: auth, body: JSON.stringify({ csv: tpl, brand_id: xy.id, dry_run: false }) });
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.equal(data.stats.ordersCreated, 1);
  assert.equal(store.listCustomers({ brandId: xy.id })[0].tags, 'VIP');
  assert.equal((await fetch(`${base}/api/import`, { method: 'POST', headers: auth, body: JSON.stringify({ csv: '' }) })).status, 400);
});
