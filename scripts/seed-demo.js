// 建立示範資料：npm run demo（會寫入 DB_PATH 指定的資料庫）
import { getConfig, loadEnvFile } from '../src/config.js';
import { addDays, today } from '../src/dates.js';
import { openDb } from '../src/db.js';

loadEnvFile();
const config = getConfig();
const store = openDb(config.dbPath);
const t = today(config.tz);

const brand = (slug, name, color, bank) => store.getBrandBySlug(slug) || store.createBrand({ slug, name, color, bank_info: bank });
const airport = brand('airport', '安心機場接送', '#1c7ed6', '台灣銀行 004 帳號 1234-5678-9012 戶名 安心交通');
const charter = brand('charter', '小旅行包車', '#2b8a3e', '郵局 700 帳號 0001-2345-6789 戶名 小旅行包車');
const rental = brand('rental', '自在租車', '#e8590c', '國泰世華 013 帳號 9876-5432-1000 戶名 自在租車');

const make = (b, uid, name, extra = {}) => store.updateCustomer(store.upsertLineCustomer(b.id, uid, { displayName: name }).id, extra);
const done = (c, days, fields) => store.createOrder(c.id, { order_date: addDays(t, days - 7), service_date: addDays(t, days), status: 'completed', ...fields });

// 常客：大約每 60 天出國一次，明天又要搭機（行程確認），今天生日
const a = make(airport, 'Udemo-a', '小美', { real_name: '王小美', phone: '0912-345-678', tags: 'VIP', email: 'mei@example.com', gender: '女', birthday: `1990-${t.slice(5)}`, address: '台北市信義區松仁路 100 號' });
for (const d of [-180, -120, -60]) done(a, d, { service_type: 'airport', service_time: '05:30', amount: 1200, items: '送機 5 人座', pickup: '台北市信義區松仁路 100 號', dropoff: '桃園機場第二航廈' });
store.createOrder(a.id, { order_date: addDays(t, -5), service_date: addDays(t, 1), service_time: '05:30', service_type: 'airport', status: 'paid', amount: 1200, items: '送機 5 人座', flight_no: 'BR198', pickup: '台北市信義區松仁路 100 號', dropoff: '桃園機場第二航廈' });

// 已回報匯款，等核對
const b = make(airport, 'Udemo-b', 'Jason', { tags: '商務' });
const ob = store.createOrder(b.id, { order_date: addDays(t, -1), payment_due_date: addDays(t, 2), service_date: addDays(t, 5), service_time: '22:10', service_type: 'airport', amount: 1500, items: '接機 7 人座', flight_no: 'CI101', pickup: '桃園機場第一航廈', dropoff: '新竹市東區光復路' });
store.addMessage(b.id, 'in', '我已匯款囉 末五碼 54321');
store.reportPayment(ob.id, '我已匯款囉 末五碼 54321');

// 包車首次客，詢問中的新客人
const c = make(charter, 'Udemo-c', '陳媽媽', { note: '帶長輩出遊，需要好上下車的車型', phone: '0933-111-222' });
done(c, -40, { service_type: 'charter', service_time: '08:00', amount: 6800, items: '9 人座一日遊', pickup: '台中高鐵站', dropoff: '日月潭', return_date: addDays(t, -40) });
const d = make(charter, 'Udemo-d', 'Amy');
store.addMessage(d.id, 'in', '請問 12/24 花蓮兩天一夜包車多少錢？');
make(charter, 'Udemo-e', '新朋友 Ken');

// 很久沒來的包車客人
const g = make(charter, 'Udemo-g', '老客戶 Leo', { tags: '公司旅遊' });
done(g, -200, { service_type: 'charter', amount: 15600, items: '中巴 20 人座', pickup: '台北車站', dropoff: '宜蘭', return_date: addDays(t, -199) });

// 租車：今天取車還沒派車、客服排定今天聯絡、待付款
const f = make(rental, 'Udemo-f', '林先生', { phone: '0955-666-777' });
store.createOrder(f.id, { order_date: addDays(t, -10), service_date: t, service_time: '10:00', service_type: 'rental', status: 'paid', amount: 4800, items: 'Toyota Altis', pickup: '高鐵左營站', dropoff: '高鐵左營站', return_date: addDays(t, 3) });
const h = make(rental, 'Udemo-h', 'Vivi', { next_contact_date: t, note: '說月底連假要再租' });
done(h, -95, { service_type: 'rental', amount: 3600, items: 'Honda CR-V', pickup: '花蓮火車站', dropoff: '花蓮火車站', return_date: addDays(t, -92) });
const i = make(rental, 'Udemo-i', 'Peter');
store.createOrder(i.id, { order_date: addDays(t, -4), payment_due_date: addDays(t, -1), service_date: addDays(t, 6), service_time: '09:00', service_type: 'rental', amount: 5400, items: 'Nissan X-Trail', pickup: '台東火車站', dropoff: '台東火車站', return_date: addDays(t, 9) });

// 同一位客人也加了另一個品牌的官方帳號：在系統裡是兩筆獨立的客戶資料
const a2 = make(rental, 'Udemo-a2', '小美', { real_name: '王小美', phone: '0912-345-678' });
done(a2, -130, { service_type: 'rental', amount: 3200, items: 'Toyota Yaris', pickup: '台南高鐵站', dropoff: '台南高鐵站', return_date: addDays(t, -128) });

console.log(`已建立示範資料到 ${config.dbPath}`);
