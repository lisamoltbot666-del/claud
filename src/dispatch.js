import { ORDER_STATUSES, SERVICE_TYPES } from './db.js';
import { balanceOf } from './payments.js';

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
  const d = driverId ? getDriver(store, driverId) : null;
  store.run('UPDATE orders SET driver_id = ?, driver_name_snap = ?, driver_phone_snap = ?, driver_plate_snap = ?, driver_car_snap = ?, updated_at = ? WHERE id = ?',
    d?.id ?? null, d?.name ?? null, d?.phone ?? null, d?.plate ?? null, d?.car_model ?? null, new Date().toISOString(), o.id);
  if (driverId && o.status === 'paid') store.updateOrder(o.id, { status: 'shipped' });
  if (!driverId && o.status === 'shipped') store.updateOrder(o.id, { status: 'paid' });
  return store.getOrder(o.id);
}

// 直接輸入司機與車輛（不在名單上的合作司機、臨時司機）：
// 電話或車號相同的司機已在名單上就沿用，否則自動加進司機名單，再指派給這張訂單；本趟資料以輸入的為準
export function assignManualDriver(store, orderId, fields) {
  const name = String(fields.name || '').trim();
  if (!name) throw new Error('請輸入司機姓名');
  const digits = (v) => String(v || '').replace(/\D/g, '');
  const plateKey = (v) => String(v || '').replace(/[\s-]/g, '').toUpperCase();
  const phone = digits(fields.phone);
  const plate = plateKey(fields.plate);
  let d = listDrivers(store).find((x) => (phone.length >= 8 && digits(x.phone) === phone) || (plate && plateKey(x.plate) === plate));
  if (d && !d.active) saveDriver(store, d.id, { active: 1 });
  if (!d) d = saveDriver(store, null, { name, phone: fields.phone, plate: fields.plate, car_model: fields.car_model, note: '派車時新增' });
  assignDriver(store, orderId, d.id);
  return setOrderDriverInfo(store, orderId, { name, phone: fields.phone, plate: fields.plate, car_model: fields.car_model });
}

// 只改這一趟的司機／車輛資料（例如司機今天開另一台車），不影響司機名單
export function setOrderDriverInfo(store, orderId, fields) {
  const o = store.getOrder(orderId);
  if (!o) throw new Error('找不到訂單');
  if (!o.driver_id) throw new Error('請先指派司機');
  const v = (k, snap) => (k in fields ? String(fields[k] || '').trim() || null : o[snap]);
  store.run('UPDATE orders SET driver_name_snap = ?, driver_phone_snap = ?, driver_plate_snap = ?, driver_car_snap = ?, updated_at = ? WHERE id = ?',
    v('name', 'driver_name_snap') || getDriver(store, o.driver_id).name, v('phone', 'driver_phone_snap'), v('plate', 'driver_plate_snap'), v('car_model', 'driver_car_snap'), new Date().toISOString(), o.id);
  return store.getOrder(o.id);
}

// 這張訂單本趟的司機資料：以指派當下（或之後修改）的紀錄為準
function tripDriver(store, o) {
  if (!o?.driver_id) return null;
  const d = getDriver(store, o.driver_id) || {};
  return {
    name: o.driver_name_snap || d.name,
    phone: o.driver_phone_snap ?? d.phone,
    plate: o.driver_plate_snap ?? d.plate,
    car_model: o.driver_car_snap ?? d.car_model,
  };
}

// 給司機的派車單
export function dispatchText(store, orderId) {
  const o = store.getOrder(orderId);
  if (!o) throw new Error('找不到訂單');
  const c = store.getCustomer(o.customer_id);
  const brand = store.getBrand(c.brand_id);
  const d = tripDriver(store, o);
  const fmt = (n) => `NT$${n.toLocaleString('en-US')}`;
  const { paid, due } = balanceOf(o);
  const payment = o.status !== 'pending_payment' ? `已付款 ${fmt(o.amount)}`
    : paid > 0 ? `⚠️ 已收訂金 ${fmt(paid)}，尾款 ${fmt(due)} 請現場收款`
      : `⚠️ 尚未付款（${fmt(o.amount)}），請確認是否現場收款`;
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
  const d = tripDriver(store, o);
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
    `SELECT o.*, c.display_name, c.real_name, c.phone, c.brand_id, COALESCE(o.driver_name_snap, d.name) AS driver_name, COALESCE(o.driver_plate_snap, d.plate) AS driver_plate
     FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN drivers d ON d.id = o.driver_id
     WHERE o.service_date BETWEEN ? AND ? AND o.status != 'cancelled'${brandId ? ' AND c.brand_id = ?' : ''}
     ORDER BY o.service_date, COALESCE(o.service_time, '99:99'), o.id`,
    from, to, ...(brandId ? [brandId] : []),
  );
}

// 這位客人搭過哪些司機、哪些車（依當時指派的紀錄）
export function driverHistory(store, customerId) {
  return store.all(
    `SELECT COALESCE(o.driver_name_snap, d.name) AS name, COALESCE(o.driver_plate_snap, d.plate) AS plate,
            COALESCE(o.driver_car_snap, d.car_model) AS car_model, COALESCE(o.driver_phone_snap, d.phone) AS phone,
            COUNT(*) AS trips, MAX(COALESCE(o.service_date, o.order_date)) AS last_date
     FROM orders o LEFT JOIN drivers d ON d.id = o.driver_id
     WHERE o.customer_id = ? AND o.driver_id IS NOT NULL AND o.status != 'cancelled'
     GROUP BY COALESCE(o.driver_name_snap, d.name), COALESCE(o.driver_plate_snap, d.plate) ORDER BY last_date DESC`, customerId,
  );
}
