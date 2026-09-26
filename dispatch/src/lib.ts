export type Env = {
  DB: D1Database
  DOCS: R2Bucket
  APP_NAME: string
  ADMIN_PHONES: string
  CANCEL_STRIKE_HOURS: string
  LINE_CHANNEL_SECRET?: string
  LINE_CHANNEL_ACCESS_TOKEN?: string
}

export type User = {
  id: number
  kind: 'driver' | 'dispatcher'
  name: string
  phone: string
  company: string
  plate: string
  car_type: string
  seats: number
  license_key: string
  vehicle_key: string
  regions: string
  status: 'pending' | 'approved' | 'rejected' | 'suspended'
  review_note: string
  is_admin: number
  line_user_id: string | null
  line_bind_code: string | null
  created_at: string
}

export type Order = {
  id: number
  poster_id: number
  taker_id: number | null
  service: string
  region: string
  ride_date: string
  ride_time: string
  pickup: string
  dropoff: string
  car_type: string
  passengers: number
  luggage: number
  flight: string
  price: number
  collect: number
  notes: string
  private_notes: string
  status: 'open' | 'taken' | 'completed' | 'cancelled'
  settled: number
  taken_at: string | null
  completed_at: string | null
  created_at: string
}

export type AppContext = { Bindings: Env; Variables: { user: User | null } }

export const REGIONS = ['高雄', '台南', '屏東', '嘉義', '台中', '北部', '東部', '其他']
export const CAR_TYPES = ['轎車', '休旅車', '7人座', '9人座（Vito/T6）', 'Alphard', '其他']
export const SERVICES = ['接機', '送機', '點對點接送', '包車']

export const STATUS_LABEL: Record<Order['status'], string> = {
  open: '待接單',
  taken: '已接單',
  completed: '已完成',
  cancelled: '已取消',
}

// R 牌租賃車：例如 RFG-5981、RAA-1234
export const PLATE_RE = /^R[A-Z]{2}-\d{4}$/

export function normalizePlate(raw: string): string {
  const s = raw.trim().toUpperCase().replace(/\s/g, '')
  const m = s.match(/^(R[A-Z]{2})-?(\d{4})$/)
  return m ? `${m[1]}-${m[2]}` : s
}

export function normalizePhone(raw: string): string {
  return raw.replace(/[\s-]/g, '')
}

// 台灣時間的上車時刻（epoch ms）
export function rideTimestamp(o: Pick<Order, 'ride_date' | 'ride_time'>): number {
  return Date.parse(`${o.ride_date}T${o.ride_time}:00+08:00`)
}

export function todayTW(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
}

export function money(n: number): string {
  return 'NT$' + n.toLocaleString('en-US')
}

// 司機收了客下收之後，要回給發單方多少（負數表示發單方要付司機）
export function returnAmount(o: Pick<Order, 'collect' | 'price'>): number {
  return o.collect - o.price
}

export function canTake(u: User, o: Order): string | null {
  if (u.status !== 'approved') return '帳號尚未通過審核'
  if (u.kind !== 'driver') return '發單方帳號不能接單'
  if (o.status !== 'open') return '這張單已經被接走或取消了'
  if (o.poster_id === u.id) return '不能接自己發的單'
  if (o.car_type !== '不限' && o.car_type !== u.car_type) return `這張單需要「${o.car_type}」，你的車型是「${u.car_type}」`
  if (u.seats && o.passengers > u.seats) return `乘客 ${o.passengers} 人，超過你的座位數 ${u.seats}`
  return null
}

const ITERATIONS = 100_000

function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

async function pbkdf2(password: string, salt: Uint8Array): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256)
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(await pbkdf2(password, salt))}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, , salt, hash] = stored.split('$')
  if (!salt || !hash) return false
  const actual = new Uint8Array(await pbkdf2(password, unb64(salt)))
  const expected = unb64(hash)
  if (actual.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i]
  return diff === 0
}

export function randomToken(bytes = 32): string {
  return b64(crypto.getRandomValues(new Uint8Array(bytes))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]!)
}

export function randomDigits(n: number): string {
  const arr = crypto.getRandomValues(new Uint32Array(n))
  return Array.from(arr, (x) => String(x % 10)).join('')
}
