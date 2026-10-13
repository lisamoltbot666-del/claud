import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_user_id TEXT UNIQUE,
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
  reorder_days INTEGER,          -- 手動指定回購週期（天），空白則自動推算
  next_contact_date TEXT,        -- 客服手動排定的下次聯絡日
  is_friend INTEGER NOT NULL DEFAULT 1,
  followed_at TEXT,
  unfollowed_at TEXT,
  last_inbound_at TEXT,          -- 客戶最後傳訊時間
  last_handled_at TEXT,          -- 客服最後回覆 / 標記已處理時間
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  items TEXT,
  amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending_payment', -- pending_payment | paid | shipped | completed | cancelled
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
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

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
  kind TEXT NOT NULL,            -- payment | reorder | care | custom
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
`;

export const ORDER_STATUSES = {
  pending_payment: '待匯款',
  paid: '已匯款',
  shipped: '已出貨',
  completed: '已完成',
  cancelled: '已取消',
};

const CUSTOMER_EDITABLE = ['display_name', 'real_name', 'phone', 'email', 'birthday', 'gender', 'address', 'tags', 'note', 'reorder_days', 'next_contact_date'];
const ORDER_EDITABLE = ['items', 'amount', 'status', 'order_date', 'payment_due_date', 'payment_report', 'note'];

const nowIso = () => new Date().toISOString();
const plain = (row) => (row ? { ...row } : row);

export function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // 舊版資料庫補上新欄位
  const cols = new Set(db.prepare('PRAGMA table_info(customers)').all().map((r) => r.name));
  for (const col of ['email', 'birthday', 'gender']) if (!cols.has(col)) db.exec(`ALTER TABLE customers ADD COLUMN ${col} TEXT`);
  return new Store(db);
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

  // ---------- customers ----------
  getCustomer(id) {
    return this.get('SELECT * FROM customers WHERE id = ?', id);
  }

  getCustomerByLineId(lineUserId) {
    return this.get('SELECT * FROM customers WHERE line_user_id = ?', lineUserId);
  }

  // 依 LINE userId 建立或更新客戶（好友加入、傳訊時呼叫）
  upsertLineCustomer(lineUserId, profile = {}) {
    const existing = this.getCustomerByLineId(lineUserId);
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
      `INSERT INTO customers (line_user_id, display_name, picture_url, status_message, followed_at)
       VALUES (?, ?, ?, ?, ?)`,
      lineUserId, profile.displayName ?? null, profile.pictureUrl ?? null, profile.statusMessage ?? null, ts,
    );
    return this.getCustomer(Number(r.lastInsertRowid));
  }

  createCustomer(fields) {
    const r = this.run('INSERT INTO customers (display_name, is_friend) VALUES (?, 0)', fields.display_name || '未命名客戶');
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

  listCustomers({ q = '', tag = '' } = {}) {
    const where = [];
    const params = [];
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
  addMessage(customerId, direction, text, type = 'text', { handled = direction === 'out' } = {}) {
    const ts = nowIso();
    this.run('INSERT INTO messages (customer_id, direction, type, text, created_at) VALUES (?, ?, ?, ?, ?)', customerId, direction, type, text, ts);
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

  listOrders({ status = '', customerId = null } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push('o.status = ?'); params.push(status); }
    if (customerId) { where.push('o.customer_id = ?'); params.push(customerId); }
    return this.all(
      `SELECT o.*, c.display_name, c.real_name, c.line_user_id
       FROM orders o JOIN customers c ON c.id = o.customer_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY o.order_date DESC, o.id DESC`,
      ...params,
    );
  }

  latestPendingOrder(customerId) {
    return this.get("SELECT * FROM orders WHERE customer_id = ? AND status = 'pending_payment' ORDER BY order_date DESC, id DESC LIMIT 1", customerId);
  }

  // ---------- reminders ----------
  logReminder({ customerId, orderId = null, kind, text, ok = true, error = null, auto = false }) {
    this.run(
      'INSERT INTO reminders (customer_id, order_id, kind, text, ok, error, auto) VALUES (?, ?, ?, ?, ?, ?, ?)',
      customerId, orderId, kind, text, ok ? 1 : 0, error, auto ? 1 : 0,
    );
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

  // ---------- kv ----------
  getKv(key) {
    return this.get('SELECT value FROM kv WHERE key = ?', key)?.value ?? null;
  }

  setKv(key, value) {
    this.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }
}
