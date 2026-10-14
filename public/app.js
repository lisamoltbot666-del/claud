const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('zh-TW', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
const money = (n) => `NT$${Number(n || 0).toLocaleString()}`;
const nameOf = (c) => c.real_name || c.display_name || `客戶#${c.id}`;
const PRIORITY = { 1: '緊急', 2: '今日', 3: '有空時' };
const KIND_LABEL = { payment: '匯款提醒', reorder: '回訪邀請', trip: '行程確認', care: '關心問候', birthday: '生日祝福', custom: '訊息' };
const SEGMENTS = { none: '尚未下單', first: '首次客', repeat: '回頭客', loyal: '忠實客', dormant: '沉睡客' };
const reorderIn = (st) => {
  if (st.nextReorderDate == null) return '';
  const d = st.daysUntilReorder;
  return d < 0 ? `<span class="due">已過 ${-d} 天</span>` : d === 0 ? '<span class="due">今天</span>' : d <= 7 ? `<span class="soon">${d} 天後</span>` : `${d} 天後`;
};
const historyLine = (st) => (st?.orderCount
  ? `${SEGMENTS[st.segment]}｜訂單 ${st.orderCount} 筆｜累積 ${money(st.totalSpent)}｜客單價 ${money(st.avgOrder)}｜最近用車 ${esc(st.lastOrderDate)}${lastService(st) ? `「${esc(lastService(st))}」` : ''}`
  : '尚無消費紀錄');
const lastService = (st) => [SERVICES[st.lastOrder?.service_type], st.lastItems].filter(Boolean).join(' ');
// 「10-14 05:30 機場接送」＋航班、地點
const tripWhen = (o) => [o.service_date, o.service_time].filter(Boolean).join(' ');
const tripRoute = (o) => [o.flight_no ? `✈ ${o.flight_no}` : '', [o.pickup, o.dropoff].filter(Boolean).join(' → '), o.return_date ? `至 ${o.return_date}` : ''].filter(Boolean).map(esc).join('｜');
let STATUSES = {};
let SERVICES = {};
let TODAY = '';
let BRANDS = [];
let currentCustomerId = null;

// ---------- 品牌 ----------
const prefs = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
let currentBrand = prefs.get('brand') || '';
const brandOf = (id) => BRANDS.find((b) => b.id === Number(id));
const brandQs = () => (currentBrand ? `brand=${currentBrand}` : '');
const brandTag = (id) => {
  const b = brandOf(id);
  return b ? `<span class="brand-tag" style="background:${esc(b.color)}">${esc(b.name)}</span>` : '';
};

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `錯誤 ${res.status}`);
  return data;
}

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = isError ? 'error' : '';
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 3500);
}

async function guard(fn) {
  try { await fn(); } catch (e) { toast(e.message, true); }
}

// ---------- tabs ----------
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(tab) {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  for (const t of ['focus', 'repurchase', 'customers', 'orders', 'brands']) $(`#tab-${t}`).hidden = t !== tab;
  guard(LOADERS[tab]);
}

