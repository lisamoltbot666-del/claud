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
    // 每週營運週報在星期幾推播（0＝星期日、1＝星期一…；-1 關閉），時間同每日清單
    weeklyReportDay: int(env.WEEKLY_REPORT_DAY, 1),
    // 營業時間（計算客服回覆速度用），例：9-21
    businessHours: (() => {
      const m = String(env.BUSINESS_HOURS || '9-21').match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
      const [a, b] = m ? [Number(m[1]), Number(m[2])] : [9, 21];
      return a < b && b <= 24 ? [a, b] : [9, 21];
    })(),
    staffUserIds: (env.STAFF_LINE_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
    paymentDueDays: int(env.PAYMENT_DUE_DAYS, 3),
    defaultReorderDays: int(env.DEFAULT_REORDER_DAYS, 90),
    newFriendDays: int(env.NEW_FRIEND_DAYS, 7),
    // 服務完成後幾天提醒傳回購邀請
    rebookDays: int(env.REBOOK_DAYS, 30),
    reminderCooldownDays: int(env.REMINDER_COOLDOWN_DAYS, 3),
    autoPaymentReminder: bool(env.AUTO_PAYMENT_REMINDER),
    autoReorderReminder: bool(env.AUTO_REORDER_REMINDER),
    // 客人傳「查訂單」、匯款通知時是否自動回覆；預設關閉，系統只記錄不回覆
    autoReply: bool(env.AUTO_REPLY),
    // 是否接受 HTTP Basic 登入（僅供程式串接或測試；瀏覽器請用登入頁）
    basicAuth: bool(env.BASIC_AUTH),
    autoTripReminder: bool(env.AUTO_TRIP_REMINDER),
    // 自動備份：每天在每日清單時間備份一次（AUTO_BACKUP=false 關閉），保留最近 BACKUP_KEEP 份
    autoBackup: env.AUTO_BACKUP === undefined || env.AUTO_BACKUP === '' ? true : bool(env.AUTO_BACKUP),
    backupDir: env.BACKUP_DIR || '',
    backupKeep: Math.max(1, int(env.BACKUP_KEEP, 14)),
    // 異地備份：S3 相容儲存（Cloudflare R2、Backblaze B2、AWS S3）
    backupS3: {
      endpoint: env.BACKUP_S3_ENDPOINT || '',
      bucket: env.BACKUP_S3_BUCKET || '',
      accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID || '',
      secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY || '',
      region: env.BACKUP_S3_REGION || 'auto',
      prefix: env.BACKUP_S3_PREFIX ?? 'crm-backups/',
    },
    bankInfo: env.BANK_INFO || '',
    shopName: env.SHOP_NAME || '本店',
    // 預先建立的品牌：「代號:名稱:顏色」以逗號分隔，例如 lumi:璐米:#d6336c,lijie:利捷
    initialBrands: (env.INITIAL_BRANDS || '').split(',').map((s) => s.trim()).filter(Boolean).map((item) => {
      const [slug, name, color] = item.split(':').map((s) => s.trim());
      return { slug, name: name || slug, ...(color ? { color } : {}) };
    }),
  };
}
