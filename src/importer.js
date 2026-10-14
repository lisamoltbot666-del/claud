import { today } from './dates.js';

// 從 CSV 匯入舊客戶與訂單。
// 可直接吃：本系統的匯入範本、首席後台「匯出全部訂單 CSV」、Airtable 匯出的 CSV，
// 以及其他欄位名稱相近的表格（欄位會自動對應，也可在後台手動調整）。

export const IMPORT_FIELDS = [
  // [欄位, 說明, 可辨識的欄位名稱（依優先順序）]
  ['brand', '品牌', ['品牌', 'brand', '官方帳號', '來源品牌']],
  ['line_user_id', 'LINE userId', ['lineuserid', 'line_user_id', 'userid']],
  ['display_name', 'LINE 名稱', ['line名稱', 'line暱稱', 'display_name', '暱稱']],
  ['real_name', '姓名', ['姓名', '客戶姓名', '客戶', '聯絡人', '乘客姓名', 'name']],
  ['phone', '電話', ['電話', '手機', '聯絡電話', 'phone', '電話/lineid', '手機號碼']],
  ['email', 'Email', ['email', 'e-mail', '信箱', '電子郵件']],
  ['birthday', '生日', ['生日', 'birthday']],
  ['address', '地址', ['地址', 'address']],
  ['tags', '標籤', ['標籤', 'tags']],
  ['customer_note', '客戶備註', ['客戶備註', '黑名單備註']],
  ['external_id', '原訂單編號', ['訂單編號', '原訂單編號', '單號', '編號', 'id', 'order_id']],
  ['order_date', '下單日', ['下單日', '訂單日期', '下單時間', '建立時間', 'created_at']],
  ['service_date', '用車日', ['用車日', '用車日期', '用車時間', '出發日期時間', '出發時間', '出發日期', 'depart_at', '取車日', '日期']],
  ['service_time', '用車時間（另一欄）', ['時間', '用車時刻', '上車時間']],
  ['service_type', '服務類型', ['服務類型', '服務', '類型', 'mode']],
  ['flight_no', '航班', ['航班', '航班編號', '航班號碼', 'flight', 'flight_no']],
  ['pickup', '上車／取車地點', ['上車地點', '出發地', '取車地點', '上車', 'from_addr']],
  ['dropoff', '目的地／還車地點', ['目的地', '下車地點', '還車地點', 'to_addr']],
  ['return_date', '結束／還車日', ['還車日', '結束日', '還車日期', 'return_date']],
  ['amount', '金額', ['金額', '報價金額', '應收金額', '總金額', '價格', 'quote_total', 'amount']],
  ['status', '訂單狀態', ['訂單狀態', '狀態', 'status']],
  ['payment_status', '付款狀態', ['付款狀態', 'payment_status']],
  ['items', '車型／內容', ['車型', '使用車輛', '品項', '內容', 'car_type_name']],
  ['order_note', '訂單備註', ['備註', '訂單備註', 'note']],
];

export const TEMPLATE_HEADERS = ['品牌', 'LINE名稱', '姓名', '電話', 'Email', '生日', '地址', '標籤', '客戶備註', '訂單編號', '下單日', '用車日', '時間', '服務類型', '航班', '上車地點', '目的地', '還車日', '金額', '訂單狀態', '付款狀態', '車型', '備註'];
export const TEMPLATE_EXAMPLE = ['享運', '小美', '王小美', '0912-345-678', '', '', '', 'VIP', '', 'A001', '2026-03-01', '2026-03-05', '06:30', '機場接送', 'BR198', '台北市信義區松仁路 100 號', '桃園機場第二航廈', '', '1200', '已完成', '已付款', '5 人座', ''];

