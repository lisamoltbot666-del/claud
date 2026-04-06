#!/usr/bin/env python3
"""
TimeTree to Spreadsheet Exporter

Exports TimeTree calendar events to CSV, Excel (.xlsx), or Google Sheets.
Outputs in dispatch management (派車管理) spreadsheet format.
Uses the TimeTree web API (reverse-engineered from the web app).
"""

import argparse
import csv
import getpass
import json
import re
import sys
import uuid
from datetime import datetime, timezone, timedelta

import requests

BASE_URL = "https://timetreeapp.com/api/v1"
CLIENT_ID = "web/2.1.0/en"

HEADERS = {
    "Content-Type": "application/json",
    "X-Timetreea": CLIENT_ID,
}

# 已知平台名稱關鍵字
KNOWN_PLATFORMS = [
    "UGO", "享運", "台灣包車", "時客", "王子", "黃鴻", "阿民",
    "三立", "zsop", "利捷",
]

# 已知行程類型
KNOWN_TRIP_TYPES = ["接送", "包車", "自駕", "包車"]


def login(session, email, password):
    """Authenticate with TimeTree and return session with cookie set."""
    device_uuid = uuid.uuid4().hex
    resp = session.put(
        f"{BASE_URL}/auth/email/signin",
        headers=HEADERS,
        json={"uid": email, "password": password, "uuid": device_uuid},
    )

    if resp.status_code != 200:
        data = resp.json() if resp.text else {}
        error_code = data.get("error", {}).get("code")
        if error_code == -702:
            print("錯誤：Email 或密碼不正確。")
        elif error_code == -495:
            print("錯誤：請求過於頻繁，請稍後再試。")
        else:
            print(f"登入失敗 (HTTP {resp.status_code}): {resp.text}")
        sys.exit(1)

    if "_session_id" not in session.cookies:
        print("錯誤：登入成功但未收到 session cookie。")
        sys.exit(1)

    print("登入成功！")
    return session


def get_calendars(session):
    """Fetch list of calendars."""
    resp = session.get(f"{BASE_URL}/calendars?since=0", headers=HEADERS)
    resp.raise_for_status()
    data = resp.json()
    calendars = data.get("calendars", [])
    return [c for c in calendars if not c.get("deactivated_at")]


def get_labels(session, calendar_id):
    """Fetch labels for a calendar, return dict of id -> label info."""
    resp = session.get(
        f"{BASE_URL}/calendar/{calendar_id}/labels", headers=HEADERS
    )
    resp.raise_for_status()
    labels = {}
    for label in resp.json().get("calendar_labels", []):
        labels[label["id"]] = label.get("name", "")
    return labels


def get_all_events(session, calendar_id):
    """Fetch all events from a calendar with pagination."""
    events = []
    url = f"{BASE_URL}/calendar/{calendar_id}/events/sync"

    page = 0
    while True:
        resp = session.get(url, headers=HEADERS)
        resp.raise_for_status()
        data = resp.json()

        batch = data.get("events", [])
        events.extend(batch)
        page += 1

        if not data.get("chunk", False):
            break

        since = data.get("since")
        url = f"{BASE_URL}/calendar/{calendar_id}/events/sync?since={since}"

    return events


def ms_to_dt(ms, tz_name=None):
    """Convert millisecond timestamp to datetime object."""
    if not ms:
        return None
    try:
        dt = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
        if tz_name:
            try:
                import zoneinfo
                tz = zoneinfo.ZoneInfo(tz_name)
                dt = dt.astimezone(tz)
            except Exception:
                pass
        else:
            try:
                import zoneinfo
                dt = dt.astimezone(zoneinfo.ZoneInfo("Asia/Taipei"))
            except Exception:
                pass
        return dt
    except (OSError, ValueError):
        return None


