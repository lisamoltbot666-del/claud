import { addDays, dateOf, diffDays, formatDateTime, today } from './dates.js';

// 產生「今日關懷清單」：哪些客戶今天需要客服特別關心、為什麼、建議做什麼
//
// 規則（優先度 1 = 最急）：
//   1 客戶已回報匯款，待核對
//   1 未匯款且已逾期
//   1 未匯款，今天到期
//   1 客戶傳訊息尚未處理
//   2 未匯款，明天到期
//   2 客服排定今天（或更早）要聯絡
//   2 依回購週期，該回購了
//   3 新好友尚未下單

export const PRIORITY_LABELS = { 1: '緊急', 2: '今日', 3: '有空時' };

export function reorderCycle(customer, orderDates, defaultDays) {
  if (customer.reorder_days) return { days: Number(customer.reorder_days), source: '手動設定' };
  const dates = [...new Set(orderDates)].sort();
  if (dates.length >= 2) {
    const gaps = [];
    for (let i = 1; i < dates.length; i++) gaps.push(diffDays(dates[i], dates[i - 1]));
    const avg = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
    if (avg > 0) return { days: avg, source: `依 ${dates.length} 筆訂單平均` };
  }
  return { days: defaultDays, source: '預設值' };
}

export function buildFocusList(store, config, now = new Date()) {
  const tz = config.tz;
  const t = today(tz, now);
  const tomorrow = addDays(t, 1);
  const cooldownStart = addDays(t, -config.reminderCooldownDays);

  const customers = store.all('SELECT * FROM customers');
  const orders = store.all("SELECT * FROM orders WHERE status != 'cancelled' ORDER BY order_date");
  const ordersByCustomer = new Map();
  for (const o of orders) {
    if (!ordersByCustomer.has(o.customer_id)) ordersByCustomer.set(o.customer_id, []);
    ordersByCustomer.get(o.customer_id).push(o);
  }

  const recentlyReminded = (customerId, kind, orderId = null) => {
    const r = store.lastReminder(customerId, kind, orderId);
    return r && dateOf(r.sent_at, tz) > cooldownStart ? r : null;
  };

  const result = [];
  for (const c of customers) {
    const reasons = [];
    const list = ordersByCustomer.get(c.id) || [];
    const pending = list.filter((o) => o.status === 'pending_payment');

    for (const o of pending) {
      const lastRem = store.lastReminder(c.id, 'payment', o.id);
      const reminded = lastRem ? { lastRemindedAt: lastRem.sent_at, remindCount: store.countReminders(o.id, 'payment') } : {};
      if (o.payment_report) {
        reasons.push({ code: 'verify_payment', priority: 1, orderId: o.id, label: '客戶已回報匯款，請核對入帳', detail: `訂單 #${o.id} NT$${o.amount}，回報內容：${o.payment_report}`, action: 'verify' });
        continue;
      }
      if (!o.payment_due_date) continue;
      if (o.payment_due_date < t) {
        reasons.push({ code: 'payment_overdue', priority: 1, orderId: o.id, label: `匯款已逾期 ${diffDays(t, o.payment_due_date)} 天`, detail: `訂單 #${o.id} NT$${o.amount}，期限 ${o.payment_due_date}`, action: 'payment', ...reminded });
      } else if (o.payment_due_date === t) {
        reasons.push({ code: 'payment_due_today', priority: 1, orderId: o.id, label: '今天是匯款期限', detail: `訂單 #${o.id} NT$${o.amount}`, action: 'payment', ...reminded });
      } else if (o.payment_due_date === tomorrow) {
        reasons.push({ code: 'payment_due_tomorrow', priority: 2, orderId: o.id, label: '明天匯款到期', detail: `訂單 #${o.id} NT$${o.amount}`, action: 'payment', ...reminded });
      }
    }

    if (c.last_inbound_at && (!c.last_handled_at || c.last_inbound_at > c.last_handled_at)) {
      reasons.push({ code: 'unreplied', priority: 1, label: '有訊息尚未處理', detail: `最後訊息 ${formatDateTime(c.last_inbound_at, tz)}`, action: 'reply' });
    }

    if (c.next_contact_date && c.next_contact_date <= t) {
      reasons.push({ code: 'scheduled', priority: 2, label: '排定今天聯絡', detail: `排定日期 ${c.next_contact_date}${c.note ? `｜備註：${c.note}` : ''}`, action: 'care' });
    }

    // 客服按「延後」會把下次聯絡日設在未來，期間不再列入回購 / 新好友提醒
    const snoozed = Boolean(c.next_contact_date && c.next_contact_date > t);

    const placed = list.filter((o) => o.status !== 'pending_payment');
    if (placed.length && !pending.length && !snoozed) {
      const cycle = reorderCycle(c, list.map((o) => o.order_date), config.defaultReorderDays);
      const lastOrder = list[list.length - 1].order_date;
      const since = diffDays(t, lastOrder);
      if (since >= cycle.days && !recentlyReminded(c.id, 'reorder')) {
        reasons.push({ code: 'reorder', priority: 2, label: '該回購了', detail: `距上次下單 ${since} 天（回購週期 ${cycle.days} 天，${cycle.source}）`, action: 'reorder' });
      }
    }

    if (!list.length && !snoozed && c.is_friend && c.followed_at && dateOf(c.followed_at, tz) >= addDays(t, -config.newFriendDays) && !recentlyReminded(c.id, 'care')) {
      reasons.push({ code: 'new_friend', priority: 3, label: '新好友尚未下單', detail: `加入日期 ${dateOf(c.followed_at, tz)}`, action: 'care' });
    }

    if (reasons.length) {
      reasons.sort((a, b) => a.priority - b.priority);
      result.push({
        customer: c,
        canPush: Boolean(c.line_user_id && c.is_friend),
        priority: reasons[0].priority,
        reasons,
      });
    }
  }

  result.sort((a, b) => a.priority - b.priority || b.reasons.length - a.reasons.length || a.customer.id - b.customer.id);
  return { date: t, items: result };
}

// 給客服的 LINE 文字摘要
export function formatFocusSummary(focus, { shopName = '', baseUrl = '' } = {}) {
  if (!focus.items.length) return `【${shopName} 今日關懷清單 ${focus.date}】\n今天沒有需要特別關心的客戶 🎉`;
  const lines = [`【${shopName} 今日關懷清單 ${focus.date}】共 ${focus.items.length} 位`];
  for (const p of [1, 2, 3]) {
    const group = focus.items.filter((i) => i.priority === p);
    if (!group.length) continue;
    lines.push('', `■ ${PRIORITY_LABELS[p]}（${group.length}）`);
    for (const item of group) {
      const name = item.customer.real_name || item.customer.display_name || `客戶#${item.customer.id}`;
      lines.push(`・${name}：${item.reasons.map((r) => r.label).join('、')}`);
    }
  }
  if (baseUrl) lines.push('', `後台：${baseUrl}`);
  return lines.join('\n');
}
