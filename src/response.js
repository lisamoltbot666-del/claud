import { addDays, dateOf } from './dates.js';
import { allLeads } from './leads.js';

// 客服回覆速度與績效。
// 「等待」＝客人傳訊息、而客服還沒回覆的這段時間。
// 客服在 LINE 官方帳號 App 回覆時，LINE 不會通知本系統，所以用對話節奏估計：
//   客人隔了 GAP_MINUTES 以上又傳訊息，代表中間客服回覆過 → 以客人下一則訊息的時間當作回覆時間（估計，會比實際稍長）。
//   客服在後台傳訊息、或按「已回覆」，則是精確時間，並算在該客服名下。
//   估計超過 ESTIMATE_MAX 分鐘的不計（可能客服早就回了、只是客人隔天才回話）；客人沒再傳訊息的對話也無法判斷、不計。
// 只計算營業時間（預設 9–21 點）內的等待，半夜傳來的訊息不會讓客服看起來回得很慢。

export const GAP_MINUTES = 10;
export const ESTIMATE_MAX = 240;

export const HANDLED_ACTION = '標記已回覆';
const AUTO = '系統自動';

// 時區與 UTC 的差（分鐘），例：台北 +480
function tzOffset(tz, at) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map((x) => [x.type, x.value]));
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(at.getTime() / 60000) * 60000) / 60000);
}

// 兩個時間點之間，落在營業時間內的分鐘數
export function businessMinutes(startIso, endIso, tz, [open, close] = [9, 21]) {
  const off = tzOffset(tz, new Date(startIso)) * 60000;
  let s = Date.parse(startIso) + off; // 以「當地時間」計算
  const e = Date.parse(endIso) + off;
  if (open === 0 && close === 24) return Math.max(0, (e - s) / 60000);
  let total = 0;
  while (s < e) {
    const day = Math.floor(s / 86400000) * 86400000;
    const a = Math.max(s, day + open * 3600000);
    const b = Math.min(e, day + close * 3600000);
    if (b > a) total += b - a;
    s = day + 86400000;
  }
  return total / 60000;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
};

export function formatMinutes(m) {
  if (m == null) return '—';
  if (m < 60) return `${Math.round(m)} 分鐘`;
  const h = m / 60;
  return `${h < 10 ? Math.round(h * 10) / 10 : Math.round(h)} 小時`;
}

const summarize = (all) => {
  const waits = all.filter((w) => w.minutes != null);
  const mins = waits.map((w) => w.minutes);
  return {
    waits: waits.length,
    answered: waits.length,
    exact: waits.filter((w) => !w.estimated).length,
    estimated: waits.filter((w) => w.estimated).length,
    unknown: all.length - waits.length, // 客人沒再傳訊息、或間隔太久，無法判斷
    median: median(mins),
    within1h: waits.length ? waits.filter((w) => w.minutes <= 60).length / waits.length : 0,
    // 超過 4 小時只算精確紀錄（估計值太長的本來就不計）
    over4h: waits.filter((w) => !w.estimated && w.minutes > 240).length,
  };
};

// 期間內每一段「等待」：開始時間、誰回覆、營業時間內等了幾分鐘
function collectWaits(store, config, { from, to, ids }) {
  const tz = config.tz;
  // 期間開始前一天抓起，確保時區換算不漏
  const since = `${addDays(from, -1)}T00:00:00.000Z`;
  const bWhere = ids ? ` AND c.brand_id IN (${ids.map(() => '?').join(',')})` : '';
  const bArgs = ids || [];
  const internal = store.internalIds();
  const events = [
    ...store.all(`SELECT m.customer_id, c.brand_id, m.created_at AS at, 'in' AS kind, NULL AS who FROM messages m JOIN customers c ON c.id = m.customer_id
      WHERE m.direction = 'in' AND m.created_at >= ?${bWhere}`, since, ...bArgs),
    ...store.all(`SELECT m.customer_id, c.brand_id, m.created_at AS at, 'reply' AS kind, m.staff_name AS who FROM messages m JOIN customers c ON c.id = m.customer_id
      WHERE m.direction = 'out' AND m.staff_name IS NOT NULL AND m.staff_name != ? AND m.created_at >= ?${bWhere}`, AUTO, since, ...bArgs),
    ...store.all(`SELECT a.customer_id, c.brand_id, a.at, 'reply' AS kind, a.user_name AS who FROM activity a JOIN customers c ON c.id = a.customer_id
      WHERE a.action = ? AND a.at >= ?${bWhere}`, HANDLED_ACTION, since, ...bArgs),
  ].filter((e) => !internal.has(e.customer_id));
  events.sort((a, b) => a.customer_id - b.customer_id || (a.at < b.at ? -1 : a.at > b.at ? 1 : a.kind === 'in' ? -1 : 1));

  const waits = [];
  let open = null;
  let current = null;
  for (const e of events) {
    if (e.customer_id !== current) {
      current = e.customer_id;
      open = null;
    }
    if (e.kind === 'in') {
      // 客人隔一段時間又傳訊息 → 推定中間客服回覆過
      if (open && Date.parse(e.at) - Date.parse(open.lastIn) >= GAP_MINUTES * 60000) {
        const m = businessMinutes(open.start, e.at, tz, config.businessHours);
        if (m <= ESTIMATE_MAX) Object.assign(open, { minutes: m, estimated: true, end: e.at });
        open = null;
      }
      if (!open) {
        const date = dateOf(e.at, tz);
        open = { customer_id: e.customer_id, brand_id: e.brand_id, start: e.at, lastIn: e.at, date, minutes: null, who: null, estimated: false };
        if (date >= from && date <= to) waits.push(open);
      } else {
        open.lastIn = e.at;
      }
    } else if (open) {
      open.minutes = businessMinutes(open.start, e.at, tz, config.businessHours);
      open.who = e.who || '未知';
      open.end = e.at;
      open = null;
    }
  }
  return waits;
}

