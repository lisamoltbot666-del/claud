import { addDays, today } from './dates.js';

// 全站搜尋：客戶（姓名、LINE 名稱、電話、標籤、備註…）、訂單（航班、地點、車型、備註、編號）、對話內容，
// 可加上日期範圍（訂單看用車日，對話看傳訊日）。電話不論有無「-」、空格、+886 都找得到。

const like = (s) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
// SQL：去掉電話裡的符號後比對
const PHONE_SQL = (col) => `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${col},''),'-',''),' ',''),'(',''),')',''),'+886','0')`;

export function search(store, config, { q = '', from = '', to = '', brandId = null, limit = 50 } = {}) {
  q = String(q).trim();
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  from = dateRe.test(from) ? from : '';
  to = dateRe.test(to) ? to : '';
  if (from && !to) to = from;
  if (to && !from) from = to;
  if (!q && !from) return { q, from, to, customers: [], orders: [], messages: [] };

  const brandWhere = brandId ? ' AND c.brand_id = ?' : '';
  const brandArgs = brandId ? [brandId] : [];
  const pat = like(q);
  const digits = q.replace(/\D/g, '').replace(/^886/, '0');
  const phoneQuery = digits.length >= 3 && /^[\d\s()+-]+$/.test(q);
  const orderIdQuery = q.match(/^#?(\d{1,7})$/);

  // ---- 客戶 ----
  let customers = [];
  if (q) {
    const fields = ['c.display_name', 'c.real_name', 'c.email', 'c.tags', 'c.note', 'c.address', 'c.line_user_id', 'c.phone'];
    const conds = fields.map((f) => `${f} LIKE ? ESCAPE '\\'`);
    const args = fields.map(() => pat);
    if (phoneQuery) { conds.push(`${PHONE_SQL('c.phone')} LIKE ?`); args.push(`%${digits}%`); }
    customers = store.all(
      `SELECT c.*, (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.status != 'cancelled') AS order_count,
              (SELECT MAX(COALESCE(o.service_date, o.order_date)) FROM orders o WHERE o.customer_id = c.id AND o.status != 'cancelled') AS last_trip
       FROM customers c WHERE (${conds.join(' OR ')})${brandWhere}
       ORDER BY COALESCE(c.last_inbound_at, c.updated_at) DESC LIMIT ?`,
      ...args, ...brandArgs, limit,
    );
  }

  // ---- 訂單 ----
  const oConds = [];
  const oArgs = [];
  if (q) {
    const fields = ['o.items', 'o.note', 'o.flight_no', 'o.pickup', 'o.dropoff', 'o.payment_report', 'o.import_ref', 'o.driver_name_snap', 'o.driver_plate_snap', 'c.display_name', 'c.real_name', 'c.phone'];
    const sub = fields.map((f) => `${f} LIKE ? ESCAPE '\\'`);
    oArgs.push(...fields.map(() => pat));
    if (phoneQuery) { sub.push(`${PHONE_SQL('c.phone')} LIKE ?`); oArgs.push(`%${digits}%`); }
    if (orderIdQuery) { sub.push('o.id = ?'); oArgs.push(Number(orderIdQuery[1])); }
    oConds.push(`(${sub.join(' OR ')})`);
  }
  if (from) {
    oConds.push('COALESCE(o.service_date, o.order_date) BETWEEN ? AND ?');
    oArgs.push(from, to);
  }
  const orders = store.all(
    `SELECT o.*, c.display_name, c.real_name, c.phone, c.brand_id
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE ${oConds.join(' AND ')}${brandWhere}
     ORDER BY COALESCE(o.service_date, o.order_date) ${from ? 'ASC' : 'DESC'}, o.service_time, o.id DESC LIMIT ?`,
    ...oArgs, ...brandArgs, from ? 500 : limit,
  );

  // ---- 對話 ----
  let messages = [];
  if (q) {
    const mArgs = [pat];
    let dateCond = '';
    if (from) {
      // 店家時區的日期範圍 → UTC 時間戳範圍（以台灣 +8 為主，跨日邊界誤差可接受）
      const offset = config.tz === 'Asia/Taipei' ? 8 : 0;
      const start = new Date(`${from}T00:00:00Z`).getTime() - offset * 3600_000;
      const end = new Date(`${addDays(to, 1)}T00:00:00Z`).getTime() - offset * 3600_000;
      dateCond = ' AND m.created_at >= ? AND m.created_at < ?';
      mArgs.push(new Date(start).toISOString(), new Date(end).toISOString());
    }
    messages = store.all(
      `SELECT m.*, c.display_name, c.real_name, c.brand_id
       FROM messages m JOIN customers c ON c.id = m.customer_id
       WHERE m.text LIKE ? ESCAPE '\\'${dateCond}${brandWhere}
       ORDER BY m.id DESC LIMIT ?`,
      ...mArgs, ...brandArgs, limit,
    );
  }

  return { q, from, to, today: today(config.tz), customers, orders, messages };
}