def parse_event_title(title):
    """
    Parse event title to extract route and platform info.

    Examples:
      "00:30安南-桃園機場UGO" -> time=00:30, pickup=安南, dropoff=桃園機場, platform=UGO
      "5:50楠梓-小港機場 享運" -> time=5:50, pickup=楠梓, dropoff=小港機場, platform=享運
      "08:15左營高鐵-壽山" -> time=08:15, pickup=左營高鐵, dropoff=壽山
      "11:00墾丁-台東包車雨台 利捷" -> pickup=墾丁, dropoff=台東, trip_type=包車, platform=利捷
    """
    if not title:
        return {}

    result = {}

    # Extract platform
    for platform in KNOWN_PLATFORMS:
        if platform in title:
            result["platform"] = platform
            title = title.replace(platform, "").strip()
            break

    # Extract trip type
    for trip_type in KNOWN_TRIP_TYPES:
        if trip_type in title:
            result["trip_type"] = trip_type
            title = title.replace(trip_type, "", 1).strip()
            break

    # Try to extract time prefix like "00:30", "5:50", "08:15"
    time_match = re.match(r'^(\d{1,2}:\d{2})\s*', title)
    if time_match:
        result["time"] = time_match.group(1)
        title = title[time_match.end():]

    # Try to extract pickup-dropoff with various separators
    route_match = re.match(r'^(.+?)[-\-~→至到](.+?)$', title)
    if route_match:
        result["pickup"] = route_match.group(1).strip()
        result["dropoff"] = route_match.group(2).strip()
    elif title.strip():
        result["title_remaining"] = title.strip()

    return result


def parse_event_note(note):
    """
    Parse event note/description for additional fields.
    Look for patterns like 司機:xxx, 車號:xxx, 車型:xxx, etc.
    """
    if not note:
        return {}

    result = {}
    # Common field patterns in notes
    patterns = {
        "driver": r'司機[：:\s]*(.+?)(?:\n|$)',
        "car_number": r'車號[：:\s]*(.+?)(?:\n|$)',
        "car_type": r'車型[：:\s]*(.+?)(?:\n|$)',
        "company": r'公司[：:\s]*(.+?)(?:\n|$)',
        "price": r'(?:價[格錢]|派價|費用)[：:\s]*(\d[\d,]*)',
        "deposit": r'訂金[：:\s]*(\d[\d,]*)',
        "balance": r'尾款[：:\s]*(\d[\d,]*)',
        "booking_date": r'預約日[：:\s]*(.+?)(?:\n|$)',
    }

    for key, pattern in patterns.items():
        match = re.search(pattern, note)
        if match:
            result[key] = match.group(1).strip()

    return result


def event_to_dispatch_row(event, labels):
    """Convert a TimeTree event into a dispatch spreadsheet row."""
    title = event.get("title", "")
    note = event.get("note", "")
    location = event.get("location", "")

    # Parse title and note
    title_info = parse_event_title(title)
    note_info = parse_event_note(note)

    # Get datetime
    start_dt = ms_to_dt(event.get("start_at"), event.get("start_timezone"))
    end_dt = ms_to_dt(event.get("end_at"), event.get("end_timezone"))

    # Date
    date_str = start_dt.strftime("%-m月%d日") if start_dt else ""

    # Time - prefer parsed time from title, fallback to event start time
    if title_info.get("time"):
        time_str = title_info["time"]
    elif start_dt and not event.get("all_day"):
        time_str = start_dt.strftime("%H:%M")
    else:
        time_str = ""

    # Trip type
    trip_type = title_info.get("trip_type", "接送")

    # Pickup / Dropoff
    pickup = title_info.get("pickup", "")
    dropoff = title_info.get("dropoff", "")

    # If no route parsed from title, try location field
    if not pickup and not dropoff and location:
        if "-" in location or "—" in location or "~" in location:
            parts = re.split(r'[-\-~→至到]', location, maxsplit=1)
            if len(parts) == 2:
                pickup = parts[0].strip()
                dropoff = parts[1].strip()
        else:
            pickup = location

    # Platform
    platform = title_info.get("platform", "")

    # Label as additional info
    label_id = event.get("label_id")
    label_name = labels.get(label_id, "")

    # Car type, driver, car number from notes
    car_type = note_info.get("car_type", "")
    driver = note_info.get("driver", "")
    car_number = note_info.get("car_number", "")
    company = note_info.get("company", "")

    # Prices
    deposit = note_info.get("deposit", "")
    balance = note_info.get("balance", "")
    price = note_info.get("price", "")
    booking_date = note_info.get("booking_date", "")

    # Build row matching the dispatch spreadsheet format
    row = {
        "訂金": deposit,
        "尾款": balance,
        "審報": "",
        "預約日": booking_date,
        "平台": platform,
        "日期": date_str,
        "時間": time_str,
        "行程": trip_type,
        "上車": pickup,
        "下車": dropoff,
        "車型": car_type,
        "司機": driver,
        "車號": car_number,
        "公司": company,
        "派價": price,
        "回帳": "",
        "薪資": "",
        "備註": note if not note_info else "",
        "款項入帳": "",
    }

    return row


