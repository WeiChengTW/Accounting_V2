import sqlite3
import re
import requests
from datetime import datetime, timedelta, timezone
import os

from dotenv import load_dotenv
from flask import Flask, request, abort, jsonify, render_template

from linebot.v3.webhook import WebhookParser
from linebot.v3.webhooks import (
    MessageEvent,
    TextMessageContent,
    GroupSource,
    RoomSource,
    UserSource,
)
from linebot.v3.messaging import (
    ApiClient,
    Configuration,
    MessagingApi,
    ReplyMessageRequest,
)
from linebot.v3.messaging.models import FlexMessage
from linebot.v3.messaging.models.flex_container import FlexContainer
from linebot.v3.exceptions import InvalidSignatureError

load_dotenv()

app = Flask(__name__)

APP_TIMEZONE = timezone(timedelta(hours=8))
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bookkeeping.db")
LIFF_ID = "2010103074-sGThhCR5"
LIFF_URL = f"https://liff.line.me/{LIFF_ID}"

CHANNEL_ACCESS_TOKEN = os.getenv("CHANNEL_ACCESS_TOKEN", "")
CHANNEL_SECRET = os.getenv("CHANNEL_SECRET", "")

configuration = Configuration(access_token=CHANNEL_ACCESS_TOKEN)
parser = WebhookParser(CHANNEL_SECRET)

_bot_user_id = None

def get_cached_bot_user_id():
    global _bot_user_id
    if _bot_user_id is None:
        _bot_user_id = get_bot_user_id()
    return _bot_user_id


def get_now():
    return datetime.now(APP_TIMEZONE).replace(tzinfo=None, microsecond=0)


def line_headers():
    return {"Authorization": f"Bearer {CHANNEL_ACCESS_TOKEN}"}


# ─── Database ─────────────────────────────────────────────────

def run_query(query, params=(), fetch_mode=None):
    with sqlite3.connect(DB_PATH) as conn:
        cur = conn.execute(query, params)
        if fetch_mode == "one":
            return cur.fetchone()
        if fetch_mode == "all":
            return cur.fetchall()
        return cur.rowcount


def init_db():
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                chat_id TEXT NOT NULL DEFAULT 'unknown',
                user_name TEXT NOT NULL DEFAULT '',
                item TEXT NOT NULL,
                amount INTEGER NOT NULL,
                record_type TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)
        columns = {row[1] for row in conn.execute("PRAGMA table_info(records)").fetchall()}
        if "chat_id" not in columns:
            conn.execute("ALTER TABLE records ADD COLUMN chat_id TEXT NOT NULL DEFAULT 'unknown'")
        if "user_name" not in columns:
            conn.execute("ALTER TABLE records ADD COLUMN user_name TEXT NOT NULL DEFAULT ''")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS manual_members (
                chat_id TEXT NOT NULL,
                member_name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (chat_id, member_name)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS settlement_payments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id TEXT NOT NULL,
                from_user_id TEXT NOT NULL,
                to_user_id TEXT NOT NULL DEFAULT '',
                to_name TEXT NOT NULL,
                amount INTEGER NOT NULL,
                created_at TEXT NOT NULL
            )
        """)
        sp_cols = {r[1] for r in conn.execute("PRAGMA table_info(settlement_payments)")}
        if "to_user_id" not in sp_cols:
            conn.execute("ALTER TABLE settlement_payments ADD COLUMN to_user_id TEXT NOT NULL DEFAULT ''")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS members (
                chat_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                user_name TEXT NOT NULL,
                picture_url TEXT NOT NULL DEFAULT '',
                joined_at TEXT NOT NULL,
                PRIMARY KEY (chat_id, user_id)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS group_config (
                chat_id TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                PRIMARY KEY (chat_id, key)
            )
        """)
        columns = {row[1] for row in conn.execute("PRAGMA table_info(members)").fetchall()}
        if "picture_url" not in columns:
            conn.execute("ALTER TABLE members ADD COLUMN picture_url TEXT NOT NULL DEFAULT ''")


# ─── DB helpers ───────────────────────────────────────────────

def normalize_member_name(name_text):
    name = (name_text or "").strip().lstrip("@").strip()
    if not name:
        raise ValueError("成員名稱不可空白")
    if len(name) > 30:
        raise ValueError("成員名稱請控制在 30 字以內")
    return name


def save_record(user_id, chat_id, user_name, item, amount, record_type, created_at):
    run_query(
        "INSERT INTO records (user_id, chat_id, user_name, item, amount, record_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (user_id, chat_id, user_name, item, amount, record_type, created_at.isoformat()),
    )


def get_record_by_id(chat_id, record_id):
    return run_query(
        "SELECT id, item, amount, record_type, created_at FROM records WHERE chat_id = ? AND id = ?",
        (chat_id, record_id),
        fetch_mode="one",
    )


