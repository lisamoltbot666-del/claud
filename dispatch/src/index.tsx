import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Child } from 'hono/jsx'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { html } from 'hono/html'
import type { AppContext, Env, Order, User } from './lib'
import {
  CAR_TYPES,
  PLATE_RE,
  REGIONS,
  SERVICES,
  canTake,
  hashPassword,
  money,
  normalizePhone,
  normalizePlate,
  randomDigits,
  randomToken,
  returnAmount,
  rideTimestamp,
  todayTW,
  verifyPassword,
} from './lib'
import { notifyNewOrder, orderSummary, pushText, replyText, verifySignature } from './line'
import { Layout, MoneyLine, OrderCard, Options, Stars, StatusTag, UserStatusTag } from './views'

type C = Context<AppContext>

const app = new Hono<AppContext>()
const SESSION_DAYS = 30
const MAX_UPLOAD = 8 * 1024 * 1024

const MESSAGES: Record<string, string> = {
  registered: '註冊完成！資料審核通過後就能開始發單、接單，審核結果會用 LINE 通知（需先綁定）。',
  posted: '已發單，符合條件的司機會收到 LINE 通知。',
  taken: '接單成功！請確認客人資訊並準時抵達。',
  released: '已退單，這張單重新開放接單。',
  unassigned: '已把司機移除，這張單重新開放接單。',
  cancelled: '訂單已取消。',
  completed: '已標記完成，記得給對方評價。',
  settled: '已更新結清狀態。',
  rated: '謝謝你的評價！',
  saved: '已儲存。',
  linked: 'LINE 綁定碼已產生，請照下方步驟綁定。',
}

// ---------- 共用 ----------

function page(c: C, title: string, body: Child, opts: { err?: string; status?: number } = {}) {
  const m = c.req.query('m')
  return c.html(
    html`<!doctype html>${(
    <Layout title={title} appName={c.env.APP_NAME} user={c.get('user')} msg={m ? MESSAGES[m] : undefined} err={opts.err}>
      {body}
    </Layout>
    )}`,
    (opts.status ?? 200) as 200,
  )
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function int(v: unknown, fallback = 0): number {
  const n = Number.parseInt(str(v), 10)
  return Number.isFinite(n) ? n : fallback
}

async function logEvent(env: Env, orderId: number, userId: number | null, action: string) {
  await env.DB.prepare('INSERT INTO order_events (order_id, user_id, action) VALUES (?, ?, ?)').bind(orderId, userId, action).run()
}

async function getOrder(env: Env, id: number) {
  return env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first<Order>()
}

async function getUser(env: Env, id: number | null) {
  if (!id) return null
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>()
}

async function reputation(env: Env, userId: number) {
  const r = await env.DB.prepare(
    `SELECT
       (SELECT AVG(stars) FROM ratings WHERE to_id = ?1) AS avg,
       (SELECT COUNT(*) FROM ratings WHERE to_id = ?1) AS count,
       (SELECT COUNT(*) FROM orders WHERE status = 'completed' AND (taker_id = ?1 OR poster_id = ?1)) AS done,
       (SELECT COUNT(*) FROM strikes WHERE user_id = ?1 AND created_at >= datetime('now', '-90 days')) AS strikes`,
  )
    .bind(userId)
    .first<{ avg: number | null; count: number; done: number; strikes: number }>()
  return r!
}

function later(c: C, p: Promise<unknown>) {
  try {
    c.executionCtx.waitUntil(p.catch((e) => console.error(e)))
  } catch {
    p.catch((e) => console.error(e))
  }
}

async function saveUpload(env: Env, file: unknown, prefix: string): Promise<string | { error: string }> {
  if (!(file instanceof File) || file.size === 0) return { error: '請上傳照片' }
  if (file.size > MAX_UPLOAD) return { error: '照片不能超過 8MB' }
  if (!file.type.startsWith('image/') && file.type !== 'application/pdf') return { error: '只能上傳照片或 PDF' }
  const key = `${prefix}/${crypto.randomUUID()}`
  await env.DOCS.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } })
  return key
}

// ---------- 登入狀態與防護 ----------

app.use('*', async (c, next) => {
  c.set('user', null)
  const token = getCookie(c, 'sid')
  if (token) {
    const u = await c.env.DB.prepare(
      'SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token = ? AND sessions.expires_at > ?',
    )
      .bind(token, Date.now())
      .first<User>()
    c.set('user', u ?? null)
  }
  // 跨站送出表單一律拒絕（LINE webhook 除外，它用簽章驗證）
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.path !== '/line/webhook') {
    const origin = c.req.header('origin')
    const self = new URL(c.req.url).origin
    if (origin ? origin !== self : c.req.header('sec-fetch-site') === 'cross-site') return c.text('Forbidden', 403)
  }
  await next()
  c.header('X-Frame-Options', 'DENY')
  c.header('Referrer-Policy', 'same-origin')
})

function needUser(c: C): User | Response {
  const u = c.get('user')
  return u ?? c.redirect(`/login?next=${encodeURIComponent(c.req.path)}`)
}

function needApproved(c: C): User | Response {
  const u = needUser(c)
  if (u instanceof Response) return u
  if (u.status !== 'approved') return c.redirect('/me')
  return u
}

function needAdmin(c: C): User | Response {
  const u = needUser(c)
  if (u instanceof Response) return u
  if (!u.is_admin) return c.text('Forbidden', 403)
  return u
}

// ---------- 首頁、規則 ----------

app.get('/', (c) => {
  if (c.get('user')) return c.redirect('/orders')
  return page(
    c,
    '首頁',
    <>
      <h1>{c.env.APP_NAME}</h1>
      <div class="card">
        <p style="margin-top:0">給南部機場接送、包車同業互相派單的免費平台。</p>
        <ul>
          <li>
            只收 <b>職業駕照 + R 牌租賃車</b> 的司機，人工審核
          </li>
          <li>同業、車行都能發單，完全免費、不抽成</li>
          <li>新單即時推播到 LINE，先接先得</li>
          <li>雙向評價、放鳥記點，每月自動對帳</li>
        </ul>
        <div class="row">
          <a class="btn" href="/register">
            免費註冊
          </a>
          <a class="btn ghost" href="/login">
            登入
          </a>
          <a class="btn ghost" href="/rules">
            平台規則
          </a>
        </div>
      </div>
    </>,
  )
})