# ─── Export functions ────────────────────────────────────────────────

DISPATCH_HEADERS = [
    "訂金", "尾款", "審報", "預約日", "平台", "日期", "時間",
    "行程", "上車", "下車", "車型", "司機", "車號", "公司",
    "派價", "回帳", "薪資", "備註", "款項入帳",
]


def export_to_csv(events, labels, output_path):
    """Export events to CSV file in dispatch format."""
    with open(output_path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=DISPATCH_HEADERS)
        writer.writeheader()

        for event in sorted(events, key=lambda e: e.get("start_at", 0)):
            row = event_to_dispatch_row(event, labels)
            writer.writerow(row)

    print(f"已匯出 {len(events)} 筆事件至 {output_path}")


def export_to_xlsx(events, labels, output_path):
    """Export events to Excel file in dispatch format."""
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    except ImportError:
        print("錯誤：需要 openpyxl 套件。請執行: pip install openpyxl")
        sys.exit(1)

    wb = Workbook()
    ws = wb.active
    ws.title = "派車表"

    # Style header row
    header_font = Font(bold=True, size=10)
    header_fill = PatternFill(start_color="D9E1F2", end_color="D9E1F2", fill_type="solid")
    thin_border = Border(
        left=Side(style="thin"),
        right=Side(style="thin"),
        top=Side(style="thin"),
        bottom=Side(style="thin"),
    )

    for col, header in enumerate(DISPATCH_HEADERS, 1):
        cell = ws.cell(row=1, column=col, value=header)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = thin_border

    # Write data
    sorted_events = sorted(events, key=lambda e: e.get("start_at", 0))
    for row_idx, event in enumerate(sorted_events, start=2):
        row = event_to_dispatch_row(event, labels)
        for col, header in enumerate(DISPATCH_HEADERS, 1):
            cell = ws.cell(row=row_idx, column=col, value=row.get(header, ""))
            cell.border = thin_border
            cell.alignment = Alignment(vertical="center")
            # Right-align numeric columns
            if header in ("訂金", "尾款", "審報", "派價", "回帳", "薪資"):
                cell.alignment = Alignment(horizontal="right", vertical="center")

    # Column widths
    col_widths = {
        "訂金": 8, "尾款": 8, "審報": 8, "預約日": 8, "平台": 10,
        "日期": 10, "時間": 7, "行程": 6, "上車": 12, "下車": 12,
        "車型": 8, "司機": 8, "車號": 12, "公司": 8, "派價": 8,
        "回帳": 8, "薪資": 8, "備註": 20, "款項入帳": 10,
    }
    for col, header in enumerate(DISPATCH_HEADERS, 1):
        ws.column_dimensions[ws.cell(row=1, column=col).column_letter].width = \
            col_widths.get(header, 10)

    # Freeze header row
    ws.freeze_panes = "A2"

    wb.save(output_path)
    print(f"已匯出 {len(events)} 筆事件至 {output_path}")


def build_dispatch_rows(events, labels):
    """Build header + data rows in dispatch format for Google Sheets."""
    rows = [DISPATCH_HEADERS]
    for event in sorted(events, key=lambda e: e.get("start_at", 0)):
        row = event_to_dispatch_row(event, labels)
        rows.append([row.get(h, "") for h in DISPATCH_HEADERS])
    return rows


