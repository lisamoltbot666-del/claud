import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { listBackups, runBackup, signV4 } from '../src/backup.js';
import { getConfig } from '../src/config.js';
import { addDays, today } from '../src/dates.js';
import { openDb } from '../src/db.js';
import { saveDriver, assignDriver } from '../src/dispatch.js';
import { buildDriverStats } from '../src/driverstats.js';
import { buildFocusList } from '../src/focus.js';
import { templates, brandInfo } from '../src/reminders.js';
import { buildResponse, businessMinutes } from '../src/response.js';
import { ANON_NAME, applyRetention, findExpired, setRetentionYears } from '../src/retention.js';
import { createApp } from '../src/server.js';
import { buildTargets, setTarget } from '../src/targets.js';

const config = getConfig({ TZ_NAME: 'Asia/Taipei', ADMIN_PASSWORD: 'pw', BASIC_AUTH: 'true' });
const T = today('Asia/Taipei');
const silent = { log() {}, warn() {}, error() {} };
// 台灣時間 → ISO
const tw = (date, hhmm) => new Date(`${date}T${hhmm}:00+08:00`).toISOString();

test('營業時間內的等待分鐘數（跨夜不算）', () => {
  assert.equal(businessMinutes(tw('2026-10-14', '10:00'), tw('2026-10-14', '10:30'), 'Asia/Taipei'), 30);
  assert.equal(businessMinutes(tw('2026-10-14', '22:00'), tw('2026-10-15', '09:30'), 'Asia/Taipei'), 30);
  assert.equal(businessMinutes(tw('2026-10-14', '20:00'), tw('2026-10-15', '10:00'), 'Asia/Taipei'), 120);
  assert.equal(businessMinutes(tw('2026-10-14', '20:00'), tw('2026-10-15', '10:00'), 'Asia/Taipei', [0, 24]), 840);
});

test('客服回覆速度：後台回覆或按已回覆是精確時間；客人隔 10 分鐘以上再傳訊息推定客服回覆過（估計）', () => {
  const store = openDb(':memory:');
  const a = store.createBrand({ slug: 'a', name: '享運' });
  const cust = (uid) => store.upsertLineCustomer(a.id, uid, { displayName: uid });
  const [c1, c2, c3, c4, c5] = ['U1', 'U2', 'U3', 'U4', 'U5'].map(cust);
  const msg = (c, dir, at, staff = null) => store.run('INSERT INTO messages (customer_id, direction, text, created_at, staff_name) VALUES (?, ?, ?, ?, ?)', c.id, dir, 'x', at, staff);
  const d = '2026-10-14';
  msg(c1, 'in', tw(d, '10:00'));
  msg(c1, 'in', tw(d, '10:05')); // 同一串，不算回覆
  msg(c1, 'out', tw(d, '10:10'), '系統自動'); // 自動訊息不算
  msg(c1, 'out', tw(d, '10:20'), '小艾'); // 精確 20 分鐘
  msg(c2, 'in', tw(d, '11:00'));
  store.run("INSERT INTO activity (at, user_name, action, customer_id) VALUES (?, '阿德', '標記已回覆', ?)", tw(d, '14:00'), c2.id); // 精確 180 分鐘
  msg(c3, 'in', tw(d, '12:00')); // 客人沒再傳 → 無法判斷
  msg(c4, 'in', tw(d, '13:00'));
  msg(c4, 'in', tw(d, '13:30')); // 估計 30 分鐘；13:30 這則之後無法判斷
  msg(c5, 'in', tw(d, '10:00'));
  msg(c5, 'in', tw('2026-10-15', '15:00')); // 隔天才回話，估計太長 → 不計
  const r = buildResponse(store, config, { from: d, to: d });
  assert.equal(r.totals.answered, 3);
  assert.equal(r.totals.exact, 2);
  assert.equal(r.totals.estimated, 1);
  assert.equal(r.totals.unknown, 3);
  assert.equal(r.totals.median, 30);
  assert.equal(Math.round(r.totals.within1h * 100), 67);
  const amy = r.byStaff.find((s) => s.name === '小艾');
  assert.equal(amy.replies, 1);
  assert.equal(amy.median, 20);
  assert.equal(amy.messages, 1);
  assert.equal(amy.leads, 1, 'U1 是小艾負責的新詢問');
  assert.equal(r.byStaff.find((s) => s.name === '阿德').median, 180);
  assert.ok(!r.byStaff.some((s) => s.name === '系統自動'));
  assert.ok(r.insights[0].includes('1 次是依對話節奏估計'));
});

