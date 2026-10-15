import { addDays, dateOf, diffDays, formatDateTime, today } from './dates.js';
import { SERVICE_TYPES } from './db.js';
import { PAID_PATTERN, latestBookingDraft } from './booking-parse.js';
import { leadsToFollowUp } from './leads.js';
import { customerStats } from './profile.js';

// 產生「今日關懷清單」：哪些客戶今天需要客服特別關心、為什麼、建議做什麼
//
// 規則（優先度 1 = 最急）：
//   1 客戶已回報匯款，待核對
//   1 未匯款且已逾期
//   1 未匯款，今天到期
//   1 今天用車，還沒派車
//   1 客人傳來預約單（7 天內），還沒建立訂單
//   1 客人說已轉帳／匯款（3 天內），但沒有待付款訂單可對應，請核對
//   2 明天用車，還沒傳行程確認
//   2 未匯款，明天到期
//   2 客服排定今天（或更早）要聯絡
//   2 依回訪週期，可邀請再次預約（邀請過後，一個週期內不再列入）
//   2 今天生日
//   2 服務完成 1～3 天，可傳感謝與評價邀請
//   2 服務完成約 30 天（REBOOK_DAYS）還沒再訂，可傳回購邀請
//   3 新好友尚未下單

export const PRIORITY_LABELS = { 1: '緊急', 2: '今日', 3: '有空時' };

export { reorderCycle } from './profile.js';

const ACTIVE = new Set(['pending_payment', 'paid', 'shipped']);

const lastService = (stats) => [SERVICE_TYPES[stats.lastOrder?.service_type], stats.lastItems].filter(Boolean).join(' ');

// 「明天 05:30 機場接送｜BR198｜台北市… → 桃園機場」
export function tripSummary(o) {
  return [
    [o.service_time, SERVICE_TYPES[o.service_type] || o.items].filter(Boolean).join(' '),
    o.flight_no,
    o.pickup || o.dropoff ? [o.pickup, o.dropoff].filter(Boolean).join(' → ') : '',
  ].filter(Boolean).join('｜');
}

