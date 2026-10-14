import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getConfig } from '../src/config.js';
import { addDays, today } from '../src/dates.js';
import { openDb } from '../src/db.js';
import { buildFocusList } from '../src/focus.js';
import { STALE_DAYS, UNMARKED, buildFunnel, leadInfo, markLost, reopenLead } from '../src/leads.js';

const config = getConfig({ TZ_NAME: 'Asia/Taipei' });
const T = today('Asia/Taipei');
const iso = (date, hh = '04') => `${date}T${hh}:00:00.000Z`; // 台灣時間中午

function setup() {
  const store = openDb(':memory:');
  const a = store.createBrand({ slug: 'a', name: '享運' });
  const b = store.createBrand({ slug: 'b', name: '首席' });
  const ask = (brand, uid, daysAgo) => {
    const c = store.upsertLineCustomer(brand.id, uid, { displayName: uid });
    store.run("INSERT INTO messages (customer_id, direction, text, created_at) VALUES (?, 'in', '請問報價', ?)", c.id, iso(addDays(T, -daysAgo)));
    return c;
  };
  const won = ask(a, 'won', 10);
  store.createOrder(won.id, { order_date: addDays(T, -8), service_date: addDays(T, -1), amount: 1500, status: 'completed' });
  const lost = ask(a, 'lost', 9);
  const stale = ask(a, 'stale', STALE_DAYS + 2);
  const open = ask(b, 'open', 3);
  const fresh = ask(b, 'fresh', 0);
  // 老客人：詢問之前就訂過 → 不算新詢問
  const old = store.upsertLineCustomer(b.id, 'old', { displayName: 'old' });
  store.createOrder(old.id, { order_date: addDays(T, -100), amount: 900, status: 'completed' });
  store.run("INSERT INTO messages (customer_id, direction, text, created_at) VALUES (?, 'in', '再訂一次', ?)", old.id, iso(addDays(T, -2)));
  // 客服只是加好友沒傳訊息 → 不算
  store.upsertLineCustomer(a.id, 'silent', { displayName: 'silent' });
  return { store, a, b, won, lost, stale, open, fresh, old };
}

test('詢問狀態：成交、洽談中、逾期未標記、未成交；老客人不算新詢問', () => {
  const { store, won, lost, stale, open, old } = setup();
  assert.equal(leadInfo(store, config, won.id).status, 'won');
  assert.equal(leadInfo(store, config, won.id).daysToWin, 2);
  assert.equal(leadInfo(store, config, open.id).status, 'open');
  assert.equal(leadInfo(store, config, stale.id).status, 'stale');
  assert.equal(leadInfo(store, config, lost.id).status, 'stale');
  assert.throws(() => markLost(store, lost.id, { reason: '亂寫' }, 'x'), /原因/);
  assert.throws(() => markLost(store, lost.id, { reason: '其他' }, 'x'), /其他/);
  markLost(store, lost.id, { reason: '價格考量', note: '嫌貴' }, '小艾');
  assert.equal(leadInfo(store, config, lost.id).status, 'lost');
  assert.equal(store.getCustomer(lost.id).lead_lost_by, '小艾');
  assert.equal(leadInfo(store, config, old.id), null);
  reopenLead(store, lost.id);
  assert.equal(leadInfo(store, config, lost.id).status, 'stale');
});

test('成交分析：總數、成交率、原因、品牌、建議、待追蹤', () => {
  const { store, a, b, lost } = setup();
  markLost(store, lost.id, { reason: '價格考量' }, 'x');
  const f = buildFunnel(store, config, { from: addDays(T, -30), to: T, granularity: 'week' });
  assert.deepEqual([f.totals.leads, f.totals.won, f.totals.lost, f.totals.stale, f.totals.open], [5, 1, 1, 1, 2]);
  assert.equal(Math.round(f.totals.rate * 100), 20);
  assert.equal(f.totals.revenue, 1500);
  assert.equal(f.totals.avgDaysToWin, 2);
  assert.deepEqual(f.reasons.map((r) => [r.reason, r.count]), [['價格考量', 1], [UNMARKED, 1]]);
  assert.ok(f.reasons[0].suggestion.includes('報價'));
  assert.deepEqual(f.byBrand.map((x) => [x.brand_id, x.leads, x.won]), [[a.id, 3, 1], [b.id, 2, 0]]);
  assert.equal(f.series.reduce((s, x) => s + x.leads, 0), 5);
  assert.ok(f.insights[0].includes('5 位新詢問'));
  assert.ok(f.insights.some((x) => x.includes('價格考量')));
  assert.ok(f.insights.some((x) => x.includes('沒標記原因')));
  assert.deepEqual(f.followUp.map((x) => x.status).sort(), ['open', 'open', 'stale']);
  assert.equal(buildFunnel(store, config, { from: addDays(T, -30), to: T, brandId: b.id }).totals.leads, 2);
});

test('今日關懷：詢問 2 天以上未成交會提醒追蹤；標記未成交或延後後就不再出現', () => {
  const { store, open, fresh, stale, lost } = setup();
  const codes = (id) => buildFocusList(store, config).items.find((i) => i.customer.id === id)?.reasons.map((r) => r.code) ?? [];
  assert.ok(codes(open.id).includes('lead_follow'));
  assert.ok(codes(stale.id).includes('lead_follow'));
  assert.ok(!codes(fresh.id).includes('lead_follow'), '今天才問的還不用追');
  markLost(store, lost.id, { reason: '選擇其他業者' }, 'x');
  assert.ok(!codes(lost.id).includes('lead_follow'));
  store.updateCustomer(open.id, { next_contact_date: addDays(T, 3) });
  assert.ok(!codes(open.id).includes('lead_follow'));
});
