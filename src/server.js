import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, loadEnvFile } from './config.js';
import { addDays, today } from './dates.js';
import { ORDER_STATUSES, SERVICE_TYPES, openDb } from './db.js';
import { buildFocusList } from './focus.js';
import { SEGMENTS, buildRepurchaseList, customerStats } from './profile.js';
import { FORWARD_HEADER, forwardStatus, forwardWebhook } from './forward.js';
import { TEMPLATE_EXAMPLE, TEMPLATE_HEADERS, runImport } from './importer.js';
import { LineRegistry, verifySignature } from './line.js';
import { ReminderService, brandInfo, startScheduler, templates } from './reminders.js';
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

// 後台看到的品牌資料：不回傳金鑰本身
function publicBrand(b, store) {
  const { channel_secret: secret, channel_access_token: token, ...rest } = b;
  return {
    ...rest,
    has_secret: Boolean(secret),
    has_token: Boolean(token),
    token_hint: token && token.length >= 20 ? `…${token.slice(-4)}` : '',
    forward_status: store && b.forward_url ? forwardStatus(store, b.id) : null,
  };
}

// 第一次啟動：用 .env 的 LINE 金鑰建立第一個品牌（或補上舊版遷移出來的「預設品牌」）
export function bootstrapBrandFromEnv(store, config) {
  const brands = store.listBrands();
  const fromEnv = { channel_secret: config.channelSecret, channel_access_token: config.channelAccessToken, bank_info: config.bankInfo };
  if (!brands.length) {
    if (!config.channelSecret && !config.channelAccessToken) return null;
    return store.createBrand({ slug: 'default', name: config.shopName, ...fromEnv });
  }
  const legacy = store.getBrandBySlug('default');
  if (legacy && !legacy.channel_secret && config.channelSecret) {
    return store.updateBrand(legacy.id, { ...fromEnv, ...(legacy.name === '預設品牌' && config.shopName !== '本店' ? { name: config.shopName } : {}) });
  }
  return null;
}

// 依 INITIAL_BRANDS 建立品牌；每個代號只建立一次，之後在後台修改或刪除都不會被蓋回來
export function ensureInitialBrands(store, config, logger = console) {
  let done;
  try {
    done = new Set(JSON.parse(store.getKv('initial_brands_created') || '[]'));
  } catch {
    done = new Set();
  }
  const created = [];
  for (const b of config.initialBrands) {
    if (!b.slug || done.has(b.slug)) continue;
    try {
      if (!store.getBrandBySlug(b.slug)) created.push(store.createBrand(b));
      done.add(b.slug);
    } catch (e) {
      logger.error(`建立品牌「${b.name}」失敗：${e.message}`);
    }
  }
  store.setKv('initial_brands_created', JSON.stringify([...done]));
  return created;
}

