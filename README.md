# TimeTree to Spreadsheet Exporter

將 TimeTree 行事曆事件匯出為試算表（CSV、Excel 或 Google 試算表）。

## 安裝

```bash
pip install -r requirements.txt
```

## 使用方式

### 互動模式（推薦）

```bash
python timetree_to_spreadsheet.py
```

會依序提示輸入 Email、密碼，並讓你選擇要匯出的行事曆。

### 命令列參數

```bash
# 匯出為 Excel（預設）
python timetree_to_spreadsheet.py -e your@email.com

# 匯出為 CSV
python timetree_to_spreadsheet.py -e your@email.com -f csv

# 指定行事曆名稱
python timetree_to_spreadsheet.py -e your@email.com -c "我的行事曆"

# 匯出所有行事曆
python timetree_to_spreadsheet.py -e your@email.com --all-calendars

# 指定輸出檔名
python timetree_to_spreadsheet.py -e your@email.com -o events.xlsx

# 匯出至 Google 試算表（使用 Service Account）
python timetree_to_spreadsheet.py -e your@email.com -f gsheet --google-creds credentials.json

# 匯出至 Google 試算表（使用 OAuth）
python timetree_to_spreadsheet.py -e your@email.com -f gsheet --google-creds client_secret.json

# 寫入現有的 Google 試算表
python timetree_to_spreadsheet.py -e your@email.com -f gsheet --google-creds credentials.json \
  --spreadsheet-url "https://docs.google.com/spreadsheets/d/XXXX/edit"
```

### 參數說明

| 參數 | 說明 |
|------|------|
| `-e, --email` | TimeTree 帳號 Email |
| `-p, --password` | TimeTree 帳號密碼（不建議在命令列輸入） |
| `-f, --format` | 輸出格式：`xlsx`（預設）、`csv`、`gsheet` |
| `-o, --output` | 輸出檔案路徑 |
| `-c, --calendar` | 指定行事曆名稱 |
| `--all-calendars` | 匯出所有行事曆 |
| `--google-creds` | Google API 憑證檔案路徑 |
| `--spreadsheet-url` | 現有 Google 試算表 URL（不指定則建立新的） |

## 匯出欄位

| 欄位 | 說明 |
|------|------|
| 標題 | 事件名稱 |
| 類型 | 活動 / 生日 / 備忘錄 |
| 全天 | 是否為全天事件 |
| 開始時間 | 事件開始日期時間 |
| 結束時間 | 事件結束日期時間 |
| 開始時區 / 結束時區 | 時區資訊 |
| 地點 | 活動地點 |
| 網址 | 相關連結 |
| 備註 | 事件備註 |
| 標籤 | 行事曆標籤 |
| 建立時間 / 更新時間 | 事件建立與更新時間 |

## Google 試算表設定

要匯出至 Google 試算表，你需要準備 Google API 憑證，有兩種方式：

### 方式一：Service Account（推薦用於自動化）

1. 前往 [Google Cloud Console](https://console.cloud.google.com/)
2. 建立專案並啟用 **Google Sheets API**
3. 建立 Service Account，下載 JSON 金鑰檔案
4. 使用此金鑰檔案作為 `--google-creds` 參數

> 注意：Service Account 建立的試算表只有該帳號能存取，腳本會提示是否設為公開。

### 方式二：OAuth 2.0（推薦用於個人使用）

1. 前往 [Google Cloud Console](https://console.cloud.google.com/)
2. 建立專案並啟用 **Google Sheets API**
3. 建立 OAuth 2.0 用戶端 ID（桌面應用程式），下載 `client_secret.json`
4. 首次執行時會開啟瀏覽器進行授權，之後會自動快取 token

## 注意事項

- 此工具使用 TimeTree 網頁版的非官方 API，若 TimeTree 更新網站可能會失效
- 密碼建議透過互動式輸入，避免在命令列中暴露
- 匯出的 Excel 檔案使用 UTF-8 編碼，CSV 使用 UTF-8 BOM 以確保中文在 Excel 中正確顯示
- Google 憑證檔案（`.json`、`token.pickle`）請勿上傳至版本控制
