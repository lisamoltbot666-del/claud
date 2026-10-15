import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// 每個品牌 = 一個 LINE 官方帳號（Messaging API channel）
const BRANDS_TABLE = `
CREATE TABLE IF NOT EXISTS brands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,     -- 網址代號，Webhook 為 /webhook/<slug>
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#06c755',
  channel_secret TEXT,
  channel_access_token TEXT,
  bank_info TEXT,
  forward_url TEXT,              -- 同時轉送 Webhook 給原本使用的系統（可留空）
  review_url TEXT,               -- 評價連結（Google 評論等），放進服務後的感謝訊息
  rebook_offer TEXT,             -- 回購優惠說明，放進服務後 30 天的回購邀請
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

const customersTable = (name) => `
CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id INTEGER NOT NULL REFERENCES brands(id),
  line_user_id TEXT,             -- 同一個人在不同品牌的官方帳號會有不同 userId
  display_name TEXT,
  picture_url TEXT,
  status_message TEXT,
  real_name TEXT,
  phone TEXT,
  email TEXT,
  birthday TEXT,                 -- YYYY-MM-DD
  gender TEXT,
  address TEXT,
  tags TEXT,
  note TEXT,
  reorder_days INTEGER,          -- 手動指定回訪週期（天），空白則自動推算
  next_contact_date TEXT,        -- 客服手動排定的下次聯絡日
  is_friend INTEGER NOT NULL DEFAULT 1,
  followed_at TEXT,
  unfollowed_at TEXT,
  last_inbound_at TEXT,          -- 客戶最後傳訊時間
  last_handled_at TEXT,          -- 客服最後回覆 / 標記已處理時間
  lead_lost_reason TEXT,         -- 詢問未成交原因（客服標記）
  lead_lost_note TEXT,
  lead_lost_at TEXT,
  lead_lost_by TEXT,
  anonymized_at TEXT,            -- 依個資保存規則匿名化的時間
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  items TEXT,                    -- 服務內容（如：送機 7 人座）
  amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending_payment', -- pending_payment | paid | shipped（已派車）| completed | cancelled
  service_type TEXT,             -- airport 機場接送 | charter 包車 | rental 租車自駕
  service_date TEXT,             -- 用車日 / 取車日 YYYY-MM-DD
  service_time TEXT,             -- HH:MM
  flight_no TEXT,
  pickup TEXT,                   -- 上車地點 / 取車地點
  dropoff TEXT,                  -- 目的地 / 還車地點
  return_date TEXT,              -- 包車結束日 / 還車日
  order_date TEXT NOT NULL,
  payment_due_date TEXT,
  payment_report TEXT,           -- 客戶回報的匯款資訊（如帳號末五碼）
  payment_reported_at TEXT,
  paid_at TEXT,
  shipped_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_line ON customers(brand_id, line_user_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_service_date ON orders(service_date);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,       -- in | out
  type TEXT NOT NULL DEFAULT 'text',
  text TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_customer ON messages(customer_id, id);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,            -- payment | reorder | trip | care | birthday | custom
  text TEXT,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  auto INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_reminders_customer ON reminders(customer_id, kind);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- 後台帳號（老闆帳號 admin 用 ADMIN_PASSWORD，不存在這裡）
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',  -- admin | staff
  active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,            -- 0 = 老闆帳號 admin
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 操作紀錄：誰在什麼時候做了什麼
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  user_name TEXT,
  action TEXT NOT NULL,
  customer_id INTEGER,
  order_id INTEGER,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_activity_customer ON activity(customer_id, id);

-- 司機（各品牌共用）；line_customer_id 連結到某品牌官方帳號的 LINE 好友，用來推播派車單
CREATE TABLE IF NOT EXISTS drivers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  plate TEXT,
  car_model TEXT,
  note TEXT,
  line_customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 每月營收目標（各品牌；沒設定的月份沿用最近一次）
CREATE TABLE IF NOT EXISTS revenue_targets (
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  month TEXT NOT NULL,           -- YYYY-MM
  amount INTEGER NOT NULL,
  updated_by TEXT,
  updated_at TEXT,
  PRIMARY KEY (brand_id, month)
);

-- 常用回覆範本（brand_id 空白 = 全部品牌共用）
CREATE TABLE IF NOT EXISTS reply_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id INTEGER REFERENCES brands(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TEXT
);
`;

export const ORDER_STATUSES = {
  pending_payment: '待付款',
  paid: '已付款',
  shipped: '已派車',
  completed: '已完成',
  cancelled: '已取消',
};

export const SERVICE_TYPES = {
  airport: '機場接送',
  charter: '包車',
  rental: '租車自駕',
};

const TRIP_COLUMNS = ['service_type', 'service_date', 'service_time', 'flight_no', 'pickup', 'dropoff', 'return_date'];

const CUSTOMER_EDITABLE = ['display_name', 'real_name', 'phone', 'email', 'birthday', 'gender', 'address', 'tags', 'note', 'reorder_days', 'next_contact_date'];
const BRAND_EDITABLE = ['slug', 'name', 'color', 'channel_secret', 'channel_access_token', 'bank_info', 'forward_url', 'review_url', 'rebook_offer'];
const ORDER_EDITABLE = ['items', 'amount', 'status', 'order_date', 'payment_due_date', 'payment_report', 'note', 'source_message_id', ...TRIP_COLUMNS];

const nowIso = () => new Date().toISOString();
const plain = (row) => (row ? { ...row } : row);

export function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(BRANDS_TABLE);
  // 轉送網址、評價連結、回購優惠
  for (const col of ['forward_url', 'review_url', 'rebook_offer']) {
    if (!db.prepare('PRAGMA table_info(brands)').all().some((r) => r.name === col)) db.exec(`ALTER TABLE brands ADD COLUMN ${col} TEXT`);
  }
  migrateLegacyCustomers(db);
  db.exec(customersTable('customers'));
  migrateTripColumns(db);
  db.exec(SCHEMA);
  // 詢問未成交原因
  {
    const cols = new Set(db.prepare('PRAGMA table_info(customers)').all().map((r) => r.name));
    for (const col of ['lead_lost_reason', 'lead_lost_note', 'lead_lost_at', 'lead_lost_by', 'anonymized_at']) if (!cols.has(col)) db.exec(`ALTER TABLE customers ADD COLUMN ${col} TEXT`);
  }
  // 對話、提醒記錄由哪位客服送出
  for (const table of ['messages', 'reminders']) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((r) => r.name === 'staff_name')) db.exec(`ALTER TABLE ${table} ADD COLUMN staff_name TEXT`);
  }
  // 訂單指派的司機、派車單送出時間
  // 指派當下司機與車輛的資料（之後司機換車、改電話，舊訂單仍保留當時的紀錄）
  for (const col of ['source_message_id INTEGER', 'driver_id INTEGER', 'dispatched_at TEXT', 'driver_name_snap TEXT', 'driver_phone_snap TEXT', 'driver_plate_snap TEXT', 'driver_car_snap TEXT']) {
    if (!db.prepare('PRAGMA table_info(orders)').all().some((r) => r.name === col.split(' ')[0])) db.exec(`ALTER TABLE orders ADD COLUMN ${col}`);
  }
  // 舊版已指派司機的訂單：補上當時的司機資料
  if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'drivers'").get()) {
    db.exec(`UPDATE orders SET driver_name_snap = (SELECT name FROM drivers d WHERE d.id = orders.driver_id),
      driver_phone_snap = (SELECT phone FROM drivers d WHERE d.id = orders.driver_id),
      driver_plate_snap = (SELECT plate FROM drivers d WHERE d.id = orders.driver_id),
      driver_car_snap = (SELECT car_model FROM drivers d WHERE d.id = orders.driver_id)
      WHERE driver_id IS NOT NULL AND driver_name_snap IS NULL`);
  }
  // 匯入的訂單記錄來源編號，重複匯入同一份檔案時不會重複建立
  if (!db.prepare('PRAGMA table_info(orders)').all().some((r) => r.name === 'import_ref')) db.exec('ALTER TABLE orders ADD COLUMN import_ref TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_import_ref ON orders(import_ref) WHERE import_ref IS NOT NULL');
  return new Store(db);
}

// 舊版資料庫的訂單表沒有行程欄位：直接補上（新欄位都可為空，舊訂單照常運作）
function migrateTripColumns(db) {
  const cols = db.prepare('PRAGMA table_info(orders)').all().map((r) => r.name);
  if (!cols.length) return;
  for (const col of TRIP_COLUMNS) if (!cols.includes(col)) db.exec(`ALTER TABLE orders ADD COLUMN ${col} TEXT`);
}

// 舊版（單一品牌）資料庫：客戶表沒有 brand_id，重建客戶表並把所有客戶歸到「預設品牌」
function migrateLegacyCustomers(db) {
  const cols = db.prepare('PRAGMA table_info(customers)').all().map((r) => r.name);
  if (!cols.length || cols.includes('brand_id')) return;
  for (const col of ['email', 'birthday', 'gender']) if (!cols.includes(col)) db.exec(`ALTER TABLE customers ADD COLUMN ${col} TEXT`);
  db.exec("INSERT OR IGNORE INTO brands (slug, name) VALUES ('default', '預設品牌')");
  const brandId = db.prepare("SELECT id FROM brands WHERE slug = 'default'").get().id;
  const copy = db.prepare('PRAGMA table_info(customers)').all().map((r) => r.name).join(', ');
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(customersTable('customers_new'));
    db.prepare(`INSERT INTO customers_new (${copy}, brand_id) SELECT ${copy}, ? FROM customers`).run(brandId);
    db.exec('DROP TABLE customers; ALTER TABLE customers_new RENAME TO customers;');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export function slugify(text) {
  const slug = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug || `brand-${Date.now().toString(36)}`;
}

export class Store {
  constructor(db) {
    this.db = db;
  }

  all(sql, ...params) {
    return this.db.prepare(sql).all(...params).map(plain);
  }

  get(sql, ...params) {
    return plain(this.db.prepare(sql).get(...params));
  }

  run(sql, ...params) {
    return this.db.prepare(sql).run(...params);
  }

  // ---------- brands ----------
  listBrands() {
    return this.all('SELECT * FROM brands ORDER BY id');
  }

  getBrand(id) {
    return this.get('SELECT * FROM brands WHERE id = ?', id);
  }

  getBrandBySlug(slug) {
    return this.get('SELECT * FROM brands WHERE slug = ?', slug);
  }

  createBrand(fields) {
    const slug = slugify(fields.slug || fields.name);
    if (this.getBrandBySlug(slug)) throw new Error(`代號「${slug}」已被使用`);
    const r = this.run('INSERT INTO brands (slug, name) VALUES (?, ?)', slug, fields.name || slug);
    return this.updateBrand(Number(r.lastInsertRowid), { ...fields, slug });
  }

  updateBrand(id, fields) {
    if ('slug' in fields) {
      fields = { ...fields, slug: slugify(fields.slug) };
      const other = this.getBrandBySlug(fields.slug);
      if (other && other.id !== id) throw new Error(`代號「${fields.slug}」已被使用`);
    }
    if ('name' in fields && !String(fields.name).trim()) throw new Error('請輸入品牌名稱');
    if (fields.color && !/^#[0-9a-f]{6}$/i.test(fields.color)) throw new Error('顏色格式需為 #RRGGBB');
    if (fields.forward_url) {
      fields = { ...fields, forward_url: String(fields.forward_url).trim() };
      let u;
      try {
        u = new URL(fields.forward_url);
      } catch {
        throw new Error('轉送網址格式不正確');
      }
      if (!['https:', 'http:'].includes(u.protocol)) throw new Error('轉送網址需以 https:// 開頭');
    }
    if (fields.review_url) {
      fields = { ...fields, review_url: String(fields.review_url).trim() };
      if (!/^https?:\/\/\S+$/.test(fields.review_url)) throw new Error('評價連結需以 https:// 開頭');
    }
    if (fields.rebook_offer) fields = { ...fields, rebook_offer: String(fields.rebook_offer).trim().slice(0, 200) };
    const keys = BRAND_EDITABLE.filter((k) => k in fields);
    if (keys.length) this.run(`UPDATE brands SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => (fields[k] === '' ? null : fields[k])), id);
    return this.getBrand(id);
  }

  deleteBrand(id) {
    const n = this.get('SELECT COUNT(*) AS n FROM customers WHERE brand_id = ?', id).n;
    if (n) throw new Error(`此品牌還有 ${n} 位客戶，無法刪除`);
    this.run('DELETE FROM brands WHERE id = ?', id);
  }

  // ---------- customers ----------
  getCustomer(id) {
    return this.get('SELECT * FROM customers WHERE id = ?', id);
  }

  getCustomerByLineId(brandId, lineUserId) {
    return this.get('SELECT * FROM customers WHERE brand_id = ? AND line_user_id = ?', brandId, lineUserId);
  }

  // 依 LINE userId 建立或更新客戶（好友加入、傳訊時呼叫）
  upsertLineCustomer(brandId, lineUserId, profile = {}) {
    const existing = this.getCustomerByLineId(brandId, lineUserId);
    const ts = nowIso();
    if (existing) {
      this.run(
        `UPDATE customers SET
           display_name = COALESCE(?, display_name),
           picture_url = COALESCE(?, picture_url),
           status_message = COALESCE(?, status_message),
           updated_at = ?
         WHERE id = ?`,
        profile.displayName ?? null, profile.pictureUrl ?? null, profile.statusMessage ?? null, ts, existing.id,
      );
      return this.getCustomer(existing.id);
    }
    const r = this.run(
      `INSERT INTO customers (brand_id, line_user_id, display_name, picture_url, status_message, followed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      brandId, lineUserId, profile.displayName ?? null, profile.pictureUrl ?? null, profile.statusMessage ?? null, ts,
    );
    return this.getCustomer(Number(r.lastInsertRowid));
  }

  createCustomer(brandId, fields) {
    if (!this.getBrand(brandId)) throw new Error('請選擇品牌');
    const r = this.run('INSERT INTO customers (brand_id, display_name, is_friend) VALUES (?, ?, 0)', brandId, fields.display_name || '未命名客戶');
    const id = Number(r.lastInsertRowid);
    this.updateCustomer(id, fields);
    return this.getCustomer(id);
  }

  setFriend(id, isFriend) {
    const ts = nowIso();
    if (isFriend) this.run('UPDATE customers SET is_friend = 1, followed_at = ?, unfollowed_at = NULL, updated_at = ? WHERE id = ?', ts, ts, id);
    else this.run('UPDATE customers SET is_friend = 0, unfollowed_at = ?, updated_at = ? WHERE id = ?', ts, ts, id);
  }

  updateCustomer(id, fields) {
    const keys = CUSTOMER_EDITABLE.filter((k) => k in fields);
    if (!keys.length) return this.getCustomer(id);
    const values = keys.map((k) => (fields[k] === '' ? null : fields[k]));
    this.run(`UPDATE customers SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...values, nowIso(), id);
    return this.getCustomer(id);
  }

  markHandled(id) {
    this.run('UPDATE customers SET last_handled_at = ? WHERE id = ?', nowIso(), id);
  }

  deleteCustomer(id) {
    this.run('DELETE FROM customers WHERE id = ?', id);
  }

  listCustomers({ q = '', tag = '', brandId = null } = {}) {
    const where = [];
    const params = [];
    if (brandId) { where.push('c.brand_id = ?'); params.push(brandId); }
    if (q) {
      where.push('(display_name LIKE ? OR real_name LIKE ? OR phone LIKE ? OR note LIKE ? OR line_user_id = ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, q);
    }
    if (tag) {
      where.push("(',' || REPLACE(tags, ' ', '') || ',') LIKE ?");
      params.push(`%,${tag},%`);
    }
    return this.all(
      `SELECT c.*,
         (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.status != 'cancelled') AS order_count,
         (SELECT COALESCE(SUM(amount),0) FROM orders o WHERE o.customer_id = c.id AND o.status IN ('paid','shipped','completed')) AS total_spent,
         (SELECT MAX(order_date) FROM orders o WHERE o.customer_id = c.id AND o.status != 'cancelled') AS last_order_date
       FROM customers c ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY COALESCE(c.last_inbound_at, c.created_at) DESC`,
      ...params,
    );
  }

  // ---------- messages ----------
  // 客服送出的訊息會把客戶標成「已處理」；自動回覆則傳 { handled: false }
  addMessage(customerId, direction, text, type = 'text', { handled = direction === 'out', staffName = null } = {}) {
    const ts = nowIso();
    this.run('INSERT INTO messages (customer_id, direction, type, text, created_at, staff_name) VALUES (?, ?, ?, ?, ?, ?)', customerId, direction, type, text, ts, staffName);
    if (direction === 'in') this.run('UPDATE customers SET last_inbound_at = ? WHERE id = ?', ts, customerId);
    else if (handled) this.run('UPDATE customers SET last_handled_at = ? WHERE id = ?', ts, customerId);
  }

  listMessages(customerId, limit = 100) {
    return this.all('SELECT * FROM (SELECT * FROM messages WHERE customer_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id', customerId, limit);
  }

  // ---------- orders ----------
  getOrder(id) {
    return this.get('SELECT * FROM orders WHERE id = ?', id);
  }

  createOrder(customerId, fields) {
    const r = this.run(
      'INSERT INTO orders (customer_id, order_date, payment_due_date, status) VALUES (?, ?, ?, ?)',
      customerId, fields.order_date, fields.payment_due_date ?? null, fields.status || 'pending_payment',
    );
    const id = Number(r.lastInsertRowid);
    return this.updateOrder(id, fields);
  }

  updateOrder(id, fields) {
    const keys = ORDER_EDITABLE.filter((k) => k in fields);
    if (fields.status && !ORDER_STATUSES[fields.status]) throw new Error(`未知的訂單狀態：${fields.status}`);
    if (fields.service_type && !SERVICE_TYPES[fields.service_type]) throw new Error(`未知的服務類型：${fields.service_type}`);
    if (fields.service_time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(fields.service_time)) throw new Error('時間格式需為 HH:MM');
    const before = this.getOrder(id);
    if (!before) return null;
    if (keys.length) {
      const values = keys.map((k) => (fields[k] === '' ? null : fields[k]));
      this.run(`UPDATE orders SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...values, nowIso(), id);
    }
    const ts = nowIso();
    if (fields.status && fields.status !== before.status) {
      if (['paid', 'shipped', 'completed'].includes(fields.status) && !before.paid_at) this.run('UPDATE orders SET paid_at = ? WHERE id = ?', ts, id);
      if (['shipped', 'completed'].includes(fields.status) && !before.shipped_at) this.run('UPDATE orders SET shipped_at = ? WHERE id = ?', ts, id);
    }
    return this.getOrder(id);
  }

  deleteOrder(id) {
    this.run('DELETE FROM orders WHERE id = ?', id);
  }

  reportPayment(orderId, report) {
    const ts = nowIso();
    this.run('UPDATE orders SET payment_report = ?, payment_reported_at = ?, updated_at = ? WHERE id = ?', report, ts, ts, orderId);
  }

  listOrders({ status = '', customerId = null, brandId = null } = {}) {
    const where = [];
    const params = [];
    if (brandId) { where.push('c.brand_id = ?'); params.push(brandId); }
    if (status) { where.push('o.status = ?'); params.push(status); }
    if (customerId) { where.push('o.customer_id = ?'); params.push(customerId); }
    return this.all(
      `SELECT o.*, c.display_name, c.real_name, c.line_user_id, c.brand_id,
         COALESCE(o.driver_name_snap, d.name) AS driver_name, COALESCE(o.driver_plate_snap, d.plate) AS driver_plate,
         COALESCE(o.driver_car_snap, d.car_model) AS driver_car, COALESCE(o.driver_phone_snap, d.phone) AS driver_phone
       FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN drivers d ON d.id = o.driver_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY o.order_date DESC, o.id DESC`,
      ...params,
    );
  }

  latestPendingOrder(customerId) {
    return this.get("SELECT * FROM orders WHERE customer_id = ? AND status = 'pending_payment' ORDER BY order_date DESC, id DESC LIMIT 1", customerId);
  }

  // ---------- reminders ----------
  logReminder({ customerId, orderId = null, kind, text, ok = true, error = null, auto = false, staffName = null }) {
    this.run(
      'INSERT INTO reminders (customer_id, order_id, kind, text, ok, error, auto, staff_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      customerId, orderId, kind, text, ok ? 1 : 0, error, auto ? 1 : 0, staffName,
    );
  }

  // ---------- 操作紀錄 ----------
  logActivity({ user = null, action, customerId = null, orderId = null, detail = null }) {
    this.run('INSERT INTO activity (user_name, action, customer_id, order_id, detail) VALUES (?, ?, ?, ?, ?)',
      user?.display_name ?? user ?? null, action, customerId, orderId, detail);
  }

  listActivity({ customerId = null, userName = null, limit = 200 } = {}) {
    const where = [];
    const params = [];
    if (customerId) { where.push('customer_id = ?'); params.push(customerId); }
    if (userName) { where.push('user_name = ?'); params.push(userName); }
    return this.all(`SELECT * FROM activity ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`, ...params, limit);
  }

  lastReminder(customerId, kind, orderId = null) {
    if (orderId) return this.get('SELECT * FROM reminders WHERE customer_id = ? AND kind = ? AND order_id = ? AND ok = 1 ORDER BY id DESC LIMIT 1', customerId, kind, orderId);
    return this.get('SELECT * FROM reminders WHERE customer_id = ? AND kind = ? AND ok = 1 ORDER BY id DESC LIMIT 1', customerId, kind);
  }

  countReminders(orderId, kind) {
    return this.get('SELECT COUNT(*) AS n FROM reminders WHERE order_id = ? AND kind = ? AND ok = 1', orderId, kind).n;
  }

  listReminders(customerId) {
    return this.all('SELECT * FROM reminders WHERE customer_id = ? ORDER BY id DESC LIMIT 50', customerId);
  }

  // ---------- 客服（接收每日清單的人）----------
  // 客服本人加各品牌官方帳號好友後，在後台把他設為客服；用該品牌的帳號推播給他
  // 不列入客戶清單的人：每日清單接收人、連結 LINE 的司機
  internalIds() {
    const ids = new Set([...this.staffIds(), ...this.weeklyIds()]);
    for (const r of this.all('SELECT line_customer_id FROM drivers WHERE line_customer_id IS NOT NULL')) ids.add(r.line_customer_id);
    return ids;
  }

  staffIds() {
    try {
      return JSON.parse(this.getKv('staff_customer_ids') || '[]');
    } catch {
      return [];
    }
  }

  setStaff(customerId, isStaff) {
    const ids = new Set(this.staffIds());
    if (isStaff) ids.add(customerId);
    else ids.delete(customerId);
    this.setKv('staff_customer_ids', JSON.stringify([...ids]));
  }

  // 週報接收人（通常是老闆、主管）
  weeklyIds() {
    try {
      return JSON.parse(this.getKv('weekly_customer_ids') || '[]');
    } catch {
      return [];
    }
  }

  setWeekly(customerId, on) {
    const ids = new Set(this.weeklyIds());
    if (on) ids.add(customerId);
    else ids.delete(customerId);
    this.setKv('weekly_customer_ids', JSON.stringify([...ids]));
  }

  // 完整備份：產生一份一致的資料庫副本（不影響正在使用的資料庫）
  backupTo(file) {
    fs.rmSync(file, { force: true });
    this.db.prepare('VACUUM INTO ?').run(file);
  }

  // ---------- kv ----------
  getKv(key) {
    return this.get('SELECT value FROM kv WHERE key = ?', key)?.value ?? null;
  }

  setKv(key, value) {
    this.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }
}
