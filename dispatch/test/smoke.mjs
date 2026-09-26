// 端對端測試：先 `npm run db:migrate:local`，用 .dev.vars 設 ADMIN_PHONES="0900000001"、LINE_CHANNEL_SECRET="testsecret"，
// 再 `npx wrangler dev` 啟動，最後 `npm test`。每次跑會用新的手機號碼，不用清資料庫。
import { createHmac } from 'node:crypto'

const BASE = process.env.BASE ?? 'http://localhost:8787'
const run = Date.now().toString().slice(-6)
const phone = (n) => `09${n}${run}`.slice(0, 10).padEnd(10, '0')
let failed = 0

function check(cond, name) {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failed++
    console.log(`  ✗ ${name}`)
  }
}

class Client {
  cookie = ''
  async req(path, opts = {}) {
    const headers = { ...(opts.headers ?? {}) }
    if (this.cookie) headers.cookie = this.cookie
    if (opts.method === 'POST' && !('origin' in headers)) headers.origin = BASE
    const res = await fetch(BASE + path, { ...opts, headers, redirect: 'manual' })
    const sc = res.headers.get('set-cookie')
    if (sc) {
      const m = sc.match(/sid=([^;]*)/)
      if (m) this.cookie = m[1] ? `sid=${m[1]}` : ''
    }
    return { status: res.status, location: res.headers.get('location'), text: await res.text(), headers: res.headers }
  }
  get(path) {
    return this.req(path)
  }
  post(path, data) {
    const body = data instanceof FormData ? data : new URLSearchParams(data)
    return this.req(path, { method: 'POST', body })
  }
}

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))

function driverForm(name, ph, plate) {
  const f = new FormData()
  for (const [k, v] of Object.entries({ kind: 'driver', name, phone: ph, password: 'password123', company: '測試車行', plate, car_type: '9人座（Vito/T6）', seats: '8', agree: '1' })) f.append(k, v)
  f.append('license', new Blob([PNG], { type: 'image/png' }), 'license.png')
  f.append('vehicle', new Blob([PNG], { type: 'image/png' }), 'vehicle.png')
  return f
}

function twNow(offsetMin) {
  const d = new Date(Date.now() + 8 * 3600_000 + offsetMin * 60_000).toISOString()
  return { ride_date: d.slice(0, 10), ride_time: d.slice(11, 16) }
}

function orderForm(when, extra = {}) {
  return {
    service: '接機',
    region: '高雄',
    ...when,
    pickup: '小港機場國際線',
    dropoff: '左營高鐵站',
    car_type: '9人座（Vito/T6）',
    passengers: '3',
    luggage: '3',
    flight: 'CI 123',
    price: '1500',
    collect: '2000',
    notes: '需舉牌',
    private_notes: '王先生 0987654321',
    ...extra,
  }
}

const orderId = (loc) => Number(loc.match(/\/orders\/(\d+)/)[1])

console.log('註冊與審核')
const admin = new Client()
let r = await admin.post('/register', { kind: 'dispatcher', name: '管理員', phone: '0900000001', password: 'password123', company: '享運國際租車', agree: '1' })
if (r.status === 400 && r.text.includes('已經註冊過')) r = await admin.post('/login', { phone: '0900000001', password: 'password123' })
check(r.status === 302, '管理員註冊或登入')
check((await admin.get('/admin')).status === 200, '管理員進得了管理頁')

const a = new Client()
const b = new Client()
const aPhone = phone(1)
const bPhone = phone(2)
check((await a.post('/register', driverForm('司機甲', aPhone, 'rfg 5981'))).location === '/me?m=registered', '司機甲註冊（車牌自動轉成 RFG-5981）')
check((await b.post('/register', driverForm('司機乙', bPhone, 'RAA-1234'))).status === 302, '司機乙註冊')
const bad = new Client()
r = await bad.post('/register', driverForm('白牌', phone(3), 'ABC-1234'))
check(r.status === 400 && r.text.includes('R 牌'), '非 R 牌被擋')
r = await bad.post('/register', driverForm('重複', aPhone, 'RAB-1111'))
check(r.status === 400 && r.text.includes('已經註冊過'), '重複手機被擋')

check((await a.get('/orders')).location === '/me', '未審核不能看單')
check((await a.get('/admin')).status === 403, '一般會員進不了管理頁')

const pending = await admin.get('/admin?status=pending')
const idOf = (ph) => Number(pending.text.split('<a class="card link"').find((card) => card.includes(ph)).match(/\/admin\/users\/(\d+)/)[1])
const aId = idOf(aPhone)
const bId = idOf(bPhone)
check((await admin.get(`/admin/users/${aId}`)).text.includes('/files/license/'), '管理員看得到證件照')
for (const id of [aId, bId]) await admin.post(`/admin/users/${id}/status`, { status: 'approved', note: '' })
check((await a.get('/orders')).status === 200, '審核通過後可以看單')

console.log('證件權限')
const aMe = await admin.get(`/admin/users/${aId}`)
const aLicense = aMe.text.match(/\/files\/(license\/[\w-]+)/)[1]
check((await admin.get(`/files/${aLicense}`)).status === 200, '管理員能開證件')
check((await b.get(`/files/${aLicense}`)).status === 403, '別的司機不能開證件')

console.log('發單與搶單')
r = await admin.post('/orders', orderForm(twNow(-60)))
check(r.status === 400 && r.text.includes('已經過了'), '過去時間不能發單')
r = await admin.post('/orders', orderForm(twNow(24 * 60)))
check(r.status === 302, '發單成功')
const o1 = orderId(r.location)
check((await b.get('/orders')).text.includes(`/orders/${o1}`), '司機在找單列表看得到')
check(!(await b.get(`/orders/${o1}`)).text.includes('王先生'), '接單前看不到客人資訊')

