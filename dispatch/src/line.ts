import type { Env, Order, User } from './lib'
import { money } from './lib'

const API = 'https://api.line.me/v2/bot/message'

async function call(env: Env, path: string, body: unknown): Promise<void> {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return
  // 推播失敗不影響派單流程，只記錄
  try {
    const res = await fetch(`${API}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
      body: JSON.stringify(body),
    })
    if (!res.ok) console.error(`LINE ${path} ${res.status}: ${await res.text()}`)
  } catch (e) {
    console.error(`LINE ${path} failed`, e)
  }
}

export async function pushText(env: Env, to: string | null | undefined, text: string): Promise<void> {
  if (!to) return
  await call(env, 'push', { to, messages: [{ type: 'text', text }] })
}

export async function replyText(env: Env, replyToken: string, text: string): Promise<void> {
  await call(env, 'reply', { replyToken, messages: [{ type: 'text', text }] })
}

export function orderSummary(o: Order, origin: string): string {
  return [
    `【${o.region}｜${o.service}】${o.ride_date} ${o.ride_time}`,
    `${o.pickup} → ${o.dropoff}`,
    `車型：${o.car_type}｜${o.passengers} 人 ${o.luggage} 件行李`,
    `派價：${money(o.price)}${o.collect ? `｜客下收 ${money(o.collect)}` : ''}`,
    o.notes ? `備註：${o.notes}` : '',
    `${origin}/orders/${o.id}`,
  ]
    .filter(Boolean)
    .join('\n')
}

// 新單：推給地區、車型符合的已審核司機
export async function notifyNewOrder(env: Env, o: Order, origin: string): Promise<void> {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return
  const { results } = await env.DB.prepare(
    `SELECT line_user_id, regions, car_type FROM users
     WHERE status = 'approved' AND kind = 'driver' AND line_user_id IS NOT NULL AND id != ?`,
  )
    .bind(o.poster_id)
    .all<Pick<User, 'line_user_id' | 'regions' | 'car_type'>>()
  const to = results
    .filter((u) => (!u.regions || u.regions.split(',').includes(o.region)) && (o.car_type === '不限' || o.car_type === u.car_type))
    .map((u) => u.line_user_id!)
  const text = '🚐 新單\n' + orderSummary(o, origin)
  for (let i = 0; i < to.length; i += 500) {
    await call(env, 'multicast', { to: to.slice(i, i + 500), messages: [{ type: 'text', text }] })
  }
}

export async function verifySignature(secret: string, body: string, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))
  let s = ''
  for (const b of mac) s += String.fromCharCode(b)
  const expected = btoa(s)
  if (expected.length !== signature.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  return diff === 0
}
