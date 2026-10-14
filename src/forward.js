// 把 LINE 送來的 Webhook 原封不動轉送給品牌原本使用的系統（同樣的內容與 x-line-signature），
// 讓舊系統照常運作。只轉送已驗證簽章的請求，並帶上 x-crm-forwarded 避免互相轉送造成迴圈。

export const FORWARD_HEADER = 'x-crm-forwarded';

export function forwardStatus(store, brandId) {
  try {
    return JSON.parse(store.getKv(`forward_status:${brandId}`) || 'null');
  } catch {
    return null;
  }
}

export async function forwardWebhook({ store, brand, raw, signature, fetchImpl = globalThis.fetch, logger = console, timeoutMs = 10_000 }) {
  const status = { at: new Date().toISOString(), url: brand.forward_url };
  try {
    const res = await fetchImpl(brand.forward_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'x-line-signature': signature, [FORWARD_HEADER]: '1' },
      body: raw,
      signal: AbortSignal.timeout(timeoutMs),
    });
    status.ok = res.ok;
    status.status = res.status;
    if (!res.ok) status.error = `HTTP ${res.status}`;
  } catch (e) {
    status.ok = false;
    status.error = e.name === 'TimeoutError' ? `逾時（${timeoutMs / 1000} 秒無回應）` : e.message;
  }
  if (!status.ok) logger.error(`轉送「${brand.name}」Webhook 到 ${brand.forward_url} 失敗：${status.error}`);
  store.setKv(`forward_status:${brand.id}`, JSON.stringify(status));
  return status;
}
