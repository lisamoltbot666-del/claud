import fs from 'node:fs';
import path from 'node:path';

// 簡易 .env 讀取（不需額外套件）；已存在的環境變數優先
export function loadEnvFile(file = path.resolve('.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const int = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v) => /^(1|true|yes|on)$/i.test(String(v ?? ''));

export function getConfig(env = process.env) {
  return {
    channelSecret: env.LINE_CHANNEL_SECRET || '',
    channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN || '',
    adminPassword: env.ADMIN_PASSWORD || '',
    port: int(env.PORT, 3000),
    dbPath: env.DB_PATH || './data/crm.db',
    tz: env.TZ_NAME || 'Asia/Taipei',
    dailyReportHour: int(env.DAILY_REPORT_HOUR, 9),
    staffUserIds: (env.STAFF_LINE_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
    paymentDueDays: int(env.PAYMENT_DUE_DAYS, 3),
    defaultReorderDays: int(env.DEFAULT_REORDER_DAYS, 30),
    newFriendDays: int(env.NEW_FRIEND_DAYS, 7),
    reminderCooldownDays: int(env.REMINDER_COOLDOWN_DAYS, 3),
    autoPaymentReminder: bool(env.AUTO_PAYMENT_REMINDER),
    autoReorderReminder: bool(env.AUTO_REORDER_REMINDER),
    bankInfo: env.BANK_INFO || '',
    shopName: env.SHOP_NAME || '本店',
    // 預先建立的品牌：「代號:名稱:顏色」以逗號分隔，例如 lumi:璐米:#d6336c,lijie:利捷
    initialBrands: (env.INITIAL_BRANDS || '').split(',').map((s) => s.trim()).filter(Boolean).map((item) => {
      const [slug, name, color] = item.split(':').map((s) => s.trim());
      return { slug, name: name || slug, ...(color ? { color } : {}) };
    }),
  };
}
