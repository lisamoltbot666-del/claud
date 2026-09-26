# 南部同業派單平台

給機場接送、包車同業互相派單的免費平台。手機網頁就能用，不用上架 App。

- 只收 **職業駕照 + R 牌租賃車** 的司機（上傳駕照、行照，管理員人工審核）
- 車行／同業可以用「發單方」身分加入，只發單
- 免費、不抽成；車資與回金由雙方自行結算，平台只做紀錄
- 新單用 LINE 官方帳號推播給地區、車型符合的司機，先接先得（同時按只有一人成功）
- 接單後才看得到客人資訊；雙向評價；臨時退單、放鳥記點
- 每月對帳頁與 Excel（CSV）下載

技術：Cloudflare Workers + D1（資料庫）+ R2（證件照），程式在 `src/`。

## 架設步驟

需要一個 Cloudflare 帳號（免費方案即可）。

```bash
cd dispatch
npm install
npx wrangler login

# 1. 建資料庫，把輸出的 database_id 填進 wrangler.toml
npx wrangler d1 create dispatch
# 2. 建證件照儲存空間
npx wrangler r2 bucket create dispatch-docs
# 3. 建資料表
npm run db:migrate:remote
```

4. 在 `wrangler.toml` 把 `ADMIN_PHONES` 填入管理員手機（用這支手機註冊會自動成為管理員並通過審核），`APP_NAME` 改成正式名稱。
5. 部署：`npm run deploy`。之後可在 Cloudflare 後台綁定自己的網域。

### LINE 通知（選用，但強烈建議）

1. 到 [LINE Developers](https://developers.line.biz/) 建一個 Messaging API channel（就是一個 LINE 官方帳號）。
2. 設定密鑰：
   ```bash
   npx wrangler secret put LINE_CHANNEL_SECRET
   npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
   ```
3. Webhook URL 填 `https://你的網域/line/webhook`，開啟「Use webhook」，關閉自動回覆訊息。
4. 會員到「帳號」頁取得 6 位數綁定碼，加官方帳號好友後傳送這組數字就完成綁定。

LINE 免費方案每月有推播則數上限，會員多時可能要升級方案。

## 本機開發與測試

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev          # http://localhost:8787
npm test             # 另開一個終端機，跑完整流程測試
npm run typecheck
```

## 之後可以加的

- 發單方指定司機、常用司機名單
- 訂單編輯
- 登入失敗次數限制、忘記密碼（簡訊或 LINE 驗證）
- LINE Login 取代手機密碼
