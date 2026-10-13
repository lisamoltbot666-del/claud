import { addDays, dateOf, localHour, today } from './dates.js';
import { buildFocusList, formatFocusSummary } from './focus.js';
import { customerStats, parseItems } from './profile.js';

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
  // 回購提醒依客戶分群換說法（參考 ThinkWithBlack MK-390 第一次回購促進計畫）：
  //   首購客：問使用感受，邀請回購同款或試其他商品（第二件不一定要同款）
  //   回購客 / 忠實客：有自己的購買間隔時才說「差不多用完」，其他只講事實天數
  //   沉睡客：好久不見，不假設商品用完、不催單
  // 只引用訂單裡有的事實（上次品項、天數），不寫資料沒有的優惠或服務
  reorder(c, _o, cfg, stats) {
    const hello = `${nameOf(c)} 您好，這裡是${cfg.shopName} 😊`;
    const reply = '想再訂、或想問其他商品，直接回覆這則訊息就可以，我們會幫您安排！';
    if (!stats?.orderCount) return `${hello}\n距離上次訂購已經一段時間了，商品還夠用嗎？需要再幫您安排一份嗎？${reply}`;
    const items = parseItems(stats.lastItems).join('、');
    const what = items ? `的${items}` : '的商品';
    if (stats.segment === 'dormant') {
      return [
        `${nameOf(c)} 您好，好久不見，這裡是${cfg.shopName} 💛`,
        `距離您上次訂購${what}已經 ${stats.daysSinceLastOrder} 天了，最近還好嗎？`,
        '如果還有需要，或想看看其他商品，隨時回覆這則訊息，我們都在這裡！',
      ].join('\n');
    }
    if (stats.segment === 'first') {
      return [
        hello,
        `謝謝您第一次選擇我們！您 ${stats.daysSinceLastOrder} 天前訂購${what}，用起來還順手嗎？有任何感想都歡迎告訴我們。`,
        `如果快用完了，可以幫您再準備一份；也想試試其他商品的話，跟我們說說您的需求就好。`,
        reply,
      ].join('\n');
    }
    const timing = stats.cycle?.source?.startsWith('依')
      ? `您平常大約每 ${stats.cycle.days} 天補貨一次，上次訂購${what}到現在 ${stats.daysSinceLastOrder} 天，應該差不多要用完了吧？`
      : `距離上次訂購${what}已經 ${stats.daysSinceLastOrder} 天了，還夠用嗎？`;
    return [hello, `謝謝您一直以來的支持！${timing}`, '需要的話可以幫您安排同樣的內容，想換換其他商品也沒問題。', reply].join('\n');
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

// 訊息範本用的品牌資訊：店名、匯款帳號都依客戶所屬品牌
export function brandInfo(brand, config) {
  return { shopName: brand?.name || config.shopName, bankInfo: brand?.bank_info || '' };
}

export class ReminderService {
  constructor({ store, lines, config, logger = console }) {
    Object.assign(this, { store, lines, config, logger });
  }

  context(customer) {
    const brand = this.store.getBrand(customer.brand_id);
    return { brand, line: this.lines.for(brand), info: brandInfo(brand, this.config) };
  }

  // 推播訊息給客戶並記錄
  async send({ customerId, kind, orderId = null, text, auto = false }) {
    const c = this.store.getCustomer(customerId);
    if (!c) throw new Error('找不到客戶');
    const order = orderId ? this.store.getOrder(orderId) : null;
    const { line, info } = this.context(c);
    const body = text?.trim() || templates[kind]?.(c, order, info, this.stats(c, kind));
    if (!body) throw new Error('訊息內容為空');
    if (!c.line_user_id || !c.is_friend) {
      const error = '此客戶不是 LINE 好友，無法推播';
      this.store.logReminder({ customerId, orderId, kind, text: body, ok: false, error, auto });
      throw new Error(error);
    }
    try {
      await line.push(c.line_user_id, body);
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
    return templates[kind]?.(c, order, this.context(c).info, this.stats(c, kind)) ?? '';
  }

  // 回購提醒需要消費統計（上次品項、距今天數、分群）
  stats(customer, kind) {
    if (kind !== 'reorder' || !customer) return null;
    return customerStats(customer, this.store.listOrders({ customerId: customer.id }), this.config);
  }

  // 每日清單推給客服：設定為客服的客戶用其所屬品牌的帳號推播；STAFF_LINE_USER_IDS 則用第一個品牌
  staffTargets() {
    const targets = [];
    for (const id of this.store.staffIds()) {
      const c = this.store.getCustomer(id);
      if (c?.line_user_id && c.is_friend) targets.push({ to: c.line_user_id, line: this.context(c).line });
    }
    const first = this.store.listBrands()[0];
    for (const uid of this.config.staffUserIds) if (first) targets.push({ to: uid, line: this.lines.for(first) });
    return targets;
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
    const summary = formatFocusSummary(focus, { brands: this.store.listBrands(), baseUrl });
    for (const { to, line } of this.staffTargets()) {
      try {
        await line.push(to, summary);
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
