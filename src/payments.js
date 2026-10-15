import { today } from './dates.js';

// 收款紀錄：一張訂單可以分多次收（訂金、尾款…）。
// 已收＝收款紀錄加總；狀態是已付款／已派車／已完成的訂單視為已收齊（舊訂單沒有收款紀錄也算得對）。
// 收款加總達到訂單金額時，待付款的訂單自動變成「已付款」；刪掉收款後不足額，已付款的訂單改回「待付款」。

export const PAYMENT_KINDS = { deposit: '訂金', balance: '尾款', full: '全額', cancel_fee: '取消費', refund: '退款', other: '其他' };
// 已取消的訂單只能記這兩種
const CANCELLED_KINDS = new Set(['cancel_fee', 'refund', 'deposit']); // deposit：補記取消前已收的訂金
export const PAYMENT_METHODS = { transfer: '匯款', cash_driver: '現金交司機', cash: '現金（現場）', card: '刷卡', other: '其他' };
const SETTLED = new Set(['paid', 'shipped', 'completed']);

// 這張訂單已收多少、還差多少；已取消的訂單：retained＝保留下來的訂金（收款減退款）
export function balanceOf(order) {
  if (!order) return { paid: 0, due: 0 };
  if (order.status === 'cancelled') return { paid: 0, due: 0, retained: Math.max(0, order.paid_amount || 0), recorded: order.paid_amount || 0 };
  const paid = SETTLED.has(order.status) ? order.amount : Math.min(order.amount, order.paid_amount || 0);
  return { paid, due: Math.max(0, order.amount - paid), recorded: order.paid_amount || 0 };
}

export function listPayments(store, orderId) {
  return store.all('SELECT * FROM payments WHERE order_id = ? ORDER BY paid_on, id', orderId);
}

export function addPayment(store, config, orderId, { amount, kind, method, paid_on: paidOn, note } = {}, userName = null) {
  const o = store.getOrder(orderId);
  if (!o) throw new Error('找不到訂單');
  const n = Math.round(Number(String(amount ?? '').replace(/[,\s]/g, '')));
  if (!Number.isFinite(n) || n <= 0) throw new Error('請輸入收款金額');
  if (kind && !PAYMENT_KINDS[kind]) throw new Error('收款類型不正確');
  if (o.status === 'cancelled' && !CANCELLED_KINDS.has(kind)) throw new Error('已取消的訂單只能記錄「退款」「取消費」或補記「訂金」');
  if (kind === 'refund' && n > Math.max(0, o.paid_amount || 0)) throw new Error(`退款不能超過已收的 NT$${Math.max(0, o.paid_amount || 0)}`);
  if (method && !PAYMENT_METHODS[method]) throw new Error('收款方式不正確');
  const day = paidOn || today(config.tz);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('收款日格式需為 YYYY-MM-DD');
  const k = kind || ((o.paid_amount || 0) > 0 ? 'balance' : n >= o.amount ? 'full' : 'deposit');
  store.run('INSERT INTO payments (order_id, amount, kind, method, paid_on, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    o.id, k === 'refund' ? -n : n, k, method || 'transfer', day, String(note || '').trim().slice(0, 200) || null, userName);
  return syncStatus(store, o.id);
}

export function deletePayment(store, paymentId) {
  const p = store.get('SELECT * FROM payments WHERE id = ?', paymentId);
  if (!p) throw new Error('找不到這筆收款');
  store.run('DELETE FROM payments WHERE id = ?', p.id);
  return { payment: p, order: syncStatus(store, p.order_id) };
}

function syncStatus(store, orderId) {
  const o = store.getOrder(orderId);
  if (o.status === 'cancelled') return o;
  if (o.status === 'pending_payment' && o.amount > 0 && o.paid_amount >= o.amount) return store.updateOrder(o.id, { status: 'paid' });
  if (o.status === 'paid' && o.paid_amount > 0 && o.paid_amount < o.amount) return store.updateOrder(o.id, { status: 'pending_payment' });
  return o;
}

export function paymentSummary(order) {
  const { paid, due } = balanceOf(order);
  return paid > 0 && due > 0 ? `已收 NT$${paid.toLocaleString('en-US')}，尾款 NT$${due.toLocaleString('en-US')}` : '';
}