// ---------- status ----------
async function loadStatus() {
  const s = await api('/api/status');
  STATUSES = s.orderStatuses;
  SERVICES = s.serviceTypes;
  TODAY = s.today;
  BRANDS = s.brands;
  if (currentBrand && !brandOf(currentBrand)) currentBrand = '';
  $('#brand-switch').innerHTML = `<option value="">全部品牌（${BRANDS.length}）</option>${BRANDS.map((b) => `<option value="${b.id}" ${String(b.id) === String(currentBrand) ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}`;
  updateExportLinks();
  $('#order-status').innerHTML = `<option value="">全部狀態</option>${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}`;
  const missing = BRANDS.filter((b) => !b.has_secret || !b.has_token).length;
  const warn = !BRANDS.length ? '⚠ 尚未建立品牌｜' : missing ? `⚠ ${missing} 個品牌尚未設定 LINE 金鑰｜` : '';
  $('#status').textContent = `${warn}今天 ${s.today}｜每日 ${s.dailyReportHour}:00 推播給 ${s.staffCount} 位客服｜自動匯款提醒：${s.autoPaymentReminder ? '開' : '關'}｜自動行程確認：${s.autoTripReminder ? '開' : '關'}｜自動回訪邀請：${s.autoReorderReminder ? '開' : '關'}`;
}

// ---------- focus ----------
async function loadFocus() {
  const data = await api(`/api/focus?${brandQs()}`);
  $('#focus-title').textContent = `今日關懷清單 ${data.date}（${data.items.length} 位）`;
  const list = $('#focus-list');
  if (!data.items.length) { list.innerHTML = '<div class="card empty">今天沒有需要特別關心的客戶 🎉</div>'; return; }
  list.innerHTML = data.items.map((item) => {
    const c = item.customer;
    const actions = new Set(item.reasons.map((r) => r.action));
    const payOrder = item.reasons.find((r) => r.action === 'payment')?.orderId;
    const verifyOrder = item.reasons.find((r) => r.action === 'verify')?.orderId;
    const tripOrder = item.reasons.find((r) => r.action === 'trip')?.orderId;
    const dispatchOrder = item.reasons.find((r) => r.action === 'dispatch' && r.status === 'paid')?.orderId;
    return `<div class="card focus-item p${item.priority}">
      ${c.picture_url ? `<img class="avatar" src="${esc(c.picture_url)}" alt="">` : '<div class="avatar"></div>'}
      <div>
        ${brandTag(c.brand_id)}<span class="name" data-open="${c.id}">${esc(nameOf(c))}</span>
        ${c.real_name && c.display_name ? `<span class="muted">（LINE：${esc(c.display_name)}）</span>` : ''}
        ${c.tags ? `<span class="muted">｜${esc(c.tags)}</span>` : ''}
        ${item.canPush ? '' : '<span class="badge">非好友，無法推播</span>'}
        <div class="history">${historyLine(item.stats)}${c.phone ? `｜☎ ${esc(c.phone)}` : ''}</div>
        <ul class="reasons">${item.reasons.map((r) => `<li><span class="badge p${r.priority}">${PRIORITY[r.priority]}</span>${esc(r.label)} <span class="muted">${esc(r.detail || '')}${r.remindCount ? `｜已提醒 ${r.remindCount} 次，最近 ${fmtTime(r.lastRemindedAt)}` : ''}</span></li>`).join('')}</ul>
      </div>
      <div class="actions">
        ${verifyOrder ? `<button class="small" data-paid="${verifyOrder}">確認已入帳</button>` : ''}
        ${dispatchOrder ? `<button class="small" data-dispatch="${dispatchOrder}">標記已派車</button>` : ''}
        ${tripOrder && item.canPush ? `<button class="small" data-compose="${c.id}" data-kind="trip" data-order="${tripOrder}">發送行程確認</button>` : ''}
        ${actions.has('payment') && item.canPush ? `<button class="small" data-compose="${c.id}" data-kind="payment" data-order="${payOrder}">發送匯款提醒</button>` : ''}
        ${actions.has('reorder') && item.canPush ? `<button class="small" data-compose="${c.id}" data-kind="reorder">發送回訪邀請</button>` : ''}
        ${actions.has('care') && item.canPush ? `<button class="small" data-compose="${c.id}" data-kind="care">發送關心問候</button>` : ''}
        ${actions.has('birthday') && item.canPush ? `<button class="small" data-compose="${c.id}" data-kind="birthday">發送生日祝福</button>` : ''}
        ${actions.has('reply') ? `<button class="small secondary" data-handled="${c.id}">標記已回覆</button>` : ''}
        ${actions.has('care') || actions.has('reorder') ? `<button class="small secondary" data-postpone="${c.id}">延後 3 天</button>` : ''}
        <button class="small secondary" data-open="${c.id}">查看客戶</button>
      </div>
    </div>`;
  }).join('');
}

$('#refresh-focus').addEventListener('click', () => guard(loadFocus));
$('#run-daily').addEventListener('click', () => guard(async () => {
  if (!confirm('立即執行每日排程？（若有開啟自動提醒，會推播給客戶；並推播清單給客服）')) return;
  const r = await api('/api/run-daily', { method: 'POST' });
  toast(`已通知 ${r.staffNotified} 位客服，自動匯款提醒 ${r.paymentSent} 則、行程確認 ${r.tripSent} 則、回訪邀請 ${r.reorderSent} 則`);
  loadFocus();
}));

// ---------- repurchase ----------
let repurchaseFilter = 'due';
document.querySelectorAll('#repurchase-filter button').forEach((b) => b.addEventListener('click', () => {
  repurchaseFilter = b.dataset.filter;
  document.querySelectorAll('#repurchase-filter button').forEach((x) => x.classList.toggle('active', x === b));
  guard(loadRepurchase);
}));
async function loadRepurchase() {
  const { rows } = await api(`/api/repurchase?filter=${repurchaseFilter}&${brandQs()}`);
  const total = rows.reduce((s, r) => s + r.stats.avgOrder, 0);
  $('#repurchase-summary').textContent = rows.length ? `${rows.length} 位，若都再預約一次約 NT$${total.toLocaleString()}` : '';
  $('#repurchase-table').innerHTML = `<thead><tr><th>客戶</th><th>類型</th><th>訂單數</th><th>累積消費</th><th>客單價</th><th>最近用車</th><th>常用服務</th><th>回訪週期</th><th>預計回訪</th><th>上次邀請</th><th></th></tr></thead>
  <tbody>${rows.length ? rows.map(({ customer: c, stats: st, hasPending, lastReminder }) => `<tr class="clickable" data-open="${c.id}">
    <td>${brandTag(c.brand_id)}${esc(nameOf(c))}${c.phone ? `<div class="muted">${esc(c.phone)}</div>` : ''}</td>
    <td>${SEGMENTS[st.segment]}</td><td>${st.orderCount}</td><td>${money(st.totalSpent)}</td><td>${money(st.avgOrder)}</td>
    <td>${esc(st.lastOrderDate)}<div class="muted">${esc(lastService(st))}</div></td>
    <td>${st.topItems.map((i) => esc(i.name)).join('、')}</td>
    <td>${st.cycle.days} 天<div class="muted">${esc(st.cycle.source)}</div></td>
    <td>${esc(st.nextReorderDate)}<div>${hasPending ? '<span class="muted">有待付款訂單</span>' : reorderIn(st)}</div></td>
    <td class="muted">${lastReminder ? fmtTime(lastReminder.sent_at) : '—'}</td>
    <td>${c.line_user_id && c.is_friend && !hasPending ? `<button class="small" data-compose="${c.id}" data-kind="reorder">回訪邀請</button>` : ''}</td>
  </tr>`).join('') : '<tr><td colspan="11" class="empty">目前沒有符合的客戶</td></tr>'}</tbody>`;
}

// ---------- customers ----------
async function loadCustomers() {
  const q = encodeURIComponent($('#customer-q').value.trim());
  const tag = encodeURIComponent($('#customer-tag').value.trim());
  const rows = await api(`/api/customers?q=${q}&tag=${tag}&${brandQs()}`);
  $('#customer-table').innerHTML = `<thead><tr><th></th><th>名稱</th><th>電話</th><th>標籤</th><th>訂單數</th><th>累積消費</th><th>最後下單</th><th>最後訊息</th><th>好友</th></tr></thead>
  <tbody>${rows.length ? rows.map((c) => `<tr class="clickable" data-open="${c.id}">
    <td>${c.picture_url ? `<img class="avatar" style="width:28px;height:28px" src="${esc(c.picture_url)}" alt="">` : ''}</td>
    <td>${brandTag(c.brand_id)}${esc(nameOf(c))}${c.is_staff ? ' <span class="badge">客服</span>' : ''}${c.real_name && c.display_name ? `<div class="muted">${esc(c.display_name)}</div>` : ''}</td>
    <td>${esc(c.phone)}</td><td>${esc(c.tags)}</td><td>${c.order_count}</td><td>${money(c.total_spent)}</td>
    <td>${esc(c.last_order_date || '')}</td><td>${fmtTime(c.last_inbound_at)}</td><td>${c.is_friend ? '✅' : '—'}</td>
  </tr>`).join('') : '<tr><td colspan="9" class="empty">尚無客戶。客戶加入官方帳號好友或傳訊息後會自動出現在這裡。</td></tr>'}</tbody>`;
}
let searchTimer;
['#customer-q', '#customer-tag'].forEach((s) => $(s).addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => guard(loadCustomers), 250); }));
$('#new-customer').addEventListener('click', () => guard(async () => {
  if (!currentBrand) throw new Error('請先在左上角選擇要新增到哪個品牌');
  const name = prompt(`新增到「${brandOf(currentBrand).name}」的客戶名稱（非 LINE 好友的客戶也可以手動建立）`);
  if (!name) return;
  const c = await api('/api/customers', { method: 'POST', body: { brand_id: currentBrand, display_name: name } });
  loadCustomers();
  openCustomer(c.id);
}));

// ---------- orders ----------
async function loadOrders() {
  let rows = await api(`/api/orders?status=${$('#order-status').value}&${brandQs()}`);
  // 「即將用車」：今天起 7 天內、還沒完成或取消的行程，依用車時間排序，方便排車
  if ($('#order-when').value === 'upcoming') {
    const end = new Date(`${TODAY}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 7);
    const last = end.toISOString().slice(0, 10);
    rows = rows.filter((o) => o.service_date && o.service_date >= TODAY && o.service_date <= last && !['completed', 'cancelled'].includes(o.status))
      .sort((a, b) => tripWhen(a).localeCompare(tripWhen(b)));
  }
  $('#order-table').innerHTML = `<thead><tr><th>#</th><th>用車</th><th>客戶</th><th>服務</th><th>行程</th><th>金額</th><th>狀態</th><th>匯款期限</th><th>匯款回報</th></tr></thead>
  <tbody>${rows.length ? rows.map((o) => `<tr class="clickable" data-open="${o.customer_id}">
    <td>${o.id}</td><td>${esc(tripWhen(o)) || `<span class="muted">下單 ${esc(o.order_date)}</span>`}</td><td>${brandTag(o.brand_id)}${esc(o.real_name || o.display_name)}</td>
    <td>${esc(SERVICES[o.service_type] || '')}<div class="muted">${esc(o.items)}</div></td><td class="muted">${tripRoute(o)}</td><td>${money(o.amount)}</td>
    <td>${esc(STATUSES[o.status])}</td><td>${o.status === 'pending_payment' ? esc(o.payment_due_date || '') : ''}</td><td>${esc(o.payment_report || '')}</td>
  </tr>`).join('') : '<tr><td colspan="9" class="empty">沒有訂單</td></tr>'}</tbody>`;
}
$('#order-status').addEventListener('change', () => guard(loadOrders));
$('#order-when').addEventListener('change', () => guard(loadOrders));

