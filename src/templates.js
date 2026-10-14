import { today } from './dates.js';
import { ORDER_STATUSES, SERVICE_TYPES } from './db.js';

// 客服自訂的常用回覆範本。可指定品牌，或給全部品牌共用；內容可放 {姓名}、{用車日} 等欄位，送出前自動帶入。

export const TEMPLATE_VARS = {
  姓名: '客戶姓名（沒有就用 LINE 名稱）',
  LINE名稱: '客戶的 LINE 名稱',
  電話: '客戶電話',
  品牌: '品牌名稱',
  匯款資訊: '品牌的匯款帳號',
  訂單編號: '訂單編號，例如 #12',
  服務: '機場接送／包車／租車自駕',
  用車日: '例如 10/20（一）',
  時間: '用車時間，例如 06:30',
  航班: '航班號碼',
  上車地點: '上車／取車地點',
  目的地: '目的地／還車地點',
  車型: '車型或內容',
  金額: '例如 NT$1,200',
  匯款期限: '例如 10/18（六）',
  訂單狀態: '待付款／已付款…',
};

const DEFAULTS = [
  ['報價回覆', '{姓名} 您好，感謝詢問 {品牌} 😊\n{用車日} {時間} {上車地點} → {目的地}，{服務}報價為 {金額}。\n確認預約的話，回覆這則訊息即可，我們會再傳匯款資訊給您！'],
  ['預約確認', '{姓名} 您好，已為您預約 {用車日} {時間} 的{服務}（訂單 {訂單編號}）：\n📍 {上車地點} → {目的地}\n✈️ 航班：{航班}\n金額 {金額}，請於 {匯款期限} 前匯款至：{匯款資訊}\n有任何異動請直接回覆，謝謝！'],
  ['感謝搭乘', '{姓名} 您好，謝謝您這次選擇 {品牌} 🙏\n行程還順利嗎？有任何建議都歡迎告訴我們，下次出門也歡迎再找我們！'],
];

const shortDate = (d) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}（${'日一二三四五六'[new Date(`${d}T00:00:00Z`).getUTCDay()]}）` : '');

export function seedTemplates(store) {
  if (store.getKv('templates_seeded')) return;
  if (!store.get('SELECT id FROM reply_templates LIMIT 1')) {
    DEFAULTS.forEach(([title, body], i) => store.run('INSERT INTO reply_templates (brand_id, title, body, sort) VALUES (NULL, ?, ?, ?)', title, body, i));
  }
  store.setKv('templates_seeded', '1');
}

export function listTemplates(store, { brandId = null } = {}) {
  return brandId
    ? store.all('SELECT * FROM reply_templates WHERE brand_id IS NULL OR brand_id = ? ORDER BY brand_id IS NOT NULL DESC, sort, id', brandId)
    : store.all('SELECT * FROM reply_templates ORDER BY brand_id IS NULL DESC, brand_id, sort, id');
}

function clean(fields) {
  const title = String(fields.title ?? '').trim();
  const body = String(fields.body ?? '').trim();
  if (!title) throw new Error('請輸入範本名稱');
  if (!body) throw new Error('請輸入範本內容');
  if (body.length > 4000) throw new Error('內容太長（LINE 訊息上限約 5000 字）');
  return { title: title.slice(0, 60), body };
}

export function saveTemplate(store, id, fields, userName) {
  const { title, body } = clean(fields);
  const brandId = fields.brand_id ? Number(fields.brand_id) : null;
  if (brandId && !store.getBrand(brandId)) throw new Error('找不到品牌');
  const now = new Date().toISOString();
  if (id) {
    if (!store.get('SELECT id FROM reply_templates WHERE id = ?', id)) throw new Error('找不到範本');
    store.run('UPDATE reply_templates SET title = ?, body = ?, brand_id = ?, updated_by = ?, updated_at = ? WHERE id = ?', title, body, brandId, userName, now, id);
  } else {
    const r = store.run('INSERT INTO reply_templates (brand_id, title, body, sort, updated_by, updated_at) VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM reply_templates), ?, ?)', brandId, title, body, userName, now);
    id = Number(r.lastInsertRowid);
  }
  return store.get('SELECT * FROM reply_templates WHERE id = ?', id);
}

// 沒指定訂單時：優先用即將到來的行程，其次最近一筆訂單
function pickOrder(store, customerId, orderId, t) {
  if (orderId) return store.get('SELECT * FROM orders WHERE id = ? AND customer_id = ?', orderId, customerId);
  return store.get("SELECT * FROM orders WHERE customer_id = ? AND status != 'cancelled' AND service_date >= ? ORDER BY service_date, service_time LIMIT 1", customerId, t)
    || store.get("SELECT * FROM orders WHERE customer_id = ? AND status != 'cancelled' ORDER BY COALESCE(service_date, order_date) DESC, id DESC LIMIT 1", customerId);
}

export function renderTemplate(store, config, { templateId, customerId, orderId = null }) {
  const tpl = store.get('SELECT * FROM reply_templates WHERE id = ?', templateId);
  if (!tpl) throw new Error('找不到範本');
  const c = store.getCustomer(customerId);
  if (!c) throw new Error('找不到客戶');
  if (tpl.brand_id && tpl.brand_id !== c.brand_id) throw new Error('這個範本屬於其他品牌');
  const brand = store.getBrand(c.brand_id);
  const o = pickOrder(store, c.id, orderId, today(config.tz));
  const values = {
    姓名: c.real_name || c.display_name || '',
    LINE名稱: c.display_name || '',
    電話: c.phone || '',
    品牌: brand?.name || '',
    匯款資訊: brand?.bank_info || '',
    訂單編號: o ? `#${o.id}` : '',
    服務: SERVICE_TYPES[o?.service_type] || '',
    用車日: shortDate(o?.service_date),
    時間: o?.service_time || '',
    航班: o?.flight_no || '',
    上車地點: o?.pickup || '',
    目的地: o?.dropoff || '',
    車型: o?.items || '',
    金額: o ? `NT$${Number(o.amount || 0).toLocaleString('en-US')}` : '',
    匯款期限: shortDate(o?.payment_due_date),
    訂單狀態: ORDER_STATUSES[o?.status] || '',
  };
  const missing = new Set();
  const text = tpl.body.replace(/\{([^{}\s]{1,10})\}/g, (m, key) => {
    if (!(key in values)) return m;
    if (!values[key]) missing.add(key);
    return values[key];
  });
  return { text, orderId: o?.id ?? null, missing: [...missing] };
}