def update_record_by_id(chat_id, record_id, item, amount, record_type, created_at, user_id=None, user_name=None):
    if user_id:
        return run_query(
            "UPDATE records SET item = ?, amount = ?, record_type = ?, created_at = ?, user_id = ?, user_name = ? WHERE chat_id = ? AND id = ?",
            (item, amount, record_type, created_at.isoformat(), user_id, user_name or "", chat_id, record_id),
        )
    return run_query(
        "UPDATE records SET item = ?, amount = ?, record_type = ?, created_at = ? WHERE chat_id = ? AND id = ?",
        (item, amount, record_type, created_at.isoformat(), chat_id, record_id),
    )


def delete_record_by_id(chat_id, record_id):
    return run_query(
        "DELETE FROM records WHERE chat_id = ? AND id = ?",
        (chat_id, record_id),
    )


def save_manual_member(chat_id, member_name):
    normalized = normalize_member_name(member_name)
    run_query(
        """
        INSERT INTO manual_members (chat_id, member_name, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(chat_id, member_name)
        DO UPDATE SET created_at = excluded.created_at
        """,
        (chat_id, normalized, get_now().isoformat()),
    )
    return normalized


def get_manual_members(chat_id):
    rows = run_query(
        "SELECT member_name FROM manual_members WHERE chat_id = ? ORDER BY created_at DESC",
        (chat_id,),
        fetch_mode="all",
    )
    return [row[0] for row in rows]


def delete_manual_member(chat_id, member_name):
    normalized = normalize_member_name(member_name)
    return run_query(
        "DELETE FROM manual_members WHERE chat_id = ? AND member_name = ?",
        (chat_id, normalized),
    )


def upsert_member(chat_id, user_id, user_name, picture_url=""):
    run_query(
        """INSERT INTO members (chat_id, user_id, user_name, picture_url, joined_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(chat_id, user_id)
           DO UPDATE SET user_name = excluded.user_name, picture_url = excluded.picture_url, joined_at = excluded.joined_at""",
        (chat_id, user_id, user_name, picture_url, get_now().isoformat()),
    )


def get_db_members(chat_id):
    rows = run_query(
        "SELECT user_id, user_name, picture_url FROM members WHERE chat_id = ? ORDER BY joined_at ASC",
        (chat_id,),
        fetch_mode="all",
    )
    return [(r[0], r[1], r[2]) for r in rows]


def save_settlement_payment(chat_id, from_user_id, to_name, amount, created_at=None, to_user_id=""):
    run_query(
        "INSERT INTO settlement_payments (chat_id, from_user_id, to_user_id, to_name, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (chat_id, from_user_id, to_user_id or "", to_name, amount, created_at or get_now().isoformat()),
    )


# ─── Date / range ─────────────────────────────────────────────

def parse_month_param(month_str):
    try:
        dt = datetime.strptime(month_str, "%Y-%m")
        return {"type": "month_year", "year": dt.year, "month": dt.month,
                "label": f"{dt.year}年{dt.month}月"}
    except (ValueError, TypeError):
        now = get_now()
        return {"type": "month_year", "year": now.year, "month": now.month,
                "label": f"{now.year}年{now.month}月"}


def range_start_end(range_spec):
    y, m = range_spec["year"], range_spec["month"]
    start = datetime(y, m, 1)
    end = datetime(y + 1, 1, 1) if m == 12 else datetime(y, m + 1, 1)
    return start, end


# ─── LINE API helpers ─────────────────────────────────────────

def resolve_display_name(user_id, chat_id):
    if not user_id or user_id == "unknown":
        return "未知使用者"
    if user_id.startswith("__manual_"):
        return user_id[len("__manual_"):]
    if user_id.startswith("__untracked_"):
        return f"未記帳成員{user_id.split('_')[-1]}"
    try:
        if chat_id.startswith("group:"):
            group_id = chat_id[len("group:"):]
            resp = requests.get(
                f"https://api.line.me/v2/bot/group/{group_id}/member/{user_id}",
                headers=line_headers(), timeout=5,
            )
            if resp.status_code == 200:
                return resp.json().get("displayName", user_id)
        elif chat_id.startswith("room:"):
            room_id = chat_id[len("room:"):]
            resp = requests.get(
                f"https://api.line.me/v2/bot/room/{room_id}/member/{user_id}",
                headers=line_headers(), timeout=5,
            )
            if resp.status_code == 200:
                return resp.json().get("displayName", user_id)
        else:
            resp = requests.get(
                f"https://api.line.me/v2/bot/profile/{user_id}",
                headers=line_headers(), timeout=5,
            )
            if resp.status_code == 200:
                return resp.json().get("displayName", user_id)
    except Exception:
        pass
    return f"{user_id[:6]}...{user_id[-4:]}" if len(user_id) > 10 else user_id


