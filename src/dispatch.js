import { ORDER_STATUSES, SERVICE_TYPES } from './db.js';

// 司機與派車：司機名單（各品牌共用）、訂單指派司機、產生派車單文字（可複製或用 LINE 傳給司機）、
// 以及傳給客人的「司機資訊」。司機若在後台連結到某品牌官方帳號的 LINE 好友，就能直接推播派車單。

const shortDate = (d) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}（${'日一二三四五六'[new Date(`${d}T00:00:00Z`).getUTCDay()]}）` : '');
const DRIVER_FIELDS = ['name', 'phone', 'plate', 'car_model', 'note', 'line_customer_id', 'active'];

export function listDrivers(store, { activeOnly = false } = {}) {
  return store.all(`SELECT d.*, c.display_name AS line_name, c.brand_id AS line_brand_id, c.is_friend AS line_is_friend
    FROM drivers d LEFT JOIN customers c ON c.id = d.line_customer_id
    ${activeOnly ? 'WHERE d.active = 1' : ''} ORDER BY d.active DESC, d.name`);
}

export function getDriver(store, id) {
  return store.get('SELECT * FROM drivers WHERE id = ?', id);
}

export function saveDriver(store, id, fields) {
  const data = {};
  for (const k of DRIVER_FIELDS) if (k in fields) data[k] = typeof fields[k] === 'string' ? fields[k].trim() || null : fields[k];
  if ('name' in data || !id) {
    if (!data.name) throw new Error('請輸入司機姓名');
    data.name = String(data.name).slice(0, 40);
  }
  if ('line_customer_id' in data) {
    data.line_customer_id = data.line_customer_id ? Number(data.line_customer_id) : null;
    if (data.line_customer_id) {
      const c = store.getCustomer(data.line_customer_id);
      if (!c?.line_user_id) throw new Error('要連結的對象必須是 LINE 好友');
    }
  }
  if ('active' in data) data.active = data.active === false || data.active === 0 || data.active === '0' ? 0 : 1;
  const keys = Object.keys(data);
  if (id) {
    if (!getDriver(store, id)) throw new Error('找不到司機');
    if (keys.length) store.run(`UPDATE drivers SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => data[k]), id);
  } else {
    const r = store.run(`INSERT INTO drivers (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((k) => data[k]));
    id = Number(r.lastInsertRowid);
  }
  return getDriver(store, id);
}

// 指派（或取消）司機。已付款的單指派後自動變成「已派車」；待付款的單保留付款狀態。
export function assignDriver(store, orderId, driverId) {
  const o = store.getOrder(orderId);
  if (!o) throw new Error('找不到訂單');
  if (['cancelled', 'completed'].includes(o.status) && driverId) throw new Error(`這筆訂單已${ORDER_STATUSES[o.status]}`);
  if (driverId) {
    const d = getDriver(store, driverId);
    if (!d) throw new Error('找不到司機');
    if (!d.active) throw new Error('這位司機已停用');
  }
  store.run('UPDATE orders SET driver_id = ?, updated_at = ? WHERE id = ?', driverId || null, new Date().toISOString(), o.id);
  if (driverId && o.status === 'paid') store.updateOrder(o.id, { status: 'shipped' });
  if (!driverId && o.status === 'shipped') store.updateOrder(o.id, { status: 'paid' });
  return store.getOrder(o.id);
}

// 給司機的派車單
export function dispatchText(store, orderId) {
  const o = store.getOrder(orderId);
  if (!o) throw new Error('找不到訂單');
  const c = store.getCustomer(o.customer_id);
  const brand = store.getBrand(c.brand_id);
  const d = o.driver_id ? getDriver(store, o.driver_id) : null;
  const payment = o.status === 'pending_payment' ? `⚠️ 尚未付款（NT$${o.amount.toLocaleString('en-US')}），請確認是否現場收款` : `已付款 NT$${o.amount.toLocaleString('en-US')}`;
  return [
    `【派車單】${brand?.name || ''} #${o.id}`,
    d ? `司機：${d.name}${d.plate ? `｜${d.plate}` : ''}` : '',
    `🕐 ${[shortDate(o.service_date), o.service_time].filter(Boolean).join(' ') || '日期未定'}｜${SERVICE_TYPES[o.service_type] || '用車'}`,
    o.flight_no ? `✈️ 航班：${o.flight_no}` : '',
    o.pickup ? `📍 上車：${o.pickup}` : '',
    o.dropoff ? `🏁 目的地：${o.dropoff}` : '',
    o.return_date && o.return_date !== o.service_date ? `📅 至 ${shortDate(o.return_date)}` : '',
    o.items ? `🚐 ${o.items}` : '',
    `👤 客人：${c.real_name || c.display_name || ''}${c.phone ? ` ${c.phone}` : ''}`,
    `💰 ${payment}`,
    o.note ? `📝 ${o.note}` : '',
  ].filter(Boolean).join('\n');
}

// 傳給客人的司機資訊
export function driverInfoText(store, orderId) {
  const o = store.getOrder(orderId);
  const d = o?.driver_id ? getDriver(store, o.driver_id) : null;
  if (!d) throw new Error('這筆訂單還沒指派司機');
  const c = store.getCustomer(o.customer_id);
  const brand = store.getBrand(c.brand_id);
  return [
    `${c.real_name || c.display_name || ''} 您好，這裡是${brand?.name || ''} 😊`,
    `您 ${[shortDate(o.service_date), o.service_time].filter(Boolean).join(' ')} 的${SERVICE_TYPES[o.service_type] || '行程'}（訂單 #${o.id}）司機資訊：`,
    `👨‍✈️ 司機：${d.name}`,
    d.phone ? `📞 電話：${d.phone}` : '',
    d.plate ? `🚘 車號：${d.plate}${d.car_model ? `（${d.car_model}）` : ''}` : '',
    '當天司機會準時抵達，有任何問題請直接回覆這則訊息，謝謝！',
  ].filter(Boolean).join('\n');
}

// 派車表：日期範圍內的行程（含司機），依用車時間排序
export function dispatchBoard(store, { from, to, brandId = null }) {
  return store.all(
    `SELECT o.*, c.display_name, c.real_name, c.phone, c.brand_id, d.name AS driver_name, d.plate AS driver_plate
     FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN drivers d ON d.id = o.driver_id
     WHERE o.service_date BETWEEN ? AND ? AND o.status != 'cancelled'${brandId ? ' AND c.brand_id = ?' : ''}
     ORDER BY o.service_date, COALESCE(o.service_time, '99:99'), o.id`,
    from, to, ...(brandId ? [brandId] : []),
  );
}
