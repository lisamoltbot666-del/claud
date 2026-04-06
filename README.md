# TimeTree to Spreadsheet Exporter

將 TimeTree 行事曆事件匯出為派車管理試算表（CSV、Excel 或 Google 試算表）。

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

# 只匯出今天的行程
python timetree_to_spreadsheet.py -e your@email.com --today

# 匯出指定日期
python timetree_to_spreadsheet.py -e your@email.com --date 2026-04-06

# 匯出日期範圍
python timetree_to_spreadsheet.py -e your@email.com --date-range "2026-04-01~2026-04-30"

# 匯出為 CSV
python timetree_to_spreadsheet.py -e your@email.com -f csv

# 匯出至 Google 試算表
python timetree_to_spreadsheet.py -e your@email.com -f gsheet --google-creds credentials.json

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
| `--today` | 只匯出今天的行程 |
| `--date` | 只匯出指定日期 (YYYY-MM-DD) |
| `--date-range` | 匯出日期範圍 (YYYY-MM-DD~YYYY-MM-DD) |
| `--google-creds` | Google API 憑證檔案路徑 |
| `--spreadsheet-url` | 現有 Google 試算表 URL（不指定則建立新的） |

## 匯出欄位（派車管理格式）

| 欄位 | 說明 | 資料來源 |
|------|------|----------|
| 訂金 | 訂金金額 | 事件備註 |
| 尾款 | 尾款金額 | 事件備註 |
| 審報 | 審報金額 | 手動填寫 |
| 預約日 | 預約日期 | 事件備註 |
| 平台 | 平台名稱 (UGO, 享運等) | 事件標題解析 |
| 日期 | 行程日期 | 事件開始時間 |
| 時間 | 出發時間 | 事件標題/開始時間 |
| 行程 | 行程類型 (接送/包車) | 事件標題解析 |
| 上車 | 上車地點 | 事件標題解析 |
| 下車 | 下車地點 | 事件標題解析 |
| 車型 | 車型 | 事件備註 |
| 司機 | 司機姓名 | 事件備註 |
| 車號 | 車牌號碼 | 事件備註 |
| 公司 | 公司名稱 | 事件備註 |
| 派價 | 派車價格 | 事件備註 |
| 回帳 | 回帳金額 | 手動填寫 |
| 薪資 | 薪資金額 | 手動填寫 |
| 備註 | 其他備註 | 事件備註 |
| 款項入帳 | 入帳資訊 | 手動填寫 |

## 事件標題格式

腳本會自動解析 TimeTree 事件標題，例如：

- `00:30安南-桃園機場UGO` → 時間: 00:30, 上車: 安南, 下車: 桃園機場, 平台: UGO
- `5:50楠梓-小港機場 享運` → 時間: 5:50, 上車: 楠梓, 下車: 小港機場, 平台: 享運
- `11:00墾丁-台東包車 利捷` → 上車: 墾丁, 下車: 台東, 行程: 包車, 平台: 利捷

## Google 試算表設定

### 方式一：Service Account（推薦用於自動化）

1. 前往 [Google Cloud Console](https://console.cloud.google.com/)
2. 建立專案並啟用 **Google Sheets API**
3. 建立 Service Account，下載 JSON 金鑰檔案
4. 使用此金鑰檔案作為 `--google-creds` 參數

### 方式二：OAuth 2.0（推薦用於個人使用）

1. 前往 [Google Cloud Console](https://console.cloud.google.com/)
2. 建立專案並啟用 **Google Sheets API**
3. 建立 OAuth 2.0 用戶端 ID（桌面應用程式），下載 `client_secret.json`
4. 首次執行時會開啟瀏覽器進行授權，之後會自動快取 token

## 注意事項

- 此工具使用 TimeTree 網頁版的非官方 API，若 TimeTree 更新網站可能會失效
- 密碼建議透過互動式輸入，避免在命令列中暴露
- 匯出的 Excel 檔案使用 UTF-8 編碼，CSV 使用 UTF-8 BOM 以確保中文正確顯示
- Google 憑證檔案（`.json`、`token.pickle`）請勿上傳至版本控制