// ---------- customer drawer ----------
async function openCustomer(id, compose = null) {
  currentCustomerId = id;
  const { customer: c, brand, stats: st, orders, messages, reminders } = await api(`/api/customers/${id}`);
  const canPush = c.line_user_id && c.is_friend;
  const pendingOrders = orders.filter((o) => o.status === 'pending_payment');
  const upcomingTrips = orders.filter((o) => o.service_date && o.service_date >= TODAY && ['pending_payment', 'paid', 'shipped'].includes(o.status));
  const field = (key, label, type = 'text', wide = false) => `<label class="${wide ? 'wide' : ''}">${label}${type === 'textarea' ? `<textarea name="${key}">${esc(c[key])}</textarea>` : `<input name="${key}" type="${type}" value="${esc(c[key])}">`}</label>`;

  $('#drawer-body').innerHTML = `
    <div class="row">
      ${c.picture_url ? `<img class="avatar" src="${esc(c.picture_url)}" alt="">` : ''}
      <div><h2>${brandTag(c.brand_id)}${esc(nameOf(c))}${c.is_staff ? ' <span class="badge">客服</span>' : ''}</h2><div class="muted">${esc(brand?.name || '')} 官方帳號｜${c.line_user_id ? `LINE userId：${esc(c.line_user_id)}` : '手動建立（非 LINE 好友）'}｜${c.is_friend ? '好友' : '非好友／已封鎖'}｜加入 ${fmtTime(c.followed_at || c.created_at)}</div></div>
      <span class="spacer"></span>
      ${canPush ? `<button class="secondary small" id="toggle-staff" title="每天由「${esc(brand?.name || '')}」的官方帳號把關懷清單推播給這位">${c.is_staff ? '取消客服' : '設為客服'}</button>` : ''}
      <button class="secondary" id="close-drawer">關閉</button>
    </div>

    <h3>消費總覽</h3>
    <div class="tiles">
      <div class="tile"><div class="label">客戶類型</div><div class="value">${SEGMENTS[st.segment]}</div><div class="sub">再次預約 ${st.repeatCount} 次</div></div>
      <div class="tile"><div class="label">訂單數</div><div class="value">${st.orderCount}</div><div class="sub">已付款 ${st.paidCount} 筆</div></div>
      <div class="tile"><div class="label">累積消費</div><div class="value">${money(st.totalSpent)}</div><div class="sub">${st.pendingAmount ? `待付款 ${money(st.pendingAmount)}` : '&nbsp;'}</div></div>
      <div class="tile"><div class="label">平均客單價</div><div class="value">${money(st.avgOrder)}</div><div class="sub">&nbsp;</div></div>
      <div class="tile"><div class="label">首次 / 最近用車</div><div class="value" style="font-size:14px">${esc(st.firstOrderDate || '—')}<br>${esc(st.lastOrderDate || '—')}</div><div class="sub">${st.daysSinceLastOrder != null ? `距今 ${st.daysSinceLastOrder} 天` : ''}</div></div>
      <div class="tile"><div class="label">回訪週期</div><div class="value">${st.cycle ? `${st.cycle.days} 天` : '—'}</div><div class="sub">${esc(st.cycle?.source || '')}</div></div>
      <div class="tile"><div class="label">預計回訪日</div><div class="value" style="font-size:14px">${esc(st.nextReorderDate || '—')}</div><div class="sub">${reorderIn(st)}</div></div>
      <div class="tile"><div class="label">常用服務</div><div class="value" style="font-size:14px">${st.topItems.map((i) => `${esc(i.name)} <span class="muted">×${i.count}</span>`).join('<br>') || '—'}</div></div>
    </div>

    <h3>基本資料</h3>
    <form id="customer-form" class="grid">
      ${field('display_name', 'LINE 名稱')}${field('real_name', '真實姓名')}${field('phone', '電話', 'tel')}
      ${field('email', 'Email', 'email')}${field('birthday', '生日', 'date')}
      <label>性別<select name="gender">${['', '女', '男', '其他'].map((g) => `<option value="${g}" ${g === (c.gender || '') ? 'selected' : ''}>${g || '—'}</option>`).join('')}</select></label>
      ${field('tags', '標籤（逗號分隔，如 VIP,團購）')}${field('reorder_days', '回訪週期（天，空白自動推算）', 'number')}${field('next_contact_date', '下次聯絡日', 'date')}
      ${field('address', '地址', 'text', true)}${field('note', '備註（喜好、注意事項…）', 'textarea', true)}
      <div class="row wide" style="grid-column:1/-1"><button type="submit">儲存資料</button><span class="spacer"></span><button type="button" class="danger small" id="delete-customer">刪除客戶</button></div>
    </form>

    <h3>訂單紀錄（${orders.length} 筆）</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>#</th><th>用車</th><th>服務 / 行程</th><th>金額</th><th>狀態</th><th>匯款期限 / 回報</th><th></th></tr></thead>
      <tbody>${orders.map((o) => `<tr>
        <td>${o.id}</td><td>${esc(tripWhen(o)) || '—'}<div class="muted">下單 ${esc(o.order_date)}</div></td>
        <td>${esc([SERVICES[o.service_type], o.items].filter(Boolean).join(' '))}<div class="muted">${tripRoute(o)}</div></td><td>${money(o.amount)}</td>
        <td><select data-order-status="${o.id}">${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}" ${k === o.status ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
        <td>${o.status === 'pending_payment' ? `${esc(o.payment_due_date || '')}${o.payment_report ? `<div class="muted">回報：${esc(o.payment_report)}</div>` : ''}` : `<span class="muted">${o.paid_at ? `入帳 ${fmtTime(o.paid_at)}` : ''}</span>`}</td>
        <td>${o.status === 'pending_payment' ? `<button class="small" data-paid="${o.id}">確認入帳</button>` : ''} <button class="small secondary" data-edit-order="${o.id}">編輯</button> <button class="small secondary" data-del-order="${o.id}">刪除</button></td>
      </tr>`).join('') || '<tr><td colspan="7" class="empty">尚無訂單</td></tr>'}</tbody>
    </table></div>
    <form id="order-form" class="grid order-form" style="margin-top:8px">
      <input type="hidden" name="id">
      <label>服務<select name="service_type"><option value="">—</option>${Object.entries(SERVICES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <label>用車 / 取車日<input name="service_date" type="date"></label>
      <label>時間<input name="service_time" type="time"></label>
      <label>航班<input name="flight_no" placeholder="如：BR198"></label>
      <label class="wide">上車 / 取車地點<input name="pickup"></label>
      <label class="wide">目的地 / 還車地點<input name="dropoff"></label>
      <label>結束 / 還車日<input name="return_date" type="date"></label>
      <label>內容<input name="items" placeholder="如：7 人座、Toyota Altis"></label>
      <label>金額<input name="amount" type="number" required></label>
      <label>下單日<input name="order_date" type="date" title="預設今天"></label>
      <label>狀態<select name="status">${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <div class="row" style="grid-column:1/-1"><button type="submit" id="order-submit">新增訂單</button><button type="button" class="secondary" id="order-cancel" hidden>取消編輯</button></div>
    </form>

    <h3>發送 LINE 訊息 ${canPush ? '' : '<span class="badge">非好友，無法推播</span>'}</h3>
    <div class="row" style="margin-bottom:6px">
      ${pendingOrders.map((o) => `<button class="small secondary" data-template="payment" data-order="${o.id}">匯款提醒 #${o.id}</button>`).join('')}
      ${upcomingTrips.map((o) => `<button class="small secondary" data-template="trip" data-order="${o.id}">行程確認 #${o.id}</button>`).join('')}
      <button class="small secondary" data-template="reorder">回訪邀請</button>
      <button class="small secondary" data-template="care">關心問候</button>
      <button class="small secondary" data-template="birthday">生日祝福</button>
    </div>
    <form id="send-form">
      <textarea name="text" placeholder="輸入訊息，或點上方按鈕套用範本"></textarea>
      <input type="hidden" name="kind" value="custom"><input type="hidden" name="orderId" value="">
      <div class="row" style="margin-top:6px"><button type="submit" ${canPush ? '' : 'disabled'}>推播給客戶</button><button type="button" class="secondary" id="mark-handled">標記已回覆（不發訊息）</button><span class="muted">推播會使用官方帳號訊息額度</span></div>
    </form>

    <h3>對話紀錄</h3>
    <div class="chat" id="chat">${messages.map((m) => `<div class="bubble ${m.direction}">${esc(m.text)}<time>${fmtTime(m.created_at)}</time></div>`).join('') || '<div class="muted">尚無訊息</div>'}</div>

    <h3>提醒紀錄</h3>
    <div class="muted">${reminders.map((r) => `${fmtTime(r.sent_at)} ${KIND_LABEL[r.kind] || r.kind}${r.auto ? '（自動）' : ''}${r.ok ? '' : ` ❌ ${esc(r.error)}`}`).join('<br>') || '尚無'}</div>
  `;
  const dlg = $('#drawer');
  if (!dlg.open) dlg.showModal();
  const chat = $('#chat');
  chat.scrollTop = chat.scrollHeight;

  $('#close-drawer').onclick = () => dlg.close();
  if ($('#toggle-staff')) $('#toggle-staff').onclick = () => guard(async () => {
    await api(`/api/customers/${id}/staff`, { method: 'POST', body: { staff: !c.is_staff } });
    toast(c.is_staff ? '已取消客服' : '已設為客服，每天會收到關懷清單');
    loadStatus();
    openCustomer(id);
  });
  $('#customer-form').onsubmit = (e) => { e.preventDefault(); guard(async () => {
    await api(`/api/customers/${id}`, { method: 'PATCH', body: Object.fromEntries(new FormData(e.target)) });
    toast('已儲存'); openCustomer(id);
  }); };
  $('#delete-customer').onclick = () => guard(async () => {
    if (!confirm(`確定刪除「${nameOf(c)}」及其所有訂單、訊息紀錄？`)) return;
    await api(`/api/customers/${id}`, { method: 'DELETE' });
    dlg.close();
  });
  const orderForm = $('#order-form');
  orderForm.onsubmit = (e) => { e.preventDefault(); guard(async () => {
    const { id: orderId, ...fields } = Object.fromEntries(new FormData(e.target));
    if (orderId) {
      if (!fields.order_date) delete fields.order_date;
      await api(`/api/orders/${orderId}`, { method: 'PATCH', body: fields });
    } else {
      await api('/api/orders', { method: 'POST', body: { customer_id: id, ...fields } });
    }
    toast(orderId ? '已更新訂單' : '已新增訂單'); openCustomer(id);
  }); };
  // 編輯：把訂單內容帶進下方表單（航班、時間異動時用）
  document.querySelectorAll('[data-edit-order]').forEach((b) => b.onclick = () => {
    const o = orders.find((x) => x.id === Number(b.dataset.editOrder));
    for (const el of orderForm.elements) if (el.name) el.value = o[el.name] ?? '';
    $('#order-submit').textContent = `儲存訂單 #${o.id}`;
    $('#order-cancel').hidden = false;
    orderForm.scrollIntoView({ block: 'center' });
  });
  $('#order-cancel').onclick = () => openCustomer(id);
  document.querySelectorAll('[data-order-status]').forEach((sel) => sel.onchange = () => guard(async () => {
    await api(`/api/orders/${sel.dataset.orderStatus}`, { method: 'PATCH', body: { status: sel.value } });
    toast('已更新訂單狀態'); openCustomer(id);
  }));
  document.querySelectorAll('[data-del-order]').forEach((b) => b.onclick = () => guard(async () => {
    if (!confirm('確定刪除這筆訂單？')) return;
    await api(`/api/orders/${b.dataset.delOrder}`, { method: 'DELETE' });
    openCustomer(id);
  }));
  document.querySelectorAll('[data-template]').forEach((b) => b.onclick = () => guard(() => applyTemplate(id, b.dataset.template, b.dataset.order)));
  $('#send-form').onsubmit = (e) => { e.preventDefault(); guard(async () => {
    const f = Object.fromEntries(new FormData(e.target));
    if (!f.text.trim()) throw new Error('請輸入訊息');
    await api(`/api/customers/${id}/send`, { method: 'POST', body: f });
    toast('已推播'); openCustomer(id);
  }); };
  $('#mark-handled').onclick = () => guard(async () => { await api(`/api/customers/${id}/handled`, { method: 'POST' }); toast('已標記'); });
  if (compose) await applyTemplate(id, compose.kind, compose.orderId);
}