// brandId：只看單一品牌；不給則列出全部品牌（客服帳號本身不列入）
export function buildFocusList(store, config, now = new Date(), { brandId = null } = {}) {
  const tz = config.tz;
  const t = today(tz, now);
  const tomorrow = addDays(t, 1);
  const cooldownStart = addDays(t, -config.reminderCooldownDays);

  const staff = store.internalIds();
  const customers = (brandId ? store.all('SELECT * FROM customers WHERE brand_id = ?', brandId) : store.all('SELECT * FROM customers'))
    .filter((c) => !staff.has(c.id) && !c.anonymized_at);
  const orders = store.all("SELECT * FROM orders WHERE status != 'cancelled' ORDER BY order_date, id");
  const ordersByCustomer = new Map();
  for (const o of orders) {
    if (!ordersByCustomer.has(o.customer_id)) ordersByCustomer.set(o.customer_id, []);
    ordersByCustomer.get(o.customer_id).push(o);
  }

  const recentlyReminded = (customerId, kind, orderId = null) => {
    const r = store.lastReminder(customerId, kind, orderId);
    return r && dateOf(r.sent_at, tz) > cooldownStart ? r : null;
  };

  // 近 7 天傳過預約單、近 3 天說已轉帳的客人
  const recentSince = new Date(Date.parse(`${addDays(t, -7)}T00:00:00Z`) - 8 * 3600_000).toISOString();
  const recentIn = store.all(
    "SELECT id, customer_id, text, created_at FROM messages WHERE direction = 'in' AND type = 'text' AND created_at >= ? ORDER BY id",
    recentSince,
  );
  const bookingCandidates = new Set(recentIn.filter((m) => /[：:]/.test(m.text || '') && (m.text.match(/\n/g) || []).length >= 2).map((m) => m.customer_id));
  const claimSince = addDays(t, -3);
  const claims = new Map();
  for (const m of recentIn) if (dateOf(m.created_at, tz) >= claimSince && PAID_PATTERN.test(m.text || '')) claims.set(m.customer_id, m);

  // 詢問後還沒成交、也沒標記未成交的客人
  const leadFollow = new Map(leadsToFollowUp(store, config, { brandId }).map((l) => [l.customer.id, l]));

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

    for (const o of list) {
      if (!o.service_date || !ACTIVE.has(o.status)) continue;
      if (o.service_date === t && o.status !== 'shipped' && !o.driver_id) {
        reasons.push({ code: 'dispatch', priority: 1, orderId: o.id, status: o.status, label: '今天用車，尚未派車', detail: `訂單 #${o.id} ${tripSummary(o)}`, action: 'dispatch' });
      } else if (o.service_date === tomorrow && !store.lastReminder(c.id, 'trip', o.id)) {
        reasons.push({ code: 'trip_tomorrow', priority: 2, orderId: o.id, label: '明天用車，請傳行程確認', detail: `訂單 #${o.id} ${tripSummary(o)}`, action: 'trip' });
      }
    }

    if (bookingCandidates.has(c.id)) {
      const draft = latestBookingDraft(store, c.id, t, { since: recentSince });
      if (draft && !list.some((o) => o.created_at > draft.at)) {
        const f = draft.fields;
        reasons.push({ code: 'booking_form', priority: 1, label: '客人傳來預約單，請建立訂單', detail: [f.service_date, f.service_time, f.flight_no, [f.pickup, f.dropoff].filter(Boolean).join(' → ')].filter(Boolean).join('｜'), action: 'booking' });
      }
    }

    const claim = claims.get(c.id);
    if (claim && claim.id > Number(store.getKv(`payment_claim_ack:${c.id}`) || 0)) {
      // 已經對應到待付款訂單（上面「已回報匯款，請核對入帳」）或已確認入帳的就不重複列
      const handled = list.some((o) => (o.payment_reported_at && o.payment_reported_at >= claim.created_at) || (o.paid_at && o.paid_at >= claim.created_at));
      if (!handled) reasons.push({ code: 'payment_claim', priority: 1, label: '客人說已轉帳，請核對入帳並建立／更新訂單', detail: `「${claim.text.replace(/\s+/g, ' ').slice(0, 60)}」${formatDateTime(claim.created_at, tz)}`, action: 'claim' });
    }

    // 未回覆的訊息不列入：客服在 LINE 官方帳號 App 回覆時 LINE 不會通知本系統，App 本身就有未讀標示

    if (c.next_contact_date && c.next_contact_date <= t) {
      reasons.push({ code: 'scheduled', priority: 2, label: '排定今天聯絡', detail: `排定日期 ${c.next_contact_date}${c.note ? `｜備註：${c.note}` : ''}`, action: 'care' });
    }

    // 客服按「延後」會把下次聯絡日設在未來，期間不再列入回訪 / 新好友提醒
    const snoozed = Boolean(c.next_contact_date && c.next_contact_date > t);

    const stats = customerStats(c, list, config, t);
    // 搭車、出遊不像消耗品天天會用到：邀請過一次後，等一個回訪週期再列入，避免一直推播
    const invited = stats.orderCount ? store.lastReminder(c.id, 'reorder') : null;
    const invitedRecently = invited && dateOf(invited.sent_at, tz) > addDays(t, -Math.max(config.reminderCooldownDays, stats.cycle.days));
    if (stats.orderCount && !pending.length && !snoozed && stats.daysUntilReorder <= 0 && !invitedRecently) {
      const last = lastService(stats);
      reasons.push({ code: 'reorder', priority: 2, label: '可邀請再次預約', detail: `距上次用車 ${stats.daysSinceLastOrder} 天（回訪週期 ${stats.cycle.days} 天，${stats.cycle.source}）${last ? `｜上次：${last}` : ''}`, action: 'reorder' });
    }

    // 服務完成後：感謝與評價邀請、約 30 天後的回購邀請（每筆訂單各一次）
    const done = list.filter((o) => ['paid', 'shipped', 'completed'].includes(o.status) && (o.return_date || o.service_date));
    const endOf = (o) => (o.return_date && o.return_date > o.service_date ? o.return_date : o.service_date);
    const latest = done.sort((a, b) => (endOf(a) < endOf(b) ? -1 : 1)).at(-1);
    if (latest && c.line_user_id) {
      const end = endOf(latest);
      const later = list.some((o) => o.id !== latest.id && (o.service_date || o.order_date) > end);
      if (end >= addDays(t, -3) && end <= addDays(t, -1) && !store.lastReminder(c.id, 'thanks', latest.id)) {
        reasons.push({ code: 'thanks', priority: 2, orderId: latest.id, label: '服務已完成，可傳感謝與評價邀請', detail: `訂單 #${latest.id} ${end}｜${tripSummary(latest)}`, action: 'thanks' });
      }
      const since = diffDays(t, end);
      if (since >= config.rebookDays && since < config.rebookDays + 7 && !later && !pending.length && !snoozed
        && !store.lastReminder(c.id, 'rebook', latest.id) && !reasons.some((r) => r.code === 'reorder')) {
        reasons.push({ code: 'rebook', priority: 2, orderId: latest.id, label: `服務後 ${since} 天，可傳回購邀請`, detail: `訂單 #${latest.id} ${end}｜${tripSummary(latest)}`, action: 'rebook' });
      }
    }

    if (c.birthday && c.birthday.slice(5) === t.slice(5) && !recentlyReminded(c.id, 'birthday')) {
      reasons.push({ code: 'birthday', priority: 2, label: '今天生日 🎂', detail: '', action: 'birthday' });
    }

    const lead = leadFollow.get(c.id);
    if (lead && !snoozed) {
      reasons.push({ code: 'lead_follow', priority: 2, label: `詢問 ${lead.age} 天尚未成交`, detail: `${lead.date} 第一次詢問｜追蹤一下，或標記未成交原因`, action: 'lead' });
    }

    // 加了好友但從沒傳過訊息的新朋友（有傳過訊息的由上面「詢問」追蹤）
    if (!list.length && !snoozed && !c.last_inbound_at && c.is_friend && c.followed_at && dateOf(c.followed_at, tz) >= addDays(t, -config.newFriendDays) && !recentlyReminded(c.id, 'care')) {
      reasons.push({ code: 'new_friend', priority: 3, label: '新好友尚未下單', detail: `加入日期 ${dateOf(c.followed_at, tz)}`, action: 'care' });
    }

    if (reasons.length) {
      reasons.sort((a, b) => a.priority - b.priority);
      result.push({
        customer: c,
        canPush: Boolean(c.line_user_id && c.is_friend),
        priority: reasons[0].priority,
        reasons,
        stats,
      });
    }
  }

  result.sort((a, b) => a.priority - b.priority || b.reasons.length - a.reasons.length || a.customer.id - b.customer.id);
  return { date: t, items: result };
}