def get_google_creds(credentials_file):
    """Obtain Google API credentials via OAuth or service account."""
    import os

    if credentials_file and os.path.exists(credentials_file):
        with open(credentials_file) as f:
            cred_data = json.load(f)

        if cred_data.get("type") == "service_account":
            from google.oauth2.service_account import Credentials
            scopes = ["https://www.googleapis.com/auth/spreadsheets"]
            return Credentials.from_service_account_file(
                credentials_file, scopes=scopes
            )
        else:
            from google_auth_oauthlib.flow import InstalledAppFlow
            from google.auth.transport.requests import Request
            import pickle

            scopes = ["https://www.googleapis.com/auth/spreadsheets"]
            token_path = os.path.join(
                os.path.dirname(credentials_file), "token.pickle"
            )

            creds = None
            if os.path.exists(token_path):
                with open(token_path, "rb") as token:
                    creds = pickle.load(token)

            if not creds or not creds.valid:
                if creds and creds.expired and creds.refresh_token:
                    creds.refresh(Request())
                else:
                    flow = InstalledAppFlow.from_client_secrets_file(
                        credentials_file, scopes
                    )
                    creds = flow.run_local_server(port=0)
                with open(token_path, "wb") as token:
                    pickle.dump(creds, token)

            return creds

    import google.auth
    creds, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/spreadsheets"]
    )
    return creds


def export_to_google_sheets(events, labels, cal_name, credentials_file=None,
                            spreadsheet_url=None):
    """Export events to Google Sheets in dispatch format."""
    try:
        import gspread
    except ImportError:
        print("錯誤：需要 gspread 套件。請執行: pip install gspread google-auth google-auth-oauthlib")
        sys.exit(1)

    creds = get_google_creds(credentials_file)
    gc = gspread.authorize(creds)

    rows = build_dispatch_rows(events, labels)
    sheet_title = f"派車表 - {cal_name}"

    if spreadsheet_url:
        sh = gc.open_by_url(spreadsheet_url)
        try:
            ws = sh.worksheet(cal_name)
            ws.clear()
        except gspread.WorksheetNotFound:
            ws = sh.add_worksheet(title=cal_name, rows=len(rows), cols=len(rows[0]))
    else:
        sh = gc.create(sheet_title)
        ws = sh.sheet1
        ws.update_title(cal_name)

    ws.update(rows, value_input_option="USER_ENTERED")

    # Format header row
    ws.format("1:1", {
        "textFormat": {"bold": True},
        "backgroundColor": {"red": 0.851, "green": 0.882, "blue": 0.949},
        "horizontalAlignment": "CENTER",
    })

    ws.freeze(rows=1)

    # Auto-resize columns
    body = {
        "requests": [{
            "autoResizeDimensions": {
                "dimensions": {
                    "sheetId": ws.id,
                    "dimension": "COLUMNS",
                    "startIndex": 0,
                    "endIndex": len(rows[0]),
                }
            }
        }]
    }
    sh.batch_update(body)

    url = sh.url
    print(f"已匯出 {len(events)} 筆事件至 Google 試算表")
    print(f"連結：{url}")

    if not spreadsheet_url:
        print("\n注意：新建的試算表預設為私人。")
        share = input("是否要設為「知道連結的人都能檢視」？(y/n): ").strip().lower()
        if share in ("y", "yes", "是"):
            sh.share(None, perm_type="anyone", role="reader")
            print("已設為公開檢視。")

    return url


