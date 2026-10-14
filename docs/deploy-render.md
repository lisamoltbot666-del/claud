# 上線到 Render（一步一步）

照著做大約 20–30 分鐘。完成後會得到一個 `https://….onrender.com` 的網址，客服在任何電腦、手機都能登入後台，LINE 的客戶訊息也會自動進來。

## 費用

本系統把資料存在 Render 的「永久磁碟」上，需要付費方案（免費方案重新部署時會把資料清掉，不適合正式使用）：

- Web Service **Starter** 方案：約 US$7／月
- 永久磁碟 1 GB：約 US$0.25／月

實際價格以 [Render 官網](https://render.com/pricing) 為準。需要綁定信用卡。

---

## 第 1 步：註冊 Render

1. 打開 <https://render.com>，按 **Get Started**。
2. 選 **GitHub** 登入（用存放這個系統的 GitHub 帳號）。
3. 第一次會問要讓 Render 讀取哪些 repo，選 **Only select repositories** → 勾選 `claud` → **Install**。

## 第 2 步：用 Blueprint 建立服務

這個 repo 裡已經有 `render.yaml`，Render 會照它自動設定好所有東西。

1. 在 Render 後台右上角按 **New** → **Blueprint**。
2. 選擇 repo **`claud`**，分支選 **`main`**，按 **Connect**。
3. Blueprint 名稱隨意（例如 `line-crm`）。
4. 畫面會列出要建立的服務 `line-crm`，以及需要你填的設定：
   - **ADMIN_PASSWORD**：輸入後台登入密碼（請設定長一點、不要跟其他網站一樣）。
5. 按 **Apply**（若要求綁定信用卡，照畫面完成）。

## 第 3 步：等待部署完成

1. 點進 `line-crm` 服務，看 **Events / Logs**，等到狀態變成綠色的 **Live**（約 2–5 分鐘）。
2. 頁面上方會顯示網址，例如 `https://line-crm-abcd.onrender.com`。
3. 用瀏覽器打開這個網址，帳號 `admin`、密碼是剛剛填的 `ADMIN_PASSWORD`。

> 看到「今日關懷清單」就代表上線成功了。這是全新的資料庫，裡面沒有示範資料。

## 第 4 步：建立品牌、貼上 LINE 金鑰（每個品牌做一次）

1. 後台上方點 **品牌** → **新增品牌**。
2. 填入：
   - **品牌名稱**：會出現在給客戶的訊息裡，例如「雞精坊」
   - **網址代號**：英文或數字，例如 `chicken`
   - **代表色**、**匯款資訊**
3. 另開一個分頁到 [LINE Developers](https://developers.line.biz/console/)：
   - 選這個品牌的 Provider → 選這個品牌官方帳號的 **Messaging API** channel
   - **Basic settings** 分頁最下面：複製 **Channel secret**
   - **Messaging API** 分頁最下面：**Channel access token (long-lived)**，沒有的話按 **Issue**，再複製
4. 把兩個金鑰貼到品牌設定，按 **建立**（或編輯後按 **儲存**）。

## 第 5 步：設定 LINE Webhook（每個品牌做一次）

> **原本的 Webhook URL 已經有填別的系統，而且那個系統還要繼續用？**
> 先把**原本的網址**複製下來，貼到後台該品牌的「**同時轉送到**」欄位並儲存，再把 LINE 的 Webhook URL 換成本系統的網址。
> 之後本系統每收到一則 LINE 事件，都會原封不動（相同內容與簽章）轉送一份給原本的系統，兩邊都能照常運作。
> 品牌卡片上會顯示「最近轉送成功／失敗」，方便確認舊系統有收到。
> 本系統預設**不會自動回覆客人**（`AUTO_REPLY=false`）；即使開啟，有設定轉送的品牌也不會自動回覆（「查訂單」、匯款通知的自動回覆），回覆交給原本的系統，避免兩邊搶同一則回覆；匯款回報、訊息紀錄、關懷清單照常運作。

1. 在後台「品牌」頁，複製該品牌顯示的 **Webhook URL**，例如
   `https://line-crm-abcd.onrender.com/webhook/chicken`
2. 回到 LINE Developers 該 channel 的 **Messaging API** 分頁：
   - **Webhook URL** → **Edit** → 貼上 → **Update**
   - 按 **Verify**，出現 **Success** 就成功了
   - 打開 **Use webhook**
3. 到 [LINE Official Account Manager](https://manager.line.biz/) → 該帳號 → **設定** → **回應設定**：
   - **Webhook**：開啟
   - **聊天**：可以保持開啟，客服照常在官方帳號後台聊天

測試：用自己的手機 LINE 傳一則訊息給這個官方帳號，回到後台「客戶」頁，應該會看到自己出現在這個品牌底下。

## 第 6 步：設定客服接收每日清單

1. 每位客服用自己的 LINE 加任一品牌官方帳號好友，並傳一則訊息。
2. 後台「客戶」找到這位客服 → 點開 → 右上角 **設為客服**。
3. 之後每天早上 9 點（台灣時間）會收到全部品牌的關懷清單，裡面附有後台網址。
   想先試一次：「今日關懷」頁按 **立即推播清單給客服**。

---

## 第 7 步：建立客服帳號

後台上方「帳號」→「新增帳號」，替每位客服建立自己的帳號（顯示名稱、登入帳號、密碼、角色）。客服登入後，系統會記錄誰傳了訊息、誰改了訂單。老闆帳號 `admin` 的密碼就是 Render 上的 `ADMIN_PASSWORD`。

---

## 日常維護

- **系統更新**：之後 GitHub 的 `main` 有新版本，Render 會自動重新部署，資料不會受影響。
- **備份**：
  - 後台「品牌」頁右上角 **下載備份**，會下載完整資料庫檔案（`.db`），建議每週下載一次存到安全的地方。
  - Render 也會每天自動幫永久磁碟做快照（在服務的 **Disks** 頁可以看到並還原）。
- **修改設定**（例如每日清單時間、自動提醒）：Render 服務 → **Environment** → 修改 `DAILY_REPORT_HOUR`、`AUTO_PAYMENT_REMINDER`、`AUTO_REORDER_REMINDER` 等 → **Save Changes**，會自動重新啟動。
- **改後台密碼**：同上，修改 `ADMIN_PASSWORD`。
- **自訂網址**（例如 `crm.你的網域.com`）：服務 → **Settings** → **Custom Domains**，照指示到網域商設定 DNS。改了網址之後，記得把每個品牌在 LINE Developers 的 Webhook URL 一起換掉。

## 常見問題

| 狀況 | 怎麼辦 |
| --- | --- |
| LINE 按 **Verify** 失敗 | 確認 Webhook URL 的代號和後台品牌代號一樣；確認貼到後台的 Channel secret 是**同一個** channel 的；服務狀態要是 **Live**。 |
| 客戶傳訊息，後台沒有出現 | 確認 LINE Developers 的 **Use webhook** 已開啟、Official Account Manager 的 **Webhook** 已開啟；切換到「全部品牌」再看一次。 |
| 推播失敗 | 確認 Channel access token 沒有貼錯，或官方帳號這個月的訊息額度是否用完。 |
| 打開網址很慢或錯誤 | 到 Render 服務的 **Logs** 看錯誤訊息，截圖給技術人員。 |