def get_chat_participants(chat_id):
    member_ids = []
    try:
        if chat_id.startswith("group:"):
            group_id = chat_id[len("group:"):]
            start = None
            while True:
                url = f"https://api.line.me/v2/bot/group/{group_id}/members/ids"
                if start:
                    url += f"?start={start}"
                resp = requests.get(url, headers=line_headers(), timeout=5).json()
                member_ids.extend(resp.get("memberIds", []))
                start = resp.get("next")
                if not start:
                    break
        elif chat_id.startswith("room:"):
            room_id = chat_id[len("room:"):]
            start = None
            while True:
                url = f"https://api.line.me/v2/bot/room/{room_id}/members/ids"
                if start:
                    url += f"?start={start}"
                resp = requests.get(url, headers=line_headers(), timeout=5).json()
                member_ids.extend(resp.get("memberIds", []))
                start = resp.get("next")
                if not start:
                    break
        elif chat_id.startswith("user:"):
            member_ids = [chat_id[len("user:"):]]
    except Exception:
        pass
    return member_ids


def get_bot_user_id():
    try:
        resp = requests.get("https://api.line.me/v2/bot/info", headers=line_headers(), timeout=5)
        if resp.status_code == 200:
            return resp.json().get("userId")
    except Exception:
        pass
    return None


# ─── Auth ─────────────────────────────────────────────────────

def verify_line_token(token):
    try:
        resp = requests.get(
            "https://api.line.me/v2/profile",
            headers={"Authorization": f"Bearer {token}"},
            timeout=5,
        )
        if resp.status_code != 200:
            return None
        return resp.json().get("userId")
    except Exception:
        return None


def get_verified_user_id():
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    return verify_line_token(auth[len("Bearer "):])


# ─── Calculation helpers ──────────────────────────────────────

def get_loan_quota(chat_id):
    row = run_query(
        "SELECT value FROM group_config WHERE chat_id=? AND key='loan_quota'",
        [chat_id], fetch_mode="one"
    )
    return int(row[0]) if row else 0


def get_balance_summary(chat_id, range_spec):
    start, end = range_start_end(range_spec)
    where = "chat_id = ? AND created_at >= ? AND created_at < ?"
    params = [chat_id, start.isoformat(), end.isoformat()]
    total_expense = run_query(
        f"SELECT COALESCE(SUM(amount), 0) FROM records WHERE {where} AND record_type = '支出'",
        params, fetch_mode="one"
    )[0]
    total_income = run_query(
        f"SELECT COALESCE(SUM(amount), 0) FROM records WHERE {where} AND record_type = '收入'",
        params, fetch_mode="one"
    )[0]
    paid_rows = run_query(
        f"SELECT user_id, COALESCE(SUM(amount), 0) AS paid FROM records WHERE {where} AND record_type = '支出' GROUP BY user_id ORDER BY paid DESC",
        params, fetch_mode="all"
    )
    return total_expense, total_income, paid_rows


def get_previous_month_balance(chat_id, range_spec):
    y, m = range_spec["year"], range_spec["month"]
    curr_start = datetime(y, m, 1)

    # Determine the start of accounting (balance_start_month)
    start_month_row = run_query(
        "SELECT value FROM group_config WHERE chat_id=? AND key='balance_start_month'",
        [chat_id], fetch_mode="one"
    )
    if start_month_row:
        sy, sm = map(int, start_month_row[0].split("-"))
        range_start = datetime(sy, sm, 1)
    else:
        range_start = datetime(y - 1, 12, 1) if m == 1 else datetime(y, m - 1, 1)

    # If current month is at or before start, no carry-over
    if curr_start <= range_start:
        return 0

    # Iterate month by month, balance floors at 0 each month
    loan_quota = get_loan_quota(chat_id)
    balance = 0
    ptr = range_start
    while ptr < curr_start:
        if ptr.month == 12:
            next_ptr = datetime(ptr.year + 1, 1, 1)
        else:
            next_ptr = datetime(ptr.year, ptr.month + 1, 1)
        params = [chat_id, ptr.isoformat(), next_ptr.isoformat()]
        manual_income = run_query(
            "SELECT COALESCE(SUM(amount), 0) FROM records WHERE chat_id=? AND created_at>=? AND created_at<? AND record_type='收入'",
            params, fetch_mode="one"
        )[0]
        expense = run_query(
            "SELECT COALESCE(SUM(amount), 0) FROM records WHERE chat_id=? AND created_at>=? AND created_at<? AND record_type='支出'",
            params, fetch_mode="one"
        )[0]
        shortfall = max(expense - balance - manual_income, 0)
        loan_used = min(shortfall, loan_quota)
        balance = max(balance + manual_income + loan_used - expense, 0)
        ptr = next_ptr
    return balance