const [ra, rb] = await Promise.all([a.post(`/orders/${o1}/take`, {}), b.post(`/orders/${o1}/take`, {})])
const wins = [ra, rb].filter((x) => x.location?.includes('m=taken')).length
check(wins === 1, `同時搶單只有一人成功（成功 ${wins} 人）`)
const [winner, loser, winnerId, loserId] = ra.location?.includes('m=taken') ? [a, b, aId, bId] : [b, a, bId, aId]
check((await winner.get(`/orders/${o1}`)).text.includes('王先生'), '接單後看得到客人資訊')
check((await loser.get(`/orders/${o1}`)).text.includes('已經被接走'), '沒搶到的人看不到細節')

console.log('退單、換司機、放鳥記點')
check((await winner.post(`/orders/${o1}/release`, {})).location.includes('m=released'), '提早退單')
check(!(await admin.get(`/admin/users/${winnerId}`)).text.includes('小時內退單'), '提早退單不記點')
await loser.post(`/orders/${o1}/take`, {})
check((await admin.post(`/orders/${o1}/unassign`, { no_show: '1' })).location.includes('m=unassigned'), '發單方回報放鳥')
check((await admin.get(`/admin/users/${loserId}`)).text.includes('發單方回報放鳥'), '放鳥記 1 點')
await winner.post(`/orders/${o1}/take`, {})
r = await winner.post(`/orders/${o1}/complete`, {})
check(r.status === 409 && r.text.includes('還沒到上車時間'), '還沒到時間不能完成')

console.log('臨時退單記點')
r = await admin.post('/orders', orderForm(twNow(60)))
const o2 = orderId(r.location)
await winner.post(`/orders/${o2}/take`, {})
await winner.post(`/orders/${o2}/release`, {})
check((await admin.get(`/admin/users/${winnerId}`)).text.includes('小時內退單'), '3 小時內退單記 1 點')

console.log('完成、結清、評價、對帳')
r = await admin.post('/orders', orderForm(twNow(30), { price: '1200', collect: '0' }))
const o3 = orderId(r.location)
await winner.post(`/orders/${o3}/take`, {})
check((await winner.post(`/orders/${o3}/complete`, {})).location.includes('m=completed'), '司機標記完成')
check((await loser.post(`/orders/${o3}/rate`, { stars: '1' })).status === 409, '局外人不能評價')
check((await winner.post(`/orders/${o3}/rate`, { stars: '5', comment: '準時付款' })).location.includes('m=rated'), '司機評價發單方')
check((await admin.post(`/orders/${o3}/rate`, { stars: '4', comment: '=HYPERLINK("x")' })).location.includes('m=rated'), '發單方評價司機')
check((await winner.get(`/orders/${o3}`)).text.includes('你已經評價過'), '不能重複評價')
await admin.post(`/orders/${o3}/settle`, {})
check((await winner.get(`/orders/${o3}`)).text.includes('已標記款項結清'), '司機看到已結清')

const month = twNow(30).ride_date.slice(0, 7)
const rep = await winner.get(`/report?month=${month}`)
check(rep.text.includes('NT$1,200'), '對帳頁有這趟派價')
const csvRaw = await fetch(`${BASE}/report.csv?month=${month}`, { headers: { cookie: winner.cookie } })
const csvBytes = new Uint8Array(await csvRaw.arrayBuffer())
const csv = new TextDecoder().decode(csvBytes)
check(csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf, 'CSV 開頭有 BOM（Excel 開中文不會亂碼）')
check(csv.includes('小港機場國際線'), 'CSV 有資料')
check(csv.includes(',1200,是'), 'CSV：客人已付清，司機應收 1200')
const adminCsv = await admin.get(`/report.csv?month=${month}`)
check(adminCsv.text.includes(',-1200,是'), 'CSV：發單方應付司機 1200')

console.log('安全')
r = await a.req(`/orders/${o1}/cancel`, { method: 'POST', body: new URLSearchParams({}), headers: { origin: 'https://evil.example' } })
check(r.status === 403, '跨站表單被擋')
check((await a.post(`/orders/${o1}/cancel`, {})).status === 409, '司機不能取消別人的單')
check((await new Client().get('/orders')).location?.startsWith('/login'), '沒登入導去登入頁')

console.log('LINE 綁定')
await a.post('/me/line-code', {})
// 綁定碼只在設定了 LINE_CHANNEL_ACCESS_TOKEN 時顯示
const bindCode = (await a.get('/me')).text.match(/<b class="big">(\d{6})<\/b>/)?.[1]
const sign = (body) => createHmac('sha256', 'testsecret').update(body).digest('base64')
const hook = (body, sig) => fetch(`${BASE}/line/webhook`, { method: 'POST', body, headers: { 'x-line-signature': sig, 'content-type': 'application/json' } })
const ev = (text) => JSON.stringify({ events: [{ type: 'message', replyToken: 't', source: { userId: `U${run}` }, message: { type: 'text', text } }] })
check((await hook(ev('123456'), 'bad')).status === 401, 'webhook 簽章錯誤被擋')
check((await hook(ev('000000'), sign(ev('000000')))).status === 200, 'webhook 簽章正確')
if (bindCode) {
  await hook(ev(bindCode), sign(ev(bindCode)))
  check((await a.get('/me')).text.includes('已綁定 LINE'), 'LINE 綁定成功')
} else {
  console.log('  - 本機沒設 LINE_CHANNEL_ACCESS_TOKEN，略過綁定碼顯示測試')
}

console.log(failed ? `\n${failed} 項失敗` : '\n全部通過')
process.exit(failed ? 1 : 0)