const norm = (h) => String(h ?? '').replace(/^﻿/, '').toLowerCase().replace(/[\s'"＿_（）()]/g, '');

// RFC 4180 CSV（也支援 Tab 分隔）
export function parseCsv(text) {
  text = String(text ?? '').replace(/^﻿/, '');
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const delim = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows;
}

export function guessMapping(headers) {
  const mapping = {};
  const used = new Set();
  const normalized = headers.map(norm);
  for (const [key, , synonyms] of IMPORT_FIELDS) {
    for (const syn of synonyms) {
      const idx = normalized.findIndex((h, i) => !used.has(i) && h === norm(syn));
      if (idx !== -1) { mapping[key] = headers[idx]; used.add(idx); break; }
    }
  }
  return mapping;
}

const pad = (n) => String(n).padStart(2, '0');

// 各種日期寫法 → { date: 'YYYY-MM-DD', time: 'HH:MM' | null }
export function parseDateTime(value, tz = 'Asia/Taipei') {
  const v = String(value ?? '').trim();
  if (!v) return null;
  // ISO 含時區（Airtable 等系統常見）→ 換成店家時區
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && /(Z|[+-]\d{2}:?\d{2})$/.test(v)) {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
  }
  let y; let mo; let d; let rest;
  let m = v.match(/^(\d{2,4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(.*)$/);
  if (m) {
    [, y, mo, d, rest] = m;
    y = Number(y);
    if (y < 1911) y += 1911; // 民國年
  } else if ((m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(.*)$/))) {
    [, mo, d, y, rest] = m; // 美式 M/D/YYYY
    y = Number(y);
  } else return null;
  mo = Number(mo); d = Number(d);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { date: `${y}-${pad(mo)}-${pad(d)}`, time: parseTime(rest) };
}

export function parseTime(value) {
  const m = String(value ?? '').match(/(上午|下午|早上|晚上)?\s*(\d{1,2})[:：](\d{2})(?::\d{2})?\s*([AaPp][Mm])?/);
  if (!m) return null;
  let h = Number(m[2]);
  const pm = /[Pp]/.test(m[4] || '') || /下午|晚上/.test(m[1] || '');
  const am = /[Aa]/.test(m[4] || '') || /上午|早上/.test(m[1] || '');
  if (pm && h < 12) h += 12;
  if (am && h === 12) h = 0;
  if (h > 23 || Number(m[3]) > 59) return null;
  return `${pad(h)}:${m[3]}`;
}

export function mapServiceType(value) {
  const v = String(value ?? '').toLowerCase();
  if (!v.trim()) return null;
  if (/租車|自駕|rental|rent/.test(v)) return 'rental';
  if (/包車|旅遊|charter|一日|半日/.test(v)) return 'charter';
  if (/機場|接機|送機|接送|airport|p2p|點對點|transfer/.test(v)) return 'airport';
  return null;
}

// 舊系統的狀態 → 本系統的狀態；已經過了用車日的訂單（未取消）視為已完成，避免舊單變成待付款提醒
export function mapStatus(statusValue, paymentValue, serviceDate, todayStr) {
  const s = String(statusValue ?? '').toLowerCase();
  const p = String(paymentValue ?? '').toLowerCase();
  if (/cancel|取消|作廢/.test(s)) return 'cancelled';
  if (/done|complete|完成|結案/.test(s)) return 'completed';
  if (serviceDate && serviceDate < todayStr) return 'completed';
  if (/dispatch|派車|執行中|進行中|shipped/.test(s)) return 'shipped';
  const unpaid = /unpaid|未付|未收|待付|部分/.test(p);
  if ((!unpaid && /已付|付清|paid|已收|已匯/.test(p)) || /^(paid|已付款|已匯款)$/.test(s)) return 'paid';
  return 'pending_payment';
}

const digits = (v) => String(v ?? '').replace(/\D/g, '');
const phoneKey = (v) => { const d = digits(v); return d.length >= 8 ? d.slice(-9) : ''; };
const amountOf = (v) => { const n = Number(String(v ?? '').replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? Math.round(n) : 0; };

function findBrand(brands, value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return null;
  return brands.find((b) => b.name.toLowerCase() === v || b.slug === v)
    || brands.find((b) => v.includes(b.name.toLowerCase()) || v.includes(b.slug)) || null;
}

/**
 * 匯入（或試算）。dryRun = true 時全部在交易內執行後還原，回傳同樣的統計，供預覽使用。
 * @param {{ csv: string, mapping?: object, brandId?: number|null, dryRun?: boolean }} opts
 */
export function runImport(store, config, { csv, mapping = null, brandId = null, dryRun = true }) {
  const rows = parseCsv(csv);
  if (!rows.length) throw new Error('檔案是空的');
  const headers = rows[0].map((h) => h.replace(/^﻿/, '').trim());
  const map = mapping || guessMapping(headers);
  const col = Object.fromEntries(Object.entries(map).filter(([, h]) => h).map(([k, h]) => [k, headers.indexOf(h)]).filter(([, i]) => i !== -1));
  const brands = store.listBrands();
  const fixedBrand = brandId ? brands.find((b) => b.id === Number(brandId)) : null;
  if (brandId && !fixedBrand) throw new Error('找不到品牌');
  if (!fixedBrand && col.brand === undefined) throw new Error('請選擇要匯入的品牌，或對應檔案中的「品牌」欄位');
  if (col.real_name === undefined && col.display_name === undefined && col.phone === undefined && col.line_user_id === undefined) {
    throw new Error('至少需要「姓名」、「LINE 名稱」或「電話」其中一個欄位');
  }

  const t = today(config.tz);
  const stats = { rows: rows.length - 1, customersCreated: 0, customersMatched: 0, ordersCreated: 0, ordersSkipped: 0, errors: [] };
  const sample = [];
  const indexes = new Map(); // brandId → { byLine, byPhone, byName }
  const indexFor = (bid) => {
    if (!indexes.has(bid)) {
      const idx = { byLine: new Map(), byPhone: new Map(), byName: new Map() };
      for (const c of store.all('SELECT * FROM customers WHERE brand_id = ?', bid)) {
        if (c.line_user_id) idx.byLine.set(c.line_user_id, c.id);
        if (phoneKey(c.phone)) idx.byPhone.set(phoneKey(c.phone), c.id);
        for (const n of [c.real_name, c.display_name]) if (n && !idx.byName.has(n.trim())) idx.byName.set(n.trim(), c.id);
      }
      indexes.set(bid, idx);
    }
    return indexes.get(bid);
  };
  const touched = new Set();

  store.db.exec('BEGIN');
  try {
    for (let r = 1; r < rows.length; r++) {
      const raw = rows[r];
      const get = (k) => (col[k] === undefined ? '' : String(raw[col[k]] ?? '').trim());
      const rowNo = r + 1;
      try {
        const brand = fixedBrand || findBrand(brands, get('brand'));
        if (!brand) throw new Error(`找不到品牌「${get('brand')}」`);
        const idx = indexFor(brand.id);

        // ---- 客戶：依 LINE userId → 電話 → 姓名 對應現有客戶，找不到就新增 ----
        const name = get('real_name');
        const display = get('display_name');
        const phone = get('phone');
        const lineId = get('line_user_id');
        if (!name && !display && !phoneKey(phone) && !lineId) throw new Error('沒有姓名、LINE 名稱或電話');
        let customerId = (lineId && idx.byLine.get(lineId)) || (phoneKey(phone) && idx.byPhone.get(phoneKey(phone)))
          || (name && idx.byName.get(name)) || (display && idx.byName.get(display)) || null;
        const profile = {
          real_name: name, phone, email: get('email'), address: get('address'), tags: get('tags'), note: get('customer_note'),
          birthday: parseDateTime(get('birthday'))?.date || '',
        };
        if (customerId) {
          // 只補空白欄位，不覆蓋後台已有資料
          const c = store.getCustomer(customerId);
          const fill = Object.fromEntries(Object.entries(profile).filter(([k, v]) => v && !c[k]));
          if (Object.keys(fill).length) store.updateCustomer(customerId, fill);
          if (!touched.has(customerId)) { stats.customersMatched++; touched.add(customerId); }
        } else {
          let c;
          if (lineId) {
            c = store.upsertLineCustomer(brand.id, lineId, { displayName: display || name });
            store.run('UPDATE customers SET is_friend = 0, followed_at = NULL WHERE id = ?', c.id); // 不確定是否仍是好友
            c = store.updateCustomer(c.id, Object.fromEntries(Object.entries(profile).filter(([, v]) => v)));
          } else {
            c = store.createCustomer(brand.id, { display_name: display || name || phone, ...Object.fromEntries(Object.entries(profile).filter(([, v]) => v)) });
          }
          customerId = c.id;
          stats.customersCreated++;
          touched.add(customerId);
          if (lineId) idx.byLine.set(lineId, customerId);
          if (phoneKey(phone)) idx.byPhone.set(phoneKey(phone), customerId);
          for (const n of [name, display]) if (n && !idx.byName.has(n)) idx.byName.set(n, customerId);
        }

        // ---- 訂單：有用車日、下單日或金額才建立 ----
        const svc = parseDateTime(get('service_date'));
        const placed = parseDateTime(get('order_date'));
        const amount = amountOf(get('amount'));
        if (!svc && !placed && !amount && !get('external_id')) continue; // 只有客戶資料的列
        const serviceDate = svc?.date || null;
        const order = {
          order_date: placed?.date || serviceDate || t,
          service_date: serviceDate,
          service_time: parseTime(get('service_time')) || svc?.time || null,
          service_type: mapServiceType(get('service_type')),
          flight_no: get('flight_no') || null,
          pickup: get('pickup') || null,
          dropoff: get('dropoff') || null,
          return_date: parseDateTime(get('return_date'))?.date || null,
          amount,
          items: get('items') || null,
          note: get('order_note') || null,
          status: mapStatus(get('status'), get('payment_status'), serviceDate, t),
        };
        const ext = get('external_id');
        const ref = ext
          ? `${brand.id}:${ext}`
          : `${brand.id}:${customerId}:${order.service_date || order.order_date}:${order.service_time || ''}:${amount}:${order.pickup || ''}`;
        if (store.get('SELECT id FROM orders WHERE import_ref = ?', ref)) { stats.ordersSkipped++; continue; }
        const created = store.createOrder(customerId, order); // 匯入的舊單不設匯款期限，不會觸發催款
        store.run('UPDATE orders SET import_ref = ? WHERE id = ?', ref, created.id);
        stats.ordersCreated++;
        if (sample.length < 5) sample.push({ row: rowNo, brand: brand.name, customer: name || display || phone, ...order });
      } catch (e) {
        stats.errors.push({ row: rowNo, message: e.message });
      }
    }
    store.db.exec(dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (e) {
    store.db.exec('ROLLBACK');
    throw e;
  }
  return { headers, mapping: map, fields: IMPORT_FIELDS.map(([key, label]) => ({ key, label })), sample, stats, dryRun };
}
