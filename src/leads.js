import { bucketKey, listBuckets, resolveGranularity } from './buckets.js';
import { addDays, dateOf, diffDays, today } from './dates.js';

// 詢問 → 成交分析。
// 「詢問」＝ LINE 好友第一次傳訊息給官方帳號（之前沒訂過的客人；老客人再來問不算新詢問）。
// 結果：成交（詢問日之後有訂單）、未成交（客服標記了原因）、洽談中（還在追）、
//      逾期未標記（超過 STALE_DAYS 天沒成交、也沒標記原因）。

export const STALE_DAYS = 7;
export const LOST_REASONS = ['價格考量', '日期／時段沒車', '只是詢價比較', '選擇其他業者', '行程取消或改期', '聯絡不上／沒回覆', '不在服務範圍', '其他'];
export const UNMARKED = '未標記原因';
const PAID = new Set(['paid', 'shipped', 'completed']);

const SUGGESTIONS = {
  價格考量: '檢視報價是否偏高；報價時說明車型、司機與服務的差異，可考慮早鳥或回頭客優惠。',
  '日期／時段沒車': '熱門日期與時段車不夠：提早排班、增加合作車隊或司機，客滿時主動推薦替代時段。',
  只是詢價比較: '報價後 24 小時內追蹤一次，附上客人評價、準時保證或取消政策，提高信任感。',
  選擇其他業者: '了解客人選別家的原因（價格、車型、回覆速度），調整方案與話術。',
  行程取消或改期: '記下新的日期並設定「下次聯絡日」，時間到了系統會提醒再追蹤。',
  '聯絡不上／沒回覆': '加快第一次回覆速度，報價後隔天再追一次；可善用常用回覆範本。',
  不在服務範圍: '評估是否擴大服務區域，或與其他地區業者合作轉介。',
  其他: '請客服在備註寫下具體原因，累積後再找出共通點。',
  [UNMARKED]: '請客服在客戶資料中標記未成交原因，分析才會準確。',
};

/** 所有「詢問」：每位 LINE 客人第一次傳訊息的時間，以及之後是否成交 */
export function allLeads(store, config, { brandId = null, brandIds = null } = {}) {
  const ids = brandIds?.length ? brandIds : brandId ? [brandId] : null;
  const tz = config.tz;
  const t = today(tz);
  const internal = store.internalIds();
  const firsts = store.all(
    `SELECT m.customer_id, MIN(m.created_at) AS first_at FROM messages m JOIN customers c ON c.id = m.customer_id
     WHERE m.direction = 'in' AND c.line_user_id IS NOT NULL${ids ? ` AND c.brand_id IN (${ids.map(() => '?').join(',')})` : ''} GROUP BY m.customer_id`,
    ...(ids || []),
  );
  const leads = [];
  for (const f of firsts) {
    if (internal.has(f.customer_id)) continue;
    const c = store.getCustomer(f.customer_id);
    const date = dateOf(f.first_at, tz);
    const orders = store.all("SELECT * FROM orders WHERE customer_id = ? AND status != 'cancelled' ORDER BY order_date, id", c.id);
    if (orders.some((o) => o.order_date < date)) continue; // 老客人，不算新詢問
    const won = orders.filter((o) => o.order_date >= date);
    let status;
    if (won.length) status = 'won';
    else if (c.lead_lost_reason) status = 'lost';
    else if (diffDays(t, date) >= STALE_DAYS) status = 'stale';
    else status = 'open';
    leads.push({
      customer: c,
      brand_id: c.brand_id,
      date,
      status,
      reason: status === 'lost' ? c.lead_lost_reason : status === 'stale' ? UNMARKED : null,
      daysToWin: won.length ? diffDays(won[0].order_date, date) : null,
      revenue: won.filter((o) => PAID.has(o.status)).reduce((s, o) => s + o.amount, 0),
      age: diffDays(t, date),
    });
  }
  return leads;
}

export function leadInfo(store, config, customerId) {
  const c = store.getCustomer(customerId);
  if (!c?.line_user_id) return null;
  return allLeads(store, config, { brandId: c.brand_id }).find((l) => l.customer.id === c.id) || null;
}

export function markLost(store, customerId, { reason, note = '' }, userName) {
  const c = store.getCustomer(customerId);
  if (!c) throw new Error('找不到客戶');
  if (!LOST_REASONS.includes(reason)) throw new Error('請選擇未成交原因');
  if (reason === '其他' && !String(note).trim()) throw new Error('選「其他」時請寫下原因');
  store.run('UPDATE customers SET lead_lost_reason = ?, lead_lost_note = ?, lead_lost_at = ?, lead_lost_by = ? WHERE id = ?',
    reason, String(note).trim().slice(0, 200) || null, new Date().toISOString(), userName, c.id);
}

export function reopenLead(store, customerId) {
  store.run('UPDATE customers SET lead_lost_reason = NULL, lead_lost_note = NULL, lead_lost_at = NULL, lead_lost_by = NULL WHERE id = ?', customerId);
}