async function applyTemplate(customerId, kind, orderId) {
  const { text } = await api(`/api/customers/${customerId}/preview?kind=${kind}${orderId ? `&orderId=${orderId}` : ''}`);
  const f = $('#send-form');
  f.text.value = text;
  f.kind.value = kind;
  f.orderId.value = orderId || '';
  f.text.focus();
}

async function markPaid(orderId) {
  if (!confirm(`確認訂單 #${orderId} 已入帳？`)) return;
  const notify = confirm('要傳 LINE 訊息通知客戶「已收到款項」嗎？');
  const r = await api(`/api/orders/${orderId}`, { method: 'PATCH', body: { status: 'paid', notify } });
  if (!notify) toast('已確認入帳');
  else toast(r.notified === true ? '已確認入帳並通知客戶' : `已確認入帳（通知失敗：${r.notified}）`, r.notified !== true);
}

// ---------- brands tab ----------
async function loadBrands() {
  const [brands, staff] = await Promise.all([api('/api/brands'), api('/api/customers').then((rows) => rows.filter((c) => c.is_staff))]);
  BRANDS = brands;
  const origin = location.origin;
  $('#brand-list').innerHTML = brands.map((b) => `<div class="card brand-card" style="border-left-color:${esc(b.color)}">
    <div>
      <h2>${brandTag(b.id)} ${esc(b.name)}</h2>
      <div class="muted" style="margin-top:4px">Webhook URL：<code>${esc(origin)}/webhook/${esc(b.slug)}</code></div>
      ${b.forward_url ? `<div class="muted">同時轉送到：<code>${esc(b.forward_url)}</code> ${forwardBadge(b.forward_status)}</div>` : ''}
      <div class="muted">Channel secret：${b.has_secret ? '<span class="ok">已設定</span>' : '<span class="warn">未設定</span>'}｜Access token：${b.has_token ? `<span class="ok">已設定 ${esc(b.token_hint)}</span>` : '<span class="warn">未設定</span>'}${b.bank_info ? `｜匯款資訊：${esc(b.bank_info)}` : ''}</div>
    </div>
    <div class="actions">
      <button class="small secondary" data-edit-brand="${b.id}">編輯</button>
      <button class="small secondary" data-sync-brand="${b.id}" title="僅限認證 / 進階帳號">同步好友</button>
    </div>
    <form class="grid" data-brand-form="${b.id}" hidden>
      ${brandFields(b)}
      <div class="row" style="grid-column:1/-1"><button type="submit">儲存</button><button type="button" class="secondary" data-cancel>取消</button><span class="spacer"></span><button type="button" class="danger small" data-delete-brand="${b.id}">刪除品牌</button></div>
    </form>
  </div>`).join('') || '<div class="card empty">尚未建立品牌，請按右上角「新增品牌」</div>';
  $('#staff-list').innerHTML = staff.length
    ? staff.map((c) => `<div class="row">${brandTag(c.brand_id)}<span class="name" data-open="${c.id}">${esc(nameOf(c))}</span></div>`).join('')
    : '<span class="muted">尚未設定客服</span>';

  document.querySelectorAll('[data-edit-brand]').forEach((btn) => btn.onclick = () => { $(`[data-brand-form="${btn.dataset.editBrand}"]`).hidden = false; });
  document.querySelectorAll('[data-brand-form]').forEach((f) => {
    f.querySelector('[data-cancel]').onclick = () => { f.hidden = true; };
    f.onsubmit = (e) => { e.preventDefault(); guard(async () => {
      await api(`/api/brands/${f.dataset.brandForm}`, { method: 'PATCH', body: Object.fromEntries(new FormData(f)) });
      toast('已儲存'); await loadStatus(); loadBrands();
    }); };
  });
  document.querySelectorAll('[data-delete-brand]').forEach((btn) => btn.onclick = () => guard(async () => {
    if (!confirm('確定刪除這個品牌？（品牌下還有客戶時無法刪除）')) return;
    await api(`/api/brands/${btn.dataset.deleteBrand}`, { method: 'DELETE' });
    await loadStatus(); loadBrands();
  }));
  document.querySelectorAll('[data-sync-brand]').forEach((btn) => btn.onclick = () => guard(async () => {
    toast('同步中…');
    const r = await api(`/api/brands/${btn.dataset.syncBrand}/sync-followers`, { method: 'POST' });
    toast(`好友共 ${r.total} 位，新增 ${r.added} 位`);
  }));
}

