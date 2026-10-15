import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { latestBookingDraft, parseBookingForm, parseContact, parseDate, parseTime, parseTrips, PAID_PATTERN } from '../src/booking-parse.js';
import { getConfig } from '../src/config.js';
import { today } from '../src/dates.js';
import { openDb } from '../src/db.js';
import { buildFocusList } from '../src/focus.js';
import { createApp } from '../src/server.js';
import { WebhookHandler } from '../src/webhook.js';

const config = getConfig({ TZ_NAME: 'Asia/Taipei', ADMIN_PASSWORD: 'pw', BASIC_AUTH: 'true' });
const T = today('Asia/Taipei');
const silent = { log() {}, warn() {}, error() {} };

const FORM = `➤接送日期：2026.11.05
➤預約時間： 凌晨4：00
➤航班編號： br108
➤聯絡人姓名：  林定緯
➤聯絡電話： 0963270949
➤乘車人數： 4
➤行李數量： 6
➤指定車型：
➤上車地點： 高雄市鳳山區文化
西路176號
➤下車地點： 小港機場國際線
➤其他需求 / 備註：
✅ 每位乘客皆投保 500 萬乘客險`;

test('辨識預約單：日期、時間、航班、姓名、電話、人數行李、跨行地址', () => {
  assert.deepEqual(parseBookingForm(FORM, '2026-10-15'), {
    service_type: 'airport', service_date: '2026-11-05', service_time: '04:00', flight_no: 'BR108',
    pickup: '高雄市鳳山區文化西路176號', dropoff: '小港機場國際線', return_date: null, items: null,
    note: '4 人、行李 6 件', real_name: '林定緯', phone: '0963270949', passengers: 4, luggage: 6,
  });
  assert.equal(parseBookingForm('請問租車是算日期，還是也可以算時間日租？', '2026-10-15'), null);
  assert.equal(parseBookingForm('姓名：王小明', '2026-10-15'), null, '欄位太少不算');
  const rental = parseBookingForm('1. 取車日期：12/24\n2. 取車時間：下午3點半\n3. 姓名：陳先生\n4. 電話：0912-345-678\n5. 指定車型：Toyota Altis\n6. 還車日期：12/26', '2026-10-15');
  assert.equal(rental.service_type, 'rental');
  assert.equal(rental.service_date, '2026-12-24');
  assert.equal(rental.return_date, '2026-12-26');
  assert.equal(rental.service_time, '15:30');
  assert.equal(rental.items, 'Toyota Altis');
  assert.equal(rental.phone, '0912-345-678');
});

test('日期、時間格式', () => {
  assert.equal(parseDate('2026年1月9日', '2026-10-15'), '2026-01-09');
  assert.equal(parseDate('１１／５', '2026-10-15'), '2026-11-05', '全形');
  assert.equal(parseDate('1/20', '2026-10-15'), '2027-01-20', '沒寫年份且已過 → 明年');
  assert.equal(parseTime('晚上8點'), '20:00');
  assert.equal(parseTime('中午12:30'), '12:30');
  assert.equal(parseTime('16:45'), '16:45');
  assert.equal(parseTime('凌晨12點'), '00:00');
  assert.ok(PAID_PATTERN.test('我已經轉帳NT$300元給您，請您查詢存款明細!(我的帳號末五碼是35751'));
  assert.ok(PAID_PATTERN.test('已匯款'));
  assert.ok(!PAID_PATTERN.test('請問怎麼付款？'));
});

function setup() {
  const store = openDb(':memory:');
  const brand = store.createBrand({ slug: 'x', name: '享運', channel_access_token: 'tok' });
  const lines = { for: () => ({ enabled: false, push: async () => ({}), reply: async () => ({}), getProfile: async () => ({}) }) };
  const wh = new WebhookHandler({ store, lines, logger: silent, tz: 'Asia/Taipei' });
  const say = (uid, text) => wh.handle(brand, { events: [{ type: 'message', source: { type: 'user', userId: uid }, message: { type: 'text', text } }] });
  return { store, brand, lines, say };
}

test('收到預約單：自動補上空白的姓名電話；關懷清單提醒建立訂單；建立後消失', async () => {
  const { store, brand, say } = setup();
  await say('U1', FORM);
  const c = store.getCustomerByLineId(brand.id, 'U1');
  assert.equal(c.real_name, '林定緯');
  assert.equal(c.phone, '0963270949');
  const reasons = () => buildFocusList(store, config).items.find((i) => i.customer.id === c.id)?.reasons.map((r) => r.code) || [];
  assert.ok(reasons().includes('booking_form'));
  const draft = latestBookingDraft(store, c.id, T);
  assert.equal(draft.fields.flight_no, 'BR108');
  store.createOrder(c.id, { order_date: T, amount: 1100, source_message_id: draft.message_id });
  assert.ok(!reasons().includes('booking_form'));
  assert.equal(latestBookingDraft(store, c.id, T), null, '已建立訂單的預約單不再顯示');

  // 客服填過的不覆蓋
  store.updateCustomer(c.id, { real_name: '林先生' });
  await say('U1', FORM.replace('林定緯', '別人'));
  assert.equal(store.getCustomer(c.id).real_name, '林先生');
});

