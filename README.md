# TimeTree to Spreadsheet Exporter

將 TimeTree 行事曆事件匯出為試算表（CSV 或 Excel）。

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
```

### 參數說明

| 參數 | 說明 |
|------|------|
| `-e, --email` | TimeTree 帳號 Email |
| `-p, --password` | TimeTree 帳號密碼（不建議在命令列輸入） |
| `-f, --format` | 輸出格式：`xlsx`（預設）或 `csv` |
| `-o, --output` | 輸出檔案路徑 |
| `-c, --calendar` | 指定行事曆名稱 |
| `--all-calendars` | 匯出所有行事曆 |

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

## 注意事項

- 此工具使用 TimeTree 網頁版的非官方 API，若 TimeTree 更新網站可能會失效
- 密碼建議透過互動式輸入，避免在命令列中暴露
- 匯出的 Excel 檔案使用 UTF-8 編碼，CSV 使用 UTF-8 BOM 以確保中文在 Excel 中正確顯示