export function createApp({ store, lines = new LineRegistry(), config, logger = console, fetchImpl = globalThis.fetch }) {
  const webhook = new WebhookHandler({ store, lines, logger, autoReply: config.autoReply });
  const reminders = new ReminderService({ store, lines, config, logger });

  const toId = (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, '無效的編號');
    return n;
  };
  const mustCustomer = (id) => store.getCustomer(id) || (() => { throw new HttpError(404, '找不到客戶'); })();
  const mustOrder = (id) => store.getOrder(id) || (() => { throw new HttpError(404, '找不到訂單'); })();
  const mustBrand = (id) => store.getBrand(id) || (() => { throw new HttpError(404, '找不到品牌'); })();
  // ?brand=<id>：只看單一品牌；空白 = 全部品牌
  // 轉送網址不能指回本系統，否則會無限轉送
  const notSelf = (forwardUrl, req) => {
    if (!forwardUrl) return;
    try {
      if (new URL(forwardUrl).host === req.headers.host) throw new HttpError(400, '轉送網址不能是本系統自己的網址');
    } catch (e) {
      if (e instanceof HttpError) throw e;
    }
  };
  const brandParam = (url) => (url.searchParams.get('brand') ? toId(url.searchParams.get('brand')) : null);
  const badRequest = (fn) => {
    try {
      return fn();
    } catch (e) {
      throw e instanceof HttpError ? e : new HttpError(400, e.message);
    }
  };

  const routes = [
    ['GET', /^\/api\/status$/, () => ({
      brands: store.listBrands().map((b) => publicBrand(b, store)),
      staffCount: reminders.staffTargets().length,
      dailyReportHour: config.dailyReportHour,
      autoPaymentReminder: config.autoPaymentReminder,
      autoReorderReminder: config.autoReorderReminder,
      autoTripReminder: config.autoTripReminder,
      lastDailyRun: store.getKv('daily_last_run'),
      today: today(config.tz),
      orderStatuses: ORDER_STATUSES,
      serviceTypes: SERVICE_TYPES,
    })],
    ['GET', /^\/api\/brands$/, () => store.listBrands().map((b) => publicBrand(b, store))],
    ['POST', /^\/api\/brands$/, (_m, body, _u, req) => { notSelf(body.forward_url, req); return publicBrand(badRequest(() => store.createBrand(body)), store); }],
    ['PATCH', /^\/api\/brands\/(\d+)$/, ([, id], body, _u, req) => {
      const brand = mustBrand(toId(id));
      const fields = { ...body };
      // 金鑰欄位留空代表不修改
      for (const k of ['channel_secret', 'channel_access_token']) if (!fields[k]) delete fields[k];
      notSelf(fields.forward_url, req);
      return publicBrand(badRequest(() => store.updateBrand(brand.id, fields)), store);
    }],
    ['DELETE', /^\/api\/brands\/(\d+)$/, ([, id]) => { badRequest(() => store.deleteBrand(mustBrand(toId(id)).id)); return { ok: true }; }],
    ['POST', /^\/api\/brands\/(\d+)\/sync-followers$/, async ([, id]) => {
      const brand = mustBrand(toId(id));
      const line = lines.for(brand);
      let ids;
      try {
        ids = await line.followerIds();
      } catch (e) {
        throw new HttpError(502, `無法取得好友名單（此功能僅限認證或進階帳號）：${e.message}`);
      }
      let added = 0;
      for (const uid of ids) {
        if (store.getCustomerByLineId(brand.id, uid)) continue;
        const profile = await line.getProfile(uid).catch(() => ({}));
        store.upsertLineCustomer(brand.id, uid, profile);
        added++;
      }
      return { total: ids.length, added };
    }],
    ['GET', /^\/api\/focus$/, (_m, _b, url) => buildFocusList(store, config, new Date(), { brandId: brandParam(url) })],
    ['GET', /^\/api\/repurchase$/, (_m, _b, url) => ({ ...buildRepurchaseList(store, config, { filter: url.searchParams.get('filter') || 'all', brandId: brandParam(url) }), segments: SEGMENTS })],
    ['GET', /^\/api\/customers$/, (_m, _b, url) => {
      const staff = new Set(store.staffIds());
      return store.listCustomers({ q: url.searchParams.get('q') || '', tag: url.searchParams.get('tag') || '', brandId: brandParam(url) }).map((c) => ({ ...c, is_staff: staff.has(c.id) }));
    }],
    ['POST', /^\/api\/customers$/, (_m, body) => badRequest(() => store.createCustomer(Number(body.brand_id), body))],
    ['GET', /^\/api\/customers\/(\d+)$/, ([, id]) => {
      const c = mustCustomer(toId(id));
      const orders = store.listOrders({ customerId: c.id });
      return { customer: { ...c, is_staff: store.staffIds().includes(c.id) }, brand: publicBrand(store.getBrand(c.brand_id)), stats: customerStats(c, orders, config), orders, messages: store.listMessages(c.id), reminders: store.listReminders(c.id) };
    }],
    ['POST', /^\/api\/customers\/(\d+)\/staff$/, ([, id], body) => {
      const c = mustCustomer(toId(id));
      if (body.staff && !(c.line_user_id && c.is_friend)) throw new HttpError(400, '這位不是 LINE 好友，無法接收通知');
      store.setStaff(c.id, Boolean(body.staff));
      return { ok: true };
    }],
    ['PATCH', /^\/api\/customers\/(\d+)$/, ([, id], body) => { mustCustomer(toId(id)); return store.updateCustomer(toId(id), body); }],
    ['DELETE', /^\/api\/customers\/(\d+)$/, ([, id]) => { store.deleteCustomer(toId(id)); return { ok: true }; }],
    ['POST', /^\/api\/customers\/(\d+)\/handled$/, ([, id]) => { mustCustomer(toId(id)); store.markHandled(toId(id)); return { ok: true }; }],
    ['GET', /^\/api\/customers\/(\d+)\/preview$/, ([, id], _b, url) => ({
      text: reminders.preview({ customerId: mustCustomer(toId(id)).id, kind: url.searchParams.get('kind'), orderId: url.searchParams.get('orderId') ? toId(url.searchParams.get('orderId')) : null }),
    })],
    ['POST', /^\/api\/customers\/(\d+)\/send$/, async ([, id], body) => {
      const kind = ['payment', 'reorder', 'trip', 'care', 'birthday', 'custom'].includes(body.kind) ? body.kind : 'custom';
      try {
        return await reminders.send({ customerId: mustCustomer(toId(id)).id, kind, orderId: body.orderId ? toId(body.orderId) : null, text: body.text });
      } catch (e) {
        throw e instanceof HttpError ? e : new HttpError(502, e.message);
      }
    }],
    ['GET', /^\/api\/orders$/, (_m, _b, url) => store.listOrders({ status: url.searchParams.get('status') || '', brandId: brandParam(url) })],
    ['POST', /^\/api\/orders$/, (_m, body) => {
      const c = mustCustomer(toId(body.customer_id));
      const orderDate = body.order_date || today(config.tz);
      return badRequest(() => store.createOrder(c.id, {
        ...body,
        amount: Math.round(Number(body.amount) || 0),
        order_date: orderDate,
        payment_due_date: body.payment_due_date || (body.status && body.status !== 'pending_payment' ? null : defaultPaymentDue(orderDate, body.service_date)),
      }));
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
          await reminders.send({ customerId: order.customer_id, orderId: order.id, kind: 'custom', text: templates.paymentReceived(store.getCustomer(order.customer_id), order, brandInfo(store.getBrand(store.getCustomer(order.customer_id).brand_id), config)) });
          notified = true;
        } catch (e) {
          notified = e.message;
        }
      }
      return { order, notified };
    }],
    ['DELETE', /^\/api\/orders\/(\d+)$/, ([, id]) => { store.deleteOrder(toId(id)); return { ok: true }; }],
    // 匯入舊資料：dryRun = true 為預覽（不寫入）
    ['POST', /^\/api\/import$/, (_m, body) => badRequest(() => runImport(store, config, {
      csv: String(body.csv ?? ''),
      mapping: body.mapping || null,
      brandId: body.brand_id ? Number(body.brand_id) : null,
      dryRun: body.dry_run !== false,
    }))],
    ['POST', /^\/api\/run-daily$/, (_m, _b, _u, req) => reminders.runDaily(new Date(), { baseUrl: `http://${req.headers.host}` })],
  ];

  const toCsv = (cols, rows) => `\uFEFF${[cols.map(([, label]) => csvCell(label)).join(','), ...rows.map((r) => cols.map(([k]) => csvCell(r[k])).join(','))].join('\r\n')}`;

  // 匯款期限預設下單後 N 天，但最晚要在用車前一天（當天或隔天就用車的，期限就是下單日）
  function defaultPaymentDue(orderDate, serviceDate) {
    const due = addDays(orderDate, config.paymentDueDays);
    if (!serviceDate || due < serviceDate) return due;
    const dayBefore = addDays(serviceDate, -1);
    return dayBefore > orderDate ? dayBefore : orderDate;
  }

  const brandName = () => {
    const names = new Map(store.listBrands().map((b) => [b.id, b.name]));
    return (id) => names.get(id) || '';
  };

  function exportCustomersCsv(brandId) {
    const nameOfBrand = brandName();
    const all = buildRepurchaseList(store, config, { brandId }).rows;
    const statsById = new Map(all.map((r) => [r.customer.id, r.stats]));
    const rows = store.listCustomers({ brandId }).map((c) => {
      const st = statsById.get(c.id);
      return {
        ...c,
        brand: nameOfBrand(c.brand_id),
        segment: SEGMENTS[st?.segment || 'none'],
        order_count: st?.orderCount ?? 0,
        total_spent: st?.totalSpent ?? 0,
        avg_order: st?.avgOrder ?? 0,
        first_order_date: st?.firstOrderDate,
        last_order_date: st?.lastOrderDate,
        cycle_days: st?.cycle?.days,
        next_reorder_date: st?.nextReorderDate,
        top_items: st?.topItems.map((i) => i.name).join('、'),
        is_friend: c.is_friend ? '是' : '否',
      };
    });
    return toCsv([
      ['id', '編號'], ['brand', '品牌'], ['display_name', 'LINE 名稱'], ['real_name', '姓名'], ['phone', '電話'], ['email', 'Email'], ['birthday', '生日'], ['gender', '性別'],
      ['address', '地址'], ['tags', '標籤'], ['note', '備註'], ['segment', '客戶類型'], ['order_count', '訂單數'], ['total_spent', '累積消費'], ['avg_order', '平均客單價'],
      ['first_order_date', '首次用車'], ['last_order_date', '最近用車'], ['cycle_days', '回訪週期(天)'], ['next_reorder_date', '預計回訪日'], ['top_items', '常用服務'],
      ['is_friend', 'LINE 好友'], ['line_user_id', 'LINE userId'],
    ], rows);
  }

  function exportOrdersCsv(brandId) {
    const nameOfBrand = brandName();
    const rows = store.listOrders({ brandId }).map((o) => ({ ...o, brand: nameOfBrand(o.brand_id), customer_name: o.real_name || o.display_name, status_label: ORDER_STATUSES[o.status], service_label: SERVICE_TYPES[o.service_type] || '' }));
    return toCsv([
      ['id', '訂單編號'], ['brand', '品牌'], ['order_date', '下單日'], ['customer_id', '客戶編號'], ['customer_name', '客戶'], ['service_label', '服務'],
      ['service_date', '用車日'], ['service_time', '時間'], ['flight_no', '航班'], ['pickup', '上車／取車地點'], ['dropoff', '目的地／還車地點'], ['return_date', '結束／還車日'],
      ['items', '內容'], ['amount', '金額'], ['status_label', '狀態'], ['payment_due_date', '匯款期限'], ['payment_report', '匯款回報'], ['paid_at', '入帳時間'], ['note', '備註'],
    ], rows);
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      // 每個品牌的官方帳號各自設定 Webhook：/webhook/<品牌代號>；/webhook 則對應 default 品牌（舊版相容）
      const hook = url.pathname.match(/^\/webhook(?:\/([a-z0-9-]+))?\/?$/);
      if (hook && req.method === 'POST') {
        const brand = store.getBrandBySlug(hook[1] || 'default') || (!hook[1] && store.listBrands().length === 1 ? store.listBrands()[0] : null);
        if (!brand) return send(res, 404, 'unknown brand');
        const raw = await readBody(req);
        const signature = req.headers['x-line-signature'];
        if (!verifySignature(brand.channel_secret, raw, signature)) return send(res, 401, 'invalid signature');
        // 同時轉送一份給品牌原本使用的系統（不影響本系統處理）
        const forwarding = brand.forward_url && !req.headers[FORWARD_HEADER]
          ? forwardWebhook({ store, brand, raw, signature, fetchImpl, logger })
          : null;
        let body;
        try { body = JSON.parse(raw.toString('utf8')); } catch { send(res, 400, 'bad json'); await forwarding; return; }
        send(res, 200, 'ok'); // 先回 200 給 LINE，再慢慢處理
        await webhook.handle(brand, body);
        await forwarding;
        return;
      }
      if (url.pathname === '/healthz') return send(res, 200, 'ok');

      if (!config.adminPassword) return send(res, 503, '請先設定 ADMIN_PASSWORD 才能使用後台（本機：.env 檔；Render：服務的 Environment 頁）');
      if (!checkAuth(req, config.adminPassword)) return send(res, 401, '請登入', { 'WWW-Authenticate': 'Basic realm="LINE CRM", charset="UTF-8"' });

      if (req.method === 'GET' && STATIC[url.pathname]) {
        const file = path.join(PUBLIC_DIR, STATIC[url.pathname]);
        return send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-cache' });
      }
      if (req.method === 'GET' && url.pathname === '/api/export/backup.db') {
        const file = path.join(os.tmpdir(), `crm-backup-${process.pid}-${Date.now()}.db`);
        try {
          store.backupTo(file);
          return send(res, 200, fs.readFileSync(file), { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="crm-backup-${today(config.tz)}.db"` });
        } finally {
          fs.rmSync(file, { force: true });
        }
      }
      const exports = { '/api/export/customers.csv': ['customers', exportCustomersCsv], '/api/export/orders.csv': ['orders', exportOrdersCsv], '/api/import/template.csv': ['import-template', () => toCsv(TEMPLATE_HEADERS.map((h, i) => [i, h]), [TEMPLATE_EXAMPLE])] };
      if (req.method === 'GET' && exports[url.pathname]) {
        const [name, fn] = exports[url.pathname];
        return send(res, 200, fn(brandParam(url)), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}-${today(config.tz)}.csv"` });
      }

      for (const [method, pattern, fn] of routes) {
        const m = url.pathname.match(pattern);
        if (!m || method !== req.method) continue;
        let body = {};
        if (['POST', 'PATCH'].includes(req.method)) {
          const raw = (await readBody(req, url.pathname === '/api/import' ? 20_000_000 : undefined)).toString('utf8');
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
  bootstrapBrandFromEnv(store, config);
  for (const b of ensureInitialBrands(store, config)) console.log(`已建立品牌：${b.name}（${b.slug}）`);
  const lines = new LineRegistry();
  const app = createApp({ store, lines, config });
  http.createServer(app).listen(config.port, () => {
    console.log(`LINE 客戶管理系統已啟動：http://localhost:${config.port}`);
    const brands = store.listBrands();
    if (!brands.length) console.warn('⚠ 尚未建立品牌，請到後台「品牌」頁新增並填入 LINE 金鑰');
    for (const b of brands) console.log(`  ${b.name} Webhook：https://<你的網域>/webhook/${b.slug}${b.channel_secret ? '' : '（⚠ 尚未設定金鑰）'}`);
    if (!config.adminPassword) console.warn('⚠ 尚未設定 ADMIN_PASSWORD，後台無法登入');
  });
  const service = new ReminderService({ store, lines, config });
  startScheduler({ service, store, config, baseUrl: process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '' });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
