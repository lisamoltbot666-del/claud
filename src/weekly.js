import { addDays, today } from './dates.js';
import { buildFunnel, STALE_DAYS } from './leads.js';
import { buildReport } from './report.js';

// 每週營運週報：上週（星期一～星期日）和前一週比較，加上營運建議。
// 每週固定一天（預設星期一）在每日清單推播時一起推給「週報接收人」，管理員也可在報表頁隨時查看、手動推播。

const money = (n) => `NT$${Math.round(n).toLocaleString('en-US')}`;
const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const pctText = (r) => `${Math.round(r * 100)}%`;
// 變化率；前一週是 0 時無法計算
const change = (cur, prev) => (prev ? (cur - prev) / prev : null);
const changeText = (cur, prev) => {
  const c = change(cur, prev);
  if (c == null) return cur ? '（前一週為 0）' : '';
  if (Math.abs(c) < 0.005) return '（持平）';
  return `（${c > 0 ? '▲' : '▼'}${Math.round(Math.abs(c) * 100)}%）`;
};

export function weekRange(tz, now = new Date()) {
  const t = today(tz, now);
  const monday = addDays(t, -((new Date(`${t}T00:00:00Z`).getUTCDay() + 6) % 7));
  return {
    weekKey: monday, // 本週一，用來判斷這週推過沒
    from: addDays(monday, -7),
    to: addDays(monday, -1),
    prevFrom: addDays(monday, -14),
    prevTo: addDays(monday, -8),
    nextFrom: monday,
    nextTo: addDays(monday, 6),
  };
}

