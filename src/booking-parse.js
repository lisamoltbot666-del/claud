import { addDays } from './dates.js';

// 辨識客人在 LINE 傳來的預約單，例如：
//   ➤接送日期：2026.11.05
//   ➤預約時間：凌晨4：00
//   ➤航班編號：BR108
//   ➤聯絡人姓名：林定緯 …
// 只做辨識與預填，不會自動建立訂單或回覆客人。

const FIELDS = [
  ['date', /^(接送|用車|預約|出發|取車|搭乘|服務)?日期$/],
  ['flight_time', /^航班(抵達|起飛)?時間$/],
  ['time', /^(預約|接送|用車|出發|上車|取車)?時間$/],
  ['flight', /^航班(編號|號碼)?$|^班機(編號|號碼)?$/],
  ['name', /^(聯絡人|乘客|訂購人)?(姓名|名字)$|^聯絡人$/],
  ['phone', /^(聯絡|聯繫)?(電話|手機)(號碼)?$/],
  ['passengers', /^(乘車|乘客|搭乘)?人數$/],
  ['luggage', /^行李(數量|件數|數)?$/],
  ['car', /^(指定)?(車型|車款)$/],
  ['pickup', /^(上車|出發|取車|接送)(地點|地址)?$/],
  ['dropoff', /^(下車|目的|到達|抵達|還車)(地點|地址)?$|^目的地$/],
  ['return_date', /^(還車|回程|結束)日期$/],
  ['note', /需求|備註/],
];
const CONTINUE = new Set(['pickup', 'dropoff', 'note']);

const toHalf = (s) => String(s).replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, ' ');

export function parseDate(text, today) {
  const s = toHalf(text).replace(/\s/g, '');
  let m = s.match(/(\d{4})[./\-年](\d{1,2})[./\-月](\d{1,2})/);
  let y; let mo; let d;
  if (m) [, y, mo, d] = m.map(Number);
  else {
    m = s.match(/(\d{1,2})[./\-月](\d{1,2})/);
    if (!m) return null;
    [, mo, d] = m.map(Number);
    y = Number(today.slice(0, 4));
    // 沒寫年份：已經過了一個月以上的日期，視為明年
    if (`${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` < addDays(today, -30)) y += 1;
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseTime(text) {
  const s = toHalf(text).replace(/\s/g, '');
  const m = s.match(/(\d{1,2})(?:[:點時](\d{1,2}|半)?)?/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] === '半' ? 30 : Number(m[2] || 0);
  if (/下午|晚上|傍晚|夜間|pm/i.test(s) && h < 12) h += 12;
  else if (/凌晨|半夜/.test(s) && h === 12) h = 0;
  else if (/中午/.test(s) && h < 11) h += 12;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function parseBookingForm(text, today) {
  if (!text || text.length > 2000) return null;
  const raw = {};
  let last = null;
  for (let line of String(text).split(/\r?\n/)) {
    line = line.trim();
    if (!line || /^[✅✔☑※]/.test(line)) continue;
    const stripped = line.replace(/^[➤►▶▸•・\-*＊\d０-９.、)）\s]+/, '');
    const m = stripped.match(/^([^：:]{1,14})[：:]\s*(.*)$/);
    const label = m ? m[1].replace(/\s/g, '') : '';
    const key = m && FIELDS.find(([, re]) => re.test(label) || re.test(label.split(/[／/]/)[0]))?.[0];
    if (key) {
      raw[key] = m[2].trim();
      last = key;
    } else if (last && CONTINUE.has(last)) {
      raw[last] = `${raw[last]}${last === 'note' && raw[last] ? ' ' : ''}${line}`;
    } else {
      last = null;
    }
  }
  const keys = Object.keys(raw).filter((k) => raw[k] !== undefined);
  if (keys.length < 3 || !['date', 'pickup', 'dropoff', 'flight'].some((k) => raw[k])) return null;

  const all = `${raw.pickup || ''} ${raw.dropoff || ''}`;
  const service_type = /租車|取車|還車/.test(text) && !raw.flight ? 'rental'
    : /包車/.test(text) ? 'charter'
      : raw.flight || /機場|航廈|airport/i.test(all) || /接送/.test(text) ? 'airport' : null;
  const passengers = raw.passengers && toHalf(raw.passengers).match(/\d+/)?.[0];
  const luggage = raw.luggage && toHalf(raw.luggage).match(/\d+/)?.[0];
  const car = raw.car && !/^(無|不指定|都可以|皆可|-|—)?$/.test(raw.car) ? raw.car : '';
  const noteParts = [
    passengers ? `${passengers} 人` : '',
    luggage ? `行李 ${luggage} 件` : '',
    raw.flight_time ? `航班時間 ${raw.flight_time}` : '',
    raw.note && !/^(無|沒有|-|—)$/.test(raw.note) ? raw.note : '',
  ].filter(Boolean);
  const out = {
    service_type,
    service_date: raw.date ? parseDate(raw.date, today) : null,
    service_time: raw.time ? parseTime(raw.time) : null,
    flight_no: raw.flight ? toHalf(raw.flight).replace(/\s/g, '').toUpperCase().slice(0, 12) || null : null,
    pickup: raw.pickup || null,
    dropoff: raw.dropoff || null,
    return_date: raw.return_date ? parseDate(raw.return_date, today) : null,
    items: car || null,
    note: noteParts.join('、') || null,
    real_name: raw.name ? raw.name.slice(0, 40) : null,
    phone: raw.phone ? toHalf(raw.phone).replace(/[^\d+\-() ]/g, '').trim() || null : null,
    passengers: passengers ? Number(passengers) : null,
    luggage: luggage ? Number(luggage) : null,
  };
  return out;
}

// 匯款／轉帳回報
export const PAID_PATTERN = /(已|有)?(匯款|轉帳|付款)(完成|好了|了)|已經?(匯|轉|付)|末[五5]碼|(匯|轉)(款|帳)\s*(NT)?\$?\s*\d/i;

// 這位客人最近一張還沒處理的預約單（已建立訂單或客服按略過的不算）
export function latestBookingDraft(store, customerId, today, { since = null } = {}) {
  const dismissed = Number(store.getKv(`booking_dismiss:${customerId}`) || 0);
  const used = new Set(store.all('SELECT source_message_id AS id FROM orders WHERE customer_id = ? AND source_message_id IS NOT NULL', customerId).map((r) => r.id));
  const rows = store.all(
    `SELECT id, text, created_at FROM messages WHERE customer_id = ? AND direction = 'in' AND type = 'text' AND id > ?${since ? ' AND created_at >= ?' : ''} ORDER BY id DESC LIMIT 50`,
    customerId, dismissed, ...(since ? [since] : []),
  );
  for (const r of rows) {
    if (used.has(r.id)) return null; // 最新的一張已經建立訂單了
    const fields = parseBookingForm(r.text, today);
    if (fields) return { message_id: r.id, at: r.created_at, fields };
  }
  return null;
}
