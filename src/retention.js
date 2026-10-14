import { addDays, today } from './dates.js';

// 個資保存規則（個資法：蒐集目的消失或期限屆滿應刪除或停止利用）：
// 超過 N 年沒有任何互動（傳訊息、下訂單、用車、被客服回覆）的客戶，自動匿名化——
// 清除姓名、電話、Email、生日、地址、LINE 帳號、備註與對話內容；訂單金額與日期保留（營收報表才不會變）。
// 尚有未完成訂單的客戶、客服 / 週報接收人 / 司機不會被匿名化。預設關閉，由管理員在後台設定年數。

export const ANON_NAME = '已匿名客戶';

export function retentionYears(store) {
  const n = Number(store.getKv('retention_years') || 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function setRetentionYears(store, years) {
  const n = Number(years);
  if (!Number.isInteger(n) || n < 0 || n > 20) throw new Error('保存年限需為 0（關閉）～ 20 年');
  if (n > 0 && n < 1) throw new Error('保存年限至少 1 年');
  store.setKv('retention_years', String(n));
  return n;
}

// 超過保存期限的客戶
export function findExpired(store, config, years, now = new Date()) {
  if (!years) return [];
  const t = today(config.tz, now);
  const cutoffDate = addDays(t, -Math.round(years * 365.25));
  const cutoff = `${cutoffDate}T00:00:00.000Z`;
  const internal = store.internalIds();
  return store.all(
    `SELECT c.id, c.brand_id, c.display_name, c.real_name, c.created_at,
            MAX(COALESCE(c.last_inbound_at, ''), COALESCE(c.last_handled_at, ''), c.created_at,
                COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.customer_id = c.id), '')) AS last_at,
            (SELECT MAX(MAX(COALESCE(o.return_date, ''), COALESCE(o.service_date, ''), o.order_date)) FROM orders o WHERE o.customer_id = c.id) AS last_order
     FROM customers c
     WHERE c.anonymized_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.status IN ('pending_payment','paid','shipped') AND COALESCE(o.service_date, o.order_date) >= ?)
     ORDER BY c.id`,
    cutoffDate,
  ).filter((c) => !internal.has(c.id) && c.last_at < cutoff && (!c.last_order || c.last_order < cutoffDate));
}

export function anonymize(store, ids) {
  const now = new Date().toISOString();
  store.db.exec('BEGIN');
  try {
    for (const id of ids) {
      store.run(`UPDATE customers SET display_name = ?, picture_url = NULL, status_message = NULL, real_name = NULL, phone = NULL, email = NULL,
        birthday = NULL, gender = NULL, address = NULL, tags = NULL, note = NULL, line_user_id = NULL, is_friend = 0, next_contact_date = NULL,
        lead_lost_note = NULL, anonymized_at = ?, updated_at = ? WHERE id = ?`, ANON_NAME, now, now, id);
      store.run('UPDATE orders SET flight_no = NULL, pickup = NULL, dropoff = NULL, payment_report = NULL, note = NULL WHERE customer_id = ?', id);
      store.run('DELETE FROM messages WHERE customer_id = ?', id);
      store.run('UPDATE reminders SET text = NULL WHERE customer_id = ?', id);
      store.run('UPDATE activity SET detail = NULL WHERE customer_id = ?', id);
    }
    store.db.exec('COMMIT');
  } catch (e) {
    store.db.exec('ROLLBACK');
    throw e;
  }
  return ids.length;
}

// 依設定執行一次；回傳匿名化的人數
export function applyRetention(store, config, { now = new Date(), user = '系統自動' } = {}) {
  const years = retentionYears(store);
  if (!years) return 0;
  const expired = findExpired(store, config, years, now);
  if (!expired.length) return 0;
  anonymize(store, expired.map((c) => c.id));
  store.logActivity({ user, action: '依個資保存規則匿名化', detail: `${expired.length} 位（超過 ${years} 年無互動）` });
  return expired.length;
}