const PRIORITY_ICONS = { 1: '🔴', 2: '🟠', 3: '🔵' };

// 給客服的 LINE 文字摘要：依品牌分段，每段內依優先度排序
export function formatFocusSummary(focus, { brands = [], baseUrl = '' } = {}) {
  const title = `【今日關懷清單 ${focus.date}】`;
  if (!focus.items.length) return `${title}\n今天沒有需要特別關心的客戶 🎉`;
  const lines = [`${title}共 ${focus.items.length} 位`, `🔴${PRIORITY_LABELS[1]} 🟠${PRIORITY_LABELS[2]} 🔵${PRIORITY_LABELS[3]}`];
  const known = new Set(brands.map((b) => b.id));
  const groups = [...brands, { id: null, name: '其他' }];
  for (const brand of groups) {
    const items = focus.items.filter((i) => (brand.id === null ? !known.has(i.customer.brand_id) : i.customer.brand_id === brand.id));
    if (!items.length) continue;
    lines.push('', `━━ ${brand.name}（${items.length}）`);
    for (const item of items) {
      const name = item.customer.real_name || item.customer.display_name || `客戶#${item.customer.id}`;
      const s = item.stats;
      const last = s?.orderCount ? lastService(s) : '';
      const history = s?.orderCount ? `（訂單 ${s.orderCount} 筆，累積 NT$${s.totalSpent}${last ? `，最近：${last}` : ''}）` : '';
      lines.push(`${PRIORITY_ICONS[item.priority]} ${name}：${item.reasons.map((r) => r.label).join('、')}${history}`);
    }
  }
  if (baseUrl) lines.push('', `後台：${baseUrl}`);
  return lines.join('\n');
}
