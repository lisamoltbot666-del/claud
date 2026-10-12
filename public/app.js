const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('zh-TW', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
const money = (n) => `NT$${Number(n || 0).toLocaleString()}`;
const nameOf = (c) => c.real_name || c.display_name || `客戶#${c.id}`;
const PRIORITY = { 1: '緊急', 2: '今日', 3: '有空時' };
const KIND_LABEL = { payment: '匯款提醒', reorder: '回購提醒', care: '關心問候', custom: '訊息' };
let STATUSES = {};
let currentCustomerId = null;

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
  for (const t of ['focus', 'customers', 'orders']) $(`#tab-${t}`).hidden = t !== tab;
  ({ focus: loadFocus, customers: loadCustomers, orders: loadOrders })[tab]();
}

// ---------- status ----------
async function loadStatus() {
  const s = await api('/api/status');
  STATUSES = s.orderStatuses;
  $('#order-status').innerHTML = `<option value="">全部狀態</option>${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}`;
  const warn = s.lineConfigured ? '' : '⚠ 尚未設定 LINE 金鑰｜';
  $('#status').textContent = `${warn}今天 ${s.today}｜每日 ${s.dailyReportHour}:00 推播給 ${s.staffCount} 位客服｜自動匯款提醒：${s.autoPaymentReminder ? '開' : '關'}｜自動回購提醒：${s.autoReorderReminder ? '開' : '關'}`;
}