app.get('/rules', (c) =>
  page(
    c,
    '平台規則',
    <>
      <h1>平台規則</h1>
      <div class="card">
        <h2 style="margin-top:0">加入資格</h2>
        <ul>
          <li>司機：需持有效職業駕照，車輛為 R 牌租賃車（車牌 R 開頭），並上傳駕照與行照供審核。</li>
          <li>發單方（車行／同業）：填寫公司名稱與聯絡方式，審核後可發單，不能接單。</li>
          <li>不接受白牌車、自用車。發現冒用或不實資料立即停權。</li>
        </ul>
        <h2>費用</h2>
        <p>平台免費，不抽成。車資、回金由發單方與司機自行結算，平台只提供紀錄。</p>
        <h2>接單與退單</h2>
        <ul>
          <li>先接先得。接單前請確認時間、車型、人數、行李。</li>
          <li>上車前 {c.env.CANCEL_STRIKE_HOURS} 小時內退單，記 1 點。</li>
          <li>司機放鳥（沒到、沒通知），發單方可回報，記 1 點。</li>
          <li>90 天內點數會顯示在個人頁，累積過多由管理員停權。</li>
        </ul>
        <h2>客人資料</h2>
        <p>客人姓名、電話只給接單司機看，僅限本趟服務使用，不得私下招攬或外流。</p>
      </div>
    </>,
  ),
)

// ---------- 註冊、登入 ----------

const RegisterForm = (p: { v?: Record<string, string> }) => {
  const v = p.v ?? {}
  return (
    <form class="stack card" method="post" enctype="multipart/form-data">
      <label>
        帳號類型
        <select name="kind" onchange="document.querySelectorAll('[data-driver]').forEach(e=>e.hidden=this.value!=='driver')">
          <option value="driver" selected={v.kind !== 'dispatcher'}>
            司機（可發單、可接單）
          </option>
          <option value="dispatcher" selected={v.kind === 'dispatcher'}>
            車行／同業（只發單）
          </option>
        </select>
      </label>
      <div class="grid2">
        <label>
          姓名
          <input name="name" required value={v.name} />
        </label>
        <label>
          手機（登入帳號）
          <input name="phone" required inputmode="tel" placeholder="0912345678" value={v.phone} />
        </label>
      </div>
      <label>
        密碼（至少 8 碼）
        <input name="password" type="password" required minlength={8} />
      </label>
      <label>
        公司／車行名稱（司機可填靠行車行）
        <input name="company" value={v.company} />
      </label>
      <div data-driver hidden={v.kind === 'dispatcher'} class="stack" style="display:grid;gap:12px">
        <div class="grid2">
          <label>
            車牌（R 牌，例如 RFG-5981）
            <input name="plate" placeholder="RFG-5981" value={v.plate} />
          </label>
          <label>
            車型
            <select name="car_type">
              <Options items={CAR_TYPES} selected={v.car_type} />
            </select>
          </label>
        </div>
        <label>
          可載乘客數
          <input name="seats" type="number" min={1} max={20} value={v.seats || '4'} />
        </label>
        <label>
          職業駕照照片
          <input name="license" type="file" accept="image/*,application/pdf" />
        </label>
        <label>
          行照照片（要看得到車牌）
          <input name="vehicle" type="file" accept="image/*,application/pdf" />
        </label>
      </div>
      <label class="inline">
        <input type="checkbox" name="agree" value="1" required /> 我已閱讀並同意
        <a href="/rules" target="_blank">
          平台規則
        </a>
      </label>
      <button class="full">送出註冊</button>
    </form>
  )
}

app.get('/register', (c) => page(c, '註冊', <><h1>註冊</h1><RegisterForm /></>))