test('客人說已轉帳但沒有待付款訂單：提醒核對；按已核對或有入帳後消失', async () => {
  const { store, brand, say } = setup();
  await say('U2', '我已經轉帳NT$300元給您，末五碼35751');
  const c = store.getCustomerByLineId(brand.id, 'U2');
  const reasons = () => buildFocusList(store, config).items.find((i) => i.customer.id === c.id)?.reasons.map((r) => r.code) || [];
  assert.ok(reasons().includes('payment_claim'));
  const last = store.get("SELECT MAX(id) AS id FROM messages WHERE customer_id = ?", c.id).id;
  store.setKv(`payment_claim_ack:${c.id}`, String(last));
  assert.ok(!reasons().includes('payment_claim'));

  // 有待付款訂單時：直接記到訂單的匯款回報（原本的「請核對入帳」），不重複提醒
  const { store: s2, brand: b2, say: say2 } = setup();
  await say2('U3', '你好');
  const c3 = s2.getCustomerByLineId(b2.id, 'U3');
  const o = s2.createOrder(c3.id, { order_date: T, amount: 1100 });
  await say2('U3', '我已經轉帳了 末五碼12345');
  assert.match(s2.getOrder(o.id).payment_report, /12345/);
  const codes = buildFocusList(s2, config).items.find((i) => i.customer.id === c3.id).reasons.map((r) => r.code);
  assert.ok(codes.includes('verify_payment'));
  assert.ok(!codes.includes('payment_claim'));
});

test('API：客戶資料附預約單、略過、建立訂單時只接受自己客人的訊息', async () => {
  const { store, brand, lines, say } = setup();
  await say('U1', FORM);
  await say('U9', '另一位客人');
  const c = store.getCustomerByLineId(brand.id, 'U1');
  const other = store.getCustomerByLineId(brand.id, 'U9');
  const server = http.createServer(createApp({ store, lines, config, logger: silent }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { Authorization: `Basic ${Buffer.from('admin:pw').toString('base64')}`, 'Content-Type': 'application/json' };
  const call = async (p, method = 'GET', body) => { const r = await fetch(base + p, { method, headers: auth, body: body && JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
  try {
    const detail = (await call(`/api/customers/${c.id}`)).data;
    assert.equal(detail.booking.fields.service_date, '2026-11-05');
    const otherMsg = store.get('SELECT id FROM messages WHERE customer_id = ?', other.id).id;
    const o = (await call('/api/orders', 'POST', { customer_id: c.id, amount: 1100, source_message_id: otherMsg })).data;
    assert.equal(o.source_message_id, null, '別人的訊息不能掛');
    assert.ok((await call(`/api/customers/${c.id}`)).data.booking, '仍顯示');
    assert.equal((await call(`/api/customers/${c.id}/booking/dismiss`, 'POST', { messageId: detail.booking.message_id })).status, 200);
    assert.equal((await call(`/api/customers/${c.id}`)).data.booking, null);
    assert.equal((await call(`/api/customers/${c.id}/payment-claim/ack`, 'POST')).status, 200);
  } finally {
    server.close();
  }
});

test('一句話寫的來回包車行程＋另外傳的聯絡人、統編、付款需求', async () => {
  const { store, brand, say } = setup();
  await say('U5', '有確定喽~我要來回包車，7位成人\n\n11/22(日)上午7:50從 高雄市苓雅區義勇路149號 出發，前往台南市大學路1號成功大學自強校區大門\n\n11/22(日)下午5:10從 台南市大學路1號成功大學自強校區大門\n出發 前往 高雄市苓雅區義勇路149號');
  await say('U5', '我需要開立統編發票\n統編：92075581\n抬頭：財團法人高雄市私立聖淵啟仁中心');
  await say('U5', '請問是否可以用匯款的方式呢?\n因公司作帳及出款需要作業時間，10/23前提供發票及明細，會於11/5匯款');
  await say('U5', '聯絡人：陳佳萱\n連絡電話：0975098102');
  const c = store.getCustomerByLineId(brand.id, 'U5');
  assert.equal(c.real_name, '陳佳萱', '「連絡電話」這種寫法也認得');
  assert.equal(c.phone, '0975098102');
  assert.equal(c.tax_id, '92075581');
  assert.equal(c.invoice_title, '財團法人高雄市私立聖淵啟仁中心');

  const d = latestBookingDraft(store, c.id, '2026-10-15');
  const f = d.fields;
  assert.equal(f.service_type, 'charter');
  assert.equal(f.service_date, '2026-11-22');
  assert.equal(f.service_time, '07:50');
  assert.equal(f.pickup, '高雄市苓雅區義勇路149號');
  assert.equal(f.dropoff, '台南市大學路1號成功大學自強校區大門');
  assert.equal(f.passengers, 7);
  assert.match(f.note, /回程 11\/22 17:10 台南市大學路1號成功大學自強校區大門 → 高雄市苓雅區義勇路149號/);
  assert.equal(f.tax_id, '92075581');
  assert.ok(f.needs.some((n) => n.includes('11/5匯款')), '付款條件列為需求');
  assert.ok(!f.needs.some((n) => n.startsWith('統編：')), '統編不重複列');
  assert.ok(buildFocusList(store, config).items.find((i) => i.customer.id === c.id).reasons.some((r) => r.code === 'booking_form'));

  // 付款條件那句不會被當成行程
  assert.deepEqual(parseTrips('10/23前提供發票及明細，會於11/5匯款', '2026-10-15'), []);
  // 不同天的回程 → 結束日
  const legs = parseTrips('12/1 早上9點從台北車站出發到桃園機場，12/5 晚上8點從桃園機場到台北車站', '2026-10-15');
  assert.deepEqual(legs.map((l) => [l.date, l.time, l.from, l.to]), [['2026-12-01', '09:00', '台北車站', '桃園機場'], ['2026-12-05', '20:00', '桃園機場', '台北車站']]);
});

test('聯絡資料辨識：各種寫法', () => {
  assert.deepEqual(parseContact('姓名: 王小明\n手機：0912 345 678'), { real_name: '王小明', phone: '0912 345 678' });
  assert.deepEqual(parseContact('請開統一編號 12345678 的發票'), { tax_id: '12345678' });
  assert.deepEqual(parseContact('我明天到'), {});
});
