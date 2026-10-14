// 合併重複客戶：同一個人可能被建立兩次（例如先從舊系統匯入，之後才在 LINE 傳訊息）。
// 合併後只留下一筆：訂單、對話、提醒紀錄全部搬過來，空白的資料欄位用另一筆補上。

const PROFILE_FIELDS = ['display_name', 'picture_url', 'status_message', 'real_name', 'phone', 'email', 'birthday', 'gender', 'address', 'reorder_days', 'next_contact_date', 'followed_at'];

export const phoneKey = (v) => {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-9) : '';
};
const nameKey = (v) => String(v ?? '').replace(/\s+/g, '').toLowerCase();

function mergeText(a, b, sep) {
  const parts = [a, b].map((x) => String(x ?? '').trim()).filter(Boolean);
  return [...new Set(parts)].join(sep) || null;
}

function mergeTags(a, b) {
  const tags = [a, b].flatMap((x) => String(x ?? '').split(/[,，]/)).map((t) => t.trim()).filter(Boolean);
  return [...new Set(tags)].join(',') || null;
}

const later = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

/** 把 removeId 合併進 keepId，回傳合併後的客戶 */
export function mergeCustomers(store, keepId, removeId) {
  if (keepId === removeId) throw new Error('不能和自己合併');
  const keep = store.getCustomer(keepId);
  const remove = store.getCustomer(removeId);
  if (!keep || !remove) throw new Error('找不到客戶');
  if (keep.brand_id !== remove.brand_id) throw new Error('不同品牌的客戶不能合併（各品牌的 LINE 帳號是分開的）');
  if (keep.line_user_id && remove.line_user_id && keep.line_user_id !== remove.line_user_id) {
    throw new Error('兩筆都連結了不同的 LINE 帳號，無法合併');
  }

  const fields = {};
  for (const f of PROFILE_FIELDS) if ((keep[f] == null || keep[f] === '') && remove[f] != null && remove[f] !== '') fields[f] = remove[f];
  fields.tags = mergeTags(keep.tags, remove.tags);
  fields.note = mergeText(keep.note, remove.note, '\n');
  const lineUserId = keep.line_user_id || remove.line_user_id;
  const isFriend = keep.line_user_id ? keep.is_friend : remove.line_user_id ? remove.is_friend : Math.max(keep.is_friend, remove.is_friend);

  const staff = store.staffIds();
  store.db.exec('BEGIN');
  try {
    for (const table of ['orders', 'messages', 'reminders']) store.run(`UPDATE ${table} SET customer_id = ? WHERE customer_id = ?`, keepId, removeId);
    store.run('DELETE FROM customers WHERE id = ?', removeId); // 先刪除，才能把 LINE userId 移過來（同品牌 userId 不可重複）
    const keys = Object.keys(fields);
    store.run(
      `UPDATE customers SET ${keys.map((k) => `${k} = ?`).join(', ')}, line_user_id = ?, is_friend = ?,
         last_inbound_at = ?, last_handled_at = ?, created_at = ?, updated_at = ? WHERE id = ?`,
      ...keys.map((k) => fields[k]), lineUserId, isFriend,
      later(keep.last_inbound_at, remove.last_inbound_at), later(keep.last_handled_at, remove.last_handled_at),
      keep.created_at < remove.created_at ? keep.created_at : remove.created_at, new Date().toISOString(), keepId,
    );
    store.db.exec('COMMIT');
  } catch (e) {
    store.db.exec('ROLLBACK');
    throw e;
  }
  if (staff.includes(removeId)) {
    store.setStaff(removeId, false);
    store.setStaff(keepId, true);
  }
  return store.getCustomer(keepId);
}

// 找出可能是同一人的客戶：同品牌、電話相同，或姓名／LINE 名稱相同
export function findDuplicates(store, { brandId = null, customerId = null } = {}) {
  const rows = brandId ? store.all('SELECT * FROM customers WHERE brand_id = ?', brandId) : store.all('SELECT * FROM customers');
  const groups = new Map(); // key → ids
  const add = (key, id) => {
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key).add(id);
  };
  for (const c of rows) {
    if (phoneKey(c.phone)) add(`${c.brand_id}|phone|${phoneKey(c.phone)}`, c.id);
    for (const n of new Set([nameKey(c.real_name), nameKey(c.display_name)])) if (n.length >= 2) add(`${c.brand_id}|name|${n}`, c.id);
  }
  // 合併有交集的群組
  const parent = new Map();
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  for (const ids of groups.values()) {
    const list = [...ids];
    for (const id of list) if (!parent.has(id)) parent.set(id, id);
    for (const id of list.slice(1)) parent.set(find(id), find(list[0]));
  }
  const clusters = new Map();
  for (const ids of groups.values()) {
    if (ids.size < 2) continue;
    for (const id of ids) {
      const root = find(id);
      if (!clusters.has(root)) clusters.set(root, new Set());
      clusters.get(root).add(id);
    }
  }
  const byId = new Map(rows.map((c) => [c.id, c]));
  const orderCount = (id) => store.get("SELECT COUNT(*) AS n FROM orders WHERE customer_id = ? AND status != 'cancelled'", id).n;
  let result = [...clusters.values()].map((ids) => [...ids].map((id) => ({ ...byId.get(id), order_count: orderCount(id) }))
    // LINE 好友排前面（建議保留這一筆）
    .sort((a, b) => Boolean(b.line_user_id) - Boolean(a.line_user_id) || b.order_count - a.order_count || a.id - b.id));
  if (customerId) result = result.filter((g) => g.some((c) => c.id === customerId));
  return result;
}