// ---------- focus ----------
async function loadFocus() {
  const data = await api('/api/focus');
  $('#focus-title').textContent = `今日關懷清單 ${data.date}（${data.items.length} 位）`;
  const list = $('#focus-list');
  if (!data.items.length) { list.innerHTML = '<div class="card empty">今天沒有需要特別關心的客戶 🎉</div>'; return; }
  list.innerHTML = data.items.map((item) => {
    const c = item.customer;
    const actions = new Set(item.reasons.map((r) => r.action));
    const payOrder = item.reasons.find((r) => r.action === 'payment')?.orderId;
    const verifyOrder = item.reasons.find((r) => r.action === 'verify')?.orderId;
    return `<div class="card focus-item p${item.priority}">
      ${c.picture_url ? `<img class="avatar" src="${esc(c.picture_url)}" alt="">` : '<div class="avatar"></div>'}
      <div>
        <span class="name" data-open="${c.id}">${esc(nameOf(c))}</span>
        ${c.real_name && c.display_name ? `<span class="muted">（LINE：${esc(c.display_name)}）</span>` : ''}
        ${c.tags ? `<span class="muted">｜${esc(c.tags)}</span>` : ''}
        ${item.canPush ? '' : '<span class="badge">非好友，無法推播</span>'}
        <ul class="reasons">${item.reasons.map((r) => `<li><span class="badge p${r.priority}">${PRIORITY[r.priority]}</span>${esc(r.label)} <span class="muted">${esc(r.detail || '')}${r.remindCount ? `｜已提醒 ${r.remindCount} 次，最近 ${fmtTime(r.lastRemindedAt)}` : ''}</span></li>`).join('')}</ul>
      </div>
      <div class="actions">
        ${verifyOrder ? `<button class="small" data-paid="${verifyOrder}">確認已入帳</button>` : ''}
        ${actions.has('payment') && item.canPush ? `<button class="small" data-compose="${c.id}" data-kind="payment" data-order="${payOrder}">發送匯款提醒</button>` : ''}
        ${actions.has('reorder') && item.canPush ? `<button class="small" data-compose="${c.id}" data-kind="reorder">發送回購提醒</button>` : ''}
        ${actions.has('care') && item.canPush ? `<button class="small" data-compose="${c.id}" data-kind="care">發送關心問候</button>` : ''}
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
  toast(`已通知 ${r.staffNotified} 位客服，自動匯款提醒 ${r.paymentSent} 則、回購提醒 ${r.reorderSent} 則`);
  loadFocus();
}));

// ---------- customers ----------
async function loadCustomers() {
  const q = encodeURIComponent($('#customer-q').value.trim());
  const tag = encodeURIComponent($('#customer-tag').value.trim());
  const rows = await api(`/api/customers?q=${q}&tag=${tag}`);
  $('#customer-table').innerHTML = `<thead><tr><th></th><th>名稱</th><th>電話</th><th>標籤</th><th>訂單數</th><th>累積消費</th><th>最後下單</th><th>最後訊息</th><th>好友</th></tr></thead>
  <tbody>${rows.length ? rows.map((c) => `<tr class="clickable" data-open="${c.id}">
    <td>${c.picture_url ? `<img class="avatar" style="width:28px;height:28px" src="${esc(c.picture_url)}" alt="">` : ''}</td>
    <td>${esc(nameOf(c))}${c.real_name && c.display_name ? `<div class="muted">${esc(c.display_name)}</div>` : ''}</td>
    <td>${esc(c.phone)}</td><td>${esc(c.tags)}</td><td>${c.order_count}</td><td>${money(c.total_spent)}</td>
    <td>${esc(c.last_order_date || '')}</td><td>${fmtTime(c.last_inbound_at)}</td><td>${c.is_friend ? '✅' : '—'}</td>
  </tr>`).join('') : '<tr><td colspan="9" class="empty">尚無客戶。客戶加入官方帳號好友或傳訊息後會自動出現在這裡。</td></tr>'}</tbody>`;
}
let searchTimer;
['#customer-q', '#customer-tag'].forEach((s) => $(s).addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => guard(loadCustomers), 250); }));
$('#new-customer').addEventListener('click', () => guard(async () => {
  const name = prompt('客戶名稱（非 LINE 好友的客戶也可以手動建立）');
  if (!name) return;
  const c = await api('/api/customers', { method: 'POST', body: { display_name: name } });
  loadCustomers();
  openCustomer(c.id);
}));
$('#sync-followers').addEventListener('click', () => guard(async () => {
  toast('同步中…');
  const r = await api('/api/sync-followers', { method: 'POST' });
  toast(`好友共 ${r.total} 位，新增 ${r.added} 位`);
  loadCustomers();
}));

// ---------- orders ----------
async function loadOrders() {
  const rows = await api(`/api/orders?status=${$('#order-status').value}`);
  $('#order-table').innerHTML = `<thead><tr><th>#</th><th>日期</th><th>客戶</th><th>品項</th><th>金額</th><th>狀態</th><th>匯款期限</th><th>匯款回報</th></tr></thead>
  <tbody>${rows.length ? rows.map((o) => `<tr class="clickable" data-open="${o.customer_id}">
    <td>${o.id}</td><td>${esc(o.order_date)}</td><td>${esc(o.real_name || o.display_name)}</td><td>${esc(o.items)}</td><td>${money(o.amount)}</td>
    <td>${esc(STATUSES[o.status])}</td><td>${o.status === 'pending_payment' ? esc(o.payment_due_date || '') : ''}</td><td>${esc(o.payment_report || '')}</td>
  </tr>`).join('') : '<tr><td colspan="8" class="empty">沒有訂單</td></tr>'}</tbody>`;
}
$('#order-status').addEventListener('change', () => guard(loadOrders));

// ---------- customer drawer ----------
async function openCustomer(id, compose = null) {
  currentCustomerId = id;
  const { customer: c, orders, messages, reminders } = await api(`/api/customers/${id}`);
  const canPush = c.line_user_id && c.is_friend;
  const pendingOrders = orders.filter((o) => o.status === 'pending_payment');
  const field = (key, label, type = 'text', wide = false) => `<label class="${wide ? 'wide' : ''}">${label}${type === 'textarea' ? `<textarea name="${key}">${esc(c[key])}</textarea>` : `<input name="${key}" type="${type}" value="${esc(c[key])}">`}</label>`;

  $('#drawer-body').innerHTML = `
    <div class="row">
      ${c.picture_url ? `<img class="avatar" src="${esc(c.picture_url)}" alt="">` : ''}
      <div><h2>${esc(nameOf(c))}</h2><div class="muted">${c.line_user_id ? `LINE userId：${esc(c.line_user_id)}` : '手動建立（非 LINE 好友）'}｜${c.is_friend ? '好友' : '非好友／已封鎖'}｜加入 ${fmtTime(c.followed_at || c.created_at)}</div></div>
      <span class="spacer"></span>
      <button class="secondary" id="close-drawer">關閉</button>
    </div>

    <h3>客戶資料</h3>
    <form id="customer-form" class="grid">
      ${field('display_name', 'LINE 名稱')}${field('real_name', '真實姓名')}${field('phone', '電話', 'tel')}
      ${field('tags', '標籤（逗號分隔，如 VIP,團購）')}${field('reorder_days', '回購週期（天，空白自動推算）', 'number')}${field('next_contact_date', '下次聯絡日', 'date')}
      ${field('address', '地址', 'text', true)}${field('note', '備註（喜好、注意事項…）', 'textarea', true)}
      <div class="row wide" style="grid-column:1/-1"><button type="submit">儲存資料</button><span class="spacer"></span><button type="button" class="danger small" id="delete-customer">刪除客戶</button></div>
    </form>

    <h3>訂單</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>#</th><th>日期</th><th>品項</th><th>金額</th><th>狀態</th><th>匯款期限 / 回報</th><th></th></tr></thead>
      <tbody>${orders.map((o) => `<tr>
        <td>${o.id}</td><td>${esc(o.order_date)}</td><td>${esc(o.items)}</td><td>${money(o.amount)}</td>
        <td><select data-order-status="${o.id}">${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}" ${k === o.status ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
        <td>${o.status === 'pending_payment' ? `${esc(o.payment_due_date || '')}${o.payment_report ? `<div class="muted">回報：${esc(o.payment_report)}</div>` : ''}` : `<span class="muted">${o.paid_at ? `入帳 ${fmtTime(o.paid_at)}` : ''}</span>`}</td>
        <td>${o.status === 'pending_payment' ? `<button class="small" data-paid="${o.id}">確認入帳</button>` : ''} <button class="small secondary" data-del-order="${o.id}">刪除</button></td>
      </tr>`).join('') || '<tr><td colspan="7" class="empty">尚無訂單</td></tr>'}</tbody>
    </table></div>
    <form id="order-form" class="row" style="margin-top:8px">
      <input name="items" placeholder="品項（如：滴雞精 x10）" style="flex:2">
      <input name="amount" type="number" placeholder="金額" style="width:110px" required>
      <input name="order_date" type="date" title="訂單日期（預設今天）">
      <select name="status"><option value="pending_payment">待匯款</option><option value="paid">已匯款</option><option value="completed">已完成</option></select>
      <button type="submit">新增訂單</button>
    </form>

    <h3>發送 LINE 訊息 ${canPush ? '' : '<span class="badge">非好友，無法推播</span>'}</h3>
    <div class="row" style="margin-bottom:6px">
      ${pendingOrders.map((o) => `<button class="small secondary" data-template="payment" data-order="${o.id}">匯款提醒 #${o.id}</button>`).join('')}
      <button class="small secondary" data-template="reorder">回購提醒</button>
      <button class="small secondary" data-template="care">關心問候</button>
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
  $('#customer-form').onsubmit = (e) => { e.preventDefault(); guard(async () => {
    await api(`/api/customers/${id}`, { method: 'PATCH', body: Object.fromEntries(new FormData(e.target)) });
    toast('已儲存'); openCustomer(id);
  }); };
  $('#delete-customer').onclick = () => guard(async () => {
    if (!confirm(`確定刪除「${nameOf(c)}」及其所有訂單、訊息紀錄？`)) return;
    await api(`/api/customers/${id}`, { method: 'DELETE' });
    dlg.close();
  });
  $('#order-form').onsubmit = (e) => { e.preventDefault(); guard(async () => {
    await api('/api/orders', { method: 'POST', body: { customer_id: id, ...Object.fromEntries(new FormData(e.target)) } });
    toast('已新增訂單'); openCustomer(id);
  }); };
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

$('#drawer').addEventListener('close', () => { currentCustomerId = null; refreshCurrentTab(); });
function refreshCurrentTab() {
  const tab = document.querySelector('nav button.active').dataset.tab;
  guard(({ focus: loadFocus, customers: loadCustomers, orders: loadOrders })[tab]);
}

// 共用的點擊事件
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-open],[data-compose],[data-handled],[data-postpone],[data-paid]');
  if (!t) return;
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

guard(async () => { await loadStatus(); await loadFocus(); });