def get_expense_by_user(chat_id, range_spec):
    start, end = range_start_end(range_spec)
    params = [chat_id, start.isoformat(), end.isoformat()]
    return run_query(
        "SELECT user_id, COALESCE(SUM(amount), 0) AS paid FROM records WHERE chat_id = ? AND created_at >= ? AND created_at < ? AND record_type = '支出' GROUP BY user_id ORDER BY paid DESC",
        params, fetch_mode="all"
    )


def get_payments_for_range(chat_id, range_spec):
    start, end = range_start_end(range_spec)
    params = [chat_id, start.isoformat(), end.isoformat()]
    return run_query(
        "SELECT id, from_user_id, to_user_id, to_name, amount FROM settlement_payments WHERE chat_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at ASC",
        params, fetch_mode="all"
    )


def allocate_proportional(total, ids, weight_map):
    if total <= 0 or not ids:
        return {uid: 0 for uid in ids}
    total_w = sum(max(weight_map.get(uid, 0), 0) for uid in ids)
    if total_w <= 0:
        return {uid: 0 for uid in ids}
    allocs, fracs, allocated = {}, [], 0
    for uid in ids:
        w = max(weight_map.get(uid, 0), 0)
        raw = total * w / total_w
        base = int(raw)
        allocs[uid] = base
        allocated += base
        fracs.append((raw - base, uid))
    remaining = total - allocated
    for _, uid in sorted(fracs, key=lambda x: x[0], reverse=True):
        if remaining <= 0:
            break
        allocs[uid] += 1
        remaining -= 1
    return allocs


def compute_transfers(chat_id, range_spec):
    """Return list of required transfers for the given month, or [] if nothing owed."""
    paid_by_user_rows = get_expense_by_user(chat_id, range_spec)
    paid_map = {uid: paid for uid, paid in paid_by_user_rows}
    total_expense = sum(paid_map.values())
    if total_expense == 0:
        return []

    _, manual_income, _ = get_balance_summary(chat_id, range_spec)
    prev_balance = get_previous_month_balance(chat_id, range_spec)
    shortfall = max(total_expense - prev_balance - manual_income, 0)
    loan_used = min(shortfall, get_loan_quota(chat_id))
    available_bank = max(prev_balance + manual_income + loan_used, 0)
    bank_reimburse = min(total_expense, available_bank)
    member_extra = total_expense - bank_reimburse

    db_members = get_db_members(chat_id)
    manual_members = get_manual_members(chat_id)
    name_cache = {uid: name for uid, name, _pic in db_members}
    for name in manual_members:
        name_cache[f"__manual_{name}"] = name

    seen_ids, participant_rows = set(), []
    for uid, name, _pic in db_members:
        seen_ids.add(uid)
        participant_rows.append((uid, paid_map.get(uid, 0)))
    seen_names = {name for _, name, _pic in db_members}
    for name in manual_members:
        fake_uid = f"__manual_{name}"
        if name not in seen_names:
            seen_ids.add(fake_uid)
            seen_names.add(name)
            participant_rows.append((fake_uid, paid_map.get(fake_uid, 0)))
    for uid in paid_map:
        if uid and uid not in seen_ids:
            participant_rows.append((uid, paid_map.get(uid, 0)))
            seen_ids.add(uid)

    if not participant_rows:
        return []

    all_ids = [uid for uid, _ in participant_rows]
    bank_map = allocate_proportional(bank_reimburse, all_ids, {uid: paid_map.get(uid, 0) for uid in all_ids})
    count = len(participant_rows)
    base_share = member_extra // count
    share_rem = member_extra % count
    target_share = {uid: base_share + (1 if i < share_rem else 0) for i, (uid, _) in enumerate(participant_rows)}

    payment_rows = get_payments_for_range(chat_id, range_spec)

    def display_name(uid):
        return name_cache.get(uid) or uid

    name_to_id = {display_name(uid).strip(): uid for uid, _ in participant_rows}
    adjust = {uid: 0 for uid in all_ids}
    for _pid, from_uid, to_uid_stored, to_name, amt in payment_rows:
        to_uid = to_uid_stored if to_uid_stored else name_to_id.get(to_name)
        if from_uid in adjust and to_uid and to_uid in adjust:
            adjust[from_uid] += amt
            adjust[to_uid] -= amt

    creditors, debtors = [], []
    for uid, paid in participant_rows:
        after_bank = paid_map.get(uid, 0) - bank_map.get(uid, 0)
        delta = after_bank - target_share[uid] + adjust.get(uid, 0)
        if delta > 0:
            creditors.append([uid, delta])
        elif delta < 0:
            debtors.append([uid, -delta])

    transfers, ci, di = [], 0, 0
    while ci < len(creditors) and di < len(debtors):
        c_uid, c_need = creditors[ci]
        d_uid, d_need = debtors[di]
        amt = min(c_need, d_need)
        if amt > 0:
            transfers.append({"from": d_uid, "to": c_uid, "amount": amt})
        creditors[ci][1] -= amt
        debtors[di][1] -= amt
        if creditors[ci][1] == 0:
            ci += 1
        if debtors[di][1] == 0:
            di += 1

    return transfers