const pct = (a, b) => (b ? a / b : 0);
const summarize = (list) => {
  const won = list.filter((l) => l.status === 'won');
  const winDays = won.map((l) => l.daysToWin);
  return {
    leads: list.length,
    won: won.length,
    lost: list.filter((l) => l.status === 'lost').length,
    stale: list.filter((l) => l.status === 'stale').length,
    open: list.filter((l) => l.status === 'open').length,
    rate: pct(won.length, list.length),
    revenue: won.reduce((s, l) => s + l.revenue, 0),
    avgDaysToWin: winDays.length ? Math.round((winDays.reduce((a, b) => a + b, 0) / winDays.length) * 10) / 10 : null,
  };
};

export function buildFunnel(store, config, { from, to, brandId = null, brandIds = null, granularity = 'auto' }) {
  if (from > to) [from, to] = [to, from];
  const g = resolveGranularity(granularity, from, to);
  const leads = allLeads(store, config, { brandId, brandIds }).filter((l) => l.date >= from && l.date <= to);
  const totals = summarize(leads);

  const series = listBuckets(from, to, g).map((b) => ({ ...b, ...summarize(leads.filter((l) => bucketKey(l.date, g) === b.key)) }));
  const seenBrands = [...new Set(leads.map((l) => l.brand_id))];
  const byBrand = seenBrands.map((id) => ({ brand_id: id, ...summarize(leads.filter((l) => l.brand_id === id)) })).sort((a, b) => b.leads - a.leads);

  const notWon = leads.filter((l) => l.status === 'lost' || l.status === 'stale');
  const reasons = [...LOST_REASONS, UNMARKED]
    .map((reason) => ({ reason, count: notWon.filter((l) => l.reason === reason).length }))
    .filter((r) => r.count)
    .map((r) => ({ ...r, share: pct(r.count, notWon.length), suggestion: SUGGESTIONS[r.reason] }))
    .sort((a, b) => b.count - a.count);

  // 星期幾詢問最多
  const weekdays = Array.from({ length: 7 }, (_, i) => ({ day: '日一二三四五六'[i], leads: 0, won: 0 }));
  for (const l of leads) {
    const w = weekdays[new Date(`${l.date}T00:00:00Z`).getUTCDay()];
    w.leads++;
    if (l.status === 'won') w.won++;
  }

  const insights = [];
  const brandName = (id) => store.getBrand(id)?.name || '';
  if (!totals.leads) {
    insights.push('這段期間沒有新的 LINE 詢問。');
  } else {
    insights.push(`共 ${totals.leads} 位新詢問，成交 ${totals.won} 位，成交率 ${Math.round(totals.rate * 100)}%${totals.avgDaysToWin != null ? `，平均詢問後 ${totals.avgDaysToWin} 天成交` : ''}。`);
    const ranked = byBrand.filter((b) => b.leads >= 5);
    if (ranked.length >= 2) {
      const best = ranked.reduce((a, b) => (b.rate > a.rate ? b : a));
      const worst = ranked.reduce((a, b) => (b.rate < a.rate ? b : a));
      if (best.rate - worst.rate >= 0.1) insights.push(`各品牌成交率差異大：${brandName(best.brand_id)} ${Math.round(best.rate * 100)}%，${brandName(worst.brand_id)} 只有 ${Math.round(worst.rate * 100)}%，可參考 ${brandName(best.brand_id)} 的報價與回覆方式。`);
    }
    const top = reasons.find((r) => r.reason !== UNMARKED);
    if (top && top.share >= 0.15) insights.push(`未成交最主要原因是「${top.reason}」（${Math.round(top.share * 100)}%）：${top.suggestion}`);
    if (totals.stale) insights.push(`有 ${totals.stale} 位詢問超過 ${STALE_DAYS} 天沒成交、也沒標記原因。${SUGGESTIONS[UNMARKED]}`);
    if (totals.open) insights.push(`還有 ${totals.open} 位詢問在洽談中，記得在今日關懷清單追蹤。`);
    const busiest = weekdays.reduce((a, b) => (b.leads > a.leads ? b : a));
    if (busiest.leads >= 3 && busiest.leads >= totals.leads * 0.25) insights.push(`星期${busiest.day}的詢問最多（${busiest.leads} 位），這天請排足客服，加快回覆。`);
  }

  const followUp = leads.filter((l) => l.status === 'open' || l.status === 'stale').sort((a, b) => b.age - a.age).slice(0, 30)
    .map((l) => ({ id: l.customer.id, name: l.customer.real_name || l.customer.display_name, brand_id: l.brand_id, date: l.date, age: l.age, status: l.status }));

  return { from, to, granularity: g, totals, series, byBrand, reasons, weekdays, insights, followUp, lostReasons: LOST_REASONS };
}

// 今日關懷清單用：詢問後 2～30 天還沒成交、沒標記未成交的客人
export function leadsToFollowUp(store, config, { brandId = null } = {}) {
  const t = today(config.tz);
  return allLeads(store, config, { brandId }).filter((l) => (l.status === 'open' || l.status === 'stale') && l.date <= addDays(t, -2) && l.date >= addDays(t, -30));
}