# ─── Main ────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="將 TimeTree 行事曆匯出為派車管理試算表 (CSV/Excel/Google Sheets)"
    )
    parser.add_argument(
        "-e", "--email", help="TimeTree 帳號 Email"
    )
    parser.add_argument(
        "-p", "--password", help="TimeTree 帳號密碼"
    )
    parser.add_argument(
        "-f", "--format", choices=["csv", "xlsx", "gsheet"], default="xlsx",
        help="輸出格式：csv, xlsx（預設）, gsheet（Google 試算表）"
    )
    parser.add_argument(
        "-o", "--output", help="輸出檔案路徑"
    )
    parser.add_argument(
        "--google-creds",
        help="Google API 憑證檔案路徑"
    )
    parser.add_argument(
        "--spreadsheet-url",
        help="現有 Google 試算表 URL（不指定則建立新的）"
    )
    parser.add_argument(
        "-c", "--calendar", help="行事曆名稱 (不指定則顯示選單)"
    )
    parser.add_argument(
        "--all-calendars", action="store_true",
        help="匯出所有行事曆"
    )
    parser.add_argument(
        "--today", action="store_true",
        help="只匯出今天的行程"
    )
    parser.add_argument(
        "--date", help="只匯出指定日期的行程 (格式: YYYY-MM-DD)"
    )
    parser.add_argument(
        "--date-range",
        help="匯出日期範圍 (格式: YYYY-MM-DD~YYYY-MM-DD)"
    )
    args = parser.parse_args()

    # Get credentials
    email = args.email or input("請輸入 TimeTree Email: ")
    password = args.password or getpass.getpass("請輸入密碼: ")

    # Login
    session = requests.Session()
    login(session, email, password)

    # Get calendars
    calendars = get_calendars(session)
    if not calendars:
        print("找不到任何行事曆。")
        sys.exit(1)

    # Select calendars to export
    if args.all_calendars:
        selected = calendars
    elif args.calendar:
        selected = [c for c in calendars if c.get("name") == args.calendar]
        if not selected:
            print(f"找不到名為 '{args.calendar}' 的行事曆。")
            print("可用的行事曆：")
            for c in calendars:
                print(f"  - {c.get('name')}")
            sys.exit(1)
    else:
        print("\n可用的行事曆：")
        for i, cal in enumerate(calendars, 1):
            print(f"  {i}. {cal.get('name')}")
        print(f"  {len(calendars) + 1}. 全部匯出")

        while True:
            try:
                choice = int(input("\n請選擇行事曆 (輸入編號): "))
                if 1 <= choice <= len(calendars):
                    selected = [calendars[choice - 1]]
                    break
                elif choice == len(calendars) + 1:
                    selected = calendars
                    break
                else:
                    print("無效的選擇，請重試。")
            except ValueError:
                print("請輸入數字。")

    # Determine date filter
    import zoneinfo
    tz = zoneinfo.ZoneInfo("Asia/Taipei")
    filter_start = None
    filter_end = None

    if args.today:
        today = datetime.now(tz).date()
        filter_start = today
        filter_end = today
        print(f"\n篩選日期：{today}")
    elif args.date:
        d = datetime.strptime(args.date, "%Y-%m-%d").date()
        filter_start = d
        filter_end = d
        print(f"\n篩選日期：{d}")
    elif args.date_range:
        parts = args.date_range.split("~")
        if len(parts) == 2:
            filter_start = datetime.strptime(parts[0].strip(), "%Y-%m-%d").date()
            filter_end = datetime.strptime(parts[1].strip(), "%Y-%m-%d").date()
            print(f"\n篩選日期：{filter_start} ~ {filter_end}")

    # Export each selected calendar
    for cal in selected:
        cal_id = cal.get("id")
        cal_name = cal.get("name", "unknown")
        print(f"\n正在取得行事曆「{cal_name}」的事件...")

        labels = get_labels(session, cal_id)
        events = get_all_events(session, cal_id)

        # Apply date filter
        if filter_start and filter_end:
            filtered = []
            for event in events:
                start_dt = ms_to_dt(
                    event.get("start_at"),
                    event.get("start_timezone", "Asia/Taipei"),
                )
                if start_dt and filter_start <= start_dt.date() <= filter_end:
                    filtered.append(event)
            events = filtered
            print(f"篩選後共 {len(events)} 筆事件。")
        else:
            print(f"共 {len(events)} 筆事件。")

        if not events:
            print(f"行事曆「{cal_name}」沒有符合條件的事件。")
            continue

        fmt = args.format

        if fmt == "gsheet":
            export_to_google_sheets(
                events, labels, cal_name,
                credentials_file=args.google_creds,
                spreadsheet_url=args.spreadsheet_url,
            )
        else:
            if args.output and len(selected) == 1:
                output_path = args.output
            else:
                safe_name = cal_name.replace("/", "_").replace("\\", "_")
                output_path = f"timetree_{safe_name}.{fmt}"

            if fmt == "csv":
                export_to_csv(events, labels, output_path)
            else:
                export_to_xlsx(events, labels, output_path)

    print("\n匯出完成！")


if __name__ == "__main__":
    main()
