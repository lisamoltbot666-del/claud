#!/usr/bin/env python3
"""
TimeTree to Spreadsheet Exporter

Exports TimeTree calendar events to CSV or Excel (.xlsx) format.
Uses the TimeTree web API (reverse-engineered from the web app).
"""

import argparse
import csv
import getpass
import json
import sys
import uuid
from datetime import datetime, timezone

import requests

BASE_URL = "https://timetreeapp.com/api/v1"
CLIENT_ID = "web/2.1.0/en"

HEADERS = {
    "Content-Type": "application/json",
    "X-Timetreea": CLIENT_ID,
}


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
    # Filter out deactivated calendars
    return [c for c in calendars if not c.get("deactivated_at")]


def get_labels(session, calendar_id):
    """Fetch labels for a calendar, return dict of id -> label info."""
    resp = session.get(
        f"{BASE_URL}/calendar/{calendar_id}/labels", headers=HEADERS
    )
    resp.raise_for_status()
    data = resp.json()
    labels = {}
    for label in data.get("calendar_labels", []):
        labels[label["id"]] = label.get("name", "")
    return labels


def get_all_events(session, calendar_id):
    """Fetch all events from a calendar with pagination."""
    events = []
    url = f"{BASE_URL}/calendar/{calendar_id}/events/sync"

    while True:
        resp = session.get(url, headers=HEADERS)
        resp.raise_for_status()
        data = resp.json()

        batch = data.get("events", [])
        events.extend(batch)

        if not data.get("chunk", False):
            break

        since = data.get("since")
        url = f"{BASE_URL}/calendar/{calendar_id}/events/sync?since={since}"

    return events


def ms_to_datetime(ms, tz_name=None):
    """Convert millisecond timestamp to formatted datetime string."""
    if not ms:
        return ""
    try:
        dt = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
        if tz_name:
            try:
                import zoneinfo
                tz = zoneinfo.ZoneInfo(tz_name)
                dt = dt.astimezone(tz)
            except Exception:
                pass
        return dt.strftime("%Y-%m-%d %H:%M:%S")
    except (OSError, ValueError):
        return str(ms)


def event_type_str(event):
    """Return human-readable event type."""
    t = event.get("type", 0)
    cat = event.get("category", 1)
    if t == 1:
        return "生日"
    if cat == 2:
        return "備忘錄"
    return "活動"


def export_to_csv(events, labels, output_path):
    """Export events to CSV file."""
    fieldnames = [
        "標題", "類型", "全天", "開始時間", "結束時間",
        "開始時區", "結束時區", "地點", "網址", "備註",
        "標籤", "建立時間", "更新時間",
    ]

    with open(output_path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()

        for event in sorted(events, key=lambda e: e.get("start_at", 0)):
            label_id = event.get("label_id")
            label_name = labels.get(label_id, "")

            writer.writerow({
                "標題": event.get("title", ""),
                "類型": event_type_str(event),
                "全天": "是" if event.get("all_day") else "否",
                "開始時間": ms_to_datetime(
                    event.get("start_at"), event.get("start_timezone")
                ),
                "結束時間": ms_to_datetime(
                    event.get("end_at"), event.get("end_timezone")
                ),
                "開始時區": event.get("start_timezone", ""),
                "結束時區": event.get("end_timezone", ""),
                "地點": event.get("location", ""),
                "網址": event.get("url", ""),
                "備註": event.get("note", ""),
                "標籤": label_name,
                "建立時間": ms_to_datetime(event.get("created_at")),
                "更新時間": ms_to_datetime(event.get("updated_at")),
            })

    print(f"已匯出 {len(events)} 筆事件至 {output_path}")


def export_to_xlsx(events, labels, output_path):
    """Export events to Excel file."""
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Font, PatternFill, Alignment
    except ImportError:
        print("錯誤：需要 openpyxl 套件。請執行: pip install openpyxl")
        sys.exit(1)

    wb = Workbook()
    ws = wb.active
    ws.title = "TimeTree 事件"

    headers = [
        "標題", "類型", "全天", "開始時間", "結束時間",
        "開始時區", "結束時區", "地點", "網址", "備註",
        "標籤", "建立時間", "更新時間",
    ]

    # Style header row
    header_font = Font(bold=True, color="FFFFFF")
    header_fill = PatternFill(start_color="4472C4", end_color="4472C4", fill_type="solid")

    for col, header in enumerate(headers, 1):
        cell = ws.cell(row=1, column=col, value=header)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal="center")

    # Write data
    for row_idx, event in enumerate(
        sorted(events, key=lambda e: e.get("start_at", 0)), start=2
    ):
        label_id = event.get("label_id")
        label_name = labels.get(label_id, "")

        values = [
            event.get("title", ""),
            event_type_str(event),
            "是" if event.get("all_day") else "否",
            ms_to_datetime(
                event.get("start_at"), event.get("start_timezone")
            ),
            ms_to_datetime(
                event.get("end_at"), event.get("end_timezone")
            ),
            event.get("start_timezone", ""),
            event.get("end_timezone", ""),
            event.get("location", ""),
            event.get("url", ""),
            event.get("note", ""),
            label_name,
            ms_to_datetime(event.get("created_at")),
            ms_to_datetime(event.get("updated_at")),
        ]

        for col, value in enumerate(values, 1):
            ws.cell(row=row_idx, column=col, value=value)

    # Auto-adjust column widths
    for col in ws.columns:
        max_length = 0
        col_letter = col[0].column_letter
        for cell in col:
            if cell.value:
                max_length = max(max_length, len(str(cell.value)))
        ws.column_dimensions[col_letter].width = min(max_length + 2, 50)

    # Freeze header row
    ws.freeze_panes = "A2"

    wb.save(output_path)
    print(f"已匯出 {len(events)} 筆事件至 {output_path}")


def main():
    parser = argparse.ArgumentParser(
        description="將 TimeTree 行事曆匯出為試算表 (CSV/Excel)"
    )
    parser.add_argument(
        "-e", "--email", help="TimeTree 帳號 Email"
    )
    parser.add_argument(
        "-p", "--password", help="TimeTree 帳號密碼"
    )
    parser.add_argument(
        "-f", "--format", choices=["csv", "xlsx"], default="xlsx",
        help="輸出格式 (預設: xlsx)"
    )
    parser.add_argument(
        "-o", "--output", help="輸出檔案路徑 (預設: timetree_events.xlsx)"
    )
    parser.add_argument(
        "-c", "--calendar", help="行事曆名稱 (不指定則顯示選單)"
    )
    parser.add_argument(
        "--all-calendars", action="store_true",
        help="匯出所有行事曆"
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

    # Export each selected calendar
    for cal in selected:
        cal_id = cal.get("id")
        cal_name = cal.get("name", "unknown")
        print(f"\n正在取得行事曆「{cal_name}」的事件...")

        labels = get_labels(session, cal_id)
        events = get_all_events(session, cal_id)

        if not events:
            print(f"行事曆「{cal_name}」沒有任何事件。")
            continue

        print(f"取得 {len(events)} 筆事件。")

        # Determine output path
        fmt = args.format
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
