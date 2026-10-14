import { today } from './dates.js';

// 每月營收目標：每個品牌各自設定；沒設定的月份沿用最近一次設定的目標。
// 營業額的算法和報表相同（已付款／已派車／已完成，依用車日）。
// 月底預估＝已發生的營業額 ＋ max(已排定的後續訂單, 依目前每日平均推估剩下的天數)

const PAID = "('paid','shipped','completed')";
const DAY = 'COALESCE(o.service_date, o.order_date)';

const lastDay = (month) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

export function getTarget(store, brandId, month) {
  return store.get('SELECT amount, month FROM revenue_targets WHERE brand_id = ? AND month <= ? ORDER BY month DESC LIMIT 1', brandId, month) || null;
}

export function setTarget(store, { brandId, month, amount }, userName = null) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) throw new Error('月份格式需為 YYYY-MM');
  if (!store.getBrand(brandId)) throw new Error('找不到品牌');
  const n = Math.round(Number(String(amount ?? '').replace(/[,\s]/g, '')));
  if (!Number.isFinite(n) || n < 0) throw new Error('目標金額需為 0 以上的數字');
  store.run(`INSERT INTO revenue_targets (brand_id, month, amount, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(brand_id, month) DO UPDATE SET amount = excluded.amount, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  brandId, month, n, userName, new Date().toISOString());
}

export function buildTargets(store, config, { month = null, brandIds = null, now = new Date() } = {}) {
  const t = today(config.tz, now);
  month ||= t.slice(0, 7);
  const days = lastDay(month);
  const from = `${month}-01`;
  const to = `${month}-${String(days).padStart(2, '0')}`;
  // 已經過的天數（含今天）
  const elapsed = t < from ? 0 : t > to ? days : Number(t.slice(8, 10));
  const cut = t < from ? from : t > to ? to : t;
  const brands = (brandIds?.length ? brandIds.map((id) => store.getBrand(id)).filter(Boolean) : store.listBrands());

  const rows = brands.map((b) => {
    const target = getTarget(store, b.id, month);
    const r = store.get(
      `SELECT COALESCE(SUM(CASE WHEN o.status IN ${PAID} AND ${DAY} <= ? THEN o.amount END), 0) AS past,
              COALESCE(SUM(CASE WHEN o.status IN ${PAID} THEN o.amount END), 0) AS achieved,
              COALESCE(SUM(CASE WHEN ${DAY} > ? THEN o.amount END), 0) AS booked
       FROM orders o JOIN customers c ON c.id = o.customer_id
       WHERE o.status != 'cancelled' AND c.brand_id = ? AND ${DAY} BETWEEN ? AND ?`,
      cut, cut, b.id, from, to,
    );
    const remaining = days - elapsed;
    const pace = elapsed ? r.past / elapsed : 0;
    const projection = elapsed >= days ? r.achieved : Math.round(r.past + Math.max(r.booked, pace * remaining));
    const amount = target?.amount ?? null;
    return {
      brand_id: b.id,
      name: b.name,
      target: amount,
      targetFrom: target && target.month !== month ? target.month : null, // 沿用哪個月的目標
      achieved: r.achieved,
      booked: r.booked,
      projection,
      progress: amount ? r.achieved / amount : null,
      projectedRate: amount ? projection / amount : null,
      perDayNeeded: amount && remaining > 0 ? Math.max(0, Math.ceil((amount - r.achieved) / remaining)) : null,
    };
  });
  const withTarget = rows.filter((x) => x.target);
  const sum = (k, list = rows) => list.reduce((s, x) => s + (x[k] || 0), 0);
  const total = {
    target: withTarget.length ? sum('target', withTarget) : null,
    achieved: sum('achieved'),
    projection: sum('projection'),
  };
  total.progress = total.target ? sum('achieved', withTarget) / total.target : null;
  total.projectedRate = total.target ? sum('projection', withTarget) / total.target : null;
  return { month, from, to, days, elapsed, brands: rows, total };
}
