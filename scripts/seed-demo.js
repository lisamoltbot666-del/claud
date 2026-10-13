// 建立示範資料：npm run demo（會寫入 DB_PATH 指定的資料庫）
import { getConfig, loadEnvFile } from '../src/config.js';
import { addDays, today } from '../src/dates.js';
import { openDb } from '../src/db.js';

loadEnvFile();
const config = getConfig();
const store = openDb(config.dbPath);
const t = today(config.tz);

const make = (uid, name, extra = {}) => store.updateCustomer(store.upsertLineCustomer(uid, { displayName: name }).id, extra);

const a = make('Udemo-a', '小美', { real_name: '王小美', phone: '0912-345-678', tags: 'VIP', email: 'mei@example.com', gender: '女', birthday: `1990-${t.slice(5)}` });
for (const [d, amt, items] of [[-120, 1680, '滴雞精 x10'], [-90, 1680, '滴雞精 x10'], [-60, 2580, '滴雞精 x10、禮盒'], [-32, 1680, '滴雞精 x10']]) {
  store.createOrder(a.id, { order_date: addDays(t, d), status: 'completed', amount: amt, items });
}
store.createOrder(a.id, { order_date: addDays(t, -6), payment_due_date: addDays(t, -2), amount: 1680, items: '滴雞精 x10' });

const b = make('Udemo-b', 'Jason', { tags: '團購' });
const ob = store.createOrder(b.id, { order_date: addDays(t, -1), payment_due_date: addDays(t, 2), amount: 3200, items: '禮盒 x4' });
store.addMessage(b.id, 'in', '我已匯款囉 末五碼 54321');
store.reportPayment(ob.id, '我已匯款囉 末五碼 54321');

const c = make('Udemo-c', '陳媽媽', { note: '喜歡無糖口味', phone: '0933-111-222' });
for (const d of [-70, -40]) store.createOrder(c.id, { order_date: addDays(t, d), status: 'completed', amount: 980, items: '無糖豆漿 x12' });

const d = make('Udemo-d', 'Amy');
store.addMessage(d.id, 'in', '請問還有現貨嗎？');

make('Udemo-e', '新朋友 Ken');

const f = make('Udemo-f', '林先生', { next_contact_date: t, note: '說月底會再訂' });
store.createOrder(f.id, { order_date: addDays(t, -10), status: 'shipped', amount: 2400, items: '綜合禮盒' });

const g = make('Udemo-g', '老客戶 Leo', { tags: '團購' });
store.createOrder(g.id, { order_date: addDays(t, -150), status: 'completed', amount: 5200, items: '綜合禮盒 x2' });

const h = make('Udemo-h', 'Vivi');
for (const d of [-45, -25]) store.createOrder(h.id, { order_date: addDays(t, d), status: 'completed', amount: 760, items: '燕麥奶 x6' });

console.log(`已建立示範資料到 ${config.dbPath}`);
