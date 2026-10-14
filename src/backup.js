import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { today } from './dates.js';

// 自動備份：每天把整個資料庫壓縮存一份在硬碟（保留最近 BACKUP_KEEP 份），
// 有設定 S3 相容的雲端儲存（Cloudflare R2、Backblaze B2、AWS S3…）就同時上傳一份到異地，
// 這樣就算 Render 的硬碟或服務出問題，資料也還在。

const NAME_RE = /^crm-\d{4}-\d{2}-\d{2}(-\d{6})?\.db\.gz$/;

export function backupDir(config) {
  if (config.backupDir) return config.backupDir;
  if (!config.dbPath || config.dbPath === ':memory:') return null;
  return path.join(path.dirname(path.resolve(config.dbPath)), 'backups');
}

export function remoteConfigured(config) {
  const s = config.backupS3;
  return Boolean(s?.endpoint && s.bucket && s.accessKeyId && s.secretAccessKey);
}

export function listBackups(config) {
  const dir = backupDir(config);
  if (!dir || !fs.existsSync(dir)) return [];
  const key = (f) => f.replace(/\.db\.gz$/, '');
  return fs.readdirSync(dir).filter((f) => NAME_RE.test(f)).sort((a, b) => (key(a) < key(b) ? 1 : -1))
    .map((name) => ({ name, size: fs.statSync(path.join(dir, name)).size }));
}

export function backupFile(config, name) {
  const dir = backupDir(config);
  if (!dir || !NAME_RE.test(name || '')) return null;
  const file = path.join(dir, name);
  return fs.existsSync(file) ? file : null;
}

// ---------- AWS Signature V4（S3 相容儲存共用）----------
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const encodePath = (p) => p.split('/').map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

export function signV4({ method, url, headers = {}, payloadHash, accessKeyId, secretAccessKey, region = 'auto', service = 's3', date = new Date() }) {
  const u = new URL(url);
  const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const all = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])), host: u.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(all).sort();
  const query = [...u.searchParams].map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)]).sort().map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [method, encodePath(u.pathname), query, ...names.map((n) => `${n}:${all[n]}`), '', names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return {
    ...all,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

export async function uploadRemote(config, name, body, fetchImpl = fetch) {
  const s = config.backupS3;
  const key = `${(s.prefix || '').replace(/^\/+/, '')}${name}`;
  const url = `${s.endpoint.replace(/\/+$/, '')}/${s.bucket}/${key}`;
  const headers = signV4({ method: 'PUT', url, headers: { 'content-type': 'application/gzip' }, payloadHash: sha256(body), accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey, region: s.region || 'auto' });
  delete headers.host;
  const res = await fetchImpl(url, { method: 'PUT', headers, body });
  if (!res.ok) throw new Error(`雲端備份上傳失敗（HTTP ${res.status}）${(await res.text().catch(() => '')).slice(0, 200)}`);
  return key;
}

// 執行一次備份；回傳結果並記錄在 kv 'backup_last'
export async function runBackup(store, config, { now = new Date(), fetchImpl = fetch, logger = console } = {}) {
  const dir = backupDir(config);
  if (!dir) throw new Error('沒有設定資料庫檔案位置，無法備份');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Intl.DateTimeFormat('en-GB', { timeZone: config.tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(now).replace(/:/g, '');
  let name = `crm-${today(config.tz, now)}.db.gz`;
  if (fs.existsSync(path.join(dir, name))) name = name.replace('.db.gz', `-${stamp}.db.gz`);
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}.db`);
  let body;
  try {
    store.backupTo(tmp);
    body = zlib.gzipSync(fs.readFileSync(tmp));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  fs.writeFileSync(path.join(dir, name), body);
  // 只保留最近幾份
  for (const old of listBackups(config).slice(Math.max(1, config.backupKeep))) fs.rmSync(path.join(dir, old.name), { force: true });

  const result = { at: now.toISOString(), name, size: body.length, remote: null, remoteError: null };
  if (remoteConfigured(config)) {
    try {
      result.remote = await uploadRemote(config, name, body, fetchImpl);
    } catch (e) {
      result.remoteError = e.message;
      logger.error(`[備份] ${e.message}`);
    }
  }
  store.setKv('backup_last', JSON.stringify(result));
  return result;
}

export function lastBackup(store) {
  try {
    return JSON.parse(store.getKv('backup_last') || 'null');
  } catch {
    return null;
  }
}