export function buildWeekly(store, config, { now = new Date(), brandIds = null } = {}) {
  const r = weekRange(config.tz, now);
  const ids = brandIds?.length ? brandIds : null;
  const cur = buildReport(store, { from: r.from, to: r.to, brandIds: ids, granularity: 'day' });
  const prev = buildReport(store, { from: r.prevFrom, to: r.prevTo, brandIds: ids, granularity: 'day' });
  const funnel = buildFunnel(store, config, { from: r.from, to: r.to, brandIds: ids, granularity: 'day' });
  const prevFunnel = buildFunnel(store, config, { from: r.prevFrom, to: r.prevTo, brandIds: ids, granularity: 'day' });

  // 各品牌：營業額、訂單、詢問、成交率，和前一週比較
  const brandList = ids ? ids.map((id) => store.getBrand(id)).filter(Boolean) : store.listBrands();
  const pick = (list, id) => list.find((x) => x.brand_id === id) || {};
  const brands = brandList.map((b) => {
    const c = pick(cur.byBrand, b.id);
    const p = pick(prev.byBrand, b.id);
    const f = pick(funnel.byBrand, b.id);
    const pf = pick(prevFunnel.byBrand, b.id);
    return {
      brand_id: b.id,
      name: b.name,
      revenue: c.revenue || 0,
      prevRevenue: p.revenue || 0,
      orders: c.orders || 0,
      prevOrders: p.orders || 0,
      leads: f.leads || 0,
      prevLeads: pf.leads || 0,
      won: f.won || 0,
      rate: f.rate || 0,
      prevRate: pf.rate || 0,
    };
  });

  // 本週（推播當週）的行程：還沒派司機、還沒付款
  const bWhere = ids ? ` AND c.brand_id IN (${ids.map(() => '?').join(',')})` : '';
  const upcoming = store.get(
    `SELECT COUNT(*) AS trips, COUNT(CASE WHEN o.driver_id IS NULL THEN 1 END) AS no_driver,
            COUNT(CASE WHEN o.status = 'pending_payment' THEN 1 END) AS unpaid
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.status NOT IN ('cancelled','completed') AND o.service_date BETWEEN ? AND ?${bWhere}`,
    r.nextFrom, r.nextTo, ...(ids || []),
  );
  // 所有逾期未付款（不限上週）
  const overdue = store.get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(o.amount), 0) AS amount FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.status = 'pending_payment' AND o.payment_due_date IS NOT NULL AND o.payment_due_date < ?${bWhere}`,
    r.nextFrom, ...(ids || []),
  );

  const T = cur.totals;
  const P = prev.totals;
  const suggestions = [];
  const revChange = change(T.revenue, P.revenue);
  if (!T.orders && !funnel.totals.leads) {
    suggestions.push('上週沒有訂單也沒有新詢問：檢查各官方帳號是否正常收到訊息，並考慮發一則優惠或近況貼文喚回老客人。');
  } else if (revChange != null && revChange <= -0.2) {
    suggestions.push(`營業額比前一週少 ${pctText(-revChange)}：到「回訪」名單主動聯繫該回購的老客人，並檢查是否有詢問沒追到。`);
  } else if (revChange != null && revChange >= 0.2) {
    suggestions.push(`營業額比前一週成長 ${pctText(revChange)}，表現很好！留意車輛與司機是否足夠，避免旺季接不到單。`);
  }
  for (const b of brands) {
    const c = change(b.revenue, b.prevRevenue);
    if (b.prevRevenue >= 5000 && c != null && c <= -0.3) suggestions.push(`${b.name} 營業額下滑 ${pctText(-c)}（${money(b.prevRevenue)} → ${money(b.revenue)}），建議了解原因：詢問變少、報價、還是車不夠？`);
    if (b.leads >= 5 && b.prevLeads >= 5 && b.prevRate - b.rate >= 0.15) suggestions.push(`${b.name} 成交率從 ${pctText(b.prevRate)} 掉到 ${pctText(b.rate)}，請檢查回覆速度與報價。`);
  }
  const leadChange = change(funnel.totals.leads, prevFunnel.totals.leads);
  if (prevFunnel.totals.leads >= 5 && leadChange != null && leadChange <= -0.3) suggestions.push(`新詢問比前一週少 ${pctText(-leadChange)}，可加強官方帳號貼文、廣告或推薦好友活動。`);
  const topReason = funnel.reasons.find((x) => x.count >= 2 && x.reason !== '未標記原因');
  if (topReason) suggestions.push(`上週未成交最多是「${topReason.reason}」（${topReason.count} 位）：${topReason.suggestion}`);
  if (funnel.totals.stale) suggestions.push(`有 ${funnel.totals.stale} 位詢問超過 ${STALE_DAYS} 天沒成交也沒標記原因，請客服補上原因，下週的分析才會準。`);
  if (funnel.totals.open) suggestions.push(`還有 ${funnel.totals.open} 位上週的詢問在洽談中，記得追蹤。`);
  if (overdue.n) suggestions.push(`有 ${overdue.n} 筆訂單已過匯款期限（共 ${money(overdue.amount)}），請盡快提醒客人匯款。`);
  if (upcoming.no_driver) suggestions.push(`本週有 ${upcoming.no_driver} 趟行程還沒派司機，請提早安排。`);
  if (T.customers >= 5 && T.repeat_rate < 0.2) suggestions.push(`回頭客只佔 ${pctText(T.repeat_rate)}：服務完成後可傳感謝訊息並附回購優惠，提高回頭率。`);
  if (!suggestions.length) suggestions.push('各項數字穩定，繼續保持！');

  const data = {
    ...r,
    totals: T,
    prevTotals: P,
    funnel: funnel.totals,
    prevFunnel: prevFunnel.totals,
    reasons: funnel.reasons.slice(0, 3),
    brands,
    upcoming,
    overdue,
    suggestions,
  };
  data.text = formatWeekly(data);
  return data;
}

export function formatWeekly(d) {
  const T = d.totals;
  const P = d.prevTotals;
  const F = d.funnel;
  const lines = [
    `📊 上週營運週報（${md(d.from)}–${md(d.to)}）`,
    '',
    `💰 營業額 ${money(T.revenue)}${changeText(T.revenue, P.revenue)}`,
    `🧾 訂單 ${T.orders} 筆${changeText(T.orders, P.orders)}，客單價 ${money(T.avg_order)}`,
    `👥 客人 ${T.customers} 位（回頭客 ${T.repeat_customers}）`,
    T.receivable ? `⏳ 待收款 ${money(T.receivable)}（${T.receivable_orders} 筆）` : '',
    `💬 新詢問 ${F.leads} 位${changeText(F.leads, d.prevFunnel.leads)}，成交 ${F.won} 位（成交率 ${pctText(F.rate)}）`,
  ];
  const active = d.brands.filter((b) => b.revenue || b.prevRevenue || b.leads || b.orders);
  if (d.brands.length > 1 && active.length) {
    lines.push('', '各品牌：');
    for (const b of active) lines.push(`・${b.name} ${money(b.revenue)}${changeText(b.revenue, b.prevRevenue)}｜${b.orders} 筆｜詢問 ${b.leads}・成交 ${b.won}`);
  }
  if (d.reasons.length) lines.push('', `未成交原因：${d.reasons.map((x) => `${x.reason} ${x.count}`).join('、')}`);
  if (d.upcoming.trips) lines.push('', `📅 本週行程 ${d.upcoming.trips} 趟${d.upcoming.no_driver ? `（${d.upcoming.no_driver} 趟未派司機）` : ''}`);
  lines.push('', '💡 營運建議：', ...d.suggestions.map((s, i) => `${i + 1}. ${s}`));
  return lines.filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== '')).join('\n');
}
