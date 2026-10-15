import { addDays, dateOf, diffDays, localHour, today } from './dates.js';
import { SERVICE_TYPES } from './db.js';
import { buildFocusList, formatFocusSummary } from './focus.js';
import { customerStats, parseItems } from './profile.js';
import { runBackup } from './backup.js';
import { applyRetention } from './retention.js';
import { buildWeekly, weekRange } from './weekly.js';

const nameOf = (c) => c.real_name || c.display_name || '您好';

// 「2026-10-14」→「10/14（二）」
const shortDate = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}（${'日一二三四五六'[new Date(`${d}T00:00:00Z`).getUTCDay()]}）`;
const RELATIVE_DAYS = { 0: '今天', 1: '明天', 2: '後天' };

// 首次客的回訪邀請：問這趟的感受，再邀請下次用車（mk-390：先把一次客推到第二次）
const FIRST_TIME = {
  airport: ['謝謝您第一次搭乘我們的機場接送！', '的行程還順利嗎？有任何建議都歡迎告訴我們。', '下次出國或回國需要接送，也可以交給我們。'],
  charter: ['謝謝您第一次選擇我們的包車！', '的行程玩得開心嗎？有任何建議都歡迎告訴我們。', '下次家庭出遊、公司旅遊或接送長輩需要包車，也可以交給我們。'],
  rental: ['謝謝您第一次向我們租車！', '的自駕行程還順利嗎？車況或服務有任何建議，都歡迎告訴我們。', '下次出遊需要租車，也可以交給我們。'],
};

export const templates = {
  payment(c, o, cfg) {
    return [
      `${nameOf(c)} 您好，這裡是${cfg.shopName} 😊`,
      o.paid_amount > 0 && o.paid_amount < o.amount
        ? `提醒您訂單 #${o.id}${o.items ? `（${o.items}）` : ''} 已收到訂金 NT$${o.paid_amount}，尾款 NT$${o.amount - o.paid_amount}，匯款期限為 ${o.payment_due_date || '近日'}。`
        : `提醒您訂單 #${o.id}${o.items ? `（${o.items}）` : ''} 金額 NT$${o.amount}，匯款期限為 ${o.payment_due_date || '近日'}。`,
      cfg.bankInfo ? `匯款資訊：${cfg.bankInfo}` : '',
      '完成匯款後，請回覆「已匯款 帳號末五碼」，我們會盡快為您確認，謝謝！',
    ].filter(Boolean).join('\n');
  },
  // 回訪邀請依客戶分群與上次的服務換說法（參考 ThinkWithBlack MK-390 第一次回購促進計畫）：
  //   首次客：問這趟行程的感受，邀請下次再用
  //   回頭客 / 忠實客：有自己的用車間隔時才提「平常大約每 N 天」，其他只講事實天數
  //   沉睡客：好久不見，不催單
  // 只引用訂單裡有的事實（服務類型、天數），不寫資料沒有的優惠或服務
  reorder(c, _o, cfg, stats) {
    const hello = `${nameOf(c)} 您好，這裡是${cfg.shopName} 😊`;
    const reply = '直接回覆這則訊息，就能幫您安排！';
    const days = stats?.daysSinceLastOrder;
    if (!stats?.orderCount || !(days > 0)) return `${hello}\n謝謝您的支持！之後有出國、出遊或其他用車的需要，${reply}`;
    const type = stats.lastOrder?.service_type;
    const service = SERVICE_TYPES[type] || parseItems(stats.lastItems).join('、') || '用車';
    if (stats.segment === 'dormant') {
      return [
        `${nameOf(c)} 您好，好久不見，這裡是${cfg.shopName} 💛`,
        `距離您上次的${service}已經 ${days} 天了，最近還好嗎？`,
        '之後有出國、出遊或其他用車的需要，隨時回覆這則訊息，我們都在這裡！',
      ].join('\n');
    }
    if (stats.segment === 'first') {
      const [thanks, how, next] = FIRST_TIME[type] || ['謝謝您第一次選擇我們！', `的${service}還順利嗎？有任何建議都歡迎告訴我們。`, '下次需要用車，也可以交給我們。'];
      return [hello, `${thanks}${days} 天前${how}`, `${next}${reply}`].join('\n');
    }
    const timing = stats.cycle?.source?.startsWith('依')
      ? `您平常大約每 ${stats.cycle.days} 天會找我們一次，距離上次的${service}已經 ${days} 天了`
      : `距離上次的${service}已經 ${days} 天了`;
    return [hello, `謝謝您一直以來的支持！${timing}，最近有出國或出遊的計畫嗎？`, `需要用車的話，可以早點幫您安排。${reply}`].join('\n');
  },
  // 行程確認：用車前一天傳給客戶，列出時間、航班、地點，請客戶有異動就回覆
  trip(c, o, cfg, { today: t } = {}) {
    if (!o) return '';
    const type = SERVICE_TYPES[o.service_type] || '用車';
    const date = o.service_date ? shortDate(o.service_date) : '';
    const rel = o.service_date && t ? RELATIVE_DAYS[diffDays(o.service_date, t)] : '';
    const when = [date, o.service_time].filter(Boolean).join(' ');
    const head = `提醒您${[rel, date].filter(Boolean).join(' ')}的${type}行程（訂單 #${o.id}）：`;
    const lines = o.service_type === 'rental'
      ? [
        when || o.pickup ? `🚗 取車：${[when, o.pickup].filter(Boolean).join('｜')}` : '',
        o.return_date || o.dropoff ? `🔑 還車：${[o.return_date ? shortDate(o.return_date) : '', o.dropoff].filter(Boolean).join('｜')}` : '',
        o.items ? `🚙 車型：${o.items}` : '',
        '取車時請攜帶駕照與身分證件。',
      ]
      : [
        when ? `🕐 時間：${when}` : '',
        o.flight_no ? `✈️ 航班：${o.flight_no}` : '',
        o.pickup ? `📍 上車地點：${o.pickup}` : '',
        o.dropoff ? `🏁 目的地：${o.dropoff}` : '',
        o.return_date && o.return_date !== o.service_date ? `📅 行程到 ${shortDate(o.return_date)}` : '',
        o.items ? `🚐 ${o.items}` : '',
      ];
    return [
      `${nameOf(c)} 您好，這裡是${cfg.shopName} 😊`,
      head,
      ...lines.filter(Boolean),
      `${o.service_type === 'airport' ? '航班、' : ''}時間或地點有異動的話，請直接回覆這則訊息告訴我們，謝謝！`,
    ].join('\n');
  },
  care(c, _o, cfg) {
    return `${nameOf(c)} 您好，謝謝您加入${cfg.shopName}的好友 💛\n想詢問報價、預約行程或有任何問題，直接在這裡留言，我們會很快回覆您！`;
  },
  birthday(c, _o, cfg) {
    return `${nameOf(c)} 生日快樂 🎂\n${cfg.shopName}祝您今天開開心心！感謝一直以來的支持，有需要隨時找我們喔 💛`;
  },
  // 服務完成後的感謝與評價邀請（品牌有設定評價連結才附上）
  thanks(c, o, cfg) {
    const service = SERVICE_TYPES[o?.service_type] || '服務';
    return [
      `${nameOf(c)} 您好，這裡是${cfg.shopName} 😊`,
      `謝謝您這次選擇我們的${service}${o?.service_date ? `（${shortDate(o.service_date)}）` : ''}！一切都還順利嗎？`,
      cfg.reviewUrl ? `如果您滿意這次的服務，很希望您花一分鐘幫我們留個評價，給我們很大的鼓勵 🙏\n${cfg.reviewUrl}` : '有任何建議都歡迎直接回覆告訴我們，我們會持續改進。',
    ].join('\n');
  },
  // 服務後約 30 天的回購邀請（品牌有設定回購優惠才提優惠）
  rebook(c, o, cfg) {
    const service = SERVICE_TYPES[o?.service_type] || '用車';
    return [
      `${nameOf(c)} 您好，這裡是${cfg.shopName} 💛`,
      `謝謝您上次使用我們的${service}！之後有出國、出遊或其他用車的需要，也可以交給我們。`,
      cfg.rebookOffer ? `🎁 回頭客專屬：${cfg.rebookOffer}` : '',
      '直接回覆這則訊息，就能幫您安排！',
    ].filter(Boolean).join('\n');
  },
  paymentReceived(c, o, cfg) {
    return `${nameOf(c)} 您好，已收到您訂單 #${o.id} 的款項 NT$${o.amount}，我們會盡快為您出貨，謝謝支持${cfg.shopName}！`;
  },
};

