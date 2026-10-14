import { addDays, diffDays, today } from './dates.js';

// 客戶消費統計與回訪分析
// 交通服務以「用車日」計算（沒填用車日才用下單日）：提前預約的行程，要等用完車才開始算回訪週期

const PAID = new Set(['paid', 'shipped', 'completed']);

export const SEGMENTS = {
  none: '尚未下單',
  first: '首次客',
  repeat: '回頭客',
  loyal: '忠實客',
  dormant: '沉睡客',
};

export function reorderCycle(customer, orderDates, defaultDays) {
  if (customer.reorder_days) return { days: Number(customer.reorder_days), source: '手動設定' };
  const dates = [...new Set(orderDates)].sort();
  if (dates.length >= 2) {
    const gaps = [];
    for (let i = 1; i < dates.length; i++) gaps.push(diffDays(dates[i], dates[i - 1]));
    const avg = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
    if (avg > 0) return { days: avg, source: `依 ${dates.length} 次用車平均` };
  }
  return { days: defaultDays, source: '預設值' };
}

// 「滴雞精 x10、禮盒*2」→ ['滴雞精', '禮盒']
export function parseItems(text) {
  return String(text || '')
    .split(/[,，、;；\n+]/)
    .map((s) => s.replace(/\s*[x×*]\s*\d+\s*(份|盒|包|瓶|組|個|件)?\s*$/i, '').trim())
    .filter(Boolean);
}

export const serviceDateOf = (o) => o.service_date || o.order_date;

// orders：該客戶的訂單（任意順序）
export function customerStats(customer, orders, config, t = today(config.tz)) {
  const valid = orders.filter((o) => o.status !== 'cancelled').sort((a, b) => serviceDateOf(a).localeCompare(serviceDateOf(b)) || a.id - b.id);
  const paid = valid.filter((o) => PAID.has(o.status));
  const totalSpent = paid.reduce((s, o) => s + Number(o.amount || 0), 0);
  const itemCounts = new Map();
  for (const o of valid) for (const name of parseItems(o.items)) itemCounts.set(name, (itemCounts.get(name) || 0) + 1);
  const topItems = [...itemCounts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, count]) => ({ name, count }));

  const stats = {
    orderCount: valid.length,
    paidCount: paid.length,
    repeatCount: Math.max(0, valid.length - 1),
    totalSpent,
    avgOrder: paid.length ? Math.round(totalSpent / paid.length) : 0,
    pendingAmount: valid.filter((o) => o.status === 'pending_payment').reduce((s, o) => s + Number(o.amount || 0), 0),
    firstOrderDate: valid[0] ? serviceDateOf(valid[0]) : null,
    lastOrderDate: valid.length ? serviceDateOf(valid.at(-1)) : null,
    lastItems: valid.at(-1)?.items ?? null,
    lastOrder: valid.at(-1) ?? null,
    topItems,
    cycle: null,
    nextReorderDate: null,
    daysSinceLastOrder: null,
    daysUntilReorder: null,
    segment: 'none',
  };
  if (!valid.length) return stats;

  stats.cycle = reorderCycle(customer, valid.map(serviceDateOf), config.defaultReorderDays);
  stats.daysSinceLastOrder = diffDays(t, stats.lastOrderDate);
  stats.nextReorderDate = addDays(stats.lastOrderDate, stats.cycle.days);
  stats.daysUntilReorder = diffDays(stats.nextReorderDate, t);
  if (stats.daysSinceLastOrder > stats.cycle.days * 2 && stats.daysSinceLastOrder >= 60) stats.segment = 'dormant';
  else if (valid.length >= 5) stats.segment = 'loyal';
  else if (valid.length >= 2) stats.segment = 'repeat';
  else stats.segment = 'first';
  return stats;
}

// 回訪名單：所有下過單的客戶，依「預計回訪日」排序
//   filter: due（已到回訪日）| soon（7 天內）| dormant（沉睡）| all
export function buildRepurchaseList(store, config, { filter = 'all', brandId = null } = {}) {
  const t = today(config.tz);
  const byCustomer = new Map();
  for (const o of store.all('SELECT * FROM orders')) {
    if (!byCustomer.has(o.customer_id)) byCustomer.set(o.customer_id, []);
    byCustomer.get(o.customer_id).push(o);
  }
  const rows = [];
  const staff = new Set(store.staffIds());
  const customers = brandId ? store.all('SELECT * FROM customers WHERE brand_id = ?', brandId) : store.all('SELECT * FROM customers');
  for (const c of customers) {
    if (staff.has(c.id)) continue;
    const stats = customerStats(c, byCustomer.get(c.id) || [], config, t);
    if (!stats.orderCount) continue;
    const hasPending = (byCustomer.get(c.id) || []).some((o) => o.status === 'pending_payment');
    const keep = {
      all: true,
      due: stats.daysUntilReorder <= 0 && !hasPending,
      soon: stats.daysUntilReorder > 0 && stats.daysUntilReorder <= 7 && !hasPending,
      dormant: stats.segment === 'dormant',
    }[filter] ?? true;
    if (keep) rows.push({ customer: c, stats, hasPending, lastReminder: store.lastReminder(c.id, 'reorder') });
  }
  rows.sort((a, b) => a.stats.nextReorderDate.localeCompare(b.stats.nextReorderDate) || b.stats.totalSpent - a.stats.totalSpent);
  return { date: t, rows };
}
