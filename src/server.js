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
import { Auth, ROLES } from './auth.js';
import { assignDriver, dispatchBoard, dispatchText, driverHistory, driverInfoText, getDriver, listDrivers, saveDriver } from './dispatch.js';
import { findDuplicates, mergeCustomers } from './merge.js';
import { LOST_REASONS, buildFunnel, leadInfo, markLost, reopenLead } from './leads.js';
import { buildReport } from './report.js';
import { buildWeekly } from './weekly.js';
import { latestBookingDraft } from './booking-parse.js';
import { PAYMENT_KINDS, PAYMENT_METHODS, addPayment, balanceOf, deletePayment, listPayments } from './payments.js';
import { buildResponse } from './response.js';
import { buildTargets, setTarget } from './targets.js';
import { buildDriverStats } from './driverstats.js';
import { backupDir, backupFile, lastBackup, listBackups, remoteConfigured, runBackup } from './backup.js';
import { applyRetention, findExpired, retentionYears, setRetentionYears } from './retention.js';
import { search } from './search.js';
import { TEMPLATE_VARS, listTemplates, renderTemplate, saveTemplate, seedTemplates } from './templates.js';
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

// 防止其他網站假冒送出修改：瀏覽器有帶 Origin 時，必須和本站相同
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host;
  try { host = new URL(origin).host; } catch { host = ''; }
  if (host !== req.headers.host) throw new HttpError(403, '來源不符');
}

// 匯出 CSV：加引號，並在 = + - @ 開頭前加 ' 避免 Excel 公式注入
const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