# ─── Webhook ──────────────────────────────────────────────────

def get_chat_id_from_source(source):
    if isinstance(source, GroupSource):
        return f"group:{source.group_id}"
    if isinstance(source, RoomSource):
        return f"room:{source.room_id}"
    return f"user:{source.user_id}"


@app.route("/callback", methods=["POST"])
def callback():
    signature = request.headers.get("X-Line-Signature", "")
    body = request.get_data(as_text=True)
    try:
        events = parser.parse(body, signature)
    except InvalidSignatureError:
        abort(400)

    for event in events:
        if not isinstance(event, MessageEvent):
            continue
        if not isinstance(event.message, TextMessageContent):
            continue

        # In groups/rooms, only respond when bot is @mentioned
        source = event.source
        if not isinstance(source, UserSource):
            bot_id = get_cached_bot_user_id()
            mentioned = False
            msg = event.message
            if hasattr(msg, 'mention') and msg.mention:
                for m in (msg.mention.mentionees or []):
                    if getattr(m, 'user_id', None) == bot_id:
                        mentioned = True
                        break
            if not mentioned:
                continue

        chat_id = get_chat_id_from_source(event.source)
        flex = {
            "type": "bubble",
            "size": "kilo",
            "body": {
                "type": "box",
                "layout": "vertical",
                "spacing": "sm",
                "paddingAll": "20px",
                "contents": [
                    {
                        "type": "text",
                        "text": "記帳系統",
                        "weight": "bold",
                        "size": "xl",
                        "color": "#06C755",
                    },
                    {
                        "type": "text",
                        "text": "點擊下方按鈕開啟記帳頁面",
                        "size": "sm",
                        "color": "#666666",
                        "margin": "sm",
                    },
                    {
                        "type": "button",
                        "style": "primary",
                        "color": "#06C755",
                        "margin": "md",
                        "action": {
                            "type": "uri",
                            "label": "開啟記帳",
                            "uri": f"{LIFF_URL}?chat_id={chat_id}",
                        },
                    },
                ],
            },
        }
        try:
            with ApiClient(configuration) as api_client:
                MessagingApi(api_client).reply_message(
                    ReplyMessageRequest(
                        reply_token=event.reply_token,
                        messages=[
                            FlexMessage(
                                alt_text="開啟記帳",
                                contents=FlexContainer.from_dict(flex),
                            )
                        ],
                    )
                )
        except Exception as e:
            app.logger.error("Reply failed: %s", e)

    return "OK"


# ─── LIFF page ────────────────────────────────────────────────

@app.route("/liff")
def liff_page():
    return render_template("liff.html", liff_id=LIFF_ID)


# ─── REST API ─────────────────────────────────────────────────

@app.route("/api/records", methods=["GET"])
def api_get_records():
    user_id = get_verified_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401

    chat_id = request.args.get("chat_id", "")
    range_spec = parse_month_param(request.args.get("month", ""))
    start, end = range_start_end(range_spec)

    rows = run_query(
        "SELECT id, user_id, user_name, item, amount, record_type, created_at FROM records WHERE chat_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at DESC, id DESC",
        (chat_id, start.isoformat(), end.isoformat()),
        fetch_mode="all",
    )
    # Fall back to members table then LINE API only for old records without stored user_name
    name_cache = None
    def get_name(user_id, stored_name):
        if stored_name:
            return stored_name
        nonlocal name_cache
        if name_cache is None:
            name_cache = {uid: name for uid, name, _pic in get_db_members(chat_id)}
        return name_cache.get(user_id) or resolve_display_name(user_id, chat_id)
    records = [
        {
            "id": row[0],
            "user_id": row[1],
            "name": get_name(row[1], row[2]),
            "item": row[3],
            "amount": row[4],
            "record_type": row[5],
            "created_at": row[6],
        }
        for row in rows
    ]
    return jsonify({"records": records, "month": range_spec["label"]})