function brandFields(b = {}) {
  const f = (key, label, extra = '') => `<label>${label}<input name="${key}" value="${esc(b[key] ?? '')}" ${extra}></label>`;
  return `${f('name', '品牌名稱（會出現在給客戶的訊息）', 'required')}
    ${f('slug', '網址代號（英數字，用於 Webhook）', 'pattern="[a-zA-Z0-9\\-]+" required')}
    <label>代表色<input name="color" type="color" value="${esc(b.color || '#06c755')}"></label>
    <label class="wide">Channel secret<input name="channel_secret" type="password" autocomplete="off" placeholder="${b.has_secret ? '已設定，留空表示不修改' : '請貼上'}"></label>
    <label class="wide">Channel access token（長期）<input name="channel_access_token" type="password" autocomplete="off" placeholder="${b.has_token ? '已設定，留空表示不修改' : '請貼上'}"></label>
    ${f('bank_info', '匯款資訊（會放進匯款提醒）').replace('<label>', '<label class="wide">')}
    ${f('forward_url', '同時轉送到（原本填在 LINE 的 Webhook 網址，舊系統還要用才填；不用請留空）', 'type="url" placeholder="https://…"').replace('<label>', '<label class="wide">')}`;
}

function forwardBadge(st) {
  if (!st) return '<span class="muted">（尚未收到訊息）</span>';
  return st.ok
    ? `<span class="ok">✓ 最近轉送成功 ${fmtTime(st.at)}</span>`
    : `<span class="warn">✗ 最近轉送失敗 ${fmtTime(st.at)}：${esc(st.error)}</span>`;
}