test('營收目標：沿用上個月、進度、月底預估', () => {
  const store = openDb(':memory:');
  const a = store.createBrand({ slug: 'a', name: '享運' });
  const b = store.createBrand({ slug: 'b', name: '首席' });
  const c = store.createCustomer(a.id, { display_name: '客' });
  setTarget(store, { brandId: a.id, month: '2026-09', amount: '100,000' });
  assert.throws(() => setTarget(store, { brandId: a.id, month: '2026-9', amount: 1 }), /月份/);
  assert.throws(() => setTarget(store, { brandId: a.id, month: '2026-10', amount: -5 }), /0 以上/);
  const o = (date, amount, status = 'completed') => store.createOrder(c.id, { order_date: date, service_date: date, amount, status });
  o('2026-10-01', 20000);
  o('2026-10-05', 10000);
  o('2026-10-25', 15000, 'paid'); // 已排定的後續訂單
  o('2026-10-28', 5000, 'pending_payment');
  const r = buildTargets(store, config, { now: new Date(tw('2026-10-10', '12:00')) });
  const x = r.brands.find((y) => y.brand_id === a.id);
  assert.equal(r.elapsed, 10);
  assert.equal(x.target, 100000);
  assert.equal(x.targetFrom, '2026-09');
  assert.equal(x.achieved, 45000, '已付款的都算達成（含之後的用車日）');
  assert.equal(x.booked, 20000);
  // 已發生 30000，每天 3000 × 剩 21 天 = 63000 > 已排定 20000
  assert.equal(x.projection, 93000);
  assert.equal(Math.round(x.projectedRate * 100), 93);
  assert.equal(x.perDayNeeded, Math.ceil(55000 / 21));
  assert.equal(r.brands.find((y) => y.brand_id === b.id).target, null);
  assert.equal(r.total.target, 100000);
  // 過去的月份：預估＝實際
  assert.equal(buildTargets(store, config, { month: '2026-10', now: new Date(tw('2026-11-03', '12:00')) }).brands[0].projection, 45000);
});

test('服務後的感謝與評價邀請、30 天回購邀請', () => {
  const store = openDb(':memory:');
  const a = store.updateBrand(store.createBrand({ slug: 'a', name: '享運' }).id, { review_url: 'https://g.page/r/abc', rebook_offer: '回頭客 9 折' });
  assert.throws(() => store.updateBrand(a.id, { review_url: 'javascript:alert(1)' }), /https/);
  const c = store.upsertLineCustomer(a.id, 'U1', { displayName: '小美' });
  const yesterday = store.createOrder(c.id, { order_date: addDays(T, -5), service_date: addDays(T, -1), service_type: 'airport', amount: 1000, status: 'completed' });
  const codes = () => buildFocusList(store, config).items.flatMap((i) => i.reasons.map((r) => r.code));
  assert.ok(codes().includes('thanks'));
  store.logReminder({ customerId: c.id, orderId: yesterday.id, kind: 'thanks', text: 'x' });
  assert.ok(!codes().includes('thanks'), '傳過就不再提醒');

  const c2 = store.upsertLineCustomer(a.id, 'U2', { displayName: '阿明' });
  const old = store.createOrder(c2.id, { order_date: addDays(T, -40), service_date: addDays(T, -config.rebookDays - 2), service_type: 'charter', amount: 5000, status: 'completed' });
  const item = () => buildFocusList(store, config).items.find((i) => i.customer.id === c2.id);
  assert.equal(item().reasons.find((r) => r.code === 'rebook').orderId, old.id);
  // 已經再訂了 → 不提醒
  const again = store.createOrder(c2.id, { order_date: T, service_date: addDays(T, 10), amount: 5000, status: 'paid' });
  assert.ok(!item()?.reasons.some((r) => r.code === 'rebook'));
  store.updateOrder(again.id, { status: 'cancelled' });
  assert.ok(item().reasons.some((r) => r.code === 'rebook'));

  const info = brandInfo(store.getBrand(a.id), config);
  const thanks = templates.thanks(c, yesterday, info);
  assert.match(thanks, /機場接送/);
  assert.match(thanks, /https:\/\/g\.page\/r\/abc/);
  assert.match(templates.rebook(c2, old, info), /回頭客專屬：回頭客 9 折/);
  assert.doesNotMatch(templates.rebook(c2, old, brandInfo({ name: 'x' }, config)), /專屬/);
});

