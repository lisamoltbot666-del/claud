const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('zh-TW', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
const money = (n) => `NT$${Number(n || 0).toLocaleString()}`;
const nameOf = (c) => c.real_name || c.display_name || `客戶#${c.id}`;
const PRIORITY = { 1: '緊急', 2: '今日', 3: '有空時' };
const KIND_LABEL = { payment: '匯款提醒', reorder: '回訪邀請', trip: '行程確認', care: '關心問候', birthday: '生日祝福', thanks: '感謝與評價邀請', rebook: '回購邀請', custom: '訊息' };
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
let ME = {};
let ROLES = {};
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
  if (res.status === 401 && data.login) { location.href = '/login'; throw new Error('請重新登入'); }
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
let currentTab = 'focus';
function showTab(tab) {
  currentTab = tab;
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  for (const t of ['focus', 'repurchase', 'customers', 'orders', 'dispatch', 'templates', 'report', 'brands', 'accounts', 'search']) $(`#tab-${t}`).hidden = t !== tab;
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
  ME = s.me;
  ROLES = s.roles;
  document.body.classList.toggle('role-staff', ME.role !== 'admin');
  $('#me').textContent = `👤 ${ME.display_name}（${ROLES[ME.role]}）`;
  $('#change-password').hidden = !ME.id;
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
    const thanksOrder = item.reasons.find((r) => r.action === 'thanks')?.orderId;
    const rebookOrder = item.reasons.find((r) => r.action === 'rebook')?.orderId;
    return `<div class="card focus-item p${item.priority}">
      ${c.picture_url ? `<img class="avatar" src="${esc(c.picture_url)}" alt="">` : '<div class="avatar"></div>'}
      <div>
        ${brandTag(c.brand_id)}<span class="name" data-open="${c.id}">${esc(nameOf(c))}</span>
        ${c.real_name && c.display_name && c.real_name !== c.display_name ? `<span class="muted">（LINE：${esc(c.display_name)}）</span>` : ''}
        ${c.tags ? `<span class="muted">｜${esc(c.tags)}</span>` : ''}
        ${item.canPush ? '' : '<span class="badge">非好友，無法推播</span>'}
        <div class="history">${historyLine(item.stats)}${c.phone ? `｜☎ ${esc(c.phone)}` : ''}</div>
        <ul class="reasons">${item.reasons.map((r) => `<li><span class="badge p${r.priority}">${PRIORITY[r.priority]}</span>${esc(r.label)} <span class="muted">${esc(r.detail || '')}${r.remindCount ? `｜已提醒 ${r.remindCount} 次，最近 ${fmtTime(r.lastRemindedAt)}` : ''}</span></li>`).join('')}</ul>
      </div>
      <div class="actions">
        ${verifyOrder ? `<button class="small" data-paid="${verifyOrder}">確認已入帳</button>` : ''}
        ${dispatchOrder ? `<button class="small" data-dispatch="${dispatchOrder}">派車</button>` : ''}
        ${tripOrder && item.canPush ? `<button class="small" data-compose="${c.id}" data-kind="trip" data-order="${tripOrder}">發送行程確認</button>` : ''}
        ${actions.has('payment') && item.canPush ? `<button class="small" data-compose="${c.id}" data-kind="payment" data-order="${payOrder}">發送匯款提醒</button>` : ''}
        ${actions.has('reorder') && item.canPush ? `<button class="small" data-compose="${c.id}" data-kind="reorder">發送回訪邀請</button>` : ''}
        ${actions.has('care') && item.canPush ? `<button class="small" data-compose="${c.id}" data-kind="care">發送關心問候</button>` : ''}
        ${thanksOrder && item.canPush ? `<button class="small" data-compose="${c.id}" data-kind="thanks" data-order="${thanksOrder}">發送感謝與評價邀請</button>` : ''}
        ${rebookOrder && item.canPush ? `<button class="small" data-compose="${c.id}" data-kind="rebook" data-order="${rebookOrder}">發送回購邀請</button>` : ''}
        ${actions.has('lead') ? `<button class="small secondary" data-compose="${c.id}" data-kind="lead">標記未成交</button>` : ''}
        ${actions.has('birthday') && item.canPush ? `<button class="small" data-compose="${c.id}" data-kind="birthday">發送生日祝福</button>` : ''}
        ${actions.has('reply') ? `<button class="small secondary" data-handled="${c.id}">標記已回覆</button>` : ''}
        ${actions.has('care') || actions.has('reorder') || actions.has('rebook') ? `<button class="small secondary" data-postpone="${c.id}">延後 3 天</button>` : ''}
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

// ---------- 全站搜尋 ----------
// 把搜尋字標黃：先跳脫 HTML，再標記
const hl = (text, q) => {
  const safe = esc(text);
  if (!q) return safe;
  const pat = esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(pat, 'gi'), (m) => `<mark>${m}</mark>`);
};
let lastSearch = null;

async function loadSearch() {
  if (!lastSearch) return;
  const { q, from, to } = lastSearch;
  const qs = new URLSearchParams({ q, from, to });
  if (currentBrand) qs.set('brand', currentBrand);
  const r = await api(`/api/search?${qs}`);
  const range = r.from ? (r.from === r.to ? r.from : `${r.from} ～ ${r.to}`) : '';
  $('#search-title').textContent = `搜尋結果：${[q && `「${q}」`, range && `用車日 ${range}`].filter(Boolean).join('，')}`;
  const custRows = r.customers.map((c) => `<tr class="clickable" data-open="${c.id}">
    <td>${brandTag(c.brand_id)}${hl(nameOf(c), q)}${c.real_name && c.display_name && c.real_name !== c.display_name ? `<div class="muted">${hl(c.display_name, q)}</div>` : ''}</td>
    <td>${hl(c.phone, q)}</td><td>${hl(c.tags, q)}</td><td class="muted">${hl(c.note, q)}</td><td>${c.order_count}</td><td>${esc(c.last_trip || '')}</td></tr>`).join('');
  const orderRows = r.orders.map((o) => `<tr class="clickable" data-open="${o.customer_id}">
    <td>#${o.id}</td><td>${esc(tripWhen(o) || o.order_date)}</td><td>${brandTag(o.brand_id)}${hl(o.real_name || o.display_name, q)}<div class="muted">${hl(o.phone, q)}</div></td>
    <td>${esc(SERVICES[o.service_type] || '')}<div class="muted">${hl(o.items, q)}</div></td>
    <td class="muted">${o.flight_no ? `✈ ${hl(o.flight_no, q)}｜` : ''}${hl([o.pickup, o.dropoff].filter(Boolean).join(' → '), q)}${o.note ? `<div>${hl(o.note, q)}</div>` : ''}</td>
    <td>${money(o.amount)}</td><td>${esc(STATUSES[o.status] || o.status)}</td></tr>`).join('');
  const msgRows = r.messages.map((m) => `<tr class="clickable" data-open="${m.customer_id}">
    <td>${fmtTime(m.created_at)}</td><td>${brandTag(m.brand_id)}${esc(m.real_name || m.display_name)}</td><td>${m.direction === 'in' ? '客人' : '我方'}</td><td>${hl(m.text, q)}</td></tr>`).join('');
  const total = r.customers.length + r.orders.length + r.messages.length;
  $('#search-results').innerHTML = total ? `
    ${r.customers.length ? `<div class="result-group"><h3>客戶（${r.customers.length}）</h3><div class="table-wrap"><table><thead><tr><th>名稱</th><th>電話</th><th>標籤</th><th>備註</th><th>訂單數</th><th>最近用車</th></tr></thead><tbody>${custRows}</tbody></table></div></div>` : ''}
    ${r.orders.length ? `<div class="result-group"><h3>訂單（${r.orders.length}）</h3><div class="table-wrap"><table><thead><tr><th>#</th><th>用車</th><th>客戶</th><th>服務</th><th>行程</th><th>金額</th><th>狀態</th></tr></thead><tbody>${orderRows}</tbody></table></div></div>` : ''}
    ${r.messages.length ? `<div class="result-group"><h3>對話（${r.messages.length}）</h3><div class="table-wrap"><table><thead><tr><th>時間</th><th>客戶</th><th></th><th>內容</th></tr></thead><tbody>${msgRows}</tbody></table></div></div>` : ''}`
    : '<div class="card empty">找不到符合的資料</div>';
}

$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#search-q').value.trim();
  const from = $('#search-from').value;
  const to = $('#search-to').value;
  if (!q && !from && !to) return toast('請輸入關鍵字或選擇日期', true);
  lastSearch = { q, from, to };
  showTab('search');
});
$('#search-clear').addEventListener('click', () => {
  lastSearch = null;
  $('#search-q').value = ''; $('#search-from').value = ''; $('#search-to').value = '';
  showTab('focus');
});

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
    <td>${brandTag(c.brand_id)}${esc(nameOf(c))}${c.is_staff ? ' <span class="badge">清單接收人</span>' : ''}${c.is_driver ? ' <span class="badge">司機</span>' : ''}${c.real_name && c.display_name && c.real_name !== c.display_name ? `<div class="muted">${esc(c.display_name)}</div>` : ''}</td>
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
  $('#order-table').innerHTML = `<thead><tr><th>#</th><th>用車</th><th>客戶</th><th>服務</th><th>行程</th><th>司機</th><th>金額</th><th>狀態</th><th>匯款期限</th><th>匯款回報</th></tr></thead>
  <tbody>${rows.length ? rows.map((o) => `<tr class="clickable" data-open="${o.customer_id}">
    <td>${o.id}</td><td>${esc(tripWhen(o)) || `<span class="muted">下單 ${esc(o.order_date)}</span>`}</td><td>${brandTag(o.brand_id)}${esc(o.real_name || o.display_name)}</td>
    <td>${esc(SERVICES[o.service_type] || '')}<div class="muted">${esc(o.items)}</div></td><td class="muted">${tripRoute(o)}</td><td>${esc(o.driver_name || '')}</td><td>${money(o.amount)}</td>
    <td>${esc(STATUSES[o.status])}</td><td>${o.status === 'pending_payment' ? esc(o.payment_due_date || '') : ''}</td><td>${esc(o.payment_report || '')}</td>
  </tr>`).join('') : '<tr><td colspan="10" class="empty">沒有訂單</td></tr>'}</tbody>`;
}
$('#order-status').addEventListener('change', () => guard(loadOrders));
$('#order-when').addEventListener('change', () => guard(loadOrders));

// ---------- customer drawer ----------
async function openCustomer(id, compose = null) {
  currentCustomerId = id;
  const { customer: c, brand, stats: st, orders, messages, reminders, duplicates, activity, lead, lostReasons, drivers } = await api(`/api/customers/${id}`);
  const canPush = c.line_user_id && c.is_friend;
  const pendingOrders = orders.filter((o) => o.status === 'pending_payment');
  const lastDone = orders.filter((o) => ['paid', 'shipped', 'completed'].includes(o.status) && o.service_date && o.service_date < TODAY).sort((a, b) => (a.service_date < b.service_date ? 1 : -1))[0];
  const upcomingTrips = orders.filter((o) => o.service_date && o.service_date >= TODAY && ['pending_payment', 'paid', 'shipped'].includes(o.status));
  const field = (key, label, type = 'text', wide = false) => `<label class="${wide ? 'wide' : ''}">${label}${type === 'textarea' ? `<textarea name="${key}">${esc(c[key])}</textarea>` : `<input name="${key}" type="${type}" value="${esc(c[key])}">`}</label>`;

  $('#drawer-body').innerHTML = `
    <div class="row">
      ${c.picture_url ? `<img class="avatar" src="${esc(c.picture_url)}" alt="">` : ''}
      <div><h2>${brandTag(c.brand_id)}${esc(nameOf(c))}${c.is_staff ? ' <span class="badge">清單接收人</span>' : ''}${c.is_weekly ? ' <span class="badge">週報接收人</span>' : ''}</h2><div class="muted">${esc(brand?.name || '')} 官方帳號｜${c.line_user_id ? `LINE userId：${esc(c.line_user_id)}` : '手動建立（非 LINE 好友）'}｜${c.is_friend ? '好友' : '非好友／已封鎖'}｜加入 ${fmtTime(c.followed_at || c.created_at)}</div></div>
      <span class="spacer"></span>
      ${canPush ? `<button class="secondary small" id="toggle-staff" title="每天由「${esc(brand?.name || '')}」的官方帳號把關懷清單推播給這位">${c.is_staff ? '取消清單接收人' : '設為清單接收人'}</button>` : ''}
      ${canPush || c.is_weekly ? `<button class="secondary small admin-only" id="toggle-weekly" title="每週由「${esc(brand?.name || '')}」的官方帳號把營運週報推播給這位（老闆、主管）">${c.is_weekly ? '取消週報接收人' : '設為週報接收人'}</button>` : ''}
      <button class="secondary" id="close-drawer">關閉</button>
    </div>

    ${duplicates.length ? `<div class="card" style="border-left:4px solid var(--amber);margin-top:12px">
      <strong>可能是同一個人</strong> <span class="muted">（同品牌、電話或姓名相同）</span>
      ${duplicates.map((d) => `<div class="row" style="margin-top:6px"><span class="name" data-open="${d.id}">${esc(nameOf(d))}</span>
        <span class="muted">${esc(d.phone || '')}｜訂單 ${d.order_count} 筆｜${d.line_user_id ? 'LINE 好友' : '非 LINE 好友'}</span><span class="spacer"></span>
        <button class="small" data-merge-in="${d.id}">把這筆合併進來</button></div>`).join('')}
    </div>` : ''}
    ${lead ? `<div class="card" id="lead-section" style="margin-top:12px;border-left:4px solid ${lead.status === 'won' ? 'var(--brand)' : lead.status === 'open' ? 'var(--blue)' : 'var(--amber)'}">
      <strong>詢問狀態：${{ won: '✅ 已成交', open: '💬 洽談中', lost: '未成交', stale: `⚠️ 超過 7 天未成交、未標記原因` }[lead.status]}</strong>
      <span class="muted">｜${esc(lead.date)} 第一次詢問（${lead.age} 天前）</span>
      ${lead.status === 'lost' ? `<div style="margin-top:6px">原因：<strong>${esc(lead.reason)}</strong>${lead.note ? `｜${esc(lead.note)}` : ''} <span class="muted">（${esc(lead.by || '')} ${fmtTime(lead.at)}）</span> <button class="small secondary" id="lead-reopen">重新開啟</button></div>` : ''}
      ${['open', 'stale'].includes(lead.status) ? `<form id="lead-lost" class="row" style="margin-top:8px">
        <select name="reason" required><option value="">未成交原因…</option>${lostReasons.map((r) => `<option>${esc(r)}</option>`).join('')}</select>
        <input name="note" placeholder="補充說明（選「其他」時必填）" style="flex:1;min-width:160px">
        <button type="submit" class="small">標記未成交</button></form>` : ''}
    </div>` : ''}
    <h3>消費總覽</h3>
    <div class="tiles">
      <div class="tile"><div class="label">客戶類型</div><div class="value">${SEGMENTS[st.segment]}</div><div class="sub">再次預約 ${st.repeatCount} 次</div></div>
      <div class="tile"><div class="label">訂單數</div><div class="value">${st.orderCount}</div><div class="sub">已付款 ${st.paidCount} 筆</div></div>
      <div class="tile"><div class="label">累積消費</div><div class="value">${money(st.totalSpent)}</div><div class="sub">${st.pendingAmount ? `待付款 ${money(st.pendingAmount)}` : '&nbsp;'}</div></div>
      <div class="tile"><div class="label">平均客單價</div><div class="value">${money(st.avgOrder)}</div><div class="sub">&nbsp;</div></div>
      <div class="tile"><div class="label">首次 / 最近用車</div><div class="value" style="font-size:14px">${esc(st.firstOrderDate || '—')}<br>${esc(st.lastOrderDate || '—')}</div><div class="sub">${st.daysSinceLastOrder != null ? (st.daysSinceLastOrder < 0 ? `${-st.daysSinceLastOrder} 天後用車` : st.daysSinceLastOrder === 0 ? '今天用車' : `距今 ${st.daysSinceLastOrder} 天`) : ''}</div></div>
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
      <div class="row wide" style="grid-column:1/-1"><button type="submit">儲存資料</button><span class="spacer"></span><button type="button" class="danger small admin-only" id="delete-customer">刪除客戶</button></div>
    </form>

    ${drivers.length ? `<h3>服務過的司機與車輛</h3>
    <div class="table-wrap"><table><thead><tr><th>司機</th><th>車號</th><th>車型</th><th>電話</th><th>服務次數</th><th>最近一次</th></tr></thead><tbody>
      ${drivers.map((d) => `<tr><td>${esc(d.name || '')}</td><td>${esc(d.plate || '')}</td><td>${esc(d.car_model || '')}</td><td>${esc(d.phone || '')}</td><td>${d.trips}</td><td>${esc(d.last_date || '')}</td></tr>`).join('')}
    </tbody></table></div>` : ''}

    <h3>訂單紀錄（${orders.length} 筆）</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>#</th><th>用車</th><th>服務 / 行程</th><th>金額</th><th>狀態</th><th>匯款期限 / 回報</th><th></th></tr></thead>
      <tbody>${orders.map((o) => `<tr>
        <td>${o.id}</td><td>${esc(tripWhen(o)) || '—'}<div class="muted">下單 ${esc(o.order_date)}</div></td>
        <td>${esc([SERVICES[o.service_type], o.items].filter(Boolean).join(' '))}<div class="muted">${tripRoute(o)}</div>${o.driver_name ? `<div>🚘 ${esc(o.driver_name)}${o.driver_plate ? `｜${esc(o.driver_plate)}` : ''}${o.driver_car ? `｜${esc(o.driver_car)}` : ''}</div>` : ''}</td><td>${money(o.amount)}</td>
        <td><select data-order-status="${o.id}">${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}" ${k === o.status ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
        <td>${o.status === 'pending_payment' ? `${esc(o.payment_due_date || '')}${o.payment_report ? `<div class="muted">回報：${esc(o.payment_report)}</div>` : ''}` : `<span class="muted">${o.paid_at ? `入帳 ${fmtTime(o.paid_at)}` : ''}</span>`}</td>
        <td>${o.status === 'pending_payment' ? `<button class="small" data-paid="${o.id}">確認入帳</button>` : ''} ${['cancelled', 'completed'].includes(o.status) ? '' : `<button class="small secondary" data-dispatch="${o.id}">派車</button> `}<button class="small secondary" data-edit-order="${o.id}">編輯</button> <button class="small secondary" data-del-order="${o.id}">刪除</button></td>
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
      ${lastDone ? `<button class="small secondary" data-template="thanks" data-order="${lastDone.id}">感謝與評價邀請</button><button class="small secondary" data-template="rebook" data-order="${lastDone.id}">回購邀請</button>` : ''}
      <button class="small secondary" data-template="reorder">回訪邀請</button>
      <button class="small secondary" data-template="care">關心問候</button>
      <button class="small secondary" data-template="birthday">生日祝福</button>
      <select id="custom-template" class="small"><option value="">常用範本…</option></select>
    </div>
    <form id="send-form">
      <textarea name="text" placeholder="輸入訊息，或點上方按鈕套用範本"></textarea>
      <input type="hidden" name="kind" value="custom"><input type="hidden" name="orderId" value="">
      <div class="row" style="margin-top:6px"><button type="submit" ${canPush ? '' : 'disabled'}>推播給客戶</button><button type="button" class="secondary" id="mark-handled">標記已回覆（不發訊息）</button><span class="muted">推播會使用官方帳號訊息額度</span></div>
    </form>

    <details style="margin-top:14px"><summary class="muted">合併其他客戶到這筆…</summary>
      <p class="muted">同一個人被建立成兩筆時（例如先匯入舊資料、後來才在 LINE 傳訊息），可以把另一筆的訂單、對話、資料併到這筆，另一筆會被刪除。只能合併同品牌的客戶。</p>
      <input id="merge-search" type="search" placeholder="輸入對方的姓名或電話">
      <div id="merge-results"></div>
    </details>

    <h3>對話紀錄</h3>
    <div class="chat" id="chat">${messages.map((m) => `<div class="bubble ${m.direction}">${esc(m.text)}<time>${fmtTime(m.created_at)}${m.staff_name ? `・${esc(m.staff_name)}` : ''}</time></div>`).join('') || '<div class="muted">尚無訊息</div>'}</div>

    <h3>提醒紀錄</h3>
    <div class="muted">${reminders.map((r) => `${fmtTime(r.sent_at)} ${KIND_LABEL[r.kind] || r.kind}${r.auto ? '（自動）' : ''}${r.staff_name && !r.auto ? `・${esc(r.staff_name)}` : ''}${r.ok ? '' : ` ❌ ${esc(r.error)}`}`).join('<br>') || '尚無'}</div>

    <h3>操作紀錄</h3>
    <div class="muted">${activity.map((a) => `${fmtTime(a.at)}｜${esc(a.user_name || '系統')}｜${esc(a.action)}${a.detail ? `：${esc(a.detail)}` : ''}`).join('<br>') || '尚無'}</div>
  `;
  const dlg = $('#drawer');
  if (!dlg.open) dlg.showModal();
  const chat = $('#chat');
  chat.scrollTop = chat.scrollHeight;

  $('#close-drawer').onclick = () => dlg.close();
  if ($('#lead-lost')) $('#lead-lost').onsubmit = (e) => { e.preventDefault(); guard(async () => {
    await api(`/api/customers/${id}/lead`, { method: 'POST', body: { lost: true, ...Object.fromEntries(new FormData(e.target)) } });
    toast('已標記未成交'); openCustomer(id);
  }); };
  if ($('#lead-reopen')) $('#lead-reopen').onclick = () => guard(async () => { await api(`/api/customers/${id}/lead`, { method: 'POST', body: { lost: false } }); openCustomer(id); });
  if (compose?.kind === 'lead') $('#lead-section')?.scrollIntoView({ block: 'center' });
  document.querySelectorAll('[data-merge-in]').forEach((b) => b.onclick = () => guard(() => mergeInto(id, Number(b.dataset.mergeIn))));
  $('#merge-search').oninput = () => {
    clearTimeout(mergeTimer);
    mergeTimer = setTimeout(() => guard(async () => {
      const q = $('#merge-search').value.trim();
      if (q.length < 2) { $('#merge-results').innerHTML = ''; return; }
      const r = await api(`/api/search?${new URLSearchParams({ q, brand: c.brand_id })}`);
      const others = r.customers.filter((x) => x.id !== id).slice(0, 8);
      $('#merge-results').innerHTML = others.map((x) => `<div class="row" style="margin-top:4px">${esc(nameOf(x))} <span class="muted">${esc(x.phone || '')}｜訂單 ${x.order_count} 筆</span><span class="spacer"></span><button class="small secondary" data-merge-pick="${x.id}">合併進來</button></div>`).join('') || '<span class="muted">找不到</span>';
      document.querySelectorAll('[data-merge-pick]').forEach((b) => b.onclick = () => guard(() => mergeInto(id, Number(b.dataset.mergePick))));
    }), 250);
  };
  if ($('#toggle-staff')) $('#toggle-staff').onclick = () => guard(async () => {
    await api(`/api/customers/${id}/staff`, { method: 'POST', body: { staff: !c.is_staff } });
    toast(c.is_staff ? '已取消' : '已設為清單接收人，每天會收到關懷清單');
    loadStatus();
    openCustomer(id);
  });
  if ($('#toggle-weekly')) $('#toggle-weekly').onclick = () => guard(async () => {
    await api(`/api/customers/${id}/weekly`, { method: 'POST', body: { weekly: !c.is_weekly } });
    toast(c.is_weekly ? '已取消週報接收人' : '已設為週報接收人，每週會收到營運週報');
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
  guard(async () => {
    const { templates } = await api(`/api/templates?brand=${c.brand_id}`);
    $('#custom-template').innerHTML = `<option value="">常用範本…（${templates.length}）</option>${templates.map((t) => `<option value="${t.id}">${esc(t.title)}${t.brand_id ? '' : '（共用）'}</option>`).join('')}`;
  });
  $('#custom-template').onchange = (e) => guard(async () => {
    if (!e.target.value) return;
    const r = await api(`/api/customers/${id}/templates/${e.target.value}`);
    const f = $('#send-form');
    f.text.value = r.text;
    f.kind.value = 'custom';
    f.orderId.value = r.orderId || '';
    f.text.focus();
    if (r.missing.length) toast(`這位客戶沒有：${r.missing.join('、')}，送出前請檢查內容`, true);
    e.target.value = '';
  });
  $('#mark-handled').onclick = () => guard(async () => { await api(`/api/customers/${id}/handled`, { method: 'POST' }); toast('已標記'); });
  if (compose && compose.kind !== 'lead') await applyTemplate(id, compose.kind, compose.orderId);
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
      <button class="small secondary admin-only" data-edit-brand="${b.id}">編輯</button>
      <button class="small secondary admin-only" data-sync-brand="${b.id}" title="僅限認證 / 進階帳號">同步好友</button>
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
    ${f('review_url', '評價連結（Google 評論等，會放進服務後的感謝訊息；可留空）', 'type="url" placeholder="https://g.page/r/…"').replace('<label>', '<label class="wide">')}
    ${f('rebook_offer', '回購優惠（會放進服務後 30 天的回購邀請，例如：回頭客再訂享 9 折；可留空）').replace('<label>', '<label class="wide">')}
    ${f('forward_url', '同時轉送到（原本填在 LINE 的 Webhook 網址，舊系統還要用才填；不用請留空）', 'type="url" placeholder="https://…"').replace('<label>', '<label class="wide">')}`;
}

function forwardBadge(st) {
  if (!st) return '<span class="muted">（尚未收到訊息）</span>';
  return st.ok
    ? `<span class="ok">✓ 最近轉送成功 ${fmtTime(st.at)}</span>`
    : `<span class="warn">✗ 最近轉送失敗 ${fmtTime(st.at)}：${esc(st.error)}</span>`;
}

// ---------- 合併重複客戶 ----------
let mergeTimer;
async function mergeInto(keepId, otherId) {
  const other = await api(`/api/customers/${otherId}`);
  if (!confirm(`把「${nameOf(other.customer)}」（訂單 ${other.orders.length} 筆）合併到這位客戶？\n\n對方的訂單、對話、提醒紀錄會搬過來，空白的資料欄位會用對方的補上，然後刪除對方那一筆。無法復原。`)) return;
  await api(`/api/customers/${keepId}/merge`, { method: 'POST', body: { other_id: otherId } });
  toast('已合併');
  openCustomer(keepId);
}

$('#find-duplicates').addEventListener('click', () => guard(async () => {
  const groups = await api(`/api/duplicates?${brandQs()}`);
  const dlg = $('#drawer');
  $('#drawer-body').innerHTML = `
    <div class="row"><h2>可能重複的客戶（${groups.length} 組）</h2><span class="spacer"></span><button class="secondary" id="close-drawer">關閉</button></div>
    <p class="muted">同品牌中電話相同、或姓名／LINE 名稱相同的客戶。每組第一筆是建議保留的（優先保留 LINE 好友，才能繼續推播）。請確認是同一人再合併。</p>
    ${groups.map((g) => `<div class="card">${g.map((c, i) => `<div class="row" style="margin:4px 0">
        ${brandTag(c.brand_id)}<span class="name" data-open="${c.id}">${esc(nameOf(c))}</span>
        <span class="muted">${esc(c.phone || '')}｜訂單 ${c.order_count} 筆｜${c.line_user_id ? 'LINE 好友' : '非 LINE 好友'}</span>
        <span class="spacer"></span>${i === 0 ? '<span class="badge">保留</span>' : `<button class="small" data-dup-keep="${g[0].id}" data-dup-other="${c.id}">合併到第一筆</button>`}
      </div>`).join('')}</div>`).join('') || '<div class="card empty">沒有找到重複的客戶 🎉</div>'}`;
  if (!dlg.open) dlg.showModal();
  $('#close-drawer').onclick = () => dlg.close();
  document.querySelectorAll('[data-dup-keep]').forEach((b) => b.onclick = () => guard(async () => {
    await api(`/api/customers/${b.dataset.dupKeep}/merge`, { method: 'POST', body: { other_id: Number(b.dataset.dupOther) } });
    toast('已合併');
    $('#find-duplicates').click();
  }));
}));

// ---------- 匯入舊資料 ----------
// Excel 存的 CSV 可能是 UTF-8 或 Big5，先試 UTF-8，失敗再用 Big5
async function readCsvFile(file) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('big5').decode(buf);
  }
}

$('#import-data').addEventListener('click', () => {
  const dlg = $('#drawer');
  const state = { csv: '', mapping: null };
  $('#drawer-body').innerHTML = `
    <div class="row"><h2>匯入舊客戶與訂單</h2><span class="spacer"></span><button class="secondary" id="close-drawer">關閉</button></div>
    <p class="muted">支援 CSV 檔（Excel／Google 試算表「下載 → CSV」）。可直接匯入首席後台「匯出全部訂單 CSV」、Airtable 匯出的 CSV，或照
      <a href="/api/import/template.csv">匯入範本</a> 填寫。一行一筆訂單；只有客戶資料、沒有訂單的行也可以。</p>
    <div class="grid">
      <label>匯入到哪個品牌
        <select id="imp-brand"><option value="">依檔案中的「品牌」欄位</option>${BRANDS.map((b) => `<option value="${b.id}" ${String(b.id) === String(currentBrand) ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
      </label>
      <label>選擇檔案<input id="imp-file" type="file" accept=".csv,.tsv,.txt,text/csv"></label>
    </div>
    <div id="imp-preview"></div>`;
  if (!dlg.open) dlg.showModal();
  $('#close-drawer').onclick = () => dlg.close();

  const run = (dryRun) => api('/api/import', { method: 'POST', body: { csv: state.csv, mapping: state.mapping, brand_id: $('#imp-brand').value || null, dry_run: dryRun } });
  const preview = () => guard(async () => {
    if (!state.csv) return;
    $('#imp-preview').innerHTML = '<p class="muted">分析中…</p>';
    let r;
    try {
      r = await run(true);
    } catch (e) {
      $('#imp-preview').innerHTML = `<p class="warn">${esc(e.message)}</p>`;
      if (!state.mapping) return;
      throw e;
    }
    state.mapping = r.mapping;
    const s = r.stats;
    const opt = (key) => `<select data-map="${key}"><option value="">（不匯入）</option>${r.headers.map((h) => `<option ${r.mapping[key] === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select>`;
    $('#imp-preview').innerHTML = `
      <h3>欄位對應（系統已自動判斷，可調整）</h3>
      <div class="grid">${r.fields.map((f) => `<label>${esc(f.label)}${opt(f.key)}</label>`).join('')}</div>
      <h3>預覽結果（尚未寫入）</h3>
      <div class="tiles">
        <div class="tile"><div class="label">資料列</div><div class="value">${s.rows}</div></div>
        <div class="tile"><div class="label">新增客戶</div><div class="value">${s.customersCreated}</div></div>
        <div class="tile"><div class="label">對應到現有客戶</div><div class="value">${s.customersMatched}</div></div>
        <div class="tile"><div class="label">新增訂單</div><div class="value">${s.ordersCreated}</div></div>
        <div class="tile"><div class="label">略過（已匯入過）</div><div class="value">${s.ordersSkipped}</div></div>
        <div class="tile"><div class="label">有問題的列</div><div class="value ${s.errors.length ? 'warn' : ''}">${s.errors.length}</div></div>
      </div>
      ${s.errors.length ? `<p class="warn">${s.errors.slice(0, 20).map((e) => `第 ${e.row} 列：${esc(e.message)}`).join('<br>')}${s.errors.length > 20 ? `<br>…還有 ${s.errors.length - 20} 列` : ''}</p>` : ''}
      ${r.sample.length ? `<h3>前幾筆訂單</h3><div class="table-wrap"><table><thead><tr><th>列</th><th>品牌</th><th>客戶</th><th>用車</th><th>服務</th><th>行程</th><th>金額</th><th>狀態</th></tr></thead><tbody>
        ${r.sample.map((o) => `<tr><td>${o.row}</td><td>${esc(o.brand)}</td><td>${esc(o.customer)}</td><td>${esc(o.service_date || o.order_date)} ${esc(o.service_time || '')}</td><td>${esc(SERVICES[o.service_type] || '')}</td><td>${esc([o.pickup, o.dropoff].filter(Boolean).join(' → '))}</td><td>${money(o.amount)}</td><td>${esc(STATUSES[o.status] || o.status)}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
      <p class="muted">已經過了用車日的訂單會標記為「已完成」；匯入的訂單不會自動催款。重複匯入同一份檔案不會重複建立訂單。</p>
      <div class="row"><button id="imp-run" ${s.customersCreated + s.customersMatched + s.ordersCreated ? '' : 'disabled'}>確認匯入</button></div>`;
    document.querySelectorAll('[data-map]').forEach((sel) => sel.onchange = () => { state.mapping = { ...state.mapping, [sel.dataset.map]: sel.value }; preview(); });
    $('#imp-run').onclick = () => guard(async () => {
      if (!confirm(`確定匯入？將新增 ${s.customersCreated} 位客戶、${s.ordersCreated} 筆訂單。`)) return;
      const done = await run(false);
      toast(`匯入完成：新增客戶 ${done.stats.customersCreated} 位、訂單 ${done.stats.ordersCreated} 筆${done.stats.errors.length ? `，${done.stats.errors.length} 列有問題未匯入` : ''}`);
      dlg.close();
    });
  });
  $('#imp-file').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    state.csv = await readCsvFile(file);
    state.mapping = null;
    preview();
  };
  $('#imp-brand').onchange = preview;
});

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
  guard(LOADERS[currentTab]);
}

// 共用的點擊事件
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-open],[data-compose],[data-handled],[data-postpone],[data-paid],[data-dispatch]');
  if (!t) return;
  if (t.dataset.dispatch) return guard(() => openDispatch(Number(t.dataset.dispatch)));
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

// ---------- 司機與派車 ----------
let dispatchRange = 0;
const addDaysStr = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
document.querySelectorAll('#dispatch-range button').forEach((b) => b.addEventListener('click', () => {
  dispatchRange = Number(b.dataset.range);
  $('#dispatch-date').value = '';
  document.querySelectorAll('#dispatch-range button').forEach((x) => x.classList.toggle('active', x === b));
  guard(loadDispatch);
}));
$('#dispatch-date').addEventListener('change', () => { document.querySelectorAll('#dispatch-range button').forEach((x) => x.classList.remove('active')); guard(loadDispatch); });

async function loadDispatch() {
  const pick = $('#dispatch-date').value;
  const from = pick || (dispatchRange === 1 ? addDaysStr(TODAY, 1) : TODAY);
  const to = pick || (dispatchRange === 7 ? addDaysStr(TODAY, 7) : from);
  const [board, drivers] = await Promise.all([api(`/api/dispatch?${new URLSearchParams({ from, to, ...(currentBrand ? { brand: currentBrand } : {}) })}`), api('/api/drivers')]);
  const unassigned = board.orders.filter((o) => !o.driver_id).length;
  $('#dispatch-summary').textContent = board.orders.length ? `${board.orders.length} 趟，${unassigned ? `${unassigned} 趟還沒派司機` : '全部已派司機 ✅'}` : '';
  const byDate = Map.groupBy ? Map.groupBy(board.orders, (o) => o.service_date) : board.orders.reduce((m, o) => m.set(o.service_date, [...(m.get(o.service_date) || []), o]), new Map());
  const driverOptions = (sel) => `<option value="">— 未指派 —</option>${board.drivers.map((d) => `<option value="${d.id}" ${d.id === sel ? 'selected' : ''}>${esc(d.name)}${d.plate ? ` ${esc(d.plate)}` : ''}</option>`).join('')}`;
  $('#dispatch-board').innerHTML = [...byDate].map(([date, list]) => `<h3>${esc(date)}（${list.length} 趟）</h3>
    <div class="table-wrap"><table><thead><tr><th>時間</th><th>客戶</th><th>服務</th><th>行程</th><th>付款</th><th>司機</th><th></th></tr></thead><tbody>
    ${list.map((o) => `<tr>
      <td><strong>${esc(o.service_time || '—')}</strong></td>
      <td>${brandTag(o.brand_id)}<span class="name" data-open="${o.customer_id}">${esc(o.real_name || o.display_name)}</span><div class="muted">${esc(o.phone || '')}</div></td>
      <td>${esc(SERVICES[o.service_type] || '')}<div class="muted">${esc(o.items || '')}</div></td>
      <td class="muted">${tripRoute(o)}</td>
      <td>${o.status === 'pending_payment' ? `<span class="warn">待付款 ${money(o.amount)}</span>` : esc(STATUSES[o.status])}</td>
      <td><select data-assign="${o.id}" ${['completed'].includes(o.status) ? 'disabled' : ''}>${driverOptions(o.driver_id)}</select>${o.dispatched_at ? `<div class="muted">已傳派車單 ${fmtTime(o.dispatched_at)}</div>` : ''}</td>
      <td><button class="small secondary" data-dispatch="${o.id}">派車單</button></td>
    </tr>`).join('')}</tbody></table></div>`).join('') || '<div class="card empty">這段期間沒有行程</div>';
  document.querySelectorAll('[data-assign]').forEach((s) => s.onchange = () => guard(async () => {
    await api(`/api/orders/${s.dataset.assign}/driver`, { method: 'POST', body: { driver_id: s.value || null } });
    toast(s.value ? '已指派司機' : '已取消指派');
    loadDispatch();
  }));
  $('#driver-table').innerHTML = `<thead><tr><th>司機</th><th>電話</th><th>車號 / 車型</th><th>LINE</th><th>備註</th><th>狀態</th><th></th></tr></thead><tbody>
    ${drivers.map((d) => `<tr><td>${esc(d.name)}</td><td>${esc(d.phone || '')}</td><td>${esc(d.plate || '')}<div class="muted">${esc(d.car_model || '')}</div></td>
      <td>${d.line_customer_id ? `${brandTag(d.line_brand_id)}${esc(d.line_name || '')}` : '<span class="muted">未連結</span>'}</td>
      <td class="muted">${esc(d.note || '')}</td><td>${d.active ? '在職' : '<span class="muted">停用</span>'}</td>
      <td><button class="small secondary" data-driver-edit="${d.id}">編輯</button></td></tr>`).join('') || '<tr><td colspan="7" class="empty">還沒有司機，按「新增司機」</td></tr>'}</tbody>`;
  document.querySelectorAll('[data-driver-edit]').forEach((b) => b.onclick = () => editDriver(drivers.find((d) => d.id === Number(b.dataset.driverEdit))));
}

function editDriver(d = {}) {
  const dlg = $('#drawer');
  const f = (k, label, extra = '') => `<label>${label}<input name="${k}" value="${esc(d[k] ?? '')}" ${extra}></label>`;
  $('#drawer-body').innerHTML = `<div class="row"><h2>${d.id ? '編輯司機' : '新增司機'}</h2><span class="spacer"></span><button class="secondary" id="close-drawer">關閉</button></div>
    <form id="driver-form" class="grid" style="margin-top:12px">
      ${f('name', '姓名', 'required')}${f('phone', '電話', 'type="tel"')}${f('plate', '車號')}${f('car_model', '車型（例如 Toyota Alphard 7 人座）')}
      <label class="wide">備註<input name="note" value="${esc(d.note || '')}"></label>
      <label>狀態<select name="active"><option value="1" ${d.active !== 0 ? 'selected' : ''}>在職</option><option value="0" ${d.active === 0 ? 'selected' : ''}>停用</option></select></label>
      <input type="hidden" name="line_customer_id" value="${d.line_customer_id ?? ''}">
      <div class="wide" style="grid-column:1/-1">
        <div class="muted">連結 LINE（用來直接傳派車單）：<span id="driver-line">${d.line_customer_id ? `${esc(d.line_name || '')} <button type="button" class="small secondary" id="driver-unlink">取消連結</button>` : '未連結'}</span></div>
        <input id="driver-line-search" type="search" placeholder="搜尋司機的 LINE 名稱（司機需先加官方帳號好友並傳訊息）" style="margin-top:4px">
        <div id="driver-line-results"></div>
      </div>
      <div class="row" style="grid-column:1/-1"><button type="submit">儲存</button></div>
    </form>`;
  if (!dlg.open) dlg.showModal();
  $('#close-drawer').onclick = () => dlg.close();
  const form = $('#driver-form');
  const unlink = () => { form.line_customer_id.value = ''; $('#driver-line').textContent = '未連結（儲存後生效）'; };
  if ($('#driver-unlink')) $('#driver-unlink').onclick = unlink;
  let timer;
  $('#driver-line-search').oninput = (e) => { clearTimeout(timer); timer = setTimeout(() => guard(async () => {
    const q = e.target.value.trim();
    if (q.length < 1) { $('#driver-line-results').innerHTML = ''; return; }
    const r = await api(`/api/search?${new URLSearchParams({ q })}`);
    const friends = r.customers.filter((c) => c.line_user_id).slice(0, 8);
    $('#driver-line-results').innerHTML = friends.map((c) => `<div class="row" style="margin-top:4px">${brandTag(c.brand_id)}${esc(nameOf(c))}<span class="spacer"></span><button type="button" class="small secondary" data-link="${c.id}" data-name="${esc(nameOf(c))}">連結</button></div>`).join('') || '<span class="muted">找不到 LINE 好友</span>';
    document.querySelectorAll('[data-link]').forEach((b) => b.onclick = () => { form.line_customer_id.value = b.dataset.link; $('#driver-line').textContent = `${b.dataset.name}（儲存後生效）`; $('#driver-line-results').innerHTML = ''; });
  }), 250); };
  form.onsubmit = (e) => { e.preventDefault(); guard(async () => {
    const body = Object.fromEntries(new FormData(form));
    await api(d.id ? `/api/drivers/${d.id}` : '/api/drivers', { method: d.id ? 'PATCH' : 'POST', body });
    toast('已儲存');
    dlg.close();
  }); };
}
$('#new-driver').addEventListener('click', () => editDriver());

async function openDispatch(orderId) {
  const r = await api(`/api/orders/${orderId}/dispatch`);
  const o = r.order;
  const returnTo = currentCustomerId;
  const dlg = $('#drawer');
  $('#drawer-body').innerHTML = `<div class="row"><h2>派車 #${o.id}</h2><span class="spacer"></span><button class="secondary" id="close-drawer">關閉</button></div>
    <div class="row" style="margin:10px 0"><label>司機 <select id="dispatch-driver"><option value="">— 未指派 —</option>${r.drivers.map((d) => `<option value="${d.id}" ${d.id === o.driver_id ? 'selected' : ''}>${esc(d.name)}${d.plate ? ` ${esc(d.plate)}` : ''}</option>`).join('')}</select></label>
      ${r.drivers.length ? '' : '<span class="muted">還沒有司機，請到「派車」頁新增</span>'}</div>
    <h3>派車單（給司機）</h3>
    <textarea id="dispatch-text" style="min-height:200px">${esc(r.text)}</textarea>
    <div class="row" style="margin-top:6px">
      <button type="button" class="secondary" id="copy-dispatch">複製</button>
      <button type="button" id="send-driver" ${r.canPushDriver ? '' : 'disabled title="司機還沒連結 LINE"'}>LINE 傳給司機</button>
      ${o.dispatched_at ? `<span class="muted">上次傳送 ${fmtTime(o.dispatched_at)}</span>` : ''}
    </div>
    <h3>司機資訊（給客人）</h3>
    <textarea id="customer-text" style="min-height:140px" ${r.driver ? '' : 'disabled'}>${esc(r.customerText || '指派司機後會產生')}</textarea>
    <div class="row" style="margin-top:6px"><button type="button" id="send-customer" ${r.driver ? '' : 'disabled'}>LINE 傳給客人</button><span class="muted">會使用官方帳號訊息額度</span></div>
    ${returnTo ? '<div class="row" style="margin-top:12px"><button type="button" class="secondary" id="back-customer">← 回客戶資料</button></div>' : ''}`;
  if (!dlg.open) dlg.showModal();
  $('#close-drawer').onclick = () => dlg.close();
  if ($('#back-customer')) $('#back-customer').onclick = () => guard(() => openCustomer(returnTo));
  $('#dispatch-driver').onchange = (e) => guard(async () => {
    await api(`/api/orders/${o.id}/driver`, { method: 'POST', body: { driver_id: e.target.value || null } });
    toast(e.target.value ? '已指派司機' : '已取消指派');
    currentCustomerId = returnTo;
    openDispatch(o.id);
  });
  $('#copy-dispatch').onclick = () => guard(async () => { await navigator.clipboard.writeText($('#dispatch-text').value); toast('已複製，可貼到 LINE 群組'); });
  $('#send-driver').onclick = () => guard(async () => {
    await api(`/api/orders/${o.id}/dispatch/driver`, { method: 'POST', body: { text: $('#dispatch-text').value } });
    toast('已傳給司機'); currentCustomerId = returnTo; openDispatch(o.id);
  });
  $('#send-customer').onclick = () => guard(async () => {
    if (!confirm('把司機資訊用 LINE 傳給客人？')) return;
    await api(`/api/orders/${o.id}/dispatch/customer`, { method: 'POST', body: { text: $('#customer-text').value } });
    toast('已傳給客人');
  });
  currentCustomerId = returnTo;
}

// ---------- 營收報表 ----------
let reportRange = 'month';
// 報表自己的品牌勾選（不影響其他頁面）；空陣列 = 全部品牌
let reportBrands = (() => { try { return JSON.parse(prefs.get('reportBrands') || '[]'); } catch { return []; } })();
const brandSlot = (id) => (BRANDS.findIndex((b) => b.id === Number(id)) % 8) + 1; // 顏色跟著品牌固定，不隨勾選變動
function selectedReportBrands() {
  const valid = reportBrands.filter((id) => brandOf(id));
  return valid.length ? valid : BRANDS.map((b) => b.id);
}
function renderReportBrands() {
  const sel = new Set(selectedReportBrands());
  const all = sel.size === BRANDS.length;
  $('#report-brands').innerHTML = `<span class="muted">品牌：</span>
    <label class="brand-check"><input type="checkbox" data-rb="all" ${all ? 'checked' : ''}> 全部</label>
    ${BRANDS.map((b) => `<label class="brand-check"><input type="checkbox" data-rb="${b.id}" ${sel.has(b.id) ? 'checked' : ''}>${brandTag(b.id)}</label>`).join('')}`;
  document.querySelectorAll('[data-rb]').forEach((cb) => cb.onchange = () => {
    if (cb.dataset.rb === 'all') reportBrands = [];
    else {
      const next = new Set(selectedReportBrands());
      if (cb.checked) next.add(Number(cb.dataset.rb)); else next.delete(Number(cb.dataset.rb));
      if (!next.size) { toast('至少要選一個品牌', true); cb.checked = true; return; }
      reportBrands = next.size === BRANDS.length ? [] : [...next];
    }
    prefs.set('reportBrands', JSON.stringify(reportBrands));
    guard(loadReport);
  });
}
const reportBrandParams = () => (reportBrands.filter((id) => brandOf(id)).length ? { brands: selectedReportBrands().join(',') } : {});

// 多品牌比較：每個品牌一條營業額趨勢線；圖例＋線尾品牌名；滑過顯示該區間各品牌數字
function brandTrendChart(series, ids) {
  const W = 720; const H = 240; const top = 16; const bottom = 26; const left = 8; const right = 70;
  const vals = series.flatMap((b) => ids.map((id) => b.brands[id]?.revenue || 0));
  const max = Math.max(1, ...vals);
  const n = series.length;
  const x = (i) => left + (n === 1 ? (W - left - right) / 2 : ((W - left - right) * i) / (n - 1));
  const y = (v) => top + (H - top - bottom) * (1 - v / max);
  const every = Math.ceil(n / 12);
  const short = (v) => (v >= 10000 ? `${Math.round(v / 1000) / 10}萬` : v.toLocaleString());
  // 線尾標籤避免重疊：依 y 排序後至少相隔 13px
  const ends = ids.map((id) => ({ id, y: y(series.at(-1).brands[id]?.revenue || 0) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 13);
  return `<div class="legend">${ids.map((id) => `<span><span class="swatch" style="background:var(--cat-${brandSlot(id)})"></span>${esc(brandOf(id)?.name || '')}</span>`).join('')}</div>
  <div class="chart" id="brand-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="各品牌營業額趨勢">
    <line class="gridline" x1="${left}" x2="${W - right}" y1="${H - bottom}" y2="${H - bottom}"/>
    <line class="gridline" x1="${left}" x2="${W - right}" y1="${y(max)}" y2="${y(max)}" stroke-dasharray="2 4"/>
    <text class="axis-label" x="${W - right}" y="${y(max) - 4}" text-anchor="end">NT$${short(max)}</text>
    ${series.map((b, i) => (i % every === 0 ? `<text class="axis-label" x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(b.tick)}</text>` : '')).join('')}
    ${ids.map((id) => `<polyline class="line" style="stroke:var(--cat-${brandSlot(id)})" points="${series.map((b, i) => `${x(i)},${y(b.brands[id]?.revenue || 0)}`).join(' ')}"/>`).join('')}
    ${ends.map((e) => `<text class="end-label" x="${W - right + 6}" y="${e.y + 4}">${esc(brandOf(e.id)?.name || '')}</text>`).join('')}
    <g class="hover" visibility="hidden"><line class="crosshair" y1="${top}" y2="${H - bottom}"/>${ids.map((id) => `<circle class="dot" r="4" data-id="${id}" style="fill:var(--cat-${brandSlot(id)})"/>`).join('')}</g>
    <rect class="hit" x="${left}" y="${top}" width="${W - left - right}" height="${H - top - bottom}" fill="transparent"/>
  </svg><div class="chart-tip" hidden></div></div>`;
}
function bindBrandChart(series, ids) {
  const chart = $('#brand-chart');
  if (!chart) return;
  const svg = chart.querySelector('svg');
  const tip = chart.querySelector('.chart-tip');
  const hover = svg.querySelector('.hover');
  const hit = svg.querySelector('.hit');
  const n = series.length;
  const W = 720; const H = 240; const top = 16; const bottom = 26; const left = 8; const right = 70;
  const max = Math.max(1, ...series.flatMap((b) => ids.map((id) => b.brands[id]?.revenue || 0)));
  const xAt = (i) => left + (n === 1 ? (W - left - right) / 2 : ((W - left - right) * i) / (n - 1));
  const yAt = (v) => top + (H - top - bottom) * (1 - v / max);
  hit.addEventListener('mousemove', (e) => {
    const box = svg.getBoundingClientRect();
    const sx = ((e.clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((sx - left) / (W - left - right)) * (n - 1))));
    const b = series[i];
    hover.setAttribute('visibility', 'visible');
    hover.querySelector('.crosshair').setAttribute('x1', xAt(i));
    hover.querySelector('.crosshair').setAttribute('x2', xAt(i));
    hover.querySelectorAll('.dot').forEach((d) => { d.setAttribute('cx', xAt(i)); d.setAttribute('cy', yAt(b.brands[d.dataset.id]?.revenue || 0)); });
    const rows = ids.map((id) => ({ id, v: b.brands[id]?.revenue || 0, o: b.brands[id]?.orders || 0 })).sort((a, c) => c.v - a.v);
    tip.innerHTML = `<strong>${esc(b.label)}</strong>${rows.map((r) => `<div><span class="swatch" style="display:inline-block;width:10px;height:3px;background:var(--cat-${brandSlot(r.id)});vertical-align:middle;margin-right:4px"></span>${esc(brandOf(r.id)?.name || '')} ${money(r.v)} <span class="muted">${r.o} 筆</span></div>`).join('')}`;
    const host = chart.getBoundingClientRect();
    tip.style.left = `${(xAt(i) / W) * box.width + box.left - host.left}px`;
    tip.style.top = `${(top / H) * box.height + box.top - host.top + 20}px`;
    tip.hidden = false;
  });
  hit.addEventListener('mouseleave', () => { hover.setAttribute('visibility', 'hidden'); tip.hidden = true; });
}
let reportG = 'auto';
const G_LABEL = { day: '每日', week: '每週', month: '每月' };
const pct = (x) => `${Math.round(x * 100)}%`;
function reportPeriod() {
  if ($('#report-from').value || $('#report-to').value) return [$('#report-from').value || $('#report-to').value, $('#report-to').value || $('#report-from').value];
  const [y, m] = TODAY.split('-').map(Number);
  const first = (yy, mm) => new Date(Date.UTC(yy, mm - 1, 1)).toISOString().slice(0, 10);
  const last = (yy, mm) => new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10);
  // 整個月／整年（包含已經預約、還沒到用車日的行程）
  if (reportRange === 'last') return [first(y, m - 1), last(y, m - 1)];
  if (reportRange === '3m') return [first(y, m - 2), last(y, m)];
  if (reportRange === 'year') return [`${y}-01-01`, `${y}-12-31`];
  if (reportRange === '12m') return [first(y, m - 11), last(y, m)];
  return [first(y, m), last(y, m)];
}
document.querySelectorAll('#report-range button').forEach((b) => b.addEventListener('click', () => {
  reportRange = b.dataset.range;
  $('#report-from').value = ''; $('#report-to').value = '';
  document.querySelectorAll('#report-range button').forEach((x) => x.classList.toggle('active', x === b));
  guard(loadReport);
}));
document.querySelectorAll('#report-g button').forEach((b) => b.addEventListener('click', () => {
  reportG = b.dataset.g;
  document.querySelectorAll('#report-g button').forEach((x) => x.classList.toggle('active', x === b));
  guard(loadReport);
}));
['#report-from', '#report-to'].forEach((s) => $(s).addEventListener('change', () => { document.querySelectorAll('#report-range button').forEach((x) => x.classList.remove('active')); guard(loadReport); }));

// 營業額直條圖（單一系列）：滑過顯示區間、營業額、訂單數；最高與最後一個區間直接標數字
function revenueChart(monthly) {
  const W = 720; const H = 220; const top = 22; const bottom = 26; const left = 4; const right = 4;
  const max = Math.max(1, ...monthly.map((m) => m.revenue));
  const band = (W - left - right) / monthly.length;
  const barW = Math.min(24, band * 0.6);
  const y = (v) => top + (H - top - bottom) * (1 - v / max);
  const peak = monthly.reduce((a, b) => (b.revenue > a.revenue ? b : a), monthly[0]);
  const short = (n) => (n >= 10000 ? `${Math.round(n / 1000) / 10}萬` : n.toLocaleString());
  const bars = monthly.map((m, i) => {
    const cx = left + band * i + band / 2;
    const h = Math.max(0, H - bottom - y(m.revenue));
    const x = cx - barW / 2;
    const yy = H - bottom - h;
    const r = Math.min(4, h);
    // 上方圓角 4px、底部貼齊基線
    const path = h > 0 ? `M${x},${H - bottom} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + barW - r} Q${x + barW},${yy} ${x + barW},${yy + r} V${H - bottom} Z` : '';
    const showLabel = m.revenue > 0 && (m === peak || i === monthly.length - 1);
    // 區間多時只標部分刻度，避免文字重疊
    const every = Math.ceil(monthly.length / 14);
    const tick = i % every === 0 || (i === monthly.length - 1 && i % every >= every / 2);
    return `<g class="band" tabindex="0" data-i="${i}" aria-label="${esc(m.label)} 營業額 NT$${m.revenue.toLocaleString()}，${m.orders} 筆">
      <rect x="${left + band * i}" y="${top}" width="${band}" height="${H - top - bottom}" fill="transparent"/>
      ${path ? `<path class="bar" d="${path}"/>` : ''}
      ${showLabel ? `<text class="value-label" x="${cx}" y="${yy - 6}" text-anchor="middle">${short(m.revenue)}</text>` : ''}
      ${tick ? `<text class="axis-label" x="${cx}" y="${H - 8}" text-anchor="middle">${esc(m.tick)}</text>` : ''}
    </g>`;
  }).join('');
  return `<div class="chart" id="revenue-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="營業額趨勢">
    <line class="gridline" x1="${left}" x2="${W - right}" y1="${H - bottom}" y2="${H - bottom}"/>
    <line class="gridline" x1="${left}" x2="${W - right}" y1="${y(max)}" y2="${y(max)}" stroke-dasharray="2 4"/>
    <text class="axis-label" x="${W - right}" y="${y(max) - 4}" text-anchor="end">NT$${short(max)}</text>
    ${bars}</svg><div class="chart-tip" hidden></div></div>`;
}
function bindChartTips(monthly) {
  const chart = $('#revenue-chart');
  if (!chart) return;
  const tip = chart.querySelector('.chart-tip');
  const show = (g) => {
    const m = monthly[Number(g.dataset.i)];
    const box = g.getBoundingClientRect();
    const host = chart.getBoundingClientRect();
    tip.innerHTML = `<strong>${esc(m.label)}</strong><br>營業額 ${money(m.revenue)}<br><span class="muted">訂單 ${m.orders} 筆</span>`;
    tip.style.left = `${box.left - host.left + box.width / 2}px`;
    tip.style.top = `${g.querySelector('.bar')?.getBoundingClientRect().top - host.top || box.height / 2}px`;
    tip.hidden = false;
  };
  chart.querySelectorAll('.band').forEach((g) => {
    g.addEventListener('mouseenter', () => show(g));
    g.addEventListener('focus', () => show(g));
    g.addEventListener('mouseleave', () => { tip.hidden = true; });
    g.addEventListener('blur', () => { tip.hidden = true; });
  });
}

async function loadReport() {
  const [from, to] = reportPeriod();
  renderReportBrands();
  const ids = selectedReportBrands();
  const r = await api(`/api/report?${new URLSearchParams({ from, to, g: reportG, ...reportBrandParams() })}`);
  // 圖表刻度：日 → 10/15、週 → 10/13、月 → 10月
  const series = r.series.map((b) => ({ ...b, tick: r.granularity === 'month' ? `${Number(b.key.slice(5))}月` : `${Number(b.key.slice(5, 7))}/${Number(b.key.slice(8))}` }));
  const t = r.totals;
  const maxBrand = Math.max(1, ...r.byBrand.map((b) => b.revenue));
  const brandsInTable = BRANDS.filter((b) => ids.includes(b.id));
  $('#report-body').innerHTML = `
    <div id="weekly-card"></div>
    <div id="targets-card"></div>
    <p class="muted">期間：${esc(r.from)} ～ ${esc(r.to)}</p>
    <div class="tiles">
      <div class="tile"><div class="label">營業額</div><div class="value">${money(t.revenue)}</div><div class="sub">已付款 ${t.paid_orders} 筆</div></div>
      <div class="tile"><div class="label">訂單數</div><div class="value">${t.orders}</div><div class="sub">另有取消 ${t.cancelled} 筆</div></div>
      <div class="tile"><div class="label">平均客單價</div><div class="value">${money(t.avg_order)}</div><div class="sub">&nbsp;</div></div>
      <div class="tile"><div class="label">待收款</div><div class="value">${money(t.receivable)}</div><div class="sub">${t.receivable_orders} 筆待付款</div></div>
      <div class="tile"><div class="label">客人數</div><div class="value">${t.customers}</div><div class="sub">新客 ${t.new_customers}・回頭客 ${t.repeat_customers}</div></div>
      <div class="tile"><div class="label">回頭客比例</div><div class="value">${pct(t.repeat_rate)}</div><div class="sub">之前也訂過的客人</div></div>
    </div>

    <h3>${G_LABEL[r.granularity]}營業額</h3>
    <div class="card">${revenueChart(series)}</div>
    ${ids.length >= 2 ? `<h3>各品牌比較（${G_LABEL[r.granularity]}營業額）</h3><div class="card">${brandTrendChart(series, ids)}</div>` : ''}

    <h3>各品牌</h3>
    <div class="table-wrap"><table><thead><tr><th>品牌</th><th>營業額</th><th></th><th>訂單</th><th>客人</th><th>回頭客比例</th><th>待收款</th></tr></thead><tbody>
      ${r.byBrand.map((b) => `<tr><td>${brandTag(b.brand_id)}</td><td>${money(b.revenue)}</td><td style="width:30%"><div class="meter" style="width:${(b.revenue / maxBrand) * 100}%"></div></td><td>${b.orders}</td><td>${b.customers}</td><td>${pct(b.customers ? b.repeat_customers / b.customers : 0)}</td><td>${money(b.receivable)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">這段期間沒有訂單</td></tr>'}
    </tbody></table></div>

    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px">
      <div><h3>各服務</h3><div class="table-wrap"><table><thead><tr><th>服務</th><th>訂單</th><th>營業額</th></tr></thead><tbody>
        ${r.byService.map((s) => `<tr><td>${esc(s.label)}</td><td>${s.orders}</td><td>${money(s.revenue)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">—</td></tr>'}</tbody></table></div></div>
      <div><h3>消費前 10 名</h3><div class="table-wrap"><table><thead><tr><th>客戶</th><th>訂單</th><th>營業額</th></tr></thead><tbody>
        ${r.topCustomers.map((c) => `<tr class="clickable" data-open="${c.customer_id}"><td>${brandTag(c.brand_id)}${esc(c.real_name || c.display_name)}</td><td>${c.orders}</td><td>${money(c.revenue)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">—</td></tr>'}</tbody></table></div></div>
    </div>

    <h3>${G_LABEL[r.granularity]}明細（各品牌）</h3>
    <div class="table-wrap"><table><thead><tr><th>${{ day: '日期', week: '週', month: '月份' }[r.granularity]}</th><th>營業額</th><th>訂單</th>${brandsInTable.map((b) => `<th>${esc(b.name)}</th>`).join('')}</tr></thead><tbody>
      ${[...series].reverse().map((m) => `<tr><td>${esc(m.label)}</td><td>${money(m.revenue)}</td><td>${m.orders}</td>${brandsInTable.map((b) => `<td>${m.brands[b.id] ? `${money(m.brands[b.id].revenue)}<div class="muted">${m.brands[b.id].orders} 筆</div>` : '<span class="muted">—</span>'}</td>`).join('')}</tr>`).join('')}
    </tbody></table></div>
    <div id="funnel-section"></div>
    <div id="response-section"></div>
    <div id="drivers-section"></div>`;
  bindChartTips(series);
  if (ids.length >= 2) bindBrandChart(series, ids);
  const month = from.slice(0, 7) === to.slice(0, 7) ? from.slice(0, 7) : TODAY.slice(0, 7);
  await Promise.all([loadFunnel(from, to), loadWeekly(), loadTargets(month), loadResponse(from, to), loadDriverStats(from, to)]);
}

// ---------- 每週營運週報 ----------
const WEEKDAY_NAMES = '日一二三四五六';
async function loadWeekly() {
  const w = await api(`/api/weekly?${new URLSearchParams(reportBrandParams())}`);
  const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  const arrow = (cur, prev) => {
    if (!prev) return cur ? '<span class="muted">前一週 0</span>' : '<span class="muted">—</span>';
    const c = (cur - prev) / prev;
    if (Math.abs(c) < 0.005) return '<span class="muted">持平</span>';
    return `<span class="${c > 0 ? 'up' : 'down'}">${c > 0 ? '▲' : '▼'} ${Math.round(Math.abs(c) * 100)}%</span>`;
  };
  const schedule = w.weeklyReportDay >= 0 && w.weeklyReportDay <= 6 ? `每週${WEEKDAY_NAMES[w.weeklyReportDay]} ${w.dailyReportHour}:00 自動推播` : '自動推播已關閉';
  $('#weekly-card').innerHTML = `<div class="card weekly">
    <div class="row"><h3 style="margin:0">上週營運週報（${md(w.from)}–${md(w.to)}，和前一週比較）</h3><span class="spacer"></span>
      <button class="small" id="send-weekly">立即推播週報</button></div>
    <div class="tiles" style="margin-top:10px">
      <div class="tile"><div class="label">營業額</div><div class="value">${money(w.totals.revenue)}</div><div class="sub">${arrow(w.totals.revenue, w.prevTotals.revenue)}</div></div>
      <div class="tile"><div class="label">訂單</div><div class="value">${w.totals.orders}</div><div class="sub">${arrow(w.totals.orders, w.prevTotals.orders)}</div></div>
      <div class="tile"><div class="label">新詢問</div><div class="value">${w.funnel.leads}</div><div class="sub">${arrow(w.funnel.leads, w.prevFunnel.leads)}</div></div>
      <div class="tile"><div class="label">成交率</div><div class="value">${Math.round(w.funnel.rate * 100)}%</div><div class="sub">前一週 ${Math.round(w.prevFunnel.rate * 100)}%</div></div>
    </div>
    <h4>💡 營運建議</h4>
    <ol class="suggestions">${w.suggestions.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
    <details><summary>LINE 推播內容預覽</summary><pre class="weekly-text">${esc(w.text)}</pre></details>
    <p class="muted">${schedule}｜接收人：${w.recipients.length ? w.recipients.map((r) => `<span class="name" data-open="${r.id}">${brandTag(r.brand_id)}${esc(r.name)}</span>`).join('、') : '尚未設定（到客戶資料把老闆或主管設為「週報接收人」，對方需先加該品牌官方帳號好友）'}${w.lastRun ? `｜上次自動推播：${esc(w.lastRun)} 那週` : ''}</p>
  </div>`;
  $('#send-weekly').onclick = () => guard(async () => {
    const r = await api('/api/weekly/send', { method: 'POST' });
    toast(`已推播週報給 ${r.sent} 位${r.failed ? `（${r.failed} 位失敗）` : ''}`);
  });
}

// ---------- 詢問與成交分析 ----------
const LEAD_STATUS = { won: '成交', open: '洽談中', stale: '逾期未標記', lost: '未成交' };
async function loadFunnel(from, to) {
  const f = await api(`/api/funnel?${new URLSearchParams({ from, to, g: reportG, ...reportBrandParams() })}`);
  const t = f.totals;
  const rate = (x) => `${Math.round(x * 100)}%`;
  const meter = (x) => `<div class="meter" style="width:${Math.max(0, Math.min(1, x)) * 100}%"></div>`;
  const label = { day: '日期', week: '週', month: '月份' }[f.granularity];
  $('#funnel-section').innerHTML = (`
    <h2 style="margin-top:28px">詢問與成交</h2>
    <p class="muted">「詢問」＝新客人第一次在 LINE 傳訊息（老客人再來問不算）。之後有訂單＝成交；客服標記原因＝未成交；超過 7 天沒成交也沒標記＝逾期未標記。</p>
    <div class="tiles">
      <div class="tile"><div class="label">新詢問</div><div class="value">${t.leads}</div><div class="sub">位客人</div></div>
      <div class="tile"><div class="label">成交</div><div class="value">${t.won}</div><div class="sub">成交率 ${rate(t.rate)}</div></div>
      <div class="tile"><div class="label">洽談中</div><div class="value">${t.open}</div><div class="sub">7 天內的詢問</div></div>
      <div class="tile"><div class="label">未成交</div><div class="value">${t.lost + t.stale}</div><div class="sub">其中未標記原因 ${t.stale}</div></div>
      <div class="tile"><div class="label">平均成交天數</div><div class="value">${t.avgDaysToWin ?? '—'}</div><div class="sub">詢問到下訂</div></div>
      <div class="tile"><div class="label">新客營業額</div><div class="value">${money(t.revenue)}</div><div class="sub">這些詢問帶來的</div></div>
    </div>

    <div class="card" style="margin-top:12px;border-left:4px solid var(--blue)"><strong>營運建議</strong>
      <ul style="margin:6px 0 0;padding-left:20px">${f.insights.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>

    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px">
      <div><h3>未成交原因</h3><div class="table-wrap"><table><thead><tr><th>原因</th><th>人數</th><th style="width:15%"></th><th>建議</th></tr></thead><tbody>
        ${f.reasons.map((r) => `<tr><td style="white-space:nowrap">${esc(r.reason)}</td><td style="white-space:nowrap">${r.count}<div class="muted">${rate(r.share)}</div></td><td style="min-width:60px">${meter(r.share)}</td><td class="muted">${esc(r.suggestion)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">沒有未成交的詢問</td></tr>'}
      </tbody></table></div></div>
      <div><h3>各品牌成交率</h3><div class="table-wrap"><table><thead><tr><th>品牌</th><th>詢問</th><th>成交</th><th>成交率</th><th style="width:30%"></th></tr></thead><tbody>
        ${f.byBrand.map((b) => `<tr><td>${brandTag(b.brand_id)}</td><td>${b.leads}</td><td>${b.won}</td><td>${rate(b.rate)}</td><td>${meter(b.rate)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">—</td></tr>'}
      </tbody></table></div></div>
    </div>

    <h3>${G_LABEL[f.granularity]}詢問與成交</h3>
    <div class="table-wrap"><table><thead><tr><th>${label}</th><th>新詢問</th><th>成交</th><th>成交率</th><th>洽談中</th><th>未成交</th><th>新客營業額</th></tr></thead><tbody>
      ${[...f.series].reverse().filter((b) => b.leads).map((b) => `<tr><td>${esc(b.label)}</td><td>${b.leads}</td><td>${b.won}</td><td>${rate(b.rate)}</td><td>${b.open}</td><td>${b.lost + b.stale}</td><td>${money(b.revenue)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">這段期間沒有新詢問</td></tr>'}
    </tbody></table></div>

    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px">
      <div><h3>星期幾的詢問</h3><div class="table-wrap"><table><thead><tr><th>星期</th><th>詢問</th><th>成交</th><th>成交率</th></tr></thead><tbody>
        ${[1, 2, 3, 4, 5, 6, 0].map((i) => f.weekdays[i]).map((w) => `<tr><td>星期${w.day}</td><td>${w.leads}</td><td>${w.won}</td><td>${w.leads ? rate(w.won / w.leads) : '—'}</td></tr>`).join('')}
      </tbody></table></div></div>
      <div><h3>待追蹤的詢問</h3><div class="table-wrap"><table><thead><tr><th>客人</th><th>詢問日</th><th>狀態</th></tr></thead><tbody>
        ${f.followUp.map((l) => `<tr class="clickable" data-compose="${l.id}" data-kind="lead"><td>${brandTag(l.brand_id)}${esc(l.name || '')}</td><td>${esc(l.date)}<div class="muted">${l.age} 天前</div></td><td>${LEAD_STATUS[l.status]}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">都處理好了 🎉</td></tr>'}
      </tbody></table></div></div>
    </div>`);
}

const meterBar = (x, cls = '') => `<div class="meter ${cls}" style="width:${Math.max(0, Math.min(1, x || 0)) * 100}%"></div>`;
const fmtMin = (m) => (m == null ? '—' : m < 60 ? `${Math.round(m)} 分鐘` : `${Math.round((m / 60) * 10) / 10} 小時`);

// ---------- 每月營收目標 ----------
async function loadTargets(month) {
  const r = await api(`/api/targets?${new URLSearchParams({ month, ...reportBrandParams() })}`);
  const [y, m] = r.month.split('-');
  $('#targets-card').innerHTML = `<h3>${y} 年 ${Number(m)} 月營收目標</h3>
    <p class="muted">已過 ${r.elapsed} / ${r.days} 天。目標沒設定的月份會沿用最近一次設定的金額；月底預估＝已發生的營業額＋（已排定的後續訂單，或依目前每日平均推估，取較高者）。</p>
    <div class="table-wrap"><table><thead><tr><th>品牌</th><th>目標</th><th>已達成</th><th style="width:22%">進度</th><th>月底預估</th><th>剩下每天需</th></tr></thead><tbody>
      ${r.brands.map((b) => `<tr><td>${brandTag(b.brand_id)}</td>
        <td><input class="target-input" data-target-brand="${b.brand_id}" inputmode="numeric" value="${b.target ?? ''}" placeholder="未設定" aria-label="${esc(b.name)} 目標">${b.targetFrom ? `<div class="muted">沿用 ${esc(b.targetFrom)}</div>` : ''}</td>
        <td>${money(b.achieved)}</td>
        <td>${b.target ? `${meterBar(b.progress, b.progress >= 1 ? 'good' : '')}<div class="muted">${pct(b.progress)}</div>` : '<span class="muted">—</span>'}</td>
        <td>${money(b.projection)}${b.target ? `<div class="${b.projectedRate >= 1 ? 'ok' : b.projectedRate < 0.9 ? 'warn' : 'muted'}">${pct(b.projectedRate)}</div>` : ''}</td>
        <td>${b.perDayNeeded != null ? money(b.perDayNeeded) : '—'}</td></tr>`).join('')}
      ${r.total.target ? `<tr><td><strong>合計</strong></td><td>${money(r.total.target)}</td><td>${money(r.total.achieved)}</td><td>${meterBar(r.total.progress)}<div class="muted">${pct(r.total.progress)}</div></td><td>${money(r.total.projection)}<div class="muted">${pct(r.total.projectedRate)}</div></td><td></td></tr>` : ''}
    </tbody></table></div>`;
  document.querySelectorAll('[data-target-brand]').forEach((inp) => inp.addEventListener('change', () => guard(async () => {
    await api('/api/targets', { method: 'PUT', body: { brandId: Number(inp.dataset.targetBrand), month: r.month, amount: inp.value || 0 } });
    toast('目標已儲存');
    loadTargets(r.month);
  })));
}

// ---------- 客服回覆速度與績效 ----------
async function loadResponse(from, to) {
  const r = await api(`/api/response?${new URLSearchParams({ from, to, ...reportBrandParams() })}`);
  const t = r.totals;
  $('#response-section').innerHTML = `
    <h2 style="margin-top:28px">客服回覆速度與績效</h2>
    <p class="muted">客人傳訊息後多久得到回覆，只計算營業時間 ${r.businessHours[0]}–${r.businessHours[1]} 點。客服在 LINE 官方帳號 App 回覆時 LINE 不會通知本系統，所以依對話節奏估計：客人隔 10 分鐘以上又傳訊息，就當作中間客服回覆過（估計值會比實際稍長）。客服在後台傳訊息或按「已回覆」的是精確時間，並記在該客服名下（不按也沒關係）。適合看趨勢，不適合精準考核。</p>
    <div class="tiles">
      <div class="tile"><div class="label">回覆時間（中位數）</div><div class="value">${t.median == null ? '—' : `約 ${fmtMin(t.median)}`}</div><div class="sub">共 ${t.answered} 次回覆</div></div>
      <div class="tile"><div class="label">1 小時內回覆</div><div class="value">${pct(t.within1h)}</div><div class="sub">&nbsp;</div></div>
      <div class="tile"><div class="label">等超過 4 小時</div><div class="value">${t.over4h}</div><div class="sub">次</div></div>
      <div class="tile"><div class="label">精確／估計</div><div class="value">${t.exact}／${t.estimated}</div><div class="sub">無法判斷 ${t.unknown} 段</div></div>
    </div>
    ${r.insights.length ? `<div class="card" style="margin-top:12px;border-left:4px solid var(--blue)"><strong>建議</strong><ul style="margin:6px 0 0;padding-left:20px">${r.insights.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px">
      <div><h3>各客服 <span class="muted" style="font-weight:normal;font-size:13px">（只含在後台回覆或按「已回覆」的紀錄）</span></h3><div class="table-wrap"><table><thead><tr><th>客服</th><th>回覆</th><th>中位數</th><th>1 小時內</th><th>傳送訊息</th><th>負責詢問</th><th>成交</th></tr></thead><tbody>
        ${r.byStaff.map((x) => `<tr><td>${esc(x.name)}</td><td>${x.replies}</td><td>${fmtMin(x.median)}</td><td>${x.replies ? pct(x.within1h) : '—'}</td><td>${x.messages}</td><td>${x.leads}</td><td>${x.won}${x.leads ? `<div class="muted">${pct(x.rate)}</div>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">這段期間沒有回覆紀錄</td></tr>'}
      </tbody></table></div></div>
      <div><h3>各品牌</h3><div class="table-wrap"><table><thead><tr><th>品牌</th><th>回覆</th><th>中位數</th><th>1 小時內</th><th>無法判斷</th></tr></thead><tbody>
        ${r.byBrand.map((b) => `<tr><td>${brandTag(b.brand_id)}</td><td>${b.waits}</td><td>${fmtMin(b.median)}</td><td>${b.answered ? pct(b.within1h) : '—'}</td><td>${b.unknown}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">—</td></tr>'}
      </tbody></table></div></div>
    </div>
    ${r.byHour.length ? `<h3>客人傳訊時段</h3><div class="table-wrap"><table><thead><tr><th>時段</th><th>回覆</th><th>回覆中位數</th><th style="width:40%"></th></tr></thead><tbody>
      ${(() => { const max = Math.max(1, ...r.byHour.map((h) => h.median || 0)); return r.byHour.map((h) => `<tr><td>${h.hour}:00–${h.hour + 1}:00</td><td>${h.waits}</td><td>${fmtMin(h.median)}</td><td>${h.median != null ? meterBar(h.median / max) : ''}</td></tr>`).join(''); })()}
    </tbody></table></div>` : ''}`;
}

// ---------- 司機與車輛 ----------
async function loadDriverStats(from, to) {
  const r = await api(`/api/driver-stats?${new URLSearchParams({ from, to, ...reportBrandParams() })}`);
  const t = r.totals;
  const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  const maxW = Math.max(1, ...r.weekdays.map((w) => w.avg));
  $('#drivers-section').innerHTML = `
    <h2 style="margin-top:28px">司機與車輛</h2>
    <div class="tiles">
      <div class="tile"><div class="label">行程</div><div class="value">${t.trips}</div><div class="sub">未指派司機 ${t.unassigned} 趟</div></div>
      <div class="tile"><div class="label">平均每天</div><div class="value">${t.avgTripsPerDay}</div><div class="sub">趟</div></div>
      <div class="tile"><div class="label">在職司機</div><div class="value">${t.activeDrivers}</div><div class="sub">位</div></div>
      <div class="tile"><div class="label">司機出勤率</div><div class="value">${t.utilization == null ? '—' : pct(t.utilization)}</div><div class="sub">有行程的日子</div></div>
    </div>
    <div class="card" style="margin-top:12px;border-left:4px solid var(--blue)"><strong>建議</strong><ul style="margin:6px 0 0;padding-left:20px">${r.insights.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px">
      <div><h3>各司機</h3><div class="table-wrap"><table><thead><tr><th>司機</th><th>車輛</th><th>趟數</th><th>出勤天數</th><th>營業額</th></tr></thead><tbody>
        ${r.byDriver.map((d) => `<tr><td>${esc(d.name || '')}</td><td>${esc([d.plate, d.car_model].filter(Boolean).join(' '))}</td><td>${d.trips}<div class="muted">每天 ${d.perDay} 趟</div></td><td>${d.days}</td><td>${money(d.revenue)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">沒有指派司機的行程</td></tr>'}
      </tbody></table></div></div>
      <div><h3>星期幾最忙</h3><div class="table-wrap"><table><thead><tr><th>星期</th><th>平均趟數</th><th style="width:45%"></th></tr></thead><tbody>
        ${r.weekdays.map((w) => `<tr><td>星期${w.day}</td><td>${w.avg}</td><td>${meterBar(w.avg / maxW)}</td></tr>`).join('')}
      </tbody></table></div></div>
      <div><h3>最滿的日子</h3><div class="table-wrap"><table><thead><tr><th>日期</th><th>趟數</th><th>司機</th></tr></thead><tbody>
        ${r.busiestDays.map((d) => `<tr><td>${md(d.date)}（${d.weekday}）</td><td>${d.trips}</td><td>${d.drivers}${d.unassigned ? `<div class="muted">未指派 ${d.unassigned}</div>` : ''}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">—</td></tr>'}
      </tbody></table></div></div>
    </div>`;
}

// ---------- 常用回覆範本 ----------
let TEMPLATE_VARS = {};
async function loadTemplates() {
  const { templates, vars } = await api(`/api/templates?${brandQs()}`);
  TEMPLATE_VARS = vars;
  $('#template-list').innerHTML = templates.map((t) => `<div class="card">
      <div class="row">${t.brand_id ? brandTag(t.brand_id) : '<span class="badge">全部品牌</span>'}<strong>${esc(t.title)}</strong>
        <span class="spacer"></span><span class="muted">${t.updated_by ? `${esc(t.updated_by)} 修改於 ${fmtTime(t.updated_at)}` : ''}</span>
        <button class="small secondary" data-tpl-edit="${t.id}">編輯</button><button class="small danger" data-tpl-del="${t.id}">刪除</button></div>
      <div class="muted" style="white-space:pre-wrap;margin-top:6px">${esc(t.body)}</div>
    </div>`).join('') || '<div class="card empty">還沒有範本，按右上角「新增範本」</div>';
  document.querySelectorAll('[data-tpl-edit]').forEach((b) => b.onclick = () => editTemplate(templates.find((t) => t.id === Number(b.dataset.tplEdit))));
  document.querySelectorAll('[data-tpl-del]').forEach((b) => b.onclick = () => guard(async () => {
    if (!confirm('確定刪除這個範本？')) return;
    await api(`/api/templates/${b.dataset.tplDel}`, { method: 'DELETE' });
    loadTemplates();
  }));
}

function editTemplate(t = {}) {
  const dlg = $('#drawer');
  $('#drawer-body').innerHTML = `<div class="row"><h2>${t.id ? '編輯範本' : '新增範本'}</h2><span class="spacer"></span><button class="secondary" id="close-drawer">關閉</button></div>
    <form id="tpl-form" class="grid" style="margin-top:12px">
      <label>範本名稱<input name="title" required maxlength="60" value="${esc(t.title || '')}"></label>
      <label>適用品牌<select name="brand_id"><option value="">全部品牌共用</option>${BRANDS.map((b) => `<option value="${b.id}" ${b.id === t.brand_id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>
      <label class="wide">內容<textarea name="body" required style="min-height:160px">${esc(t.body || '')}</textarea></label>
      <div class="wide" style="grid-column:1/-1"><span class="muted">點一下插入欄位：</span>${Object.entries(TEMPLATE_VARS).map(([k, v]) => `<button type="button" class="small secondary" data-var="${esc(k)}" title="${esc(v)}" style="margin:2px">{${esc(k)}}</button>`).join('')}</div>
      <div class="row" style="grid-column:1/-1"><button type="submit">儲存</button></div>
    </form>`;
  if (!dlg.open) dlg.showModal();
  $('#close-drawer').onclick = () => dlg.close();
  const ta = $('#tpl-form [name=body]');
  document.querySelectorAll('[data-var]').forEach((b) => b.onclick = () => {
    const ins = `{${b.dataset.var}}`;
    const [s, e] = [ta.selectionStart, ta.selectionEnd];
    ta.value = ta.value.slice(0, s) + ins + ta.value.slice(e);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = s + ins.length;
  });
  $('#tpl-form').onsubmit = (e) => { e.preventDefault(); guard(async () => {
    const body = Object.fromEntries(new FormData(e.target));
    await api(t.id ? `/api/templates/${t.id}` : '/api/templates', { method: t.id ? 'PATCH' : 'POST', body });
    toast('已儲存');
    dlg.close();
  }); };
}
$('#new-template').addEventListener('click', () => guard(async () => {
  if (!Object.keys(TEMPLATE_VARS).length) TEMPLATE_VARS = (await api('/api/templates')).vars;
  editTemplate({ brand_id: currentBrand ? Number(currentBrand) : null });
}));

// ---------- 帳號管理 ----------
// ---------- 資料備份、個資保存 ----------
const fmtSize = (n) => (n >= 1048576 ? `${Math.round((n / 1048576) * 10) / 10} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
async function loadBackups() {
  const b = await api('/api/backups');
  const last = b.last;
  $('#backup-section').innerHTML = `
    <p>${b.auto ? `✅ 每天 ${b.hour}:00 自動備份，保留最近 ${b.keep} 份。` : '⚠️ 自動備份已關閉（AUTO_BACKUP=false）。'}
      ${b.remote ? `<br>☁️ 同時上傳到雲端：<code>${esc(b.remote.endpoint)}/${esc(b.remote.bucket)}/${esc(b.remote.prefix)}</code>` : '<br><span class="warn">⚠️ 尚未設定異地備份：備份只存在同一顆硬碟，硬碟或服務出問題時會一起不見。請依說明設定 Cloudflare R2（免費 10GB）。</span>'}</p>
    ${last ? `<p class="muted">最近一次：${fmtTime(last.at)}｜${esc(last.name)}（${fmtSize(last.size)}）${last.remote ? '｜<span class="ok">已上傳雲端</span>' : ''}${last.remoteError ? `｜<span class="warn">雲端上傳失敗：${esc(last.remoteError)}</span>` : ''}</p>` : '<p class="muted">還沒有自動備份。</p>'}
    <div class="row"><button class="small" id="run-backup">立即備份</button><a class="button small secondary" href="/api/export/backup.db">下載目前完整資料庫</a></div>
    ${b.files.length ? `<div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>備份檔</th><th>大小</th><th></th></tr></thead><tbody>
      ${b.files.map((f) => `<tr><td><code>${esc(f.name)}</code></td><td>${fmtSize(f.size)}</td><td><a href="/api/backups/file/${encodeURIComponent(f.name)}">下載</a></td></tr>`).join('')}
    </tbody></table></div><p class="muted">備份檔是壓縮過的資料庫（.db.gz），解壓縮後就是完整的 crm.db。</p>` : ''}`;
  $('#run-backup').onclick = () => guard(async () => {
    toast('備份中…');
    const r = await api('/api/backups/run', { method: 'POST' });
    toast(r.remoteError ? `已備份到硬碟，但雲端上傳失敗：${r.remoteError}` : `已備份 ${r.name}${r.remote ? '，並上傳雲端' : ''}`);
    loadBackups();
  });
}

async function loadRetention() {
  const r = await api('/api/retention');
  $('#retention-section').innerHTML = `
    <p class="muted">依個資法，蒐集目的消失後應刪除或停止利用個人資料。開啟後，每天會把<strong>超過設定年數沒有任何互動</strong>（傳訊息、下訂單、用車、客服回覆）的客戶匿名化：清除姓名、電話、Email、生日、地址、LINE 帳號、備註與對話內容；訂單金額和日期會保留，營收報表不受影響。還有未完成訂單的客戶、客服、週報接收人、司機不會被匿名化。<strong>匿名化無法復原。</strong></p>
    <div class="row"><label>保存年限 <select id="retention-years">${[0, 1, 2, 3, 5, 7, 10].map((y) => `<option value="${y}" ${y === r.years ? 'selected' : ''}>${y ? `${y} 年` : '關閉（永久保存）'}</option>`).join('')}</select></label>
      ${r.years ? `<span>目前有 <strong>${r.count}</strong> 位客戶超過 ${r.years} 年沒有互動</span>${r.count ? '<button class="small danger" id="run-retention">立即匿名化</button>' : ''}` : ''}</div>
    ${r.sample.length ? `<div class="muted" style="margin-top:6px">例如：${r.sample.map((c) => `<span class="name" data-open="${c.id}">${brandTag(c.brand_id)}${esc(c.name || '')}</span>（最後互動 ${esc(c.last_at || '')}）`).join('、')}</div>` : ''}`;
  $('#retention-years').onchange = (e) => guard(async () => {
    const years = Number(e.target.value);
    if (years && !confirm(`確定要開啟？每天會自動把超過 ${years} 年沒有互動的客戶匿名化，無法復原。`)) { e.target.value = r.years; return; }
    await api('/api/retention', { method: 'PUT', body: { years } });
    toast(years ? `已設定保存 ${years} 年` : '已關閉，資料永久保存');
    loadRetention();
  });
  if ($('#run-retention')) $('#run-retention').onclick = () => guard(async () => {
    if (!confirm(`確定要把 ${r.count} 位客戶匿名化？無法復原。建議先下載一份備份。`)) return;
    const x = await api('/api/retention/run', { method: 'POST' });
    toast(`已匿名化 ${x.anonymized} 位客戶`);
    loadRetention();
  });
}

async function loadAccounts() {
  loadBackups().catch((e) => toast(e.message));
  loadRetention().catch((e) => toast(e.message));
  const [users, activity] = await Promise.all([api('/api/users'), api(`/api/activity?${new URLSearchParams({ user: $('#activity-user').value })}`)]);
  $('#user-table').innerHTML = `<thead><tr><th>名稱</th><th>帳號</th><th>角色</th><th>狀態</th><th>最後登入</th><th></th></tr></thead><tbody>
    <tr><td>管理員</td><td><code>admin</code></td><td>管理員</td><td>啟用</td><td></td><td class="muted">密碼＝ADMIN_PASSWORD</td></tr>
    ${users.map((u) => `<tr>
      <td>${esc(u.display_name)}</td><td><code>${esc(u.username)}</code></td>
      <td><select data-user-role="${u.id}">${Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${k === u.role ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
      <td>${u.active ? '啟用' : '<span class="warn">停用</span>'}</td><td class="muted">${fmtTime(u.last_login_at)}</td>
      <td><button class="small secondary" data-user-reset="${u.id}">重設密碼</button> <button class="small secondary" data-user-active="${u.id}" data-active="${u.active ? 0 : 1}">${u.active ? '停用' : '啟用'}</button></td>
    </tr>`).join('')}</tbody>`;
  const names = ['管理員', ...users.map((u) => u.display_name)];
  const sel = $('#activity-user');
  const cur = sel.value;
  sel.innerHTML = `<option value="">全部人員</option>${names.map((n) => `<option ${n === cur ? 'selected' : ''}>${esc(n)}</option>`).join('')}`;
  $('#activity-table').innerHTML = `<thead><tr><th>時間</th><th>人員</th><th>動作</th><th>內容</th></tr></thead><tbody>${activity.map((a) => `<tr ${a.customer_id ? `class="clickable" data-open="${a.customer_id}"` : ''}>
    <td>${fmtTime(a.at)}</td><td>${esc(a.user_name || '系統')}</td><td>${esc(a.action)}</td><td class="muted">${esc(a.detail || '')}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">尚無紀錄</td></tr>'}</tbody>`;
  document.querySelectorAll('[data-user-role]').forEach((s) => s.onchange = () => guard(async () => { await api(`/api/users/${s.dataset.userRole}`, { method: 'PATCH', body: { role: s.value } }); toast('已更新'); loadAccounts(); }));
  document.querySelectorAll('[data-user-active]').forEach((b) => b.onclick = () => guard(async () => { await api(`/api/users/${b.dataset.userActive}`, { method: 'PATCH', body: { active: b.dataset.active === '1' } }); loadAccounts(); }));
  document.querySelectorAll('[data-user-reset]').forEach((b) => b.onclick = () => guard(async () => {
    const pw = prompt('輸入新密碼（至少 8 個字）');
    if (!pw) return;
    await api(`/api/users/${b.dataset.userReset}`, { method: 'PATCH', body: { password: pw } });
    toast('已重設，對方需要用新密碼重新登入');
  }));
}
$('#activity-user').addEventListener('change', () => guard(loadAccounts));
$('#new-user').addEventListener('click', () => {
  const dlg = $('#drawer');
  $('#drawer-body').innerHTML = `<div class="row"><h2>新增帳號</h2><span class="spacer"></span><button class="secondary" id="close-drawer">關閉</button></div>
    <form id="user-new" class="grid" style="margin-top:12px">
      <label>顯示名稱（會記錄在訊息與操作紀錄）<input name="display_name" required></label>
      <label>登入帳號（英數字）<input name="username" required pattern="[a-zA-Z0-9._\\-]{2,30}" autocomplete="off"></label>
      <label>密碼（至少 8 個字）<input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
      <label>角色<select name="role">${Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${k === 'staff' ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <div class="row" style="grid-column:1/-1"><button type="submit">建立</button></div>
    </form>`;
  dlg.showModal();
  $('#close-drawer').onclick = () => dlg.close();
  $('#user-new').onsubmit = (e) => { e.preventDefault(); guard(async () => {
    await api('/api/users', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    toast('已建立帳號');
    dlg.close();
  }); };
});
$('#logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login';
});
$('#change-password').addEventListener('click', () => guard(async () => {
  const current = prompt('目前的密碼');
  if (!current) return;
  const password = prompt('新密碼（至少 8 個字）');
  if (!password) return;
  if (prompt('再輸入一次新密碼') !== password) throw new Error('兩次輸入的新密碼不一樣');
  await api('/api/me/password', { method: 'POST', body: { current, password } });
  alert('密碼已修改，請用新密碼重新登入');
  location.href = '/login';
}));

const LOADERS = { focus: loadFocus, repurchase: loadRepurchase, customers: loadCustomers, orders: loadOrders, dispatch: loadDispatch, templates: loadTemplates, report: loadReport, brands: loadBrands, accounts: loadAccounts, search: loadSearch };
guard(async () => { await loadStatus(); await loadFocus(); });