@app.route("/api/record", methods=["POST"])
def api_create_record():
    verified_user_id = get_verified_user_id()
    if not verified_user_id:
        return jsonify({"error": "Unauthorized"}), 401

    data = request.get_json()
    chat_id = data.get("chat_id", "")
    payer_user_id = (data.get("user_id") or "").strip()
    user_id = payer_user_id if payer_user_id else verified_user_id
    user_name = (data.get("user_name") or "").strip()
    item = (data.get("item") or "").strip()
    record_type = data.get("record_type", "支出")
    date_str = data.get("date", "")

    if not item:
        return jsonify({"error": "item required"}), 400
    try:
        amount = int(data.get("amount", 0))
        if amount <= 0:
            raise ValueError
    except (ValueError, TypeError):
        return jsonify({"error": "amount must be positive integer"}), 400

    try:
        created_at = datetime.fromisoformat(date_str) if date_str else get_now()
    except ValueError:
        created_at = get_now()

    save_record(user_id, chat_id, user_name, item, amount, record_type, created_at)
    return jsonify({"ok": True})


@app.route("/api/record/<int:record_id>", methods=["PUT"])
def api_update_record(record_id):
    user_id = get_verified_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401

    data = request.get_json()
    chat_id = data.get("chat_id", "")
    existing = get_record_by_id(chat_id, record_id)
    if not existing:
        return jsonify({"error": "Not found"}), 404

    _, old_item, old_amount, old_type, old_dt = existing
    item = data.get("item", old_item)
    record_type = data.get("record_type", old_type)
    new_user_id = (data.get("user_id") or "").strip() or None
    new_user_name = (data.get("user_name") or "").strip()
    try:
        amount = int(data.get("amount", old_amount))
        if amount <= 0:
            raise ValueError
    except (ValueError, TypeError):
        return jsonify({"error": "amount must be positive integer"}), 400
    try:
        created_at = datetime.fromisoformat(data["date"]) if data.get("date") else datetime.fromisoformat(old_dt)
    except (ValueError, KeyError):
        created_at = datetime.fromisoformat(old_dt)

    update_record_by_id(chat_id, record_id, item, amount, record_type, created_at, new_user_id, new_user_name)
    return jsonify({"ok": True})


@app.route("/api/record/<int:record_id>", methods=["DELETE"])
def api_delete_record(record_id):
    user_id = get_verified_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401

    chat_id = request.args.get("chat_id", "")
    count = delete_record_by_id(chat_id, record_id)
    if count == 0:
        return jsonify({"error": "Not found"}), 404
    return jsonify({"ok": True})


@app.route("/api/summary", methods=["GET"])
def api_summary():
    user_id = get_verified_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401

    chat_id = request.args.get("chat_id", "")
    range_spec = parse_month_param(request.args.get("month", ""))

    total_expense, total_income, paid_rows = get_balance_summary(chat_id, range_spec)
    prev_balance = get_previous_month_balance(chat_id, range_spec)
    balance = prev_balance + total_income - total_expense

    name_cache = {uid: name for uid, name, _pic in get_db_members(chat_id)}
    paid_by_user = [
        {"user_id": uid, "name": name_cache.get(uid) or resolve_display_name(uid, chat_id), "paid": paid}
        for uid, paid in paid_rows
    ]
    return jsonify({
        "month": range_spec["label"],
        "previous_month_balance": prev_balance,
        "total_income": total_income,
        "total_expense": total_expense,
        "balance": balance,
        "paid_by_user": paid_by_user,
    })


@app.route("/api/config", methods=["GET"])
def api_config_get():
    user_id = get_verified_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401
    chat_id = request.args.get("chat_id", "")
    key = request.args.get("key", "")
    if not chat_id or not key:
        return jsonify({"error": "missing params"}), 400
    row = run_query(
        "SELECT value FROM group_config WHERE chat_id=? AND key=?",
        [chat_id, key], fetch_mode="one"
    )
    return jsonify({"value": row[0] if row else None})


@app.route("/api/config", methods=["POST"])
def api_config_set():
    user_id = get_verified_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401
    data = request.get_json()
    chat_id = data.get("chat_id", "")
    key = data.get("key", "")
    value = data.get("value", "")
    if not chat_id or not key:
        return jsonify({"error": "missing params"}), 400
    run_query(
        "INSERT OR REPLACE INTO group_config (chat_id, key, value) VALUES (?, ?, ?)",
        [chat_id, key, str(value)]
    )
    return jsonify({"ok": True})


@app.route("/api/monthly_expenses", methods=["GET"])
def api_monthly_expenses():
    user_id = get_verified_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401

    chat_id = request.args.get("chat_id", "")
    if not chat_id:
        return jsonify({"error": "missing params"}), 400

    rows = run_query(
        """SELECT substr(created_at, 1, 7) as month,
                  SUM(amount) as total
           FROM records
           WHERE chat_id = ? AND record_type = '支出'
           GROUP BY month
           ORDER BY month""",
        (chat_id,), fetch_mode="all"
    )
    return jsonify([{"month": r[0], "total": r[1]} for r in rows])