test('司機與車輛統計：趟數、星期幾、最滿的日子、行程超過司機人數', () => {
  const store = openDb(':memory:');
  const a = store.createBrand({ slug: 'a', name: '享運' });
  const c = store.createCustomer(a.id, { display_name: '客' });
  const d1 = saveDriver(store, null, { name: '王大明', plate: 'ABC-1234' });
  const d2 = saveDriver(store, null, { name: '李小龍', plate: 'XYZ-9' });
  const trip = (date, driver, amount = 1000) => {
    const o = store.createOrder(c.id, { order_date: date, service_date: date, amount, status: 'paid' });
    if (driver) assignDriver(store, o.id, driver.id);
    return o;
  };
  // 2026-10-03 是星期六：3 趟（超過 2 位司機）
  trip('2026-10-03', d1); trip('2026-10-03', d2); trip('2026-10-03', null);
  trip('2026-10-05', d1); trip('2026-10-06', d1);
  const r = buildDriverStats(store, { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(r.totals.trips, 5);
  assert.equal(r.totals.unassigned, 1);
  assert.equal(r.totals.activeDrivers, 2);
  assert.deepEqual(r.byDriver.map((d) => [d.name, d.trips, d.days]), [['王大明', 3, 3], ['李小龍', 1, 1]]);
  assert.equal(r.busiestDays[0].date, '2026-10-03');
  assert.equal(r.busiestDays[0].drivers, 2);
  assert.equal(r.weekdays.find((w) => w.day === '六').trips, 3);
  assert.ok(r.insights.some((x) => x.includes('超過在職司機人數')));
  assert.ok(r.insights.some((x) => x.includes('星期六最忙')));
});

test('自動備份：壓縮備份可還原、只保留最近幾份、上傳雲端（簽章）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-bk-'));
  try {
    const store = openDb(path.join(dir, 'crm.db'));
    store.createBrand({ slug: 'a', name: '享運' });
    const cfg = getConfig({ TZ_NAME: 'Asia/Taipei', DB_PATH: path.join(dir, 'crm.db'), BACKUP_KEEP: '2' });
    for (const day of ['2026-10-01', '2026-10-02', '2026-10-03']) await runBackup(store, cfg, { now: new Date(tw(day, '09:00')), logger: silent });
    assert.deepEqual(listBackups(cfg).map((f) => f.name), ['crm-2026-10-03.db.gz', 'crm-2026-10-02.db.gz']);
    // 同一天再備份一次不會覆蓋
    await runBackup(store, cfg, { now: new Date(tw('2026-10-03', '15:30')), logger: silent });
    assert.equal(listBackups(cfg)[0].name, 'crm-2026-10-03-153000.db.gz');
    // 解壓縮後是完整的資料庫
    const restored = path.join(dir, 'restored.db');
    fs.writeFileSync(restored, zlib.gunzipSync(fs.readFileSync(path.join(dir, 'backups', 'crm-2026-10-03.db.gz'))));
    const db = new DatabaseSync(restored);
    assert.equal(db.prepare('SELECT name FROM brands').get().name, '享運');
    db.close();

    const s3 = getConfig({ TZ_NAME: 'Asia/Taipei', DB_PATH: path.join(dir, 'crm.db'), BACKUP_S3_ENDPOINT: 'https://acc.r2.cloudflarestorage.com', BACKUP_S3_BUCKET: 'bk', BACKUP_S3_ACCESS_KEY_ID: 'AK', BACKUP_S3_SECRET_ACCESS_KEY: 'SK' });
    const calls = [];
    const r = await runBackup(store, s3, { now: new Date(tw('2026-10-04', '09:00')), logger: silent, fetchImpl: async (url, opts) => { calls.push({ url, opts }); return { ok: true, text: async () => '' }; } });
    assert.equal(r.remote, 'crm-backups/crm-2026-10-04.db.gz');
    assert.equal(calls[0].url, 'https://acc.r2.cloudflarestorage.com/bk/crm-backups/crm-2026-10-04.db.gz');
    assert.equal(calls[0].opts.method, 'PUT');
    assert.match(calls[0].opts.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    const fail = await runBackup(store, s3, { now: new Date(tw('2026-10-05', '09:00')), logger: silent, fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'denied' }) });
    assert.match(fail.remoteError, /403/);
    assert.ok(listBackups(s3).some((f) => f.name === 'crm-2026-10-05.db.gz'), '雲端失敗時硬碟備份仍在');
    store.db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AWS Signature V4 與官方範例一致', () => {
  const h = signV4({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { Range: 'bytes=0-9' }, payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', date: new Date('2013-05-24T00:00:00Z') });
  assert.match(h.authorization, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
});

test('個資保存：超過年限無互動才匿名化；有進行中訂單、客服不動；訂單金額保留', () => {
  const store = openDb(':memory:');
  const a = store.createBrand({ slug: 'a', name: '享運' });
  const longAgo = new Date(Date.now() - 4 * 365 * 86400000).toISOString();
  const mk = (uid) => {
    const c = store.updateCustomer(store.upsertLineCustomer(a.id, uid, { displayName: uid }).id, { real_name: `${uid} 本名`, phone: '0912', note: '喜歡靠窗' });
    store.run('UPDATE customers SET created_at = ?, last_inbound_at = ? WHERE id = ?', longAgo, longAgo, c.id);
    store.run("INSERT INTO messages (customer_id, direction, text, created_at) VALUES (?, 'in', '我的電話 0912', ?)", c.id, longAgo);
    return c;
  };
  const gone = mk('gone');
  const oldOrder = store.createOrder(gone.id, { order_date: addDays(T, -1500), service_date: addDays(T, -1500), amount: 3000, status: 'completed', pickup: '我家', flight_no: 'BR1' });
  const recent = mk('recent');
  store.createOrder(recent.id, { order_date: addDays(T, -100), amount: 1000, status: 'completed' });
  const booked = mk('booked');
  store.createOrder(booked.id, { order_date: addDays(T, -1500), service_date: addDays(T, 30), amount: 1000, status: 'paid' });
  const staff = mk('staff');
  store.setStaff(staff.id, true);
  const talked = mk('talked');
  store.addMessage(talked.id, 'in', '最近好嗎');

  assert.equal(applyRetention(store, config), 0, '預設關閉');
  assert.throws(() => setRetentionYears(store, 1.5), /年/);
  setRetentionYears(store, 3);
  assert.deepEqual(findExpired(store, config, 3).map((c) => c.id), [gone.id]);
  assert.equal(applyRetention(store, config), 1);
  const g = store.getCustomer(gone.id);
  assert.equal(g.display_name, ANON_NAME);
  assert.equal(g.real_name, null);
  assert.equal(g.phone, null);
  assert.equal(g.line_user_id, null);
  assert.equal(g.note, null);
  assert.ok(g.anonymized_at);
  assert.equal(store.listMessages(gone.id).length, 0);
  const o = store.getOrder(oldOrder.id);
  assert.equal(o.amount, 3000);
  assert.equal(o.pickup, null);
  assert.equal(store.getCustomer(recent.id).real_name, 'recent 本名');
  assert.equal(findExpired(store, config, 3).length, 0, '已匿名化的不再列入');
  assert.match(store.listActivity()[0].action, /個資保存/);
  assert.ok(!buildFocusList(store, config).items.some((i) => i.customer.id === gone.id), '匿名化的客戶不再出現在關懷清單');
});

test('API：目標、回覆速度、司機統計、備份、個資保存都限管理員', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-api-'));
  const store = openDb(':memory:');
  const a = store.createBrand({ slug: 'a', name: '享運' });
  const cfg = getConfig({ TZ_NAME: 'Asia/Taipei', ADMIN_PASSWORD: 'pw', BASIC_AUTH: 'true', BACKUP_DIR: dir });
  const server = http.createServer(createApp({ store, config: cfg, logger: silent }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const hdr = (u, p) => ({ Authorization: `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`, 'Content-Type': 'application/json' });
  const call = async (p, method = 'GET', body, h = hdr('admin', 'pw')) => { const r = await fetch(base + p, { method, headers: h, body: body && JSON.stringify(body) }); return { status: r.status, data: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.arrayBuffer() }; };
  try {
    const put = await call('/api/targets', 'PUT', { brandId: a.id, month: T.slice(0, 7), amount: 50000 });
    assert.equal(put.status, 200, JSON.stringify(put.data));
    assert.equal((await call('/api/targets')).data.brands[0].target, 50000);
    assert.equal((await call('/api/response')).status, 200);
    assert.equal((await call('/api/driver-stats')).status, 200);
    const bk = await call('/api/backups/run', 'POST');
    assert.equal(bk.status, 200);
    const list = (await call('/api/backups')).data;
    assert.equal(list.files.length, 1);
    assert.equal(list.remote, null);
    const file = await call(`/api/backups/file/${list.files[0].name}`);
    assert.equal(file.status, 200);
    assert.ok(zlib.gunzipSync(Buffer.from(file.data)).length > 0);
    assert.equal((await call('/api/backups/file/..%2Fcrm.db')).status, 404);
    assert.equal((await call('/api/retention/run', 'POST')).status, 400);
    assert.equal((await call('/api/retention', 'PUT', { years: 3 })).data.years, 3);
    assert.equal((await call('/api/retention')).data.count, 0);
    // 客服帳號
    await call('/api/users', 'POST', { username: 'amy', display_name: 'Amy', password: 'password1' });
    for (const [p, m] of [['/api/targets', 'GET'], ['/api/response', 'GET'], ['/api/driver-stats', 'GET'], ['/api/backups', 'GET'], ['/api/backups/run', 'POST'], [`/api/backups/file/${list.files[0].name}`, 'GET'], ['/api/retention', 'GET'], ['/api/retention/run', 'POST']]) {
      assert.equal((await call(p, m, undefined, hdr('amy', 'password1'))).status, 403, p);
    }
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