export function buildResponse(store, config, { from, to, brandId = null, brandIds = null }) {
  if (from > to) [from, to] = [to, from];
  const ids = brandIds?.length ? brandIds : brandId ? [brandId] : null;
  const waits = collectWaits(store, config, { from, to, ids });
  const totals = summarize(waits);

  const byBrand = [...new Set(waits.map((w) => w.brand_id))]
    .map((id) => ({ brand_id: id, ...summarize(waits.filter((w) => w.brand_id === id)) }))
    .sort((a, b) => b.waits - a.waits);

  // 客服績效：回覆了幾段等待、回覆速度、負責的新詢問成交了幾位、傳了幾則訊息
  const staff = new Map();
  const row = (name) => {
    if (!staff.has(name)) staff.set(name, { name, minutes: [], leads: 0, won: 0, messages: 0, reminders: 0 });
    return staff.get(name);
  };
  for (const w of waits) if (w.who) row(w.who).minutes.push(w.minutes);
  const firstWait = new Map();
  for (const w of waits) if (!firstWait.has(w.customer_id)) firstWait.set(w.customer_id, w);
  for (const l of allLeads(store, config, { brandIds: ids }).filter((x) => x.date >= from && x.date <= to)) {
    const w = firstWait.get(l.customer.id);
    if (!w?.who || w.date !== l.date) continue;
    const s = row(w.who);
    s.leads++;
    if (l.status === 'won') s.won++;
  }
  const bWhere = ids ? ` AND c.brand_id IN (${ids.map(() => '?').join(',')})` : '';
  const off = tzOffset(config.tz, new Date(`${from}T12:00:00Z`)) * 60000; // 店家時區的日期 → UTC 時間範圍
  const range = [new Date(Date.parse(`${from}T00:00:00Z`) - off).toISOString(), new Date(Date.parse(`${addDays(to, 1)}T00:00:00Z`) - off).toISOString()];
  for (const r of store.all(`SELECT m.staff_name AS name, COUNT(*) AS n FROM messages m JOIN customers c ON c.id = m.customer_id
    WHERE m.direction = 'out' AND m.staff_name IS NOT NULL AND m.staff_name != ? AND m.created_at >= ? AND m.created_at < ?${bWhere} GROUP BY m.staff_name`, AUTO, ...range, ...(ids || []))) row(r.name).messages = r.n;
  const byStaff = [...staff.values()].map((s) => ({
    name: s.name,
    replies: s.minutes.length,
    median: median(s.minutes),
    within1h: s.minutes.length ? s.minutes.filter((m) => m <= 60).length / s.minutes.length : 0,
    messages: s.messages,
    leads: s.leads,
    won: s.won,
    rate: s.leads ? s.won / s.leads : 0,
  })).sort((a, b) => b.replies - a.replies || b.messages - a.messages);

  // 幾點收到的訊息回得最慢（依客人傳訊的時段）
  const hourOf = (iso) => Number(new Intl.DateTimeFormat('en-US', { timeZone: config.tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(iso)));
  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, ...summarize(waits.filter((w) => hourOf(w.start) === h)) })).filter((h) => h.waits);

  const insights = [];
  if (totals.answered) {
    insights.push(`營業時間內回覆時間中位數約 ${formatMinutes(totals.median)}，${Math.round(totals.within1h * 100)}% 在 1 小時內回覆${totals.estimated ? `（其中 ${totals.estimated} 次是依對話節奏估計）` : ''}。`);
    if (totals.over4h) insights.push(`有 ${totals.over4h} 次讓客人等超過 4 小時，客人很可能已經找別家了。`);
    const slow = byHour.filter((h) => h.answered >= 3 && h.median > Math.max(30, (totals.median || 0) * 2));
    if (slow.length) insights.push(`${slow.map((h) => `${h.hour} 點`).join('、')}收到的訊息回得特別慢，這些時段請安排人手。`);
  }

  return { from, to, businessHours: config.businessHours, totals, byBrand, byStaff, byHour, insights };
}
