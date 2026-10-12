import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, loadEnvFile } from './config.js';
import { addDays, today } from './dates.js';
import { ORDER_STATUSES, openDb } from './db.js';
import { buildFocusList } from './focus.js';
import { LineClient, verifySignature } from './line.js';
import { ReminderService, startScheduler, templates } from './reminders.js';
import { WebhookHandler } from './webhook.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, '內容過大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

function checkAuth(req, password) {
  const m = (req.headers.authorization || '').match(/^Basic (.+)$/);
  if (!m) return false;
  const [, pass = ''] = Buffer.from(m[1], 'base64').toString().split(/:(.*)/s);
  const a = crypto.createHash('sha256').update(pass).digest();
  const b = crypto.createHash('sha256').update(password).digest();
  return crypto.timingSafeEqual(a, b);
}

// 匯出 CSV：加引號，並在 = + - @ 開頭前加 ' 避免 Excel 公式注入
const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

export function createApp({ store, line, config, logger = console }) {
  const webhook = new WebhookHandler({ store, line, logger });
  const reminders = new ReminderService({ store, line, config, logger });

  const toId = (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, '無效的編號');
    return n;
  };
  const mustCustomer = (id) => store.getCustomer(id) || (() => { throw new HttpError(404, '找不到客戶'); })();
  const mustOrder = (id) => store.getOrder(id) || (() => { throw new HttpError(404, '找不到訂單'); })();

  const routes = [
    ['GET', /^\/api\/status$/, () => ({
      lineConfigured: Boolean(config.channelSecret && config.channelAccessToken),
      staffCount: config.staffUserIds.length,
      dailyReportHour: config.dailyReportHour,
      autoPaymentReminder: config.autoPaymentReminder,
      autoReorderReminder: config.autoReorderReminder,
      lastDailyRun: store.getKv('daily_last_run'),
      today: today(config.tz),
      orderStatuses: ORDER_STATUSES,
    })],
    ['GET', /^\/api\/focus$/, () => buildFocusList(store, config)],
    ['GET', /^\/api\/customers$/, (_m, _b, url) => store.listCustomers({ q: url.searchParams.get('q') || '', tag: url.searchParams.get('tag') || '' })],
    ['POST', /^\/api\/customers$/, (_m, body) => store.createCustomer(body)],
    ['GET', /^\/api\/customers\/(\d+)$/, ([, id]) => {
      const c = mustCustomer(toId(id));
      return { customer: c, orders: store.listOrders({ customerId: c.id }), messages: store.listMessages(c.id), reminders: store.listReminders(c.id) };
    }],
    ['PATCH', /^\/api\/customers\/(\d+)$/, ([, id], body) => { mustCustomer(toId(id)); return store.updateCustomer(toId(id), body); }],
    ['DELETE', /^\/api\/customers\/(\d+)$/, ([, id]) => { store.deleteCustomer(toId(id)); return { ok: true }; }],
    ['POST', /^\/api\/customers\/(\d+)\/handled$/, ([, id]) => { mustCustomer(toId(id)); store.markHandled(toId(id)); return { ok: true }; }],
    ['GET', /^\/api\/customers\/(\d+)\/preview$/, ([, id], _b, url) => ({
      text: reminders.preview({ customerId: mustCustomer(toId(id)).id, kind: url.searchParams.get('kind'), orderId: url.searchParams.get('orderId') ? toId(url.searchParams.get('orderId')) : null }),
    })],
    ['POST', /^\/api\/customers\/(\d+)\/send$/, async ([, id], body) => {
      const kind = ['payment', 'reorder', 'care', 'custom'].includes(body.kind) ? body.kind : 'custom';
      try {
        return await reminders.send({ customerId: mustCustomer(toId(id)).id, kind, orderId: body.orderId ? toId(body.orderId) : null, text: body.text });
      } catch (e) {
        throw e instanceof HttpError ? e : new HttpError(502, e.message);
      }
    }],
    ['GET', /^\/api\/orders$/, (_m, _b, url) => store.listOrders({ status: url.searchParams.get('status') || '' })],
    ['POST', /^\/api\/orders$/, (_m, body) => {
      const c = mustCustomer(toId(body.customer_id));
      const orderDate = body.order_date || today(config.tz);
      return store.createOrder(c.id, {
        ...body,
        amount: Math.round(Number(body.amount) || 0),
        order_date: orderDate,
        payment_due_date: body.payment_due_date || (body.status && body.status !== 'pending_payment' ? null : addDays(orderDate, config.paymentDueDays)),
      });
    }],
    ['PATCH', /^\/api\/orders\/(\d+)$/, async ([, id], body) => {
      const before = mustOrder(toId(id));
      if ('amount' in body) body.amount = Math.round(Number(body.amount) || 0);
      let order;
      try {
        order = store.updateOrder(before.id, body);
      } catch (e) {
        throw new HttpError(400, e.message);
      }
      let notified = null;
      if (body.notify && before.status === 'pending_payment' && order.status === 'paid') {
        try {
          await reminders.send({ customerId: order.customer_id, orderId: order.id, kind: 'custom', text: templates.paymentReceived(store.getCustomer(order.customer_id), order, config) });
          notified = true;
        } catch (e) {
          notified = e.message;
        }
      }
      return { order, notified };
    }],
    ['DELETE', /^\/api\/orders\/(\d+)$/, ([, id]) => { store.deleteOrder(toId(id)); return { ok: true }; }],
    ['POST', /^\/api\/sync-followers$/, async () => {
      let ids;
      try {
        ids = await line.followerIds();
      } catch (e) {
        throw new HttpError(502, `無法取得好友名單（此功能僅限認證或進階帳號）：${e.message}`);
      }
      let added = 0;
      for (const uid of ids) {
        if (store.getCustomerByLineId(uid)) continue;
        const profile = await line.getProfile(uid).catch(() => ({}));
        store.upsertLineCustomer(uid, profile);
        added++;
      }
      return { total: ids.length, added };
    }],
    ['POST', /^\/api\/run-daily$/, (_m, _b, _u, req) => reminders.runDaily(new Date(), { baseUrl: `http://${req.headers.host}` })],
  ];

  function exportCsv() {
    const cols = ['id', 'display_name', 'real_name', 'phone', 'address', 'tags', 'note', 'is_friend', 'followed_at', 'order_count', 'total_spent', 'last_order_date', 'line_user_id'];
    const rows = store.listCustomers().map((c) => cols.map((k) => csvCell(c[k])).join(','));
    return `﻿${[cols.join(','), ...rows].join('\r\n')}`;
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/webhook' && req.method === 'POST') {
        const raw = await readBody(req);
        if (!verifySignature(config.channelSecret, raw, req.headers['x-line-signature'])) return send(res, 401, 'invalid signature');
        let body;
        try { body = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, 'bad json'); }
        send(res, 200, 'ok'); // 先回 200 給 LINE，再慢慢處理
        await webhook.handle(body);
        return;
      }
      if (url.pathname === '/healthz') return send(res, 200, 'ok');

      if (!config.adminPassword) return send(res, 503, '請先在 .env 設定 ADMIN_PASSWORD 才能使用後台');
      if (!checkAuth(req, config.adminPassword)) return send(res, 401, '請登入', { 'WWW-Authenticate': 'Basic realm="LINE CRM", charset="UTF-8"' });

      if (req.method === 'GET' && STATIC[url.pathname]) {
        const file = path.join(PUBLIC_DIR, STATIC[url.pathname]);
        return send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-cache' });
      }
      if (req.method === 'GET' && url.pathname === '/api/export/customers.csv') {
        return send(res, 200, exportCsv(), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="customers-${today(config.tz)}.csv"` });
      }

      for (const [method, pattern, fn] of routes) {
        const m = url.pathname.match(pattern);
        if (!m || method !== req.method) continue;
        let body = {};
        if (['POST', 'PATCH'].includes(req.method)) {
          const raw = (await readBody(req)).toString('utf8');
          try { body = raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'JSON 格式錯誤'); }
        }
        return send(res, 200, await fn(m, body, url, req));
      }
      send(res, 404, { error: '找不到' });
    } catch (e) {
      if (!(e instanceof HttpError)) logger.error(e);
      if (!res.headersSent) send(res, e.status || 500, { error: e.message });
    }
  };
}

function main() {
  loadEnvFile();
  const config = getConfig();
  const store = openDb(config.dbPath);
  const line = new LineClient(config.channelAccessToken);
  const app = createApp({ store, line, config });
  http.createServer(app).listen(config.port, () => {
    console.log(`LINE 客戶管理系統已啟動：http://localhost:${config.port}`);
    console.log(`LINE Webhook 網址：https://<你的網域>/webhook`);
    if (!config.channelSecret || !config.channelAccessToken) console.warn('⚠ 尚未設定 LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN');
    if (!config.adminPassword) console.warn('⚠ 尚未設定 ADMIN_PASSWORD，後台無法登入');
  });
  const service = new ReminderService({ store, line, config });
  startScheduler({ service, store, config, baseUrl: process.env.PUBLIC_URL || '' });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
