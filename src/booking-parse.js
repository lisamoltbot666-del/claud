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
  ['name', /^(聯絡人|連絡人|乘客|訂購人)?(姓名|名字)$|^(聯絡人|連絡人)$/],
  ['phone', /^(聯絡|連絡|聯繫|連繫)?(人)?(電話|手機)(號碼)?$/],
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

// ---------- 一句話寫完的行程 ----------
// 「11/22(日)上午7:50從 高雄市苓雅區義勇路149號 出發，前往台南市大學路1號」
const LEG_START = /(?:(\d{4})[./\-年])?(\d{1,2})[/.月](\d{1,2})日?\s*(?:[（(][^）)]{1,4}[）)])?\s*((?:凌晨|半夜|早上|上午|中午|下午|傍晚|晚上)?\s*\d{1,2}\s*(?:[:：點時]\s*(?:\d{1,2}|半)?)?分?)/g;

export function parseTrips(text, today) {
  const s = toHalf(text || '').replace(/\r?\n/g, '');
  const starts = [...s.matchAll(LEG_START)];
  const legs = [];
  starts.forEach((m, i) => {
    const body = s.slice(m.index + m[0].length, i + 1 < starts.length ? starts[i + 1].index : s.length);
    const from = body.match(/(?:從|由|自)\s*(.+?)\s*(?:出發|上車|搭車|離開|前往|到達|抵達|送到|送往|去|到)/);
    const to = body.match(/(?:前往|到達|抵達|送到|送往|去|到)\s*([^，,。；;!！?？]+)/);
    if (!from && !to) return;
    const date = parseDate(`${m[1] ? `${m[1]}/` : ''}${m[2]}/${m[3]}`, today);
    legs.push({
      date,
      time: parseTime(m[4]),
      from: from ? from[1].replace(/[，,]$/, '').trim() : null,
      to: to ? to[1].replace(/(出發|下車)$/, '').trim() : null,
    });
  });
  return legs.filter((l) => l.date && (l.from || l.to));
}

// ---------- 聯絡人、統編、特殊需求 ----------
export function parseContact(text) {
  const out = {};
  for (const raw of toHalf(text || '').split(/\r?\n/)) {
    const line = raw.trim().replace(/^[➤►▶▸•・\-*\d.、)\s]+/, '');
    const m = line.match(/^([^:]{1,10}):\s*(.+)$/);
    if (!m) continue;
    const label = m[1].replace(/\s/g, '');
    const value = m[2].trim();
    if (!out.real_name && /^(聯絡人|連絡人|聯繫人|乘客|訂購人)?(姓名|名字)$|^(聯絡人|連絡人|聯繫人)$/.test(label)) out.real_name = value.slice(0, 40);
    else if (!out.phone && /(電話|手機)/.test(label) && /\d{8,}/.test(value.replace(/\D/g, ''))) out.phone = value.replace(/[^\d+\-() ]/g, '').trim();
    else if (!out.tax_id && /統(一)?編(號)?/.test(label) && /\d{8}/.test(value)) out.tax_id = value.match(/\d{8}/)[0];
    else if (!out.invoice_title && /抬頭/.test(label)) out.invoice_title = value.slice(0, 80);
  }
  if (!out.tax_id) {
    const t = toHalf(text || '').match(/統(?:一)?編(?:號)?\s*[:：]?\s*(\d{8})/);
    if (t) out.tax_id = t[1];
  }
  return out;
}

// 客人提到、客服需要注意的事
const NEED_PATTERN = /統編|發票|收據|抬頭|匯款|轉帳|月結|作帳|兒童座椅|安全座椅|增高墊|嬰兒|輪椅|寵物|大型行李|高爾夫|滑雪|舉牌|接機牌|中途停|停靠|加點|回程|來回|包車/;