const CUSTOMER_FIELD_LABELS = { display_name: 'LINE 名稱', real_name: '姓名', phone: '電話', email: 'Email', birthday: '生日', gender: '性別', address: '地址', tags: '標籤', note: '備註', reorder_days: '回訪週期', next_contact_date: '下次聯絡日' };
const ORDER_FIELD_LABELS = { items: '內容', amount: '金額', order_date: '下單日', payment_due_date: '匯款期限', payment_report: '匯款回報', note: '備註', service_type: '服務類型', service_date: '用車日', service_time: '用車時間', flight_no: '航班', pickup: '上車地點', dropoff: '目的地', return_date: '還車日' };

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
  const webhook = new WebhookHandler({ store, lines, logger, autoReply: config.autoReply, tz: config.tz });
  const reminders = new ReminderService({ store, lines, config, logger });
  const auth = new Auth({ store, config });
  seedTemplates(store);
  // 操作紀錄
  const log = (req, action, { customerId = null, orderId = null, detail = null } = {}) => store.logActivity({ user: req.user, action, customerId, orderId, detail });
  const label = (c) => (c ? c.real_name || c.display_name || `客戶#${c.id}` : '');

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
  // ?brands=1,3,5：報表勾選的多個品牌
  const brandsParam = (url) => {
    const raw = url.searchParams.get('brands');
    if (!raw) return null;
    const ids = [...new Set(raw.split(',').filter(Boolean).map(toId))];
    for (const id of ids) mustBrand(id);
    return ids;
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
    ['GET', /^\/api\/status$/, (_m, _b, _u, req) => ({
      me: req.user,
      roles: ROLES,
      brands: store.listBrands().map((b) => publicBrand(b, store)),
      staffCount: reminders.staffTargets().length,
      weeklyCount: reminders.weeklyTargets().length,
      weeklyReportDay: config.weeklyReportDay,
      dailyReportHour: config.dailyReportHour,
      autoPaymentReminder: config.autoPaymentReminder,
      autoReorderReminder: config.autoReorderReminder,
      autoTripReminder: config.autoTripReminder,
      lastDailyRun: store.getKv('daily_last_run'),
      today: today(config.tz),
      orderStatuses: ORDER_STATUSES,
      paymentKinds: PAYMENT_KINDS,
      paymentMethods: PAYMENT_METHODS,
      serviceTypes: SERVICE_TYPES,
    })],
    ['GET', /^\/api\/brands$/, () => store.listBrands().map((b) => publicBrand(b, store))],
    ['POST', /^\/api\/brands$/, (_m, body, _u, req) => {
      notSelf(body.forward_url, req);
      const b = badRequest(() => store.createBrand(body));
      log(req, '新增品牌', { detail: b.name });
      return publicBrand(b, store);
    }, { admin: true }],
    ['PATCH', /^\/api\/brands\/(\d+)$/, ([, id], body, _u, req) => {
      const brand = mustBrand(toId(id));
      const fields = { ...body };
      // 金鑰欄位留空代表不修改
      for (const k of ['channel_secret', 'channel_access_token']) if (!fields[k]) delete fields[k];
      notSelf(fields.forward_url, req);
      const b = badRequest(() => store.updateBrand(brand.id, fields));
      log(req, '修改品牌設定', { detail: `${b.name}：${Object.keys(fields).map((k) => (k.startsWith('channel_') ? `${k}（金鑰）` : k)).join('、')}` });
      return publicBrand(b, store);
    }, { admin: true }],
    ['DELETE', /^\/api\/brands\/(\d+)$/, ([, id], _b, _u, req) => {
      const b = mustBrand(toId(id));
      badRequest(() => store.deleteBrand(b.id));
      log(req, '刪除品牌', { detail: b.name });
      return { ok: true };
    }, { admin: true }],
    ['POST', /^\/api\/brands\/(\d+)\/sync-followers$/, async ([, id], _body, _u, _req) => {
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
      log(_req, '同步 LINE 好友', { detail: `${brand.name}：好友 ${ids.length} 位，新增 ${added} 位` });
      return { total: ids.length, added };
    }, { admin: true }],
    ['GET', /^\/api\/duplicates$/, (_m, _b, url) => findDuplicates(store, { brandId: brandParam(url) })],
    // 把 other_id 合併進 :id（保留 :id）
    ['POST', /^\/api\/customers\/(\d+)\/merge$/, ([, id], body, _u, req) => {
      const keep = mustCustomer(toId(id));
      const other = mustCustomer(toId(body.other_id));
      const merged = badRequest(() => mergeCustomers(store, keep.id, other.id));
      store.run('UPDATE activity SET customer_id = ? WHERE customer_id = ?', keep.id, other.id);
      log(req, '合併客戶', { customerId: keep.id, detail: `把「${label(other)}」（#${other.id}）合併進來` });
      return merged;
    }],
    ['GET', /^\/api\/search$/, (_m, _b, url) => search(store, config, {
      q: url.searchParams.get('q') || '', from: url.searchParams.get('from') || '', to: url.searchParams.get('to') || '', brandId: brandParam(url),
    })],
    ['GET', /^\/api\/focus$/, (_m, _b, url) => buildFocusList(store, config, new Date(), { brandId: brandParam(url) })],
    ['GET', /^\/api\/repurchase$/, (_m, _b, url) => ({ ...buildRepurchaseList(store, config, { filter: url.searchParams.get('filter') || 'all', brandId: brandParam(url) }), segments: SEGMENTS })],
    ['GET', /^\/api\/customers$/, (_m, _b, url) => {
      const staff = new Set(store.staffIds());
      const weekly = new Set(store.weeklyIds());
      const drivers = new Set(store.all('SELECT line_customer_id FROM drivers WHERE line_customer_id IS NOT NULL').map((r) => r.line_customer_id));
      return store.listCustomers({ q: url.searchParams.get('q') || '', tag: url.searchParams.get('tag') || '', brandId: brandParam(url) }).map((c) => ({ ...c, is_staff: staff.has(c.id), is_weekly: weekly.has(c.id), is_driver: drivers.has(c.id) }));
    }],
    ['POST', /^\/api\/customers$/, (_m, body, _u, req) => {
      const c = badRequest(() => store.createCustomer(Number(body.brand_id), body));
      log(req, '新增客戶', { customerId: c.id, detail: label(c) });
      return c;
    }],
    ['GET', /^\/api\/customers\/(\d+)$/, ([, id]) => {
      const c = mustCustomer(toId(id));
      const orders = store.listOrders({ customerId: c.id });
      const duplicates = (findDuplicates(store, { brandId: c.brand_id, customerId: c.id })[0] || []).filter((d) => d.id !== c.id);
      const lead = leadInfo(store, config, c.id);
      return { booking: latestBookingDraft(store, c.id, today(config.tz)), drivers: driverHistory(store, c.id), lead: lead && { date: lead.date, status: lead.status, age: lead.age, reason: c.lead_lost_reason, note: c.lead_lost_note, by: c.lead_lost_by, at: c.lead_lost_at }, lostReasons: LOST_REASONS, customer: { ...c, is_staff: store.staffIds().includes(c.id), is_weekly: store.weeklyIds().includes(c.id) }, brand: publicBrand(store.getBrand(c.brand_id)), stats: customerStats(c, orders, config), orders, messages: store.listMessages(c.id), reminders: store.listReminders(c.id), duplicates, activity: store.listActivity({ customerId: c.id, limit: 50 }) };
    }],
    ['POST', /^\/api\/customers\/(\d+)\/staff$/, ([, id], body, _u, req) => {
      const c = mustCustomer(toId(id));
      if (body.staff && !(c.line_user_id && c.is_friend)) throw new HttpError(400, '這位不是 LINE 好友，無法接收通知');
      store.setStaff(c.id, Boolean(body.staff));
      log(req, body.staff ? '設為每日清單接收人' : '取消每日清單接收人', { customerId: c.id, detail: label(c) });
      return { ok: true };
    }],
    // 預約單：略過（之後不再顯示這張及更早的）；匯款回報：已核對
    ['POST', /^\/api\/customers\/(\d+)\/booking\/dismiss$/, ([, id], body, _u, req) => {
      const c = mustCustomer(toId(id));
      store.setKv(`booking_dismiss:${c.id}`, String(toId(body.messageId)));
      log(req, '略過預約單', { customerId: c.id });
      return { ok: true };
    }],
    ['POST', /^\/api\/customers\/(\d+)\/payment-claim\/ack$/, ([, id], _b, _u, req) => {
      const c = mustCustomer(toId(id));
      const last = store.get("SELECT MAX(id) AS id FROM messages WHERE customer_id = ? AND direction = 'in'", c.id)?.id || 0;
      store.setKv(`payment_claim_ack:${c.id}`, String(last));
      log(req, '核對客人轉帳回報', { customerId: c.id });
      return { ok: true };
    }],
    ['POST', /^\/api\/customers\/(\d+)\/weekly$/, ([, id], body, _u, req) => {
      const c = mustCustomer(toId(id));
      if (body.weekly && !(c.line_user_id && c.is_friend)) throw new HttpError(400, '這位不是 LINE 好友，無法接收週報');
      store.setWeekly(c.id, Boolean(body.weekly));
      log(req, body.weekly ? '設為週報接收人' : '取消週報接收人', { customerId: c.id, detail: label(c) });
      return { ok: true };
    }, { admin: true }],
    ['PATCH', /^\/api\/customers\/(\d+)$/, ([, id], body, _u, req) => {
      const before = mustCustomer(toId(id));
      const after = store.updateCustomer(before.id, body);
      const changed = Object.keys(body).filter((k) => (before[k] ?? '') !== (after[k] ?? ''));
      if (changed.length) log(req, '修改客戶資料', { customerId: before.id, detail: changed.map((k) => CUSTOMER_FIELD_LABELS[k] || k).join('、') });
      return after;
    }],
    ['DELETE', /^\/api\/customers\/(\d+)$/, ([, id], _b, _u, req) => {
      const c = mustCustomer(toId(id));
      store.deleteCustomer(c.id);
      log(req, '刪除客戶', { detail: `${label(c)}（#${c.id}）` });
      return { ok: true };
    }, { admin: true }],
    ['POST', /^\/api\/customers\/(\d+)\/handled$/, ([, id], _b, _u, req) => {
      mustCustomer(toId(id));
      store.markHandled(toId(id));
      log(req, '標記已回覆', { customerId: toId(id) });
      return { ok: true };
    }],
    ['GET', /^\/api\/customers\/(\d+)\/preview$/, ([, id], _b, url) => ({
      text: reminders.preview({ customerId: mustCustomer(toId(id)).id, kind: url.searchParams.get('kind'), orderId: url.searchParams.get('orderId') ? toId(url.searchParams.get('orderId')) : null }),
    })],
    ['POST', /^\/api\/customers\/(\d+)\/send$/, async ([, id], body, _u, req) => {
      const kind = ['payment', 'reorder', 'trip', 'care', 'birthday', 'thanks', 'rebook', 'custom'].includes(body.kind) ? body.kind : 'custom';
      try {
        return await reminders.send({ customerId: mustCustomer(toId(id)).id, kind, orderId: body.orderId ? toId(body.orderId) : null, text: body.text, staffName: req.user.display_name });
      } catch (e) {
        throw e instanceof HttpError ? e : new HttpError(502, e.message);
      }
    }],
    ['GET', /^\/api\/orders$/, (_m, _b, url) => store.listOrders({ status: url.searchParams.get('status') || '', brandId: brandParam(url) })],
    ['POST', /^\/api\/orders$/, (_m, body, _u, req) => {
      const c = mustCustomer(toId(body.customer_id));
      const orderDate = body.order_date || today(config.tz);
      // 從預約單建立：確認訊息屬於這位客人
      if (body.source_message_id) {
        const msg = store.get('SELECT id FROM messages WHERE id = ? AND customer_id = ?', Number(body.source_message_id), c.id);
        body = { ...body, source_message_id: msg ? msg.id : null };
      }
      const o = badRequest(() => store.createOrder(c.id, {
        ...body,
        amount: Math.round(Number(body.amount) || 0),
        order_date: orderDate,
        payment_due_date: body.payment_due_date || (body.status && body.status !== 'pending_payment' ? null : defaultPaymentDue(orderDate, body.service_date)),
      }));
      log(req, '新增訂單', { customerId: c.id, orderId: o.id, detail: `#${o.id} ${[o.service_date, SERVICE_TYPES[o.service_type]].filter(Boolean).join(' ')} NT$${o.amount}` });
      return o;
    }],
    // ---------- 收款紀錄（訂金、尾款…）----------
    ['GET', /^\/api\/orders\/(\d+)\/payments$/, ([, id]) => {
      const o = store.getOrder(toId(id));
      if (!o) throw new HttpError(404, '找不到訂單');
      return { order: o, payments: listPayments(store, o.id), kinds: PAYMENT_KINDS, methods: PAYMENT_METHODS };
    }],
    ['POST', /^\/api\/orders\/(\d+)\/payments$/, ([, id], body, _u, req) => {
      const o = badRequest(() => addPayment(store, config, toId(id), body, req.user.display_name));
      const p = listPayments(store, o.id).at(-1);
      log(req, '記錄收款', { customerId: o.customer_id, orderId: o.id, detail: `#${o.id} ${PAYMENT_KINDS[p.kind]} NT$${p.amount}（${PAYMENT_METHODS[p.method]}）` });
      return { order: o, payments: listPayments(store, o.id) };
    }],
    ['DELETE', /^\/api\/payments\/(\d+)$/, ([, id], _b, _u, req) => {
      const { payment: p, order: o } = badRequest(() => deletePayment(store, toId(id)));
      log(req, '刪除收款紀錄', { customerId: o.customer_id, orderId: o.id, detail: `#${o.id} ${PAYMENT_KINDS[p.kind]} NT$${p.amount}` });
      return { order: o, payments: listPayments(store, o.id) };
    }],
    ['PATCH', /^\/api\/orders\/(\d+)$/, async ([, id], body, _u, req) => {
      const before = mustOrder(toId(id));
      if ('amount' in body) body.amount = Math.round(Number(body.amount) || 0);
      let order;
      try {
        order = store.updateOrder(before.id, body);
      } catch (e) {
        throw new HttpError(400, e.message);
      }
      const changes = Object.keys(body).filter((k) => k !== 'notify' && (before[k] ?? '') !== (order[k] ?? ''))
        .map((k) => (k === 'status' ? `狀態 ${ORDER_STATUSES[before.status]} → ${ORDER_STATUSES[order.status]}` : ORDER_FIELD_LABELS[k] || k));
      if (changes.length) log(req, '修改訂單', { customerId: order.customer_id, orderId: order.id, detail: `#${order.id} ${changes.join('、')}` });
      let notified = null;
      if (body.notify && before.status === 'pending_payment' && order.status === 'paid') {
        try {
          await reminders.send({ customerId: order.customer_id, orderId: order.id, kind: 'custom', staffName: req.user.display_name, text: templates.paymentReceived(store.getCustomer(order.customer_id), order, brandInfo(store.getBrand(store.getCustomer(order.customer_id).brand_id), config)) });
          notified = true;
        } catch (e) {
          notified = e.message;
        }
      }
      return { order, notified };
    }],
    ['DELETE', /^\/api\/orders\/(\d+)$/, ([, id], _b, _u, req) => {
      const o = mustOrder(toId(id));
      store.deleteOrder(o.id);
      log(req, '刪除訂單', { customerId: o.customer_id, detail: `#${o.id} ${o.service_date || o.order_date} NT$${o.amount}` });
      return { ok: true };
    }],
    // 匯入舊資料：dryRun = true 為預覽（不寫入）
    ['POST', /^\/api\/import$/, (_m, body, _u, req) => {
      const r = badRequest(() => runImport(store, config, {
        csv: String(body.csv ?? ''),
        mapping: body.mapping || null,
        brandId: body.brand_id ? Number(body.brand_id) : null,
        dryRun: body.dry_run !== false,
      }));
      if (!r.dryRun) log(req, '匯入舊資料', { detail: `新增客戶 ${r.stats.customersCreated}、對應 ${r.stats.customersMatched}、新增訂單 ${r.stats.ordersCreated}、略過 ${r.stats.ordersSkipped}、錯誤 ${r.stats.errors.length}` });
      return r;
    }, { admin: true }],
    ['POST', /^\/api\/run-daily$/, (_m, _b, _u, req) => {
      log(req, '手動推播每日清單');
      return reminders.runDaily(new Date(), { baseUrl: `http://${req.headers.host}` });
    }],
    // ---------- 司機與派車 ----------
    ['GET', /^\/api\/drivers$/, () => listDrivers(store)],
    ['POST', /^\/api\/drivers$/, (_m, body, _u, req) => {
      const d = badRequest(() => saveDriver(store, null, body));
      log(req, '新增司機', { detail: d.name });
      return d;
    }],
    ['PATCH', /^\/api\/drivers\/(\d+)$/, ([, id], body, _u, req) => {
      const d = badRequest(() => saveDriver(store, toId(id), body));
      log(req, '修改司機資料', { detail: d.name });
      return d;
    }],
    ['GET', /^\/api\/dispatch$/, (_m, _b, url) => {
      const from = url.searchParams.get('from') || today(config.tz);
      const to = url.searchParams.get('to') || from;
      return { from, to, orders: dispatchBoard(store, { from, to, brandId: brandParam(url) }), drivers: listDrivers(store, { activeOnly: true }) };
    }],
    ['POST', /^\/api\/orders\/(\d+)\/driver$/, ([, id], body, _u, req) => {
      const before = mustOrder(toId(id));
      const o = badRequest(() => assignDriver(store, before.id, body.driver_id ? toId(body.driver_id) : null));
      const d = o.driver_id ? getDriver(store, o.driver_id) : null;
      log(req, d ? '指派司機' : '取消指派司機', { customerId: o.customer_id, orderId: o.id, detail: `#${o.id}${d ? ` → ${d.name}` : ''}` });
      return o;
    }],
    ['GET', /^\/api\/orders\/(\d+)\/dispatch$/, ([, id]) => {
      const o = mustOrder(toId(id));
      const d = o.driver_id ? getDriver(store, o.driver_id) : null;
      const link = d?.line_customer_id ? store.getCustomer(d.line_customer_id) : null;
      return {
        order: o,
        driver: d,
        text: dispatchText(store, o.id),
        customerText: d ? driverInfoText(store, o.id) : '',
        canPushDriver: Boolean(link?.line_user_id && link.is_friend),
        drivers: listDrivers(store, { activeOnly: true }),
      };
    }],
    ['POST', /^\/api\/orders\/(\d+)\/dispatch\/(driver|customer)$/, async ([, id, target], body, _u, req) => {
      const o = mustOrder(toId(id));
      const d = o.driver_id ? getDriver(store, o.driver_id) : null;
      if (!d) throw new HttpError(400, '請先指派司機');
      const toDriver = target === 'driver';
      if (toDriver && !d.line_customer_id) throw new HttpError(400, '這位司機還沒連結 LINE，請複製派車單用其他方式傳送');
      const text = String(body.text || '').trim() || (toDriver ? dispatchText(store, o.id) : driverInfoText(store, o.id));
      try {
        await reminders.send({ customerId: toDriver ? d.line_customer_id : o.customer_id, orderId: toDriver ? null : o.id, kind: 'custom', text, staffName: req.user.display_name });
      } catch (e) {
        throw new HttpError(502, e.message);
      }
      if (toDriver) store.run('UPDATE orders SET dispatched_at = ? WHERE id = ?', new Date().toISOString(), o.id);
      log(req, toDriver ? '傳派車單給司機' : '傳司機資訊給客人', { customerId: o.customer_id, orderId: o.id, detail: `#${o.id} ${d.name}` });
      return { ok: true };
    }],
    // ---------- 詢問成交 ----------
    ['POST', /^\/api\/customers\/(\d+)\/lead$/, ([, id], body, _u, req) => {
      const c = mustCustomer(toId(id));
      if (body.lost) {
        badRequest(() => markLost(store, c.id, body, req.user.display_name));
        log(req, '標記未成交', { customerId: c.id, detail: `${body.reason}${body.note ? `：${body.note}` : ''}` });
      } else {
        reopenLead(store, c.id);
        log(req, '重新開啟詢問', { customerId: c.id });
      }
      return { ok: true };
    }],
    ['GET', /^\/api\/funnel$/, (_m, _b, url) => {
      const t = today(config.tz);
      return badRequest(() => buildFunnel(store, config, { from: url.searchParams.get('from') || `${t.slice(0, 7)}-01`, to: url.searchParams.get('to') || t, brandId: brandParam(url), brandIds: brandsParam(url), granularity: url.searchParams.get('g') || 'auto' }));
    }, { admin: true }],
    // ---------- 營收報表（管理員）----------
    ['GET', /^\/api\/report$/, (_m, _b, url) => {
      const t = today(config.tz);
      return badRequest(() => buildReport(store, { from: url.searchParams.get('from') || `${t.slice(0, 7)}-01`, to: url.searchParams.get('to') || t, brandId: brandParam(url), brandIds: brandsParam(url), granularity: url.searchParams.get('g') || 'auto', basis: url.searchParams.get('basis') || 'service' }));
    }, { admin: true }],
    // ---------- 客服回覆速度、營收目標、司機統計（管理員）----------
    ['GET', /^\/api\/response$/, (_m, _b, url) => {
      const t = today(config.tz);
      return badRequest(() => buildResponse(store, config, { from: url.searchParams.get('from') || `${t.slice(0, 7)}-01`, to: url.searchParams.get('to') || t, brandIds: brandsParam(url) }));
    }, { admin: true }],
    ['GET', /^\/api\/targets$/, (_m, _b, url) => badRequest(() => buildTargets(store, config, { month: url.searchParams.get('month') || null, brandIds: brandsParam(url) })), { admin: true }],
    ['PUT', /^\/api\/targets$/, (_m, body, _u, req) => {
      badRequest(() => setTarget(store, { brandId: toId(body.brandId), month: body.month, amount: body.amount }, req.user.display_name));
      log(req, '設定營收目標', { detail: `${store.getBrand(toId(body.brandId))?.name} ${body.month} NT$${body.amount}` });
      return { ok: true };
    }, { admin: true }],
    ['GET', /^\/api\/driver-stats$/, (_m, _b, url) => {
      const t = today(config.tz);
      return badRequest(() => buildDriverStats(store, { from: url.searchParams.get('from') || `${t.slice(0, 7)}-01`, to: url.searchParams.get('to') || t, brandIds: brandsParam(url) }));
    }, { admin: true }],
    // ---------- 自動備份（管理員）----------
    ['GET', /^\/api\/backups$/, () => ({
      files: listBackups(config),
      last: lastBackup(store),
      auto: config.autoBackup,
      keep: config.backupKeep,
      hour: config.dailyReportHour,
      local: Boolean(backupDir(config)),
      remote: remoteConfigured(config) ? { endpoint: new URL(config.backupS3.endpoint).host, bucket: config.backupS3.bucket, prefix: config.backupS3.prefix } : null,
    }), { admin: true }],
    ['POST', /^\/api\/backups\/run$/, async (_m, _b, _u, req) => {
      const r = await runBackup(store, config, { fetchImpl, logger }).catch((e) => { throw new HttpError(500, e.message); });
      log(req, '手動備份', { detail: `${r.name}${r.remote ? '（已上傳雲端）' : ''}${r.remoteError ? `（雲端失敗：${r.remoteError}）` : ''}` });
      return r;
    }, { admin: true }],
    // ---------- 個資保存規則（管理員）----------
    ['GET', /^\/api\/retention$/, () => {
      const years = retentionYears(store);
      const expired = years ? findExpired(store, config, years) : [];
      return { years, count: expired.length, sample: expired.slice(0, 20).map((c) => ({ id: c.id, brand_id: c.brand_id, name: c.real_name || c.display_name, last_at: c.last_at > (c.last_order || '') ? c.last_at.slice(0, 10) : c.last_order })) };
    }, { admin: true }],
    ['PUT', /^\/api\/retention$/, (_m, body, _u, req) => {
      const years = badRequest(() => setRetentionYears(store, body.years));
      log(req, '設定個資保存年限', { detail: years ? `${years} 年` : '關閉' });
      return { years };
    }, { admin: true }],
    ['POST', /^\/api\/retention\/run$/, (_m, _b, _u, req) => {
      if (!retentionYears(store)) throw new HttpError(400, '請先設定保存年限');
      return { anonymized: applyRetention(store, config, { user: req.user.display_name }) };
    }, { admin: true }],
    // ---------- 每週營運週報（管理員）----------
    ['GET', /^\/api\/weekly$/, (_m, _b, url) => {
      const recipients = store.weeklyIds().map((id) => store.getCustomer(id)).filter(Boolean)
        .map((c) => ({ id: c.id, name: c.real_name || c.display_name, brand_id: c.brand_id, is_friend: c.is_friend }));
      return { ...badRequest(() => buildWeekly(store, config, { brandIds: brandsParam(url) })), recipients, weeklyReportDay: config.weeklyReportDay, dailyReportHour: config.dailyReportHour, lastRun: store.getKv('weekly_last_run') };
    }, { admin: true }],
    ['POST', /^\/api\/weekly\/send$/, async (_m, _b, _u, req) => {
      if (!reminders.weeklyTargets().length) throw new HttpError(400, '還沒有週報接收人：請到客戶資料把老闆或主管設為「週報接收人」');
      const r = await reminders.sendWeekly();
      if (!r.sent) throw new HttpError(502, `週報推播失敗：${r.errors[0]}`);
      log(req, '手動推播週報', { detail: `${r.sent} 位${r.failed ? `，失敗 ${r.failed} 位` : ''}` });
      return { sent: r.sent, failed: r.failed };
    }, { admin: true }],
    // ---------- 常用回覆範本 ----------
    ['GET', /^\/api\/templates$/, (_m, _b, url) => ({ templates: listTemplates(store, { brandId: brandParam(url) }), vars: TEMPLATE_VARS })],
    ['POST', /^\/api\/templates$/, (_m, body, _u, req) => {
      const tpl = badRequest(() => saveTemplate(store, null, body, req.user.display_name));
      log(req, '新增範本', { detail: tpl.title });
      return tpl;
    }],
    ['PATCH', /^\/api\/templates\/(\d+)$/, ([, id], body, _u, req) => {
      const tpl = badRequest(() => saveTemplate(store, toId(id), body, req.user.display_name));
      log(req, '修改範本', { detail: tpl.title });
      return tpl;
    }],
    ['DELETE', /^\/api\/templates\/(\d+)$/, ([, id], _b, _u, req) => {
      const tpl = store.get('SELECT * FROM reply_templates WHERE id = ?', toId(id));
      if (!tpl) throw new HttpError(404, '找不到範本');
      store.run('DELETE FROM reply_templates WHERE id = ?', tpl.id);
      log(req, '刪除範本', { detail: tpl.title });
      return { ok: true };
    }],
    ['GET', /^\/api\/customers\/(\d+)\/templates\/(\d+)$/, ([, id, tid], _b, url) => badRequest(() => renderTemplate(store, config, {
      templateId: toId(tid), customerId: mustCustomer(toId(id)).id, orderId: url.searchParams.get('orderId') ? toId(url.searchParams.get('orderId')) : null,
    }))],
    // ---------- 帳號與操作紀錄 ----------
    ['GET', /^\/api\/users$/, () => auth.listUsers(), { admin: true }],
    ['POST', /^\/api\/users$/, (_m, body, _u, req) => {
      const u = badRequest(() => auth.createUser(body));
      log(req, '新增帳號', { detail: `${u.display_name}（${u.username}，${ROLES[u.role]}）` });
      return u;
    }, { admin: true }],
    ['PATCH', /^\/api\/users\/(\d+)$/, ([, id], body, _u, req) => {
      if (toId(id) === req.user.id && (body.active === false || body.role === 'staff')) throw new HttpError(400, '不能停用自己或拿掉自己的管理員權限');
      const u = badRequest(() => auth.updateUser(toId(id), body));
      const what = [body.display_name !== undefined && '名稱', body.role !== undefined && `角色→${ROLES[u.role]}`, body.active !== undefined && (u.active ? '啟用' : '停用'), body.password && '重設密碼'].filter(Boolean);
      log(req, '修改帳號', { detail: `${u.display_name}（${u.username}）：${what.join('、')}` });
      return u;
    }, { admin: true }],
    ['POST', /^\/api\/me\/password$/, (_m, body, _u, req) => {
      if (!req.user.id) throw new HttpError(400, '老闆帳號 admin 的密碼請在 Render 的 Environment 修改 ADMIN_PASSWORD');
      const u = store.get('SELECT * FROM users WHERE id = ?', req.user.id);
      if (!auth.checkCredentials(u.username, body.current || '')) throw new HttpError(400, '目前密碼不正確');
      badRequest(() => auth.updateUser(u.id, { password: body.password }));
      log(req, '修改自己的密碼');
      return { ok: true, relogin: true };
    }],
    ['GET', /^\/api\/activity$/, (_m, _b, url) => store.listActivity({ userName: url.searchParams.get('user') || null, limit: 300 }), { admin: true }],
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
    const rows = store.listOrders({ brandId }).map((o) => ({ ...o, collected: balanceOf(o).paid, due: balanceOf(o).due, brand: nameOfBrand(o.brand_id), customer_name: o.real_name || o.display_name, status_label: ORDER_STATUSES[o.status], service_label: SERVICE_TYPES[o.service_type] || '' }));
    return toCsv([
      ['id', '訂單編號'], ['brand', '品牌'], ['order_date', '下單日'], ['customer_id', '客戶編號'], ['customer_name', '客戶'], ['service_label', '服務'],
      ['service_date', '用車日'], ['service_time', '時間'], ['flight_no', '航班'], ['pickup', '上車／取車地點'], ['dropoff', '目的地／還車地點'], ['return_date', '結束／還車日'],
      ['items', '內容'], ['amount', '金額'], ['collected', '已收'], ['due', '未收'], ['status_label', '狀態'], ['payment_due_date', '匯款期限'], ['payment_report', '匯款回報'], ['paid_at', '入帳時間'], ['note', '備註'],
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

      // ---- 登入頁與登入／登出（不需登入）----
      if (req.method === 'GET' && (url.pathname === '/login' || url.pathname === '/style.css')) {
        const file = path.join(PUBLIC_DIR, url.pathname === '/login' ? 'login.html' : 'style.css');
        return send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-cache' });
      }
      if (req.method === 'POST' && url.pathname === '/api/login') {
        sameOrigin(req);
        let body;
        try { body = JSON.parse((await readBody(req, 10_000)).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'JSON 格式錯誤'); }
        const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        let result;
        try {
          result = auth.login(body.username, body.password, ip);
        } catch (e) {
          throw new HttpError(e.status || 400, e.message);
        }
        req.user = result.user;
        log(req, '登入');
        return send(res, 200, { user: result.user }, { 'Set-Cookie': auth.sessionCookie(result.token, req) });
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        auth.logout(req);
        return send(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
      }

      req.user = auth.userFromRequest(req);
      if (!req.user) {
        if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return send(res, 302, '', { Location: '/login' });
        return send(res, 401, { error: '請先登入', login: true });
      }
      if (!['GET', 'HEAD'].includes(req.method)) sameOrigin(req);

      if (req.method === 'GET' && STATIC[url.pathname]) {
        const file = path.join(PUBLIC_DIR, STATIC[url.pathname]);
        return send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-cache' });
      }
      const backupMatch = req.method === 'GET' && url.pathname.match(/^\/api\/backups\/file\/([^/]+)$/);
      if (backupMatch) {
        if (req.user.role !== 'admin') throw new HttpError(403, '只有管理員可以下載備份');
        const file = backupFile(config, decodeURIComponent(backupMatch[1]));
        if (!file) throw new HttpError(404, '找不到這份備份');
        log(req, '下載自動備份', { detail: path.basename(file) });
        return send(res, 200, fs.readFileSync(file), { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${path.basename(file)}"` });
      }
      if (req.method === 'GET' && url.pathname === '/api/export/backup.db') {
        if (req.user.role !== 'admin') throw new HttpError(403, '只有管理員可以下載備份');
        log(req, '下載備份');
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

      for (const [method, pattern, fn, opts = {}] of routes) {
        const m = url.pathname.match(pattern);
        if (!m || method !== req.method) continue;
        if (opts.admin && req.user.role !== 'admin') throw new HttpError(403, '這個功能只有管理員可以使用');
        let body = {};
        if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
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