@app.route("/api/settlement", methods=["GET"])
def api_settlement():
    user_id = get_verified_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401

    chat_id = request.args.get("chat_id", "")
    range_spec = parse_month_param(request.args.get("month", ""))

    paid_by_user_rows = get_expense_by_user(chat_id, range_spec)
    paid_map = {uid: paid for uid, paid in paid_by_user_rows}
    total_expense = sum(paid_map.values())

    if total_expense == 0:
        return jsonify({
            "month": range_spec["label"],
            "total_expense": 0,
            "transfers": [],
            "payments": [],
            "participants": [],
            "message": "該月份尚無支出紀錄",
        })

    _, manual_income, _ = get_balance_summary(chat_id, range_spec)
    total_income = manual_income
    prev_balance = get_previous_month_balance(chat_id, range_spec)
    shortfall = max(total_expense - prev_balance - manual_income, 0)
    loan_used = min(shortfall, get_loan_quota(chat_id))
    available_bank = max(prev_balance + manual_income + loan_used, 0)
    bank_reimburse = min(total_expense, available_bank)
    member_extra = total_expense - bank_reimburse

    # Build participant list from DB members
    db_members = get_db_members(chat_id)
    manual_members = get_manual_members(chat_id)

    seen_ids = set()
    participant_rows = []
    for uid, name, _pic in db_members:
        seen_ids.add(uid)
        participant_rows.append((uid, paid_map.get(uid, 0)))

    # Add manual members
    seen_names = {name for _, name, _pic in db_members}
    for name in manual_members:
        fake_uid = f"__manual_{name}"
        if name not in seen_names:
            seen_ids.add(fake_uid)
            seen_names.add(name)
            participant_rows.append((fake_uid, paid_map.get(fake_uid, 0)))

    # Add payers who recorded expenses but aren't in members table (fallback)
    for uid in paid_map:
        if uid and uid not in seen_ids:
            participant_rows.append((uid, paid_map.get(uid, 0)))
            seen_ids.add(uid)

    if not participant_rows:
        return jsonify({
            "month": range_spec["label"],
            "total_expense": total_expense,
            "transfers": [],
            "payments": [],
            "participants": [],
            "message": "尚無成員，請先請群組成員開啟 LIFF 記帳頁面",
        })

    # Build name cache from DB members so we don't need extra LINE API calls
    name_cache = {uid: name for uid, name, _pic in db_members}
    for name in manual_members:
        name_cache[f"__manual_{name}"] = name

    def display_name(uid):
        if uid in name_cache:
            return name_cache[uid]
        return resolve_display_name(uid, chat_id)

    all_ids = [uid for uid, _ in participant_rows]
    bank_map = allocate_proportional(bank_reimburse, all_ids, {uid: paid_map.get(uid, 0) for uid in all_ids})

    count = len(participant_rows)
    base_share = member_extra // count
    share_rem = member_extra % count
    target_share = {uid: base_share + (1 if i < share_rem else 0) for i, (uid, _) in enumerate(participant_rows)}

    # Payment adjustments
    payment_rows = get_payments_for_range(chat_id, range_spec)
    name_to_id = {display_name(uid).strip(): uid for uid, _ in participant_rows}
    adjust = {uid: 0 for uid in all_ids}
    for _pid, from_uid, to_uid_stored, to_name, amt in payment_rows:
        to_uid = to_uid_stored if to_uid_stored else name_to_id.get(to_name)
        if from_uid in adjust and to_uid and to_uid in adjust:
            adjust[from_uid] += amt
            adjust[to_uid] -= amt

    # Calculate transfers
    creditors, debtors = [], []
    for uid, paid in participant_rows:
        after_bank = paid_map.get(uid, 0) - bank_map.get(uid, 0)
        delta = after_bank - target_share[uid] + adjust.get(uid, 0)
        if delta > 0:
            creditors.append([uid, delta])
        elif delta < 0:
            debtors.append([uid, -delta])

    transfers = []
    ci, di = 0, 0
    while ci < len(creditors) and di < len(debtors):
        c_uid, c_need = creditors[ci]
        d_uid, d_need = debtors[di]
        amt = min(c_need, d_need)
        if amt > 0:
            transfers.append({
                "from_user_id": d_uid,
                "from_name": display_name(d_uid),
                "to_user_id": c_uid,
                "to_name": display_name(c_uid),
                "amount": amt,
            })
        creditors[ci][1] -= amt
        debtors[di][1] -= amt
        if creditors[ci][1] == 0:
            ci += 1
        if debtors[di][1] == 0:
            di += 1

    participants_out = [
        {
            "user_id": uid,
            "name": display_name(uid),
            "paid": paid,
            "bank_withdraw": bank_map.get(uid, 0),
        }
        for uid, paid in participant_rows
    ]
    paid_payments = [
        {"id": pid, "from_name": display_name(f_uid), "to_name": to_name, "amount": amt}
        for pid, f_uid, _to_uid_s, to_name, amt in payment_rows
    ]

    return jsonify({
        "month": range_spec["label"],
        "previous_month_balance": prev_balance,
        "total_income": total_income,
        "total_expense": total_expense,
        "bank_reimbursement": bank_reimburse,
        "per_person_extra": int(round(member_extra / count)) if count > 0 else 0,
        "participants": participants_out,
        "transfers": transfers,
        "payments": paid_payments,
    })