$('#new-brand').addEventListener('click', () => {
  const dlg = $('#drawer');
  $('#drawer-body').innerHTML = `<div class="row"><h2>新增品牌</h2><span class="spacer"></span><button class="secondary" id="close-drawer">關閉</button></div>
    <form id="brand-new" class="grid" style="margin-top:12px">${brandFields()}<div class="row" style="grid-column:1/-1"><button type="submit">建立</button></div></form>`;
  dlg.showModal();
  $('#close-drawer').onclick = () => dlg.close();
  $('#brand-new').onsubmit = (e) => { e.preventDefault(); guard(async () => {
    const b = await api('/api/brands', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    toast(`已建立「${b.name}」，請到 LINE Developers 設定 Webhook`);
    dlg.close();
    await loadStatus();
  }); };
});

function updateExportLinks() {
  $('#export-customers').href = `/api/export/customers.csv?${brandQs()}`;
  $('#export-orders').href = `/api/export/orders.csv?${brandQs()}`;
}

$('#brand-switch').addEventListener('change', (e) => {
  currentBrand = e.target.value;
  prefs.set('brand', currentBrand);
  updateExportLinks();
  refreshCurrentTab();
});

$('#drawer').addEventListener('close', () => { currentCustomerId = null; refreshCurrentTab(); });
function refreshCurrentTab() {
  const tab = document.querySelector('nav button.active').dataset.tab;
  guard(LOADERS[tab]);
}

// 共用的點擊事件
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-open],[data-compose],[data-handled],[data-postpone],[data-paid],[data-dispatch]');
  if (!t) return;
  if (t.dataset.dispatch) return guard(async () => {
    await api(`/api/orders/${t.dataset.dispatch}`, { method: 'PATCH', body: { status: 'shipped' } });
    toast('已標記派車'); refreshCurrentTab();
  });
  if (t.dataset.paid) return guard(async () => { await markPaid(t.dataset.paid); currentCustomerId ? openCustomer(currentCustomerId) : refreshCurrentTab(); });
  if (t.dataset.compose) return guard(() => openCustomer(Number(t.dataset.compose), { kind: t.dataset.kind, orderId: t.dataset.order }));
  if (t.dataset.handled) return guard(async () => { await api(`/api/customers/${t.dataset.handled}/handled`, { method: 'POST' }); loadFocus(); });
  if (t.dataset.postpone) return guard(async () => {
    const d = new Date(); d.setDate(d.getDate() + 3);
    await api(`/api/customers/${t.dataset.postpone}`, { method: 'PATCH', body: { next_contact_date: d.toLocaleDateString('en-CA') } });
    toast('已延後 3 天'); loadFocus();
  });
  if (t.dataset.open) return guard(() => openCustomer(Number(t.dataset.open)));
});

const LOADERS = { focus: loadFocus, repurchase: loadRepurchase, customers: loadCustomers, orders: loadOrders, brands: loadBrands };
guard(async () => { await loadStatus(); await loadFocus(); });
