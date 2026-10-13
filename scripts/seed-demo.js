// 建立示範資料：npm run demo（會寫入 DB_PATH 指定的資料庫）
import { getConfig, loadEnvFile } from '../src/config.js';
import { addDays, today } from '../src/dates.js';
import { openDb } from '../src/db.js';

loadEnvFile();
const config = getConfig();
const store = openDb(config.dbPath);
const t = today(config.tz);

const brand = (slug, name, color, bank) => store.getBrandBySlug(slug) || store.createBrand({ slug, name, color, bank_info: bank });
const chicken = brand('chicken', '雞精坊', '#d9480f', '台灣銀行 004 帳號 1234-5678-9012 戶名 雞精坊');
const soy = brand('soy', '豆漿屋', '#1c7ed6', '郵局 700 帳號 0001-2345-6789 戶名 豆漿屋');
const oat = brand('oat', '燕麥日記', '#7048e8', '國泰世華 013 帳號 9876-5432-1000 戶名 燕麥日記');

const make = (b, uid, name, extra = {}) => store.updateCustomer(store.upsertLineCustomer(b.id, uid, { displayName: name }).id, extra);

const a = make(chicken, 'Udemo-a', '小美', { real_name: '王小美', phone: '0912-345-678', tags: 'VIP', email: 'mei@example.com', gender: '女', birthday: `1990-${t.slice(5)}` });
for (const [d, amt, items] of [[-120, 1680, '滴雞精 x10'], [-90, 1680, '滴雞精 x10'], [-60, 2580, '滴雞精 x10、禮盒'], [-32, 1680, '滴雞精 x10']]) {
  store.createOrder(a.id, { order_date: addDays(t, d), status: 'completed', amount: amt, items });
}
store.createOrder(a.id, { order_date: addDays(t, -6), payment_due_date: addDays(t, -2), amount: 1680, items: '滴雞精 x10' });

const b = make(chicken, 'Udemo-b', 'Jason', { tags: '團購' });
const ob = store.createOrder(b.id, { order_date: addDays(t, -1), payment_due_date: addDays(t, 2), amount: 3200, items: '禮盒 x4' });
store.addMessage(b.id, 'in', '我已匯款囉 末五碼 54321');
store.reportPayment(ob.id, '我已匯款囉 末五碼 54321');

const c = make(soy, 'Udemo-c', '陳媽媽', { note: '喜歡無糖口味', phone: '0933-111-222' });
for (const d of [-70, -40]) store.createOrder(c.id, { order_date: addDays(t, d), status: 'completed', amount: 980, items: '無糖豆漿 x12' });

const d = make(soy, 'Udemo-d', 'Amy');
store.addMessage(d.id, 'in', '請問還有現貨嗎？');

make(oat, 'Udemo-e', '新朋友 Ken');

const f = make(chicken, 'Udemo-f', '林先生', { next_contact_date: t, note: '說月底會再訂' });
store.createOrder(f.id, { order_date: addDays(t, -10), status: 'shipped', amount: 2400, items: '綜合禮盒' });

const g = make(soy, 'Udemo-g', '老客戶 Leo', { tags: '團購' });
store.createOrder(g.id, { order_date: addDays(t, -150), status: 'completed', amount: 5200, items: '綜合禮盒 x2' });

const h = make(oat, 'Udemo-h', 'Vivi');
for (const d of [-45, -25]) store.createOrder(h.id, { order_date: addDays(t, d), status: 'completed', amount: 760, items: '燕麥奶 x6' });

// 同一位客人也加了另一個品牌的官方帳號：在系統裡是兩筆獨立的客戶資料
const a2 = make(soy, 'Udemo-a2', '小美', { real_name: '王小美', phone: '0912-345-678' });
store.createOrder(a2.id, { order_date: addDays(t, -35), status: 'completed', amount: 450, items: '無糖豆漿 x6' });

console.log(`已建立示範資料到 ${config.dbPath}`);