// 訊息範本用的品牌資訊：店名、匯款帳號都依客戶所屬品牌
export function brandInfo(brand, config) {
  return { shopName: brand?.name || config.shopName, bankInfo: brand?.bank_info || '', reviewUrl: brand?.review_url || '', rebookOffer: brand?.rebook_offer || '' };
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
  async send({ customerId, kind, orderId = null, text, auto = false, staffName = auto ? '系統自動' : null }) {
    const c = this.store.getCustomer(customerId);
    if (!c) throw new Error('找不到客戶');
    const order = orderId ? this.store.getOrder(orderId) : null;
    const { line, info } = this.context(c);
    const body = text?.trim() || templates[kind]?.(c, order, info, this.extras(c, kind));
    if (!body) throw new Error('訊息內容為空');
    if (!c.line_user_id || !c.is_friend) {
      const error = '此客戶不是 LINE 好友，無法推播';
      this.store.logReminder({ customerId, orderId, kind, text: body, ok: false, error, auto, staffName });
      throw new Error(error);
    }
    try {
      await line.push(c.line_user_id, body);
    } catch (e) {
      this.store.logReminder({ customerId, orderId, kind, text: body, ok: false, error: e.message, auto, staffName });
      throw e;
    }
    this.store.logReminder({ customerId, orderId, kind, text: body, auto, staffName });
    this.store.addMessage(customerId, 'out', body, 'text', { staffName });
    return { text: body };
  }

  preview({ customerId, kind, orderId = null }) {
    const c = this.store.getCustomer(customerId);
    const order = orderId ? this.store.getOrder(orderId) : null;
    return templates[kind]?.(c, order, this.context(c).info, this.extras(c, kind)) ?? '';
  }

  // 範本需要的額外資料：回訪邀請要消費統計（上次服務、距今天數、分群）；行程確認要今天日期（算「明天」）
  extras(customer, kind) {
    if (kind === 'trip') return { today: today(this.config.tz) };
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

  // 週報接收人：用他所屬品牌的帳號推播
  weeklyTargets() {
    const targets = [];
    for (const id of this.store.weeklyIds()) {
      const c = this.store.getCustomer(id);
      if (c?.line_user_id && c.is_friend) targets.push({ to: c.line_user_id, line: this.context(c).line });
    }
    return targets;
  }

  async sendWeekly(now = new Date()) {
    const weekly = buildWeekly(this.store, this.config, { now });
    let sent = 0;
    const errors = [];
    for (const { to, line } of this.weeklyTargets()) {
      try {
        await line.push(to, weekly.text);
        sent++;
      } catch (e) {
        errors.push(e.message);
        this.logger.error(`推播週報失敗：${e.message}`);
      }
    }
    return { sent, failed: errors.length, errors, text: weekly.text };
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

  // 自動行程確認：明天用車的訂單，每筆只傳一次
  async autoTripReminders(now = new Date()) {
    const tomorrow = addDays(today(this.config.tz, now), 1);
    const due = this.store.all(
      `SELECT o.* FROM orders o JOIN customers c ON c.id = o.customer_id
       WHERE o.service_date = ? AND o.status IN ('pending_payment', 'paid', 'shipped') AND c.is_friend = 1 AND c.line_user_id IS NOT NULL`,
      tomorrow,
    );
    let sent = 0;
    for (const o of due) {
      if (this.store.lastReminder(o.customer_id, 'trip', o.id)) continue;
      try {
        await this.send({ customerId: o.customer_id, orderId: o.id, kind: 'trip', auto: true });
        sent++;
      } catch (e) {
        this.logger.error(`自動行程確認失敗（訂單 #${o.id}）：${e.message}`);
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
        this.logger.error(`自動回訪邀請失敗（客戶 #${item.customer.id}）：${e.message}`);
      }
    }
    return sent;
  }

  // 每日排程：自動提醒（若開啟）→ 產生關懷清單 → 推播摘要給客服
  async runDaily(now = new Date(), { baseUrl = '' } = {}) {
    const report = { paymentSent: 0, tripSent: 0, reorderSent: 0, staffNotified: 0 };
    if (this.config.autoPaymentReminder) report.paymentSent = await this.autoPaymentReminders(now);
    if (this.config.autoTripReminder) report.tripSent = await this.autoTripReminders(now);
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
    if (localHour(config.tz, now) < config.dailyReportHour) return;
    if (store.getKv('daily_last_run') !== t) {
      store.setKv('daily_last_run', t);
      try {
        const r = await service.runDaily(now, { baseUrl });
        logger.log(`[每日排程 ${t}] 關懷 ${r.focusCount} 位、自動匯款提醒 ${r.paymentSent}、行程確認 ${r.tripSent}、回訪邀請 ${r.reorderSent}、通知客服 ${r.staffNotified}`);
      } catch (e) {
        logger.error(`[每日排程] 失敗：${e.message}`);
      }
      // 個資保存規則（管理員有設定才會執行）
      try {
        const n = applyRetention(store, config, { now });
        if (n) logger.log(`[個資保存] 匿名化 ${n} 位客戶`);
      } catch (e) {
        logger.error(`[個資保存] 失敗：${e.message}`);
      }
    }
    // 每日自動備份
    if (config.autoBackup && store.getKv('backup_last_run') !== t) {
      store.setKv('backup_last_run', t);
      try {
        const r = await runBackup(store, config, { now, logger });
        logger.log(`[備份 ${t}] ${r.name}（${Math.round(r.size / 1024)} KB）${r.remote ? '，已上傳雲端' : ''}`);
      } catch (e) {
        logger.error(`[備份] 失敗：${e.message}`);
      }
    }
    // 每週營運週報：設定的星期幾（預設星期一），和每日清單同一時間
    const week = weekRange(config.tz, now).weekKey;
    const weekday = new Date(`${t}T00:00:00Z`).getUTCDay();
    if (weekday === config.weeklyReportDay && store.getKv('weekly_last_run') !== week) {
      store.setKv('weekly_last_run', week);
      try {
        const r = await service.sendWeekly(now);
        logger.log(`[週報 ${t}] 推播給 ${r.sent} 位`);
      } catch (e) {
        logger.error(`[週報] 失敗：${e.message}`);
      }
    }
  };
  tick();
  return setInterval(tick, 60_000);
}