app.post('/register', async (c) => {
  const b = await c.req.parseBody()
  const v = {
    kind: str(b.kind) === 'dispatcher' ? 'dispatcher' : 'driver',
    name: str(b.name),
    phone: normalizePhone(str(b.phone)),
    company: str(b.company),
    plate: normalizePlate(str(b.plate)),
    car_type: str(b.car_type),
    seats: String(int(b.seats, 4)),
  }
  const password = typeof b.password === 'string' ? b.password : ''
  const fail = (err: string) => page(c, '註冊', <><h1>註冊</h1><RegisterForm v={v} /></>, { err, status: 400 })

  if (!v.name) return fail('請填姓名')
  if (!/^09\d{8}$/.test(v.phone)) return fail('手機格式不對，請填 09 開頭 10 碼')
  if (password.length < 8) return fail('密碼至少 8 碼')
  if (!b.agree) return fail('請勾選同意平台規則')
  if (v.kind === 'dispatcher' && !v.company) return fail('車行／同業請填公司名稱')
  if (v.kind === 'driver') {
    if (!PLATE_RE.test(v.plate)) return fail('車牌需為 R 牌租賃車，格式如 RFG-5981')
    if (!CAR_TYPES.includes(v.car_type)) return fail('請選車型')
  }
  const exists = await c.env.DB.prepare('SELECT 1 FROM users WHERE phone = ?').bind(v.phone).first()
  if (exists) return fail('這支手機已經註冊過了，請直接登入')

  let licenseKey = ''
  let vehicleKey = ''
  if (v.kind === 'driver') {
    const l = await saveUpload(c.env, b.license, 'license')
    if (typeof l !== 'string') return fail(`職業駕照：${l.error}`)
    const r = await saveUpload(c.env, b.vehicle, 'vehicle')
    if (typeof r !== 'string') return fail(`行照：${r.error}`)
    licenseKey = l
    vehicleKey = r
  }

  const admins = c.env.ADMIN_PHONES.split(',').map(normalizePhone).filter(Boolean)
  const isAdmin = admins.includes(v.phone)
  const res = await c.env.DB.prepare(
    `INSERT INTO users (kind, name, phone, password_hash, company, plate, car_type, seats, license_key, vehicle_key, regions, status, is_admin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      v.kind,
      v.name,
      v.phone,
      await hashPassword(password),
      v.company,
      v.kind === 'driver' ? v.plate : '',
      v.kind === 'driver' ? v.car_type : '',
      v.kind === 'driver' ? int(v.seats, 4) : 0,
      licenseKey,
      vehicleKey,
      '高雄',
      isAdmin ? 'approved' : 'pending',
      isAdmin ? 1 : 0,
    )
    .run()
  await startSession(c, res.meta.last_row_id as number)
  return c.redirect('/me?m=registered')
})

async function startSession(c: C, userId: number) {
  const token = randomToken()
  await c.env.DB.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(token, userId, Date.now() + SESSION_DAYS * 86400_000)
    .run()
  setCookie(c, 'sid', token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_DAYS * 86400 })
}

const LoginForm = (p: { phone?: string; next?: string }) => (
  <form class="stack card" method="post">
    <input type="hidden" name="next" value={p.next ?? ''} />
    <label>
      手機
      <input name="phone" required inputmode="tel" value={p.phone} />
    </label>
    <label>
      密碼
      <input name="password" type="password" required />
    </label>
    <button class="full">登入</button>
    <p class="muted" style="margin:0">
      還沒有帳號？<a href="/register">免費註冊</a>
    </p>
  </form>
)

app.get('/login', (c) => page(c, '登入', <><h1>登入</h1><LoginForm next={c.req.query('next')} /></>))

app.post('/login', async (c) => {
  const b = await c.req.parseBody()
  const phone = normalizePhone(str(b.phone))
  const next = str(b.next)
  const u = await c.env.DB.prepare('SELECT id, password_hash FROM users WHERE phone = ?').bind(phone).first<{ id: number; password_hash: string }>()
  if (!u || !(await verifyPassword(typeof b.password === 'string' ? b.password : '', u.password_hash))) {
    return page(c, '登入', <><h1>登入</h1><LoginForm phone={phone} next={next} /></>, { err: '手機或密碼錯誤', status: 401 })
  }
  await startSession(c, u.id)
  return c.redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/orders')
})

app.post('/logout', async (c) => {
  const token = getCookie(c, 'sid')
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run()
  deleteCookie(c, 'sid', { path: '/' })
  return c.redirect('/')
})

// ---------- 找單 ----------

app.get('/orders', async (c) => {
  const u = needApproved(c)
  if (u instanceof Response) return u
  const region = c.req.query('region') ?? ''
  const car = c.req.query('car') ?? (u.kind === 'driver' ? 'mine' : '')
  const today = todayTW()

  let sql = `SELECT * FROM orders WHERE status = 'open' AND ride_date >= ?`
  const args: (string | number)[] = [today]
  if (region) {
    sql += ' AND region = ?'
    args.push(region)
  }
  if (car === 'mine') {
    sql += ` AND (car_type = '不限' OR car_type = ?)`
    args.push(u.car_type)
  } else if (car) {
    sql += ' AND car_type = ?'
    args.push(car)
  }
  sql += ' ORDER BY ride_date, ride_time LIMIT 200'
  const { results } = await c.env.DB.prepare(sql).bind(...args).all<Order>()
  const now = Date.now()
  const list = results.filter((o) => rideTimestamp(o) > now - 3600_000)

  return page(
    c,
    '找單',
    <>
      <div class="row between">
        <h1>待接的單</h1>
        <a class="btn" href="/orders/new">
          ＋ 發單
        </a>
      </div>
      <form class="filters" method="get">
        <select name="region" onchange="this.form.submit()">
          <option value="">全部地區</option>
          <Options items={REGIONS} selected={region} />
        </select>
        <select name="car" onchange="this.form.submit()">
          <option value="">全部車型</option>
          {u.kind === 'driver' ? (
            <option value="mine" selected={car === 'mine'}>
              我的車型能接的
            </option>
          ) : null}
          <Options items={['不限', ...CAR_TYPES]} selected={car} />
        </select>
        <a class="btn ghost" href={c.req.url}>
          重新整理
        </a>
      </form>
      {list.length ? list.map((o) => <OrderCard o={o} />) : <div class="card muted">目前沒有符合條件的單。</div>}
    </>,
  )
})

// ---------- 發單 ----------

const OrderForm = (p: { v?: Record<string, string> }) => {
  const v = p.v ?? {}
  return (
    <form class="stack card" method="post" action="/orders">
      <div class="grid2">
        <label>
          服務
          <select name="service">
            <Options items={SERVICES} selected={v.service} />
          </select>
        </label>
        <label>
          上車地區
          <select name="region">
            <Options items={REGIONS} selected={v.region ?? '高雄'} />
          </select>
        </label>
        <label>
          日期
          <input name="ride_date" type="date" required value={v.ride_date ?? todayTW()} />
        </label>
        <label>
          時間
          <input name="ride_time" type="time" required value={v.ride_time} />
        </label>
      </div>
      <label>
        上車地點
        <input name="pickup" required placeholder="例如：小港機場國際線" value={v.pickup} />
      </label>
      <label>
        下車地點
        <input name="dropoff" required placeholder="例如：左營高鐵站" value={v.dropoff} />
      </label>
      <div class="grid2">
        <label>
          需求車型
          <select name="car_type">
            <Options items={['不限', ...CAR_TYPES]} selected={v.car_type} />
          </select>
        </label>
        <label>
          航班（選填）
          <input name="flight" placeholder="CI 123" value={v.flight} />
        </label>
        <label>
          乘客人數
          <input name="passengers" type="number" min={1} max={50} value={v.passengers ?? '1'} />
        </label>
        <label>
          行李件數
          <input name="luggage" type="number" min={0} max={50} value={v.luggage ?? '0'} />
        </label>
        <label>
          派價（司機實拿）
          <input name="price" type="number" min={0} required inputmode="numeric" value={v.price} />
        </label>
        <label>
          客下收（司機向客人收現金，已付填 0）
          <input name="collect" type="number" min={0} inputmode="numeric" value={v.collect ?? '0'} />
        </label>
      </div>
      <label>
        公開備註（所有司機看得到）
        <textarea name="notes" placeholder="例如：需舉牌、有嬰兒座椅需求">
          {v.notes}
        </textarea>
      </label>
      <label>
        客人資訊（只有接單司機看得到）
        <textarea name="private_notes" placeholder="客人姓名、電話、詳細地址">
          {v.private_notes}
        </textarea>
      </label>
      <button class="full">發單</button>
    </form>
  )
}

app.get('/orders/new', (c) => {
  const u = needApproved(c)
  if (u instanceof Response) return u
  return page(c, '發單', <><h1>發單</h1><OrderForm /></>)
})

app.post('/orders', async (c) => {
  const u = needApproved(c)
  if (u instanceof Response) return u
  const b = await c.req.parseBody()
  const v: Record<string, string> = {}
  for (const k of ['service', 'region', 'ride_date', 'ride_time', 'pickup', 'dropoff', 'car_type', 'flight', 'passengers', 'luggage', 'price', 'collect', 'notes', 'private_notes']) {
    v[k] = str(b[k])
  }
  const fail = (err: string) => page(c, '發單', <><h1>發單</h1><OrderForm v={v} /></>, { err, status: 400 })
  if (!SERVICES.includes(v.service)) return fail('請選服務')
  if (!REGIONS.includes(v.region)) return fail('請選地區')
  if (!['不限', ...CAR_TYPES].includes(v.car_type)) return fail('請選車型')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.ride_date) || !/^\d{2}:\d{2}$/.test(v.ride_time)) return fail('請填日期和時間')
  if (Number.isNaN(rideTimestamp(v as unknown as Order)) || rideTimestamp(v as unknown as Order) < Date.now()) return fail('上車時間已經過了')
  if (!v.pickup || !v.dropoff) return fail('請填上下車地點')
  const price = int(v.price, -1)
  if (price < 0) return fail('請填派價')
  const collect = Math.max(0, int(v.collect))

  const res = await c.env.DB.prepare(
    `INSERT INTO orders (poster_id, service, region, ride_date, ride_time, pickup, dropoff, car_type, passengers, luggage, flight, price, collect, notes, private_notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      u.id,
      v.service,
      v.region,
      v.ride_date,
      v.ride_time,
      v.pickup,
      v.dropoff,
      v.car_type,
      Math.max(1, int(v.passengers, 1)),
      Math.max(0, int(v.luggage)),
      v.flight,
      price,
      collect,
      v.notes,
      v.private_notes,
    )
    .run()
  const id = res.meta.last_row_id as number
  await logEvent(c.env, id, u.id, 'post')
  const o = (await getOrder(c.env, id))!
  later(c, notifyNewOrder(c.env, o, new URL(c.req.url).origin))
  return c.redirect(`/orders/${id}?m=posted`)
})

// ---------- 訂單詳情與操作 ----------

app.get('/orders/:id', async (c) => {
  const u = needApproved(c)
  if (u instanceof Response) return u
  const o = await getOrder(c.env, int(c.req.param('id')))
  if (!o) return c.notFound()
  const isPoster = o.poster_id === u.id
  const isTaker = o.taker_id === u.id
  if (o.status !== 'open' && !isPoster && !isTaker && !u.is_admin) {
    return page(c, '訂單', <div class="card">這張單已經被接走或取消了。<a href="/orders">看其他單</a></div>)
  }
  const poster = (await getUser(c.env, o.poster_id))!
  const taker = await getUser(c.env, o.taker_id)
  const posterRep = await reputation(c.env, poster.id)
  const takerRep = taker ? await reputation(c.env, taker.id) : null
  const myRating = await c.env.DB.prepare('SELECT stars FROM ratings WHERE order_id = ? AND from_id = ?').bind(o.id, u.id).first()
  const takeBlock = canTake(u, o)
  const started = rideTimestamp(o) - 3600_000 <= Date.now()

  return page(
    c,
    `訂單 #${o.id}`,
    <>
      <div class="row between">
        <h1>
          #{o.id} {o.service}
        </h1>
        <StatusTag status={o.status} />
      </div>
      <div class="card">
        <dl>
          <dt>時間</dt>
          <dd class="big">
            {o.ride_date} {o.ride_time}
          </dd>
          <dt>上車</dt>
          <dd>
            {o.pickup}（{o.region}）
          </dd>
          <dt>下車</dt>
          <dd>{o.dropoff}</dd>
          <dt>車型</dt>
          <dd>{o.car_type}</dd>
          <dt>人數／行李</dt>
          <dd>
            {o.passengers} 人／{o.luggage} 件
          </dd>
          {o.flight ? (
            <>
              <dt>航班</dt>
              <dd>{o.flight}</dd>
            </>
          ) : null}
          <dt>派價</dt>
          <dd class="price">{money(o.price)}</dd>
          <dt>款項</dt>
          <dd>
            <MoneyLine o={o} />
          </dd>
          {o.notes ? (
            <>
              <dt>備註</dt>
              <dd style="white-space:pre-wrap">{o.notes}</dd>
            </>
          ) : null}
          {(isPoster || isTaker || u.is_admin) && o.private_notes ? (
            <>
              <dt>客人資訊</dt>
              <dd style="white-space:pre-wrap">{o.private_notes}</dd>
            </>
          ) : null}
        </dl>
      </div>

      <div class="card">
        <div class="muted">發單方</div>
        <div class="row between">
          <a href={`/u/${poster.id}`}>
            {poster.name}
            {poster.company ? `（${poster.company}）` : ''}
          </a>
          <Stars avg={posterRep.avg} count={posterRep.count} />
        </div>
        {isTaker ? (
          <div>
            電話：<a href={`tel:${poster.phone}`}>{poster.phone}</a>
          </div>
        ) : null}
        {taker ? (
          <>
            <div class="muted" style="margin-top:10px">
              接單司機
            </div>
            <div class="row between">
              <a href={`/u/${taker.id}`}>
                {taker.name}｜{taker.car_type} {taker.plate}
              </a>
              <span>
                <Stars avg={takerRep!.avg} count={takerRep!.count} />
                {takerRep!.strikes ? <span class="tag bad" style="margin-left:6px">記點 {takerRep!.strikes}</span> : null}
              </span>
            </div>
            {isPoster || u.is_admin ? (
              <div>
                電話：<a href={`tel:${taker.phone}`}>{taker.phone}</a>
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      {o.status === 'open' && !isPoster ? (
        takeBlock ? (
          <div class="card muted">{takeBlock}</div>
        ) : (
          <form method="post" action={`/orders/${o.id}/take`} onsubmit="return confirm('確定要接這張單嗎？')">
            <button class="full">我要接單</button>
          </form>
        )
      ) : null}

      {isTaker && o.status === 'taken' ? (
        <div class="row">
          {started ? (
            <form class="inline" method="post" action={`/orders/${o.id}/complete`}>
              <button>完成這趟</button>
            </form>
          ) : null}
          <form
            class="inline"
            method="post"
            action={`/orders/${o.id}/release`}
            onsubmit={`return confirm('確定要退單嗎？上車前 ${c.env.CANCEL_STRIKE_HOURS} 小時內退單會記 1 點。')`}
          >
            <button class="ghost">退單</button>
          </form>
        </div>
      ) : null}

      {isPoster && (o.status === 'open' || o.status === 'taken') ? (
        <div class="row">
          {o.status === 'taken' && started ? (
            <form class="inline" method="post" action={`/orders/${o.id}/complete`}>
              <button>標記完成</button>
            </form>
          ) : null}
          {o.status === 'taken' ? (
            <>
              <form class="inline" method="post" action={`/orders/${o.id}/unassign`} onsubmit="return confirm('移除這位司機，重新開放接單？')">
                <button class="ghost">換司機</button>
              </form>
              <form
                class="inline"
                method="post"
                action={`/orders/${o.id}/unassign`}
                onsubmit="return confirm('回報司機放鳥？司機會被記 1 點，這張單重新開放接單。')"
              >
                <input type="hidden" name="no_show" value="1" />
                <button class="ghost">回報放鳥</button>
              </form>
            </>
          ) : null}
          <form class="inline" method="post" action={`/orders/${o.id}/cancel`} onsubmit="return confirm('確定取消這張單？')">
            <button class="danger">取消訂單</button>
          </form>
        </div>
      ) : null}

      {o.status === 'completed' && (isPoster || isTaker) ? (
        <>
          {isPoster ? (
            <form method="post" action={`/orders/${o.id}/settle`} class="card row between">
              <span>{o.settled ? '✅ 款項已結清' : '款項尚未結清'}</span>
              <button class="ghost">{o.settled ? '改為未結清' : '標記已結清'}</button>
            </form>
          ) : (
            <div class="card">{o.settled ? '✅ 發單方已標記款項結清' : '發單方尚未標記結清'}</div>
          )}
          {myRating ? (
            <div class="card muted">你已經評價過這趟了。</div>
          ) : (
            <form method="post" action={`/orders/${o.id}/rate`} class="card stack">
              <b>評價{isPoster ? '司機' : '發單方'}</b>
              <div class="row">
                {[5, 4, 3, 2, 1].map((n) => (
                  <label class="inline">
                    <input type="radio" name="stars" value={String(n)} required checked={n === 5} /> {'★'.repeat(n)}
                  </label>
                ))}
              </div>
              <input name="comment" placeholder="留言（選填）" />
              <button>送出評價</button>
            </form>
          )}
        </>
      ) : null}
    </>,
  )
})

async function orderAction(c: C, handler: (u: User, o: Order, b: Record<string, unknown>) => Promise<Response>) {
  const u = needApproved(c)
  if (u instanceof Response) return u
  const o = await getOrder(c.env, int(c.req.param('id')))
  if (!o) return c.notFound()
  return handler(u, o, await c.req.parseBody())
}

function back(c: C, o: Order, err: string) {
  return page(c, '訂單', <div class="card">
    {err} <a href={`/orders/${o.id}`}>回訂單</a>
  </div>, { err, status: 409 })
}

app.post('/orders/:id/take', (c) =>
  orderAction(c, async (u, o) => {
    const why = canTake(u, o)
    if (why) return back(c, o, why)
    // 用 status = 'open' 當條件，兩個人同時按只有一個會成功
    const res = await c.env.DB.prepare(`UPDATE orders SET taker_id = ?, status = 'taken', taken_at = datetime('now') WHERE id = ? AND status = 'open'`)
      .bind(u.id, o.id)
      .run()
    if (!res.meta.changes) return back(c, o, '慢了一步，這張單已經被接走了')
    await logEvent(c.env, o.id, u.id, 'take')
    const poster = await getUser(c.env, o.poster_id)
    later(c, pushText(c.env, poster?.line_user_id, `✅ 你的單已被接走\n司機：${u.name} ${u.phone}｜${u.car_type} ${u.plate}\n` + orderSummary(o, new URL(c.req.url).origin)))
    return c.redirect(`/orders/${o.id}?m=taken`)
  }),
)

app.post('/orders/:id/release', (c) =>
  orderAction(c, async (u, o) => {
    if (o.taker_id !== u.id || o.status !== 'taken') return back(c, o, '你不是這張單的接單司機')
    const res = await c.env.DB.prepare(`UPDATE orders SET taker_id = NULL, status = 'open', taken_at = NULL WHERE id = ? AND taker_id = ? AND status = 'taken'`)
      .bind(o.id, u.id)
      .run()
    if (!res.meta.changes) return back(c, o, '訂單狀態已變更，請重新整理')
    const late = rideTimestamp(o) - Date.now() < Number(c.env.CANCEL_STRIKE_HOURS) * 3600_000
    if (late) {
      await c.env.DB.prepare('INSERT INTO strikes (user_id, order_id, reason) VALUES (?, ?, ?)').bind(u.id, o.id, `上車前 ${c.env.CANCEL_STRIKE_HOURS} 小時內退單`).run()
    }
    await logEvent(c.env, o.id, u.id, late ? 'release_late' : 'release')
    const poster = await getUser(c.env, o.poster_id)
    const origin = new URL(c.req.url).origin
    later(c, pushText(c.env, poster?.line_user_id, `⚠️ 司機 ${u.name} 退單，已重新開放接單\n` + orderSummary(o, origin)))
    later(c, notifyNewOrder(c.env, { ...o, status: 'open', taker_id: null }, origin))
    return c.redirect(`/orders/${o.id}?m=released`)
  }),
)

app.post('/orders/:id/unassign', (c) =>
  orderAction(c, async (u, o, b) => {
    if (o.poster_id !== u.id || o.status !== 'taken' || !o.taker_id) return back(c, o, '只有發單方可以換司機')
    const takerId = o.taker_id
    const res = await c.env.DB.prepare(`UPDATE orders SET taker_id = NULL, status = 'open', taken_at = NULL WHERE id = ? AND taker_id = ? AND status = 'taken'`)
      .bind(o.id, takerId)
      .run()
    if (!res.meta.changes) return back(c, o, '訂單狀態已變更，請重新整理')
    const noShow = str(b.no_show) === '1'
    if (noShow) await c.env.DB.prepare('INSERT INTO strikes (user_id, order_id, reason) VALUES (?, ?, ?)').bind(takerId, o.id, '發單方回報放鳥').run()
    await logEvent(c.env, o.id, u.id, noShow ? 'unassign_no_show' : 'unassign')
    const taker = await getUser(c.env, takerId)
    const origin = new URL(c.req.url).origin
    later(c, pushText(c.env, taker?.line_user_id, `${noShow ? '❌ 發單方回報你放鳥（記 1 點），' : 'ℹ️ 發單方已換司機，'}你已被移出這張單\n` + orderSummary(o, origin)))
    later(c, notifyNewOrder(c.env, { ...o, status: 'open', taker_id: null }, origin))
    return c.redirect(`/orders/${o.id}?m=unassigned`)
  }),
)

app.post('/orders/:id/cancel', (c) =>
  orderAction(c, async (u, o) => {
    if (o.poster_id !== u.id && !u.is_admin) return back(c, o, '只有發單方可以取消')
    const res = await c.env.DB.prepare(`UPDATE orders SET status = 'cancelled' WHERE id = ? AND status IN ('open', 'taken')`).bind(o.id).run()
    if (!res.meta.changes) return back(c, o, '這張單已完成或已取消')
    await logEvent(c.env, o.id, u.id, 'cancel')
    const taker = await getUser(c.env, o.taker_id)
    later(c, pushText(c.env, taker?.line_user_id, '🚫 發單方已取消這張單\n' + orderSummary(o, new URL(c.req.url).origin)))
    return c.redirect(`/orders/${o.id}?m=cancelled`)
  }),
)

app.post('/orders/:id/complete', (c) =>
  orderAction(c, async (u, o) => {
    if (o.poster_id !== u.id && o.taker_id !== u.id) return back(c, o, '只有發單方或接單司機可以完成')
    if (rideTimestamp(o) - 3600_000 > Date.now()) return back(c, o, '還沒到上車時間')
    const res = await c.env.DB.prepare(`UPDATE orders SET status = 'completed', completed_at = datetime('now') WHERE id = ? AND status = 'taken'`).bind(o.id).run()
    if (!res.meta.changes) return back(c, o, '訂單狀態已變更，請重新整理')
    await logEvent(c.env, o.id, u.id, 'complete')
    return c.redirect(`/orders/${o.id}?m=completed`)
  }),
)

app.post('/orders/:id/settle', (c) =>
  orderAction(c, async (u, o) => {
    if (o.poster_id !== u.id || o.status !== 'completed') return back(c, o, '只有發單方可以標記結清')
    await c.env.DB.prepare('UPDATE orders SET settled = 1 - settled WHERE id = ?').bind(o.id).run()
    await logEvent(c.env, o.id, u.id, o.settled ? 'unsettle' : 'settle')
    return c.redirect(`/orders/${o.id}?m=settled`)
  }),
)

app.post('/orders/:id/rate', (c) =>
  orderAction(c, async (u, o, b) => {
    if (o.status !== 'completed' || !o.taker_id) return back(c, o, '完成後才能評價')
    const to = o.poster_id === u.id ? o.taker_id : o.taker_id === u.id ? o.poster_id : null
    if (!to) return back(c, o, '只有發單方或接單司機可以評價')
    const stars = int(b.stars)
    if (stars < 1 || stars > 5) return back(c, o, '請選 1～5 顆星')
    await c.env.DB.prepare('INSERT OR IGNORE INTO ratings (order_id, from_id, to_id, stars, comment) VALUES (?, ?, ?, ?, ?)')
      .bind(o.id, u.id, to, stars, str(b.comment).slice(0, 200))
      .run()
    return c.redirect(`/orders/${o.id}?m=rated`)
  }),
)

// ---------- 我的單、對帳 ----------

app.get('/mine', async (c) => {
  const u = needApproved(c)
  if (u instanceof Response) return u
  const tab = c.req.query('tab') === 'taken' ? 'taken' : 'posted'
  const col = tab === 'taken' ? 'taker_id' : 'poster_id'
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM orders WHERE ${col} = ?
     ORDER BY CASE status WHEN 'taken' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, ride_date DESC, ride_time DESC LIMIT 200`,
  )
    .bind(u.id)
    .all<Order>()
  return page(
    c,
    '我的單',
    <>
      <h1>我的單</h1>
      <div class="filters">
        <a class={tab === 'posted' ? 'btn' : 'btn ghost'} href="/mine">
          我發的
        </a>
        {u.kind === 'driver' ? (
          <a class={tab === 'taken' ? 'btn' : 'btn ghost'} href="/mine?tab=taken">
            我接的
          </a>
        ) : null}
      </div>
      {results.length ? results.map((o) => <OrderCard o={o} />) : <div class="card muted">還沒有訂單。</div>}
    </>,
  )
})

type ReportRow = Order & { role: 'poster' | 'taker'; other_name: string; other_company: string }

async function reportRows(env: Env, userId: number, month: string) {
  const { results } = await env.DB.prepare(
    `SELECT o.*, CASE WHEN o.poster_id = ?1 THEN 'poster' ELSE 'taker' END AS role,
            other.name AS other_name, other.company AS other_company
     FROM orders o
     JOIN users other ON other.id = CASE WHEN o.poster_id = ?1 THEN o.taker_id ELSE o.poster_id END
     WHERE o.status = 'completed' AND (o.poster_id = ?1 OR o.taker_id = ?1) AND o.ride_date LIKE ?2
     ORDER BY o.ride_date, o.ride_time`,
  )
    .bind(userId, `${month}%`)
    .all<ReportRow>()
  return results
}

// 正數：我應收；負數：我應付
function myBalance(r: ReportRow): number {
  const ret = returnAmount(r)
  return r.role === 'poster' ? ret : -ret
}

function monthParam(c: C): string {
  const m = c.req.query('month') ?? ''
  return /^\d{4}-\d{2}$/.test(m) ? m : todayTW().slice(0, 7)
}

app.get('/report', async (c) => {
  const u = needApproved(c)
  if (u instanceof Response) return u
  const month = monthParam(c)
  const rows = await reportRows(c.env, u.id, month)
  const asTaker = rows.filter((r) => r.role === 'taker')
  const asPoster = rows.filter((r) => r.role === 'poster')
  const unsettled = rows.filter((r) => !r.settled)
  const receivable = unsettled.map(myBalance).filter((x) => x > 0).reduce((a, b) => a + b, 0)
  const payable = -unsettled.map(myBalance).filter((x) => x < 0).reduce((a, b) => a + b, 0)

  return page(
    c,
    '對帳',
    <>
      <h1>對帳</h1>
      <form class="filters" method="get">
        <input type="month" name="month" value={month} onchange="this.form.submit()" style="width:auto" />
        <a class="btn ghost" href={`/report.csv?month=${month}`}>
          下載 Excel（CSV）
        </a>
      </form>
      <div class="grid2">
        <div class="card">
          <div class="muted">接單 {asTaker.length} 趟，派價合計</div>
          <div class="price">{money(asTaker.reduce((a, r) => a + r.price, 0))}</div>
        </div>
        <div class="card">
          <div class="muted">發單 {asPoster.length} 趟，派出合計</div>
          <div class="price">{money(asPoster.reduce((a, r) => a + r.price, 0))}</div>
        </div>
        <div class="card">
          <div class="muted">未結清：我應收</div>
          <div class="price">{money(receivable)}</div>
        </div>
        <div class="card">
          <div class="muted">未結清：我應付</div>
          <div class="price" style="color:var(--bad)">
            {money(payable)}
          </div>
        </div>
      </div>
      <div class="card scroll">
        <table>
          <thead>
            <tr>
              <th>日期</th>
              <th>路線</th>
              <th>角色</th>
              <th>對方</th>
              <th>派價</th>
              <th>客下收</th>
              <th>我應收／付</th>
              <th>結清</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const bal = myBalance(r)
              return (
                <tr>
                  <td>
                    <a href={`/orders/${r.id}`}>
                      {r.ride_date.slice(5)} {r.ride_time}
                    </a>
                  </td>
                  <td>
                    {r.pickup} → {r.dropoff}
                  </td>
                  <td>{r.role === 'poster' ? '發單' : '接單'}</td>
                  <td>{r.other_company || r.other_name}</td>
                  <td>{money(r.price)}</td>
                  <td>{r.collect ? money(r.collect) : '-'}</td>
                  <td style={bal < 0 ? 'color:var(--bad)' : ''}>{bal === 0 ? '-' : bal > 0 ? `收 ${money(bal)}` : `付 ${money(-bal)}`}</td>
                  <td>{r.settled ? '✅' : ''}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {rows.length ? null : <p class="muted">這個月還沒有完成的訂單。</p>}
      </div>
    </>,
  )
})

app.get('/report.csv', async (c) => {
  const u = needApproved(c)
  if (u instanceof Response) return u
  const month = monthParam(c)
  const rows = await reportRows(c.env, u.id, month)
  const esc = (v: string | number) => {
    if (typeof v === 'number') return String(v)
    const s = v
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s // 避免 Excel 公式注入
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  const header = ['訂單編號', '日期', '時間', '服務', '上車', '下車', '車型', '角色', '對方', '對方公司', '派價', '客下收', '我應收(+)/應付(-)', '已結清']
  const lines = rows.map((r) =>
    [r.id, r.ride_date, r.ride_time, r.service, r.pickup, r.dropoff, r.car_type, r.role === 'poster' ? '發單' : '接單', r.other_name, r.other_company, r.price, r.collect, myBalance(r), r.settled ? '是' : '否']
      .map(esc)
      .join(','),
  )
  const body = '﻿' + [header.join(','), ...lines].join('\r\n')
  return c.body(body, 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="report-${month}.csv"`,
  })
})

// ---------- 帳號 ----------

app.get('/me', async (c) => {
  const u = needUser(c)
  if (u instanceof Response) return u
  const rep = await reputation(c.env, u.id)
  const regions = u.regions.split(',').filter(Boolean)
  const lineReady = Boolean(c.env.LINE_CHANNEL_ACCESS_TOKEN)
  return page(
    c,
    '帳號',
    <>
      <h1>我的帳號</h1>
      <div class="card">
        <div class="row between">
          <span class="big">{u.name}</span>
          <UserStatusTag status={u.status} />
        </div>
        <div class="muted">
          {u.kind === 'driver' ? `司機｜${u.car_type} ${u.plate}｜${u.seats} 座` : '車行／同業（只發單）'}
          {u.company ? `｜${u.company}` : ''}
        </div>
        {u.status === 'pending' ? <p>資料審核中，通過後就能發單、接單。</p> : null}
        {u.status === 'rejected' || u.status === 'suspended' ? <p style="color:var(--bad)">{u.review_note || '請聯絡平台管理員。'}</p> : null}
        <div class="row" style="margin-top:8px">
          <Stars avg={rep.avg} count={rep.count} />
          <span class="muted">完成 {rep.done} 趟</span>
          {rep.strikes ? <span class="tag bad">90 天內記點 {rep.strikes}</span> : null}
        </div>
      </div>

      <h2>LINE 通知</h2>
      <div class="card">
        {u.line_user_id ? (
          <p style="margin:0">✅ 已綁定 LINE，新單和訂單異動會推播給你。</p>
        ) : !lineReady ? (
          <p class="muted" style="margin:0">
            平台尚未設定 LINE 官方帳號。
          </p>
        ) : u.line_bind_code ? (
          <p style="margin:0">
            加入平台的 LINE 官方帳號，然後傳送這組數字：<b class="big">{u.line_bind_code}</b>
          </p>
        ) : (
          <form method="post" action="/me/line-code">
            <button>取得 LINE 綁定碼</button>
          </form>
        )}
      </div>

      {u.kind === 'driver' ? (
        <>
          <h2>想收哪些地區的新單通知</h2>
          <form class="card stack" method="post" action="/me">
            <div class="row">
              {REGIONS.map((r) => (
                <label class="inline">
                  <input type="checkbox" name="regions" value={r} checked={regions.includes(r)} /> {r}
                </label>
              ))}
            </div>
            <button>儲存</button>
          </form>
        </>
      ) : null}

      <form method="post" action="/logout">
        <button class="ghost full">登出</button>
      </form>
    </>,
  )
})

app.post('/me', async (c) => {
  const u = needUser(c)
  if (u instanceof Response) return u
  const b = await c.req.parseBody({ all: true })
  const raw = b.regions
  const picked = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(str).filter((r) => REGIONS.includes(r))
  await c.env.DB.prepare('UPDATE users SET regions = ? WHERE id = ?').bind(picked.join(','), u.id).run()
  return c.redirect('/me?m=saved')
})

app.post('/me/line-code', async (c) => {
  const u = needUser(c)
  if (u instanceof Response) return u
  for (let i = 0; i < 5; i++) {
    const code = randomDigits(6)
    const res = await c.env.DB.prepare('UPDATE users SET line_bind_code = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM users WHERE line_bind_code = ?)')
      .bind(code, u.id, code)
      .run()
    if (res.meta.changes) break
  }
  return c.redirect('/me?m=linked')
})

app.get('/u/:id', async (c) => {
  const me = needApproved(c)
  if (me instanceof Response) return me
  const u = await getUser(c.env, int(c.req.param('id')))
  if (!u) return c.notFound()
  const rep = await reputation(c.env, u.id)
  const { results: comments } = await c.env.DB.prepare(
    `SELECT r.stars, r.comment, r.created_at, f.name AS from_name FROM ratings r JOIN users f ON f.id = r.from_id
     WHERE r.to_id = ? AND r.comment != '' ORDER BY r.id DESC LIMIT 20`,
  )
    .bind(u.id)
    .all<{ stars: number; comment: string; created_at: string; from_name: string }>()
  return page(
    c,
    u.name,
    <>
      <h1>{u.name}</h1>
      <div class="card">
        <div class="muted">
          {u.kind === 'driver' ? `司機｜${u.car_type} ${u.plate}｜${u.seats} 座` : '車行／同業'}
          {u.company ? `｜${u.company}` : ''}
        </div>
        <div class="row" style="margin-top:6px">
          <UserStatusTag status={u.status} />
          <Stars avg={rep.avg} count={rep.count} />
          <span class="muted">完成 {rep.done} 趟</span>
          {rep.strikes ? <span class="tag bad">90 天內記點 {rep.strikes}</span> : <span class="tag">無記點</span>}
        </div>
      </div>
      {comments.map((r) => (
        <div class="card">
          <div>{'★'.repeat(r.stars)}</div>
          <div>{r.comment}</div>
          <div class="muted">
            {r.from_name}・{r.created_at.slice(0, 10)}
          </div>
        </div>
      ))}
    </>,
  )
})

// 證件照片只有本人和管理員看得到
app.get('/files/*', async (c) => {
  const u = needUser(c)
  if (u instanceof Response) return u
  const key = c.req.path.slice('/files/'.length)
  if (!u.is_admin && key !== u.license_key && key !== u.vehicle_key) return c.text('Forbidden', 403)
  const obj = await c.env.DOCS.get(key)
  if (!obj) return c.notFound()
  return c.body(obj.body, 200, { 'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream', 'Cache-Control': 'private, no-store' })
})

// ---------- 管理 ----------

app.get('/admin', async (c) => {
  const a = needAdmin(c)
  if (a instanceof Response) return a
  const filter = c.req.query('status') ?? 'pending'
  const { results } = await c.env.DB.prepare(
    `SELECT u.*, (SELECT COUNT(*) FROM strikes s WHERE s.user_id = u.id AND s.created_at >= datetime('now', '-90 days')) AS strikes
     FROM users u ${filter === 'all' ? '' : 'WHERE u.status = ?'} ORDER BY u.id DESC LIMIT 300`,
  )
    .bind(...(filter === 'all' ? [] : [filter]))
    .all<User & { strikes: number }>()
  const stats = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM users WHERE status = 'pending') AS pending,
            (SELECT COUNT(*) FROM users WHERE status = 'approved') AS approved,
            (SELECT COUNT(*) FROM orders WHERE status = 'open') AS open,
            (SELECT COUNT(*) FROM orders WHERE status = 'completed' AND completed_at >= datetime('now', '-30 days')) AS done30`,
  ).first<{ pending: number; approved: number; open: number; done30: number }>()
  const tabs: [string, string][] = [
    ['pending', `待審核（${stats!.pending}）`],
    ['approved', '已通過'],
    ['suspended', '停權'],
    ['rejected', '未通過'],
    ['all', '全部'],
  ]
  return page(
    c,
    '管理',
    <>
      <h1>管理</h1>
      <div class="grid2">
        <div class="card">
          <div class="muted">會員（已通過）</div>
          <div class="price">{stats!.approved}</div>
        </div>
        <div class="card">
          <div class="muted">待接單／近 30 天完成</div>
          <div class="price">
            {stats!.open}／{stats!.done30}
          </div>
        </div>
      </div>
      <div class="filters">
        {tabs.map(([k, label]) => (
          <a class={filter === k ? 'btn' : 'btn ghost'} href={`/admin?status=${k}`}>
            {label}
          </a>
        ))}
      </div>
      {results.map((u) => (
        <a class="card link" href={`/admin/users/${u.id}`}>
          <div class="row between">
            <b>
              {u.name} {u.company ? `（${u.company}）` : ''}
            </b>
            <UserStatusTag status={u.status} />
          </div>
          <div class="muted">
            {u.kind === 'driver' ? `司機｜${u.car_type} ${u.plate}` : '發單方'}｜{u.phone}｜註冊 {u.created_at.slice(0, 10)}
            {u.strikes ? `｜記點 ${u.strikes}` : ''}
          </div>
        </a>
      ))}
      {results.length ? null : <div class="card muted">沒有資料。</div>}
    </>,
  )
})

app.get('/admin/users/:id', async (c) => {
  const a = needAdmin(c)
  if (a instanceof Response) return a
  const u = await getUser(c.env, int(c.req.param('id')))
  if (!u) return c.notFound()
  const { results: strikes } = await c.env.DB.prepare('SELECT * FROM strikes WHERE user_id = ? ORDER BY id DESC LIMIT 50')
    .bind(u.id)
    .all<{ id: number; order_id: number | null; reason: string; created_at: string }>()
  return page(
    c,
    `審核 ${u.name}`,
    <>
      <h1>
        {u.name} <UserStatusTag status={u.status} />
      </h1>
      <div class="card">
        <dl>
          <dt>類型</dt>
          <dd>{u.kind === 'driver' ? '司機' : '車行／同業'}</dd>
          <dt>手機</dt>
          <dd>{u.phone}</dd>
          <dt>公司</dt>
          <dd>{u.company || '-'}</dd>
          {u.kind === 'driver' ? (
            <>
              <dt>車牌</dt>
              <dd>{u.plate}</dd>
              <dt>車型</dt>
              <dd>
                {u.car_type}｜{u.seats} 座
              </dd>
            </>
          ) : null}
          <dt>註冊</dt>
          <dd>{u.created_at}</dd>
        </dl>
      </div>
      {u.kind === 'driver' ? (
        <div class="grid2">
          <div class="card">
            <div class="muted">職業駕照</div>
            {u.license_key ? <a href={`/files/${u.license_key}`} target="_blank"><img class="doc" src={`/files/${u.license_key}`} alt="職業駕照" /></a> : '未上傳'}
          </div>
          <div class="card">
            <div class="muted">行照（確認 R 牌與車牌一致）</div>
            {u.vehicle_key ? <a href={`/files/${u.vehicle_key}`} target="_blank"><img class="doc" src={`/files/${u.vehicle_key}`} alt="行照" /></a> : '未上傳'}
          </div>
        </div>
      ) : null}
      <form class="card stack" method="post" action={`/admin/users/${u.id}/status`}>
        <label>
          備註（未通過或停權時會顯示給對方）
          <input name="note" value={u.review_note} />
        </label>
        <div class="row">
          <button name="status" value="approved">
            通過
          </button>
          <button class="ghost" name="status" value="rejected">
            不通過
          </button>
          <button class="danger" name="status" value="suspended">
            停權
          </button>
        </div>
      </form>
      <h2>記點紀錄</h2>
      {strikes.length ? (
        strikes.map((s) => (
          <div class="card">
            {s.created_at.slice(0, 16)}｜{s.reason}
            {s.order_id ? (
              <>
                ｜<a href={`/orders/${s.order_id}`}>#{s.order_id}</a>
              </>
            ) : null}
          </div>
        ))
      ) : (
        <div class="card muted">沒有記點。</div>
      )}
    </>,
  )
})

app.post('/admin/users/:id/status', async (c) => {
  const a = needAdmin(c)
  if (a instanceof Response) return a
  const b = await c.req.parseBody()
  const status = str(b.status)
  if (!['approved', 'rejected', 'suspended'].includes(status)) return c.text('Bad Request', 400)
  const id = int(c.req.param('id'))
  await c.env.DB.prepare('UPDATE users SET status = ?, review_note = ? WHERE id = ?').bind(status, str(b.note), id).run()
  const u = await getUser(c.env, id)
  const text =
    status === 'approved'
      ? `🎉 ${c.env.APP_NAME} 審核通過，可以開始發單、接單了！\n${new URL(c.req.url).origin}/orders`
      : `${c.env.APP_NAME} 帳號狀態：${status === 'rejected' ? '審核未通過' : '停權'}${str(b.note) ? `\n原因：${str(b.note)}` : ''}`
  later(c, pushText(c.env, u?.line_user_id, text))
  return c.redirect(`/admin/users/${id}`)
})

// ---------- LINE webhook ----------

type LineEvent = { type: string; replyToken?: string; source?: { userId?: string }; message?: { type: string; text?: string } }

app.post('/line/webhook', async (c) => {
  const body = await c.req.text()
  const secret = c.env.LINE_CHANNEL_SECRET
  if (!secret || !(await verifySignature(secret, body, c.req.header('x-line-signature') ?? ''))) return c.text('Unauthorized', 401)
  const { events } = JSON.parse(body) as { events: LineEvent[] }
  for (const e of events) {
    const lineId = e.source?.userId
    if (!lineId || !e.replyToken) continue
    if (e.type === 'follow') {
      await replyText(c.env, e.replyToken, `歡迎加入 ${c.env.APP_NAME}！\n請到平台「帳號」頁取得 6 位數綁定碼，傳到這裡就能收到新單通知。`)
    } else if (e.type === 'message' && e.message?.type === 'text') {
      const code = (e.message.text ?? '').trim()
      if (!/^\d{6}$/.test(code)) continue
      const u = await c.env.DB.prepare('SELECT id, name FROM users WHERE line_bind_code = ?').bind(code).first<{ id: number; name: string }>()
      if (!u) {
        await replyText(c.env, e.replyToken, '綁定碼不正確或已使用，請到平台重新取得。')
        continue
      }
      await c.env.DB.batch([
        c.env.DB.prepare('UPDATE users SET line_user_id = NULL WHERE line_user_id = ?').bind(lineId),
        c.env.DB.prepare('UPDATE users SET line_user_id = ?, line_bind_code = NULL WHERE id = ?').bind(lineId, u.id),
      ])
      await replyText(c.env, e.replyToken, `✅ ${u.name}，LINE 綁定完成！之後新單和訂單異動會在這裡通知你。`)
    }
  }
  return c.text('ok')
})

export default app
