import type { Child, FC, PropsWithChildren } from 'hono/jsx'
import { raw } from 'hono/html'
import type { Order, User } from './lib'
import { STATUS_LABEL, money, returnAmount } from './lib'

const CSS = `
:root{--bg:#f5f6f8;--card:#fff;--text:#1d2129;--muted:#6b7280;--line:#e5e7eb;--brand:#0f766e;--brand-soft:#e6f4f1;--warn:#b45309;--warn-soft:#fef3c7;--bad:#b91c1c;--bad-soft:#fee2e2;--ok:#15803d}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--card:#1b1f24;--text:#e6e8eb;--muted:#9aa3ad;--line:#2c323a;--brand:#2dd4bf;--brand-soft:#123a36;--warn:#fbbf24;--warn-soft:#3a2e12;--bad:#f87171;--bad-soft:#3b1717;--ok:#4ade80}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 -apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif}
a{color:var(--brand)}
header{background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
header .in{max-width:760px;margin:0 auto;padding:10px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
header .brand{font-weight:700;text-decoration:none;color:var(--text);margin-right:auto}
header nav{display:flex;gap:14px;flex-wrap:wrap;font-size:15px}
header nav a{text-decoration:none}
main{max-width:760px;margin:0 auto;padding:16px}
h1{font-size:22px;margin:4px 0 14px}
h2{font-size:18px;margin:22px 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:0 0 12px}
.card.link{display:block;text-decoration:none;color:inherit}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.between{justify-content:space-between}
.muted{color:var(--muted);font-size:14px}
.big{font-size:18px;font-weight:700}
.price{font-size:20px;font-weight:700;color:var(--brand)}
.tag{display:inline-block;padding:1px 8px;border-radius:999px;font-size:13px;background:var(--brand-soft);color:var(--brand)}
.tag.warn{background:var(--warn-soft);color:var(--warn)}
.tag.bad{background:var(--bad-soft);color:var(--bad)}
.tag.gray{background:var(--line);color:var(--muted)}
.msg{padding:10px 14px;border-radius:10px;margin:0 0 14px;background:var(--brand-soft);color:var(--brand)}
.msg.err{background:var(--bad-soft);color:var(--bad)}
form.stack{display:grid;gap:12px}
label{display:grid;gap:4px;font-size:14px;color:var(--muted)}
label.inline{display:flex;gap:8px;align-items:center;color:var(--text);font-size:15px}
input,select,textarea{font:inherit;color:var(--text);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:9px 10px;width:100%}
input[type=checkbox],input[type=radio]{width:auto}
textarea{min-height:70px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media (max-width:480px){.grid2{grid-template-columns:1fr}}
button,.btn{font:inherit;border:0;border-radius:8px;padding:10px 16px;background:var(--brand);color:#fff;cursor:pointer;text-decoration:none;display:inline-block;text-align:center}
@media (prefers-color-scheme:dark){button,.btn{color:#062522}}
button.ghost,.btn.ghost{background:transparent;color:var(--brand);border:1px solid var(--line)}
button.danger{background:var(--bad)}
button.full{width:100%}
form.inline{display:inline}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;margin:0}
dt{color:var(--muted);font-size:14px}
dd{margin:0}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}
.scroll{overflow-x:auto}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.filters select{width:auto}
img.doc{max-width:100%;border-radius:8px;border:1px solid var(--line)}
`

export const Layout: FC<PropsWithChildren<{ title: string; appName: string; user: User | null; msg?: string; err?: string }>> = (p) => (
  <html lang="zh-Hant">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{`${p.title}｜${p.appName}`}</title>
      <style>{raw(CSS)}</style>
    </head>
    <body>
      <header>
        <div class="in">
          <a class="brand" href="/">
            {p.appName}
          </a>
          <nav>
            {p.user ? (
              <>
                <a href="/orders">找單</a>
                <a href="/orders/new">發單</a>
                <a href="/mine">我的單</a>
                <a href="/report">對帳</a>
                <a href="/me">帳號</a>
                {p.user.is_admin ? <a href="/admin">管理</a> : null}
              </>
            ) : (
              <>
                <a href="/rules">規則</a>
                <a href="/login">登入</a>
                <a href="/register">註冊</a>
              </>
            )}
          </nav>
        </div>
      </header>
      <main>
        {p.msg ? <div class="msg">{p.msg}</div> : null}
        {p.err ? <div class="msg err">{p.err}</div> : null}
        {p.children}
      </main>
    </body>
  </html>
)

export const StatusTag: FC<{ status: Order['status'] }> = ({ status }) => {
  const cls = status === 'open' ? 'tag' : status === 'taken' ? 'tag warn' : status === 'cancelled' ? 'tag bad' : 'tag gray'
  return <span class={cls}>{STATUS_LABEL[status]}</span>
}

export const UserStatusTag: FC<{ status: User['status'] }> = ({ status }) => {
  const map = { pending: ['tag warn', '審核中'], approved: ['tag', '已通過'], rejected: ['tag bad', '未通過'], suspended: ['tag bad', '停權'] } as const
  const [cls, label] = map[status]
  return <span class={cls}>{label}</span>
}

export const OrderCard: FC<{ o: Order; extra?: Child }> = ({ o, extra }) => (
  <a class="card link" href={`/orders/${o.id}`}>
    <div class="row between">
      <span class="big">
        {o.ride_date.slice(5).replace('-', '/')} {o.ride_time}
      </span>
      <span class="price">{money(o.price)}</span>
    </div>
    <div>
      {o.pickup} → {o.dropoff}
    </div>
    <div class="row muted" style="margin-top:4px">
      <StatusTag status={o.status} />
      <span class="tag gray">{o.region}</span>
      <span>{o.service}</span>
      <span>·</span>
      <span>{o.car_type}</span>
      <span>·</span>
      <span>
        {o.passengers} 人 {o.luggage} 件
      </span>
      {o.collect ? <span class="tag warn">客下收 {money(o.collect)}</span> : null}
      {extra}
    </div>
  </a>
)

export const MoneyLine: FC<{ o: Order }> = ({ o }) => {
  const r = returnAmount(o)
  if (!o.collect) return <span>客人已付清，發單方需付司機 {money(o.price)}</span>
  if (r > 0) return <span>司機向客人收 {money(o.collect)}，回金給發單方 {money(r)}</span>
  if (r < 0) return <span>司機向客人收 {money(o.collect)}，發單方再補司機 {money(-r)}</span>
  return <span>司機向客人收 {money(o.collect)}，剛好等於派價，不用回金</span>
}

export const Stars: FC<{ avg: number | null; count: number }> = ({ avg, count }) =>
  count ? (
    <span>
      ★ {avg!.toFixed(1)}（{count} 則）
    </span>
  ) : (
    <span class="muted">尚無評價</span>
  )

export const Options: FC<{ items: string[]; selected?: string }> = ({ items, selected }) => (
  <>
    {items.map((x) => (
      <option value={x} selected={x === selected}>
        {x}
      </option>
    ))}
  </>
)
