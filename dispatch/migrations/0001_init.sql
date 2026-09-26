-- 會員：司機（職業駕照 + R 牌租賃車，可發單也可接單）或 發單方（車行／同業，只能發單）
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL CHECK (kind IN ('driver', 'dispatcher')),
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  company       TEXT NOT NULL DEFAULT '',
  plate         TEXT NOT NULL DEFAULT '',
  car_type      TEXT NOT NULL DEFAULT '',
  seats         INTEGER NOT NULL DEFAULT 0,
  license_key   TEXT NOT NULL DEFAULT '',  -- R2：職業駕照照片
  vehicle_key   TEXT NOT NULL DEFAULT '',  -- R2：行照照片
  regions       TEXT NOT NULL DEFAULT '',  -- 想收通知的地區，逗號分隔
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'suspended')),
  review_note   TEXT NOT NULL DEFAULT '',
  is_admin      INTEGER NOT NULL DEFAULT 0,
  line_user_id  TEXT UNIQUE,
  line_bind_code TEXT UNIQUE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  poster_id     INTEGER NOT NULL REFERENCES users(id),
  taker_id      INTEGER REFERENCES users(id),
  service       TEXT NOT NULL,              -- 接機／送機／點對點／包車
  region        TEXT NOT NULL,
  ride_date     TEXT NOT NULL,              -- YYYY-MM-DD（台灣時間）
  ride_time     TEXT NOT NULL,              -- HH:MM
  pickup        TEXT NOT NULL,
  dropoff       TEXT NOT NULL,
  car_type      TEXT NOT NULL,              -- 需求車型，'不限' 表示都可以
  passengers    INTEGER NOT NULL DEFAULT 1,
  luggage       INTEGER NOT NULL DEFAULT 0,
  flight        TEXT NOT NULL DEFAULT '',
  price         INTEGER NOT NULL,           -- 派價：司機這趟實拿
  collect       INTEGER NOT NULL DEFAULT 0, -- 客下收：司機向客人收的現金，0 表示已付清
  notes         TEXT NOT NULL DEFAULT '',   -- 公開備註
  private_notes TEXT NOT NULL DEFAULT '',   -- 客人姓名電話等，接單後才看得到
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'taken', 'completed', 'cancelled')),
  settled       INTEGER NOT NULL DEFAULT 0, -- 雙方款項已結清
  taken_at      TEXT,
  completed_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX orders_status_date ON orders(status, ride_date, ride_time);
CREATE INDEX orders_poster ON orders(poster_id);
CREATE INDEX orders_taker ON orders(taker_id);

CREATE TABLE ratings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id),
  from_id    INTEGER NOT NULL REFERENCES users(id),
  to_id      INTEGER NOT NULL REFERENCES users(id),
  stars      INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (order_id, from_id)
);
CREATE INDEX ratings_to ON ratings(to_id);

-- 記點：臨時退單、放鳥
CREATE TABLE strikes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  order_id   INTEGER REFERENCES orders(id),
  reason     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX strikes_user ON strikes(user_id);

-- 訂單異動紀錄，糾紛時查證用
CREATE TABLE order_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id),
  user_id    INTEGER REFERENCES users(id),
  action     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX order_events_order ON order_events(order_id);
