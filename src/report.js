import { bucketKey, listBuckets, resolveGranularity } from './buckets.js';
import { SERVICE_TYPES } from './db.js';

// 營收報表：以用車日（沒有用車日則用下單日）歸屬期間。
// 營業額＝已付款／已派車／已完成的訂單金額；待收款＝待付款訂單金額；取消的訂單不計。
// 回頭客＝期間內有訂單、且在期間開始前就有過訂單的客人。

const PAID = "('paid','shipped','completed')";
const DAY = "COALESCE(o.service_date, o.order_date)";

export function buildReport(store, { from, to, brandId = null, granularity = 'auto' }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('日期格式需為 YYYY-MM-DD');
  if (from > to) [from, to] = [to, from];
  const bWhere = brandId ? ' AND c.brand_id = ?' : '';
  const bArgs = brandId ? [brandId] : [];
  const base = `FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status != 'cancelled' AND ${DAY} BETWEEN ? AND ?${bWhere}`;
  const args = [from, to, ...bArgs];

  const totals = store.get(
    `SELECT COUNT(*) AS orders,
            COALESCE(SUM(CASE WHEN o.status IN ${PAID} THEN o.amount END), 0) AS revenue,
            COUNT(CASE WHEN o.status IN ${PAID} THEN 1 END) AS paid_orders,
            COALESCE(SUM(CASE WHEN o.status = 'pending_payment' THEN o.amount END), 0) AS receivable,
            COUNT(CASE WHEN o.status = 'pending_payment' THEN 1 END) AS receivable_orders,
            COUNT(DISTINCT o.customer_id) AS customers
     ${base}`, ...args,
  );
  totals.cancelled = store.get(`SELECT COUNT(*) AS n FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = 'cancelled' AND ${DAY} BETWEEN ? AND ?${bWhere}`, ...args).n;
  totals.avg_order = totals.paid_orders ? Math.round(totals.revenue / totals.paid_orders) : 0;
  // 期間前就有訂單的客人（不分品牌篩選：同一品牌內的客戶資料本來就是分開的）
  totals.repeat_customers = store.get(
    `SELECT COUNT(DISTINCT o.customer_id) AS n ${base}
       AND EXISTS (SELECT 1 FROM orders p WHERE p.customer_id = o.customer_id AND p.status != 'cancelled' AND COALESCE(p.service_date, p.order_date) < ?)`,
    ...args, from,
  ).n;
  totals.new_customers = totals.customers - totals.repeat_customers;
  totals.repeat_rate = totals.customers ? totals.repeat_customers / totals.customers : 0;

  const byBrand = store.all(
    `SELECT c.brand_id, COUNT(*) AS orders, COALESCE(SUM(CASE WHEN o.status IN ${PAID} THEN o.amount END), 0) AS revenue,
            COALESCE(SUM(CASE WHEN o.status = 'pending_payment' THEN o.amount END), 0) AS receivable,
            COUNT(DISTINCT o.customer_id) AS customers,
            COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM orders p WHERE p.customer_id = o.customer_id AND p.status != 'cancelled' AND COALESCE(p.service_date, p.order_date) < ?) THEN o.customer_id END) AS repeat_customers
     ${base} GROUP BY c.brand_id ORDER BY revenue DESC`,
    from, ...args,
  );

  const byService = store.all(
    `SELECT o.service_type, COUNT(*) AS orders, COALESCE(SUM(CASE WHEN o.status IN ${PAID} THEN o.amount END), 0) AS revenue
     ${base} GROUP BY o.service_type ORDER BY revenue DESC`, ...args,
  ).map((r) => ({ ...r, label: SERVICE_TYPES[r.service_type] || '未分類' }));

  const topCustomers = store.all(
    `SELECT o.customer_id, c.display_name, c.real_name, c.brand_id, COUNT(*) AS orders, COALESCE(SUM(CASE WHEN o.status IN ${PAID} THEN o.amount END), 0) AS revenue
     ${base} GROUP BY o.customer_id ORDER BY revenue DESC, orders DESC LIMIT 10`, ...args,
  );

  // 趨勢：依「日／週／月」切區間，每個區間的營業額與訂單數，並分列各品牌
  const g = resolveGranularity(granularity, from, to);
  const daily = store.all(
    `SELECT ${DAY} AS day, c.brand_id, COUNT(*) AS orders, COALESCE(SUM(CASE WHEN o.status IN ${PAID} THEN o.amount END), 0) AS revenue
     ${base} GROUP BY day, c.brand_id`, ...args,
  );
  const series = listBuckets(from, to, g).map((b) => ({ ...b, orders: 0, revenue: 0, brands: {} }));
  const byKey = new Map(series.map((b) => [b.key, b]));
  for (const r of daily) {
    const b = byKey.get(bucketKey(r.day, g));
    if (!b) continue;
    b.orders += r.orders;
    b.revenue += r.revenue;
    const x = (b.brands[r.brand_id] ||= { orders: 0, revenue: 0 });
    x.orders += r.orders;
    x.revenue += r.revenue;
  }

  return { from, to, granularity: g, totals, byBrand, byService, topCustomers, series };
}