export function findNeeds(text) {
  return String(text || '').split(/\r?\n|。/).map((l) => l.trim()).filter((l) => l && NEED_PATTERN.test(l) && !/^[➤►▶▸]/.test(l) && !/^[✅✔☑※]/.test(l));
}

function serviceHint(text) {
  if (/包車/.test(text)) return 'charter';
  if (/租車|自駕|取車|還車/.test(text)) return 'rental';
  if (/機場|航廈|航班|接機|送機/.test(text)) return 'airport';
  return null;
}

// 把一段對話（多則訊息）整理成一張預約草稿
export function draftFromMessages(messages, today) {
  let anchor = null;
  let fields = null;
  for (const m of [...messages].reverse()) {
    const form = parseBookingForm(m.text, today);
    if (form) { anchor = m; fields = form; break; }
    const legs = parseTrips(m.text, today);
    if (legs.length) {
      const [first, ...rest] = legs;
      const all = messages.map((x) => x.text).join('\n');
      const pax = toHalf(all).match(/(\d+)\s*(?:位|個|名)?\s*(?:成人|大人|乘客|人)/);
      const lastDate = legs.at(-1).date;
      fields = {
        service_type: serviceHint(all),
        service_date: first.date,
        service_time: first.time,
        flight_no: null,
        pickup: first.from,
        dropoff: first.to,
        return_date: lastDate !== first.date ? lastDate : null,
        items: null,
        note: [
          pax ? `${pax[1]} 人` : '',
          ...rest.map((l) => `${/來回/.test(all) || l.from === first.to ? '回程' : '行程'} ${l.date.slice(5).replace('-', '/')} ${l.time || ''} ${[l.from, l.to].filter(Boolean).join(' → ')}`.replace(/\s+/g, ' ').trim()),
        ].filter(Boolean).join('、') || null,
        real_name: null,
        phone: null,
        passengers: pax ? Number(pax[1]) : null,
        luggage: null,
        legs,
      };
      anchor = m;
      break;
    }
  }
  if (!anchor) return null;
  // 同一段對話（預約單前後 2 天內）的聯絡資料、統編、特殊需求一起整理
  const near = messages.filter((m) => Math.abs(Date.parse(m.created_at) - Date.parse(anchor.created_at)) <= 2 * 86400000);
  const contact = {};
  const needs = [];
  for (const m of near) {
    const c = parseContact(m.text);
    for (const [k, v] of Object.entries(c)) contact[k] = v; // 後面的訊息為準
    for (const n of findNeeds(m.text)) {
      // 統編、抬頭已經單獨整理，不重複列
      if (m.id === anchor.id || needs.includes(n) || /^(統(一)?編(號)?|抬頭)\s*[:：]/.test(toHalf(n))) continue;
      needs.push(n);
    }
  }
  fields.real_name = fields.real_name || contact.real_name || null;
  fields.phone = fields.phone || contact.phone || null;
  fields.tax_id = contact.tax_id || null;
  fields.invoice_title = contact.invoice_title || null;
  fields.needs = needs.slice(0, 8);
  return { message_id: anchor.id, at: anchor.created_at, fields };
}

// 這位客人最近一張還沒處理的預約單（已建立訂單或客服按略過的不算）
export function latestBookingDraft(store, customerId, today, { since = null } = {}) {
  const dismissed = Number(store.getKv(`booking_dismiss:${customerId}`) || 0);
  const rows = store.all(
    `SELECT id, text, created_at FROM messages WHERE customer_id = ? AND direction = 'in' AND type = 'text' AND id > ?${since ? ' AND created_at >= ?' : ''} ORDER BY id DESC LIMIT 40`,
    customerId, dismissed, ...(since ? [since] : []),
  ).reverse();
  const draft = draftFromMessages(rows, today);
  if (!draft) return null;
  const used = store.get('SELECT 1 AS x FROM orders WHERE customer_id = ? AND source_message_id >= ?', customerId, draft.message_id);
  return used ? null : draft;
}
