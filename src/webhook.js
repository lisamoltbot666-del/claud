import { ORDER_STATUSES, SERVICE_TYPES } from './db.js';

const PAID_PATTERN = /(已|有)?(匯款|轉帳|付款)(完成|好了|了)|已(匯|轉|付)/;
const QUERY_PATTERN = /^(查訂單|訂單查詢|我的訂單|查詢訂單)$/;

const NON_TEXT_LABELS = { image: '[圖片]', video: '[影片]', audio: '[語音]', file: '[檔案]', location: '[位置]', sticker: '[貼圖]' };

// 處理 LINE Webhook 事件：自動收集好友資料、紀錄訊息、辨識匯款回報與查詢訂單
export class WebhookHandler {
  constructor({ store, lines, logger = console }) {
    Object.assign(this, { store, lines, logger });
  }

  async handle(brand, body) {
    const ctx = { brand, line: this.lines.for(brand) };
    for (const event of body.events || []) {
      try {
        await this.handleEvent(ctx, event);
      } catch (e) {
        this.logger.error(`處理 LINE 事件失敗：${e.message}`);
      }
    }
  }

  async ensureCustomer({ brand, line }, userId) {
    const c = this.store.getCustomerByLineId(brand.id, userId);
    if (c && c.display_name) return c;
    let profile = {};
    if (line.enabled) {
      try {
        profile = await line.getProfile(userId);
      } catch (e) {
        this.logger.warn?.(`取得 LINE 個人資料失敗：${e.message}`);
      }
    }
    return this.store.upsertLineCustomer(brand.id, userId, profile);
  }

  async reply({ line }, event, customer, text) {
    if (!event.replyToken || !line.enabled) return;
    try {
      await line.reply(event.replyToken, text);
      // 自動回覆不算客服處理過，保留「未處理」狀態讓客服看到
      this.store.addMessage(customer.id, 'out', text, 'text', { handled: false });
    } catch (e) {
      this.logger.error(`自動回覆失敗：${e.message}`);
    }
  }

  async handleEvent(ctx, event) {
    const { brand, line } = ctx;
    const userId = event.source?.userId;
    if (!userId || event.source.type !== 'user') return;

    if (event.type === 'follow') {
      const existing = this.store.getCustomerByLineId(brand.id, userId);
      let profile = {};
      if (line.enabled) profile = await line.getProfile(userId).catch(() => ({}));
      const c = this.store.upsertLineCustomer(brand.id, userId, profile);
      if (existing) this.store.setFriend(c.id, true);
      return;
    }

    if (event.type === 'unfollow') {
      const c = this.store.getCustomerByLineId(brand.id, userId);
      if (c) this.store.setFriend(c.id, false);
      return;
    }

    if (event.type !== 'message') return;
    const customer = await this.ensureCustomer(ctx, userId);
    if (!customer.is_friend) this.store.setFriend(customer.id, true);
    const msg = event.message || {};
    const text = msg.type === 'text' ? msg.text : NON_TEXT_LABELS[msg.type] || `[${msg.type}]`;
    this.store.addMessage(customer.id, 'in', text, msg.type || 'text');

    const pending = this.store.latestPendingOrder(customer.id);

    if (msg.type === 'text' && QUERY_PATTERN.test(msg.text.trim())) {
      const orders = this.store.listOrders({ customerId: customer.id }).slice(0, 5);
      const lines = orders.length
        ? orders.map((o) => `#${o.id} ${[o.service_date || o.order_date, o.service_time, SERVICE_TYPES[o.service_type]].filter(Boolean).join(' ')} NT$${o.amount}｜${ORDER_STATUSES[o.status]}`)
        : ['目前查不到您的訂單紀錄喔！'];
      await this.reply(ctx, event, customer, ['您最近的訂單：', ...lines].join('\n'));
      return;
    }

    if (pending && msg.type === 'text' && PAID_PATTERN.test(msg.text)) {
      this.store.reportPayment(pending.id, msg.text.slice(0, 200));
      await this.reply(ctx, event, customer, `收到您的匯款通知（訂單 #${pending.id} NT$${pending.amount}），我們核對後會再通知您，謝謝！`);
      return;
    }

    if (pending && msg.type === 'image' && !pending.payment_report) {
      this.store.reportPayment(pending.id, '客戶傳送圖片（可能是匯款截圖），請至官方帳號聊天室查看');
    }
  }
}
