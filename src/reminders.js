import { addDays, dateOf, localHour, today } from './dates.js';
import { buildFocusList, formatFocusSummary } from './focus.js';

const nameOf = (c) => c.real_name || c.display_name || '您好';

export const templates = {
  payment(c, o, cfg) {
    return [
      `${nameOf(c)} 您好，這裡是${cfg.shopName} 😊`,
      `提醒您訂單 #${o.id}${o.items ? `（${o.items}）` : ''} 金額 NT$${o.amount}，匯款期限為 ${o.payment_due_date || '近日'}。`,
      cfg.bankInfo ? `匯款資訊：${cfg.bankInfo}` : '',
      '完成匯款後，請回覆「已匯款 帳號末五碼」，我們會盡快為您確認，謝謝！',
    ].filter(Boolean).join('\n');
  },
  reorder(c, _o, cfg) {
    return `${nameOf(c)} 您好，這裡是${cfg.shopName} 😊\n距離上次訂購已經一段時間了，商品還夠用嗎？需要再幫您安排一份嗎？直接回覆這則訊息就可以下單喔！`;
  },
  care(c, _o, cfg) {
    return `${nameOf(c)} 您好，謝謝您加入${cfg.shopName}的好友 💛\n有任何想了解的商品或問題，直接在這裡留言，我們會很快回覆您！`;
  },
  birthday(c, _o, cfg) {
    return `${nameOf(c)} 生日快樂 🎂\n${cfg.shopName}祝您今天開開心心！感謝一直以來的支持，有需要隨時找我們喔 💛`;
  },
  paymentReceived(c, o, cfg) {
    return `${nameOf(c)} 您好，已收到您訂單 #${o.id} 的款項 NT$${o.amount}，我們會盡快為您出貨，謝謝支持${cfg.shopName}！`;
  },
};

export class ReminderService {
  constructor({ store, line, config, logger = console }) {
    Object.assign(this, { store, line, config, logger });
  }

  // 推播訊息給客戶並記錄
  async send({ customerId, kind, orderId = null, text, auto = false }) {
    const c = this.store.getCustomer(customerId);
    if (!c) throw new Error('找不到客戶');
    const order = orderId ? this.store.getOrder(orderId) : null;
    const body = text?.trim() || templates[kind]?.(c, order, this.config);
    if (!body) throw new Error('訊息內容為空');
    if (!c.line_user_id || !c.is_friend) {
      const error = '此客戶不是 LINE 好友，無法推播';
      this.store.logReminder({ customerId, orderId, kind, text: body, ok: false, error, auto });
      throw new Error(error);
    }
    try {
      await this.line.push(c.line_user_id, body);
    } catch (e) {
      this.store.logReminder({ customerId, orderId, kind, text: body, ok: false, error: e.message, auto });
      throw e;
    }
    this.store.logReminder({ customerId, orderId, kind, text: body, auto });
    this.store.addMessage(customerId, 'out', body);
    return { text: body };
  }

  preview({ customerId, kind, orderId = null }) {
    const c = this.store.getCustomer(customerId);
    const order = orderId ? this.store.getOrder(orderId) : null;
    return templates[kind]?.(c, order, this.config) ?? '';
  }

  // 自動提醒：明天到期 / 今天到期 / 已逾期的未匯款訂單，每天每筆最多一次、總共最多 3 次
  async autoPaymentReminders(now = new Date()) {
    const t = today(this.config.tz, now);
    const due = this.store.all(
      `SELECT o.* FROM orders o JOIN customers c ON c.id = o.customer_id
       WHERE o.status = 'pending_payment' AND o.payment_report IS NULL AND o.payment_due_date IS NOT NULL
         AND o.payment_due_date <= ? AND c.is_friend = 1 AND c.line_user_id IS NOT NULL`,
      addDays(t, 1),
    );
    let sent = 0;
    for (const o of due) {
      const last = this.store.lastReminder(o.customer_id, 'payment', o.id);
      if (last && dateOf(last.sent_at, this.config.tz) === t) continue;
      if (this.store.countReminders(o.id, 'payment') >= 3) continue;
      try {
        await this.send({ customerId: o.customer_id, orderId: o.id, kind: 'payment', auto: true });
        sent++;
      } catch (e) {
        this.logger.error(`自動匯款提醒失敗（訂單 #${o.id}）：${e.message}`);
      }
    }
    return sent;
  }

  async autoReorderReminders(focus) {
    let sent = 0;
    for (const item of focus.items) {
      if (!item.canPush || !item.reasons.some((r) => r.code === 'reorder')) continue;
      try {
        await this.send({ customerId: item.customer.id, kind: 'reorder', auto: true });
        sent++;
      } catch (e) {
        this.logger.error(`自動回購提醒失敗（客戶 #${item.customer.id}）：${e.message}`);
      }
    }
    return sent;
  }

  // 每日排程：自動提醒（若開啟）→ 產生關懷清單 → 推播摘要給客服
  async runDaily(now = new Date(), { baseUrl = '' } = {}) {
    const report = { paymentSent: 0, reorderSent: 0, staffNotified: 0 };
    if (this.config.autoPaymentReminder) report.paymentSent = await this.autoPaymentReminders(now);
    let focus = buildFocusList(this.store, this.config, now);
    if (this.config.autoReorderReminder) {
      report.reorderSent = await this.autoReorderReminders(focus);
      if (report.reorderSent) focus = buildFocusList(this.store, this.config, now);
    }
    const summary = formatFocusSummary(focus, { shopName: this.config.shopName, baseUrl });
    for (const staff of this.config.staffUserIds) {
      try {
        await this.line.push(staff, summary);
        report.staffNotified++;
      } catch (e) {
        this.logger.error(`推播關懷清單給客服失敗：${e.message}`);
      }
    }
    report.focusCount = focus.items.length;
    report.summary = summary;
    return report;
  }
}

// 每分鐘檢查一次，到了設定的小時且今天還沒跑過，就執行每日排程
export function startScheduler({ service, store, config, logger = console, baseUrl = '' }) {
  const tick = async () => {
    const now = new Date();
    const t = today(config.tz, now);
    if (localHour(config.tz, now) < config.dailyReportHour || store.getKv('daily_last_run') === t) return;
    store.setKv('daily_last_run', t);
    try {
      const r = await service.runDaily(now, { baseUrl });
      logger.log(`[每日排程 ${t}] 關懷 ${r.focusCount} 位、自動匯款提醒 ${r.paymentSent}、回購提醒 ${r.reorderSent}、通知客服 ${r.staffNotified}`);
    } catch (e) {
      logger.error(`[每日排程] 失敗：${e.message}`);
    }
  };
  tick();
  return setInterval(tick, 60_000);
}