@app.route("/api/payment/<int:payment_id>", methods=["DELETE"])
def api_delete_payment(payment_id):
    user_id = get_verified_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401
    chat_id = request.args.get("chat_id", "")
    count = run_query(
        "DELETE FROM settlement_payments WHERE id = ? AND chat_id = ?",
        (payment_id, chat_id)
    )
    if count == 0:
        return jsonify({"error": "Not found"}), 404
    return jsonify({"ok": True})


@app.route("/api/payment", methods=["POST"])
def api_create_payment():
    user_id = get_verified_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401

    data = request.get_json()
    chat_id = data.get("chat_id", "")
    to_name = (data.get("to_name") or "").strip()
    try:
        amount = int(data.get("amount", 0))
        if amount <= 0:
            raise ValueError
    except (ValueError, TypeError):
        return jsonify({"error": "amount must be positive integer"}), 400
    if not to_name:
        return jsonify({"error": "to_name required"}), 400

    month_str = (data.get("month") or "").strip()
    try:
        y, m = map(int, month_str.split("-"))
        payment_date = datetime(y, m, 1).isoformat()
    except Exception:
        payment_date = get_now().isoformat()

    from_user_id = (data.get("from_user_id") or "").strip() or user_id
    to_user_id = (data.get("to_user_id") or "").strip()

    save_manual_member(chat_id, to_name)
    save_settlement_payment(chat_id, from_user_id, to_name, amount, payment_date, to_user_id)
    return jsonify({"ok": True})


@app.route("/api/unsettled_check", methods=["GET"])
def api_unsettled_check():
    user_id = get_verified_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401

    chat_id = request.args.get("chat_id", "")
    now = get_now()
    if now.month == 1:
        last = now.replace(year=now.year - 1, month=12, day=1)
    else:
        last = now.replace(month=now.month - 1, day=1)

    month_str = last.strftime("%Y-%m")
    range_spec = parse_month_param(month_str)

    transfers = compute_transfers(chat_id, range_spec)
    unsettled = len(transfers) > 0
    return jsonify({"unsettled": unsettled, "month": month_str})


@app.route("/api/register_member", methods=["POST"])
def api_register_member():
    user_id = get_verified_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401
    data = request.get_json()
    chat_id = data.get("chat_id", "")
    user_name = (data.get("user_name") or "").strip()
    picture_url = (data.get("picture_url") or "").strip()
    if chat_id and user_name:
        upsert_member(chat_id, user_id, user_name, picture_url)
    return jsonify({"ok": True})


@app.route("/api/members", methods=["GET"])
def api_get_members():
    user_id = get_verified_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401

    chat_id = request.args.get("chat_id", "")
    db_members = get_db_members(chat_id)
    manual = get_manual_members(chat_id)

    return jsonify({
        "members": [{"user_id": uid, "name": name, "picture_url": pic, "source": "line"} for uid, name, pic in db_members]
                 + [{"user_id": f"__manual_{name}", "name": name, "picture_url": "", "source": "manual"} for name in manual]
    })


@app.route("/api/members", methods=["POST"])
def api_add_member():
    user_id = get_verified_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401

    data = request.get_json()
    chat_id = data.get("chat_id", "")
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name required"}), 400
    try:
        saved = save_manual_member(chat_id, name)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True, "name": saved})


@app.route("/api/members/<name>", methods=["DELETE"])
def api_delete_member(name):
    user_id = get_verified_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401

    chat_id = request.args.get("chat_id", "")
    count = delete_manual_member(chat_id, name)
    if count == 0:
        return jsonify({"error": "Not found"}), 404
    return jsonify({"ok": True})


@app.route("/api/members/merge", methods=["POST"])
def api_merge_member():
    user_id = get_verified_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401

    data = request.get_json()
    chat_id = data.get("chat_id", "")
    manual_name = (data.get("manual_name") or "").strip()
    if not manual_name:
        return jsonify({"error": "manual_name required"}), 400

    count = delete_manual_member(chat_id, manual_name)
    if count == 0:
        return jsonify({"error": "Manual member not found"}), 404
    return jsonify({"ok": True})


init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=True)
