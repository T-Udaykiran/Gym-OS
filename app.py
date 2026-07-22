import os
import sys
import uuid
import sqlite3
import json
import queue
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, session, Response, send_file
import database

# Ensure the schema exists before requests. Every environment (local and
# Vercel) talks to the same remote Supabase database, which is what makes
# data persist across Vercel's stateless serverless invocations.
database.init_db()

app = Flask(__name__, static_folder="static", static_url_path="")
app.secret_key = "gymos-secret-secure-key-9988"

# The server (e.g. Vercel's serverless runtime) may run in UTC while the gym
# operates in India Standard Time. Using the naive server clock directly would
# stamp check-ins hours away from the wall-clock time members actually
# scanned at, so every "current time" lookup in this file goes through here.
IST_OFFSET = timedelta(hours=5, minutes=30)


def now_ist():
    return datetime.utcnow() + IST_OFFSET

# Canonical DOB storage format is ISO "YYYY-MM-DD" everywhere. Also accepts the
# "12 May 1994" display format so members who saved a DOB before this format was
# enforced can still edit it without the value looking invalid.
def parse_and_validate_dob(value):
    """Returns (iso_string_or_None, error_message_or_None).
    A None value means "leave unchanged" (field was empty/omitted)."""
    if value is None:
        return None, None
    value = str(value).strip()
    if value == "":
        return None, None

    # Strip time component from ISO 8601 strings (e.g. '1994-05-11T00:00:00.000Z' -> '1994-05-11')
    if "T" in value:
        value = value.split("T")[0]
    if " " in value and ":" in value:
        value = value.split(" ")[0]

    # Remove commas (e.g. 'May 11, 1994' -> 'May 11 1994')
    clean_val = value.replace(",", "").strip()

    parsed = None
    formats = (
        "%Y-%m-%d", "%d %B %Y", "%d %b %Y", "%B %d %Y", "%b %d %Y",
        "%d/%m/%Y", "%Y/%m/%d", "%d-%m-%Y", "%m/%d/%Y", "%Y.%m.%d"
    )
    for fmt in formats:
        try:
            parsed = datetime.strptime(clean_val, fmt).date()
            break
        except ValueError:
            continue

    if parsed is None:
        return None, "Unrecognized date of birth format."

    today = now_ist().date()
    if parsed > today:
        return None, "Date of birth cannot be in the future."
    age_years = (today - parsed).days / 365.25
    if age_years < 10:
        return None, "Member must be at least 10 years old."
    if age_years > 120:
        return None, "Please enter a valid date of birth."
    return parsed.isoformat(), None

def generate_receipt_number(cursor, gym_id, payment_id=None):
    today_str = now_ist().strftime("%Y%m%d")
    if payment_id:
        return f"RCPT-PAY-{today_str}-{payment_id:06d}"
    
    prefix = f"RCPT-PAY-{today_str}-"
    cursor.execute("SELECT COUNT(*) FROM payments WHERE receipt_number LIKE ?", (prefix + "%",))
    count = cursor.fetchone()[0] + 1
    while True:
        candidate = f"{prefix}TEMP{count:06d}"
        cursor.execute("SELECT 1 FROM payments WHERE receipt_number = ?", (candidate,))
        if not cursor.fetchone():
            return candidate
        count += 1

# Active SSE event queues, each tagged with the gym they belong to so a
# check-in at one gym never reaches another gym's dashboard.
SSE_LISTENERS = []  # list of (gym_id, queue.Queue)


def broadcast_event(event_type, payload, gym_id):
    event_data = {
        "type": event_type,
        "payload": payload,
        "timestamp": now_ist().isoformat()
    }
    # Create copy of list to prevent modification during iteration
    for listener_gym_id, q in list(SSE_LISTENERS):
        if listener_gym_id != gym_id:
            continue
        try:
            q.put(event_data)
        except Exception:
            pass

def build_whatsapp_link(phone, message):
    """Build a wa.me link with the message pre-filled in the chat compose box.

    WhatsApp's click-to-chat links can only pre-fill a message - actually
    sending it still requires the recipient's device/WhatsApp Web session to
    tap Send, since WhatsApp has no API for silently firing messages from a
    plain web link (that requires the paid WhatsApp Business Platform).
    """
    import urllib.parse
    encoded_msg = urllib.parse.quote(message)
    clean_phone = "".join([c for c in phone if c.isdigit() or c == "+"])
    if clean_phone.startswith("0"):
        clean_phone = "+1" + clean_phone[1:]  # default fallback for testing
    return f"https://wa.me/{clean_phone}?text={encoded_msg}"

def log_action(cursor, action, entity_type=None, entity_id=None, details=None, gym_id=None):
    """Write one audit_log row for a state-changing action.

    Snapshots the actor's email/role at write time (not just their id) and
    never references entity_type/entity_id via a foreign key, so the log
    entry survives even if the actor's account or the entity itself is
    later deleted - that's the whole point of an audit trail.

    gym_id defaults to the caller's own session gym, but company-portal
    actions (which have no gym of their own) act ON a specific tenant, so
    they pass that tenant's id explicitly to keep it visible in that gym's
    log too.
    """
    cursor.execute(
        "INSERT INTO audit_log (actor_user_id, actor_email, actor_role, action, entity_type, entity_id, details, gym_id) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            session.get("user_id") or session.get("company_user_id"),
            session.get("email"),
            session.get("role"),
            action,
            entity_type,
            entity_id,
            json.dumps(details) if details is not None else None,
            gym_id if gym_id is not None else session.get("gym_id"),
        ),
    )

def sync_primary_emergency_contact(cursor, member_id, gym_id):
    """Mirror the first contact into legacy member columns for owner views.

    The emergency_contacts table is authoritative. The columns on members are
    kept populated so older owner screens and exports remain compatible.
    """
    cursor.execute("SELECT name, phone, relationship FROM emergency_contacts WHERE member_id = ? AND gym_id = ? ORDER BY id ASC LIMIT 1", (member_id, gym_id))
    contact = cursor.fetchone()
    if contact:
        legacy = f"{contact['name']} / {contact['phone']}"
        cursor.execute("UPDATE members SET emergency_contact = ?, emergency_contact_name = ?, emergency_contact_number = ?, emergency_contact_relation = ? WHERE id = ? AND gym_id = ?", (legacy, contact["name"], contact["phone"], contact["relationship"], member_id, gym_id))
    else:
        cursor.execute("UPDATE members SET emergency_contact = '', emergency_contact_name = '', emergency_contact_number = '', emergency_contact_relation = '' WHERE id = ? AND gym_id = ?", (member_id, gym_id))

def is_subscription_active(gym_id):
    """Whether a tenant's (manually-managed) company subscription is current."""
    if not gym_id:
        return False
    conn = database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT subscription_status, subscription_end_date FROM gyms WHERE id = ?", (gym_id,))
    row = cursor.fetchone()
    conn.close()
    if not row or row["subscription_status"] != "active":
        return False
    end_date = row["subscription_end_date"]
    if not end_date:
        return False
    return end_date >= now_ist().strftime("%Y-%m-%d")

# Helper decorator for authentication & role protection
def login_required(role=None, allow_expired=False):
    def decorator(f):
        from functools import wraps
        @wraps(f)
        def wrapper(*args, **kwargs):
            if "user_id" not in session:
                return jsonify({"error": "Unauthorized. Please login."}), 401
            if role and session.get("role") != role:
                return jsonify({"error": "Forbidden. Insufficient permissions."}), 403
            if not allow_expired and session.get("role") in ("owner", "member"):
                if not is_subscription_active(session.get("gym_id")):
                    return jsonify({
                        "error": "This gym's subscription is inactive. Please renew to continue.",
                        "subscription_expired": True
                    }), 402
            return f(*args, **kwargs)
        return wrapper
    return decorator

# Company-portal auth: separate role/session space from owner/member. A
# company account isn't scoped to any single gym, so it never sets
# session["gym_id"] and is exempt from the subscription check above.
def company_login_required(f):
    from functools import wraps
    @wraps(f)
    def wrapper(*args, **kwargs):
        if "company_user_id" not in session:
            return jsonify({"error": "Unauthorized. Please login."}), 401
        return f(*args, **kwargs)
    return wrapper

@app.route("/")
def index():
    return send_file(os.path.join(app.static_folder, "index.html"))

@app.route("/member/")
@app.route("/member")
def member_index():
    return send_file(os.path.join(app.static_folder, "member", "index.html"))

@app.route("/admin/")
@app.route("/admin")
def admin_index():
    return send_file(os.path.join(app.static_folder, "admin", "index.html"))

@app.route("/owner/")
@app.route("/owner")
def owner_index():
    return send_file(os.path.join(app.static_folder, "owner", "index.html"))

@app.route("/company/")
@app.route("/company")
def company_index():
    return send_file(os.path.join(app.static_folder, "company", "index.html"))

# ================= AUTHENTICATION ENDPOINTS =================

@app.route("/api/gyms/search", methods=["GET"])
def public_gym_search():
    """Public lookup for the registration screen's gym picker.

    Deliberately returns only id/name/gym_code - no phone, address, or
    subscription details - since this endpoint has no auth requirement.
    Only actively-subscribed gyms are returned, since registering into an
    inactive one would just be rejected anyway.
    """
    q = request.args.get("q", "").strip()
    if len(q) < 2:
        return jsonify([])

    conn = database.get_db_connection()
    cursor = conn.cursor()
    match = f"%{q}%"
    cursor.execute("""
        SELECT id, name, gym_code FROM gyms
        WHERE (gym_code ILIKE ? OR name ILIKE ?) AND subscription_status = 'active'
        ORDER BY name ASC
        LIMIT 10
    """, (match, match))
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return jsonify(rows)

@app.route("/api/auth/register", methods=["POST"])
def auth_register():
    data = request.get_json() or {}
    email = data.get("email")
    password = data.get("password")
    first_name = data.get("first_name")
    last_name = data.get("last_name") or ""
    phone = data.get("phone")
    emergency_name = data.get("emergency_contact_name")
    emergency_number = data.get("emergency_contact_number")
    legacy_emergency = data.get("emergency_contact")
    
    if (emergency_name is None and emergency_number is None) and legacy_emergency is not None:
        if "/" in legacy_emergency:
            parts = legacy_emergency.split("/", 1)
            emergency_name = parts[0].strip()
            emergency_number = parts[1].strip()
        else:
            emergency_name = ""
            emergency_number = legacy_emergency.strip()
            
    if legacy_emergency is None:
        if emergency_name and emergency_number:
            legacy_emergency = f"{emergency_name} / {emergency_number}"
        elif emergency_number:
            legacy_emergency = emergency_number
        else:
            legacy_emergency = ""

    # Transitional default: the gym-picker UI isn't wired up on the
    # registration screen yet, so fall back to tenant #1 until it is.
    gym_id = data.get("gym_id") or 1

    if not all([email, password, first_name, phone, emergency_name, emergency_number]):
        return jsonify({"error": "Missing required registration fields"}), 400

    conn = database.get_db_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT id, subscription_status, subscription_end_date FROM gyms WHERE id = ?", (gym_id,))
    gym = cursor.fetchone()
    if not gym:
        conn.close()
        return jsonify({"error": "Selected gym not found"}), 404
    if not is_subscription_active(gym_id):
        conn.close()
        return jsonify({"error": "This gym isn't currently accepting new registrations."}), 403

    try:
        # Create User
        password_hash = database.hash_password(password)
        cursor.execute(
            "INSERT INTO users (email, password_hash, role, gym_id) VALUES (?, ?, 'member', ?)",
            (email, password_hash, gym_id)
        )
        user_id = cursor.lastrowid

        # Create Member (status default is 'pending' and requires owner approval)
        cursor.execute(
            "INSERT INTO members (user_id, first_name, last_name, phone, emergency_contact, emergency_contact_name, emergency_contact_number, status, gym_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
            (user_id, first_name, last_name, phone, legacy_emergency, emergency_name, emergency_number, gym_id)
        )
        member_id = cursor.lastrowid
        # Do not create separate emergency contact records unless the member later adds a secondary contact.

        # Create a welcome notification
        cursor.execute(
            "INSERT INTO notifications (user_id, type, message, gym_id) VALUES (?, 'welcome', ?, ?)",
            (user_id, f"Welcome to GymOS, {first_name}! Access granted once approved. Please see the owner to purchase a membership plan.", gym_id)
        )
        
        log_action(cursor, "member_self_registered", "member", member_id, {
            "name": f"{first_name} {last_name}", "email": email
        })

        conn.commit()
        
        broadcast_event("MEMBER_REGISTERED", {
            "id": member_id,
            "name": f"{first_name} {last_name}",
            "email": email,
            "phone": phone
        }, gym_id)
        
        return jsonify({
            "success": True,
            "pending": True,
            "user": {"id": user_id, "email": email, "role": "member", "member_id": member_id}
        })
    except sqlite3.IntegrityError as e:
        conn.rollback()
        if "email" in str(e).lower():
            return jsonify({"error": "Email address already registered"}), 400
        return jsonify({"error": f"Registration failed: {e}"}), 400
    except Exception as e:
        conn.rollback()
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()

@app.route("/api/public/gym-info", methods=["GET"])
def public_gym_info():
    conn = database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT name, phone, address, logo_url FROM gyms ORDER BY id ASC LIMIT 1")
    row = cursor.fetchone()
    conn.close()
    if row:
        return jsonify({
            "name": row["name"] or "GymOS",
            "phone": row["phone"] or "",
            "address": row["address"] or "",
            "logo_url": row["logo_url"] or ""
        })
    return jsonify({
        "name": "GymOS",
        "phone": "",
        "address": "",
        "logo_url": ""
    })

@app.route("/api/auth/login", methods=["POST"])
def auth_login():
    data = request.get_json() or {}
    email = data.get("email")
    password = data.get("password")
    
    if not email or not password:
        return jsonify({"error": "Email and password are required"}), 400
        
    conn = database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT id, email, password_hash, role, gym_id FROM users WHERE email = ?", (email,))
    user = cursor.fetchone()

    if not user or not database.verify_password(user["password_hash"], password):
        conn.close()
        return jsonify({"error": "Invalid email or password"}), 401

    user_id = user["id"]
    role = user["role"]
    gym_id = user["gym_id"]

    member_id = None
    preferences_completed = False
    if role == "member":
        cursor.execute("SELECT id, status, first_name, last_name, preferences_completed FROM members WHERE user_id = ?", (user_id,))
        m = cursor.fetchone()
        if m:
            if m["status"] == "suspended":
                conn.close()
                return jsonify({"error": "Your GymOS account is currently suspended. Please contact the gym owner."}), 403
            if m["status"] == "pending":
                conn.close()
                return jsonify({"error": "Your GymOS registration is pending owner approval. Please wait."}), 403
            elif m["status"] == "rejected":
                conn.close()
                return jsonify({"error": "Your registration request was rejected. Please contact your gym.", "status": "rejected"}), 403
            member_id = m["id"]
            preferences_completed = bool(m["preferences_completed"])
            
    session["user_id"] = user_id
    session["role"] = role
    session["email"] = user["email"]
    session["gym_id"] = gym_id
    if member_id:
        session["member_id"] = member_id

    log_action(cursor, "login", "user", user_id, {"email": user["email"], "role": role})
    conn.commit()
    conn.close()

    return jsonify({
        "success": True,
        "user": {
            "id": user_id,
            "email": user["email"],
            "role": role,
            "member_id": member_id,
            "preferences_completed": preferences_completed if role == "member" else None,
            "subscription_active": is_subscription_active(gym_id) if role == "owner" else None
        }
    })

@app.route("/api/auth/me", methods=["GET"])
def auth_me():
    if "user_id" not in session:
        return jsonify({"user": None})
        
    conn = database.get_db_connection()
    cursor = conn.cursor()
    
    user_id = session["user_id"]
    role = session["role"]
    
    user_data = {
        "id": user_id,
        "email": session["email"],
        "role": role
    }

    if role == "owner":
        user_data["subscription_active"] = is_subscription_active(session.get("gym_id"))
        cursor.execute("SELECT first_name, last_name, profile_photo FROM users WHERE id = ?", (user_id,))
        u_row = cursor.fetchone()
        if u_row:
            user_data["first_name"] = u_row["first_name"] or ""
            user_data["last_name"] = u_row["last_name"] or ""
            user_data["profile_photo"] = u_row["profile_photo"] or ""

    if role == "member":
        cursor.execute("""
            SELECT m.*, mb.end_date, mb.status as membership_status 
            FROM members m
            LEFT JOIN memberships mb ON m.id = mb.member_id AND mb.status = 'active'
            WHERE m.user_id = ?
            ORDER BY mb.end_date DESC LIMIT 1
        """, (user_id,))
        m = cursor.fetchone()
        if m:
            user_data["member_details"] = dict(m)
            session["member_id"] = m["id"]
            
    conn.close()
    return jsonify({"user": user_data})

@app.route("/api/auth/logout", methods=["POST"])
def auth_logout():
    session.clear()
    return jsonify({"success": True})

# ================= COMPANY PORTAL AUTH =================
# Separate credential space from gym owners/members: a company account
# manages tenants rather than belonging to one, so it never gets a gym_id.

@app.route("/api/company/auth/login", methods=["POST"])
def company_auth_login():
    data = request.get_json() or {}
    email = data.get("email")
    password = data.get("password")

    if not email or not password:
        return jsonify({"error": "Email and password are required"}), 400

    conn = database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT id, email, password_hash FROM company_users WHERE email = ?", (email,))
    user = cursor.fetchone()

    if not user or not database.verify_password(user["password_hash"], password):
        conn.close()
        return jsonify({"error": "Invalid email or password"}), 401

    session.clear()
    session["company_user_id"] = user["id"]
    session["role"] = "company"
    session["email"] = user["email"]
    conn.close()

    return jsonify({"success": True, "user": {"id": user["id"], "email": user["email"]}})

@app.route("/api/company/auth/me", methods=["GET"])
def company_auth_me():
    if "company_user_id" not in session:
        return jsonify({"user": None})
    return jsonify({"user": {"id": session["company_user_id"], "email": session.get("email")}})

# ================= COMPANY PORTAL: TENANT MANAGEMENT =================

@app.route("/api/company/gyms", methods=["GET"])
@company_login_required
def company_get_gyms():
    conn = database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT g.id, g.name, g.phone, g.address, g.gym_code, g.subscription_status, g.subscription_end_date,
               u.email as owner_email,
               (SELECT COUNT(*) FROM members m WHERE m.gym_id = g.id AND m.status NOT IN ('pending', 'rejected')) as member_count
        FROM gyms g
        LEFT JOIN users u ON g.owner_user_id = u.id
        ORDER BY g.id DESC
    """)
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return jsonify(rows)

@app.route("/api/company/gyms", methods=["POST"])
@company_login_required
def company_create_gym():
    data = request.get_json() or {}
    gym_name = data.get("gym_name")
    gym_phone = data.get("gym_phone", "")
    gym_address = data.get("gym_address", "")
    owner_first_name = data.get("owner_first_name")
    owner_email = data.get("owner_email")
    owner_password = data.get("owner_password")

    if not all([gym_name, owner_first_name, owner_email, owner_password]):
        return jsonify({"error": "Gym name, owner name, email, and password are required"}), 400

    conn = database.get_db_connection()
    cursor = conn.cursor()

    try:
        qr_token = f"gymos-{database.generate_gym_code(gym_name).lower()}"
        cursor.execute(
            "INSERT INTO gyms (name, phone, address, qr_code_token) VALUES (?, ?, ?, ?)",
            (gym_name, gym_phone, gym_address, qr_token)
        )
        gym_id = cursor.lastrowid
        gym_code = database.unique_gym_code(cursor, gym_name)

        pw_hash = database.hash_password(owner_password)
        cursor.execute(
            "INSERT INTO users (email, password_hash, role, gym_id, first_name) VALUES (?, ?, 'owner', ?, ?)",
            (owner_email, pw_hash, gym_id, owner_first_name)
        )
        owner_user_id = cursor.lastrowid

        # New tenants start unpaid - the company must mark a subscription
        # paid before the owner portal unlocks (see is_subscription_active).
        cursor.execute(
            "UPDATE gyms SET gym_code = ?, owner_user_id = ?, subscription_status = 'expired' WHERE id = ?",
            (gym_code, owner_user_id, gym_id)
        )

        # Seed default settings so the owner portal has something to show immediately.
        cursor.execute("INSERT INTO settings (key, value, gym_id) VALUES ('gym_name', ?, ?)", (gym_name, gym_id))
        if gym_phone:
            cursor.execute("INSERT INTO settings (key, value, gym_id) VALUES ('gym_phone', ?, ?)", (gym_phone, gym_id))
        if gym_address:
            cursor.execute("INSERT INTO settings (key, value, gym_id) VALUES ('gym_address', ?, ?)", (gym_address, gym_id))
        cursor.execute("INSERT INTO settings (key, value, gym_id) VALUES ('qr_token', ?, ?)", (qr_token, gym_id))

        log_action(cursor, "gym_created", "gym", gym_id, {
            "gym_name": gym_name, "gym_code": gym_code, "owner_email": owner_email
        }, gym_id=gym_id)
        conn.commit()

        return jsonify({"success": True, "gym_id": gym_id, "gym_code": gym_code})
    except sqlite3.IntegrityError:
        conn.rollback()
        return jsonify({"error": "Owner email already exists"}), 400
    except Exception as e:
        conn.rollback()
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()

@app.route("/api/company/gyms/<int:id>", methods=["GET"])
@company_login_required
def company_get_gym_detail(id):
    conn = database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT g.*, u.email as owner_email
        FROM gyms g
        LEFT JOIN users u ON g.owner_user_id = u.id
        WHERE g.id = ?
    """, (id,))
    gym = cursor.fetchone()
    if not gym:
        conn.close()
        return jsonify({"error": "Gym not found"}), 404

    cursor.execute("""
        SELECT cs.*, cp.name as plan_name
        FROM company_subscriptions cs
        LEFT JOIN company_plans cp ON cs.company_plan_id = cp.id
        WHERE cs.gym_id = ?
        ORDER BY cs.created_at DESC
    """, (id,))
    history = [dict(r) for r in cursor.fetchall()]

    cursor.execute("SELECT COUNT(*) FROM members WHERE gym_id = ? AND status NOT IN ('pending', 'rejected')", (id,))
    member_count = cursor.fetchone()[0]

    conn.close()
    return jsonify({"gym": dict(gym), "subscription_history": history, "member_count": member_count})

@app.route("/api/company/gyms/<int:id>/mark-paid", methods=["POST"])
@company_login_required
def company_mark_gym_paid(id):
    data = request.get_json() or {}
    company_plan_id = data.get("company_plan_id")
    amount_paid = data.get("amount_paid")
    start_date_str = data.get("start_date") or now_ist().strftime("%Y-%m-%d")
    notes = data.get("notes")

    if not company_plan_id:
        return jsonify({"error": "A subscription plan is required"}), 400

    conn = database.get_db_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT id, name FROM gyms WHERE id = ?", (id,))
    gym = cursor.fetchone()
    if not gym:
        conn.close()
        return jsonify({"error": "Gym not found"}), 404

    cursor.execute("SELECT name, price, duration_months FROM company_plans WHERE id = ?", (company_plan_id,))
    plan = cursor.fetchone()
    if not plan:
        conn.close()
        return jsonify({"error": "Subscription plan not found"}), 404

    try:
        start_date = datetime.strptime(start_date_str, "%Y-%m-%d")
    except ValueError:
        conn.close()
        return jsonify({"error": "Invalid start_date format, must be YYYY-MM-DD"}), 400

    end_date = start_date + timedelta(days=plan["duration_months"] * 30)
    end_date_str = end_date.strftime("%Y-%m-%d")
    pay_time = now_ist().strftime("%Y-%m-%d %H:%M:%S")

    try:
        cursor.execute("""
            INSERT INTO company_subscriptions (gym_id, company_plan_id, status, start_date, end_date, amount_paid, payment_date, notes)
            VALUES (?, ?, 'active', ?, ?, ?, ?, ?)
        """, (id, company_plan_id, start_date_str, end_date_str,
              amount_paid if amount_paid is not None else plan["price"], pay_time, notes))

        cursor.execute(
            "UPDATE gyms SET subscription_status = 'active', subscription_end_date = ?, subscription_plan_id = ? WHERE id = ?",
            (end_date_str, company_plan_id, id)
        )

        log_action(cursor, "gym_subscription_paid", "gym", id, {
            "plan_name": plan["name"], "amount_paid": amount_paid if amount_paid is not None else plan["price"],
            "end_date": end_date_str
        }, gym_id=id)
        conn.commit()

        return jsonify({"success": True, "subscription_end_date": end_date_str})
    except Exception as e:
        conn.rollback()
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()

# ================= COMPANY PORTAL: SUBSCRIPTION PLAN TIERS =================

@app.route("/api/company/plans", methods=["GET"])
@company_login_required
def company_get_plans():
    conn = database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM company_plans ORDER BY price ASC")
    p_list = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return jsonify(p_list)

@app.route("/api/company/plans", methods=["POST"])
@company_login_required
def company_create_plan():
    data = request.get_json() or {}
    name = data.get("name")
    price = data.get("price")
    duration = data.get("duration_months")

    if not all([name, price is not None, duration]):
        return jsonify({"error": "Missing required plan fields"}), 400

    conn = database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO company_plans (name, price, duration_months) VALUES (?, ?, ?)",
        (name, float(price), int(duration))
    )
    plan_id = cursor.lastrowid
    log_action(cursor, "company_plan_created", "company_plan", plan_id, {"name": name, "price": price, "duration_months": duration})
    conn.commit()
    conn.close()

    return jsonify({"success": True, "plan_id": plan_id})

@app.route("/api/company/plans/<int:id>", methods=["PUT"])
@company_login_required
def company_update_plan(id):
    data = request.get_json() or {}
    name = data.get("name")
    price = data.get("price")
    duration = data.get("duration_months")

    if not all([name, price is not None, duration]):
        return jsonify({"error": "Missing plan edit data"}), 400

    conn = database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        "UPDATE company_plans SET name = ?, price = ?, duration_months = ? WHERE id = ?",
        (name, float(price), int(duration), id)
    )
    log_action(cursor, "company_plan_updated", "company_plan", id, {"name": name, "price": price, "duration_months": duration})
    conn.commit()
    conn.close()
    return jsonify({"success": True})

@app.route("/api/company/plans/<int:id>", methods=["DELETE"])
@company_login_required
def company_delete_plan(id):
    conn = database.get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("DELETE FROM company_plans WHERE id = ?", (id,))
        log_action(cursor, "company_plan_deleted", "company_plan", id, {})
        conn.commit()
        return jsonify({"success": True})
    except sqlite3.IntegrityError:
        return jsonify({"error": "Cannot delete plan. It has subscription history assigned."}), 400
    finally:
        conn.close()

@app.route("/api/auth/reset-password", methods=["POST"])
def auth_reset_password():
    # No email/SMS infrastructure is configured, so identity is verified with
    # a second factor (phone on file) instead of a mailed reset link.
    data = request.get_json() or {}
    email = (data.get("email") or "").strip()
    phone = (data.get("phone") or "").strip()
    new_password = data.get("new_password") or ""

    if not email or not phone or not new_password:
        return jsonify({"error": "Email, phone number and a new password are required"}), 400
    if len(new_password) < 8:
        return jsonify({"error": "New password must be at least 8 characters"}), 400

    conn = database.get_db_connection()
    cursor = conn.cursor()

    generic_error = jsonify({"error": "No account matches that email and phone number combination"}), 404

    cursor.execute("SELECT id, role, gym_id FROM users WHERE email = ?", (email,))
    user = cursor.fetchone()
    if not user:
        conn.close()
        return generic_error

    verified = False
    if user["role"] == "member":
        cursor.execute("SELECT phone FROM members WHERE user_id = ?", (user["id"],))
        m = cursor.fetchone()
        if m and m["phone"] and m["phone"].strip() == phone:
            verified = True
    else:
        cursor.execute("SELECT phone FROM gyms WHERE id = ?", (user["gym_id"],))
        g = cursor.fetchone()
        if g and g["phone"] and g["phone"].strip() == phone:
            verified = True

    if not verified:
        conn.close()
        return generic_error

    password_hash = database.hash_password(new_password)
    cursor.execute("UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, user["id"]))
    log_action(cursor, "password_reset", "user", user["id"], {"email": email})
    conn.commit()
    conn.close()

    return jsonify({"success": True, "message": "Password updated. You can now sign in with your new password."})

# ================= SERVER-SENT EVENTS (SSE) STREAM =================

@app.route("/api/stream")
@login_required()
def sse_stream():
    gym_id = session["gym_id"]

    def event_generator():
        q = queue.Queue()
        listener = (gym_id, q)
        SSE_LISTENERS.append(listener)
        try:
            # Send initial connected event
            yield f"data: {json.dumps({'type': 'CONNECTED', 'payload': {}})}\n\n"
            while True:
                try:
                    # Block for 15s, then trigger keepalive ping
                    event = q.get(timeout=15)
                    yield f"data: {json.dumps(event)}\n\n"
                except queue.Empty:
                    yield ":keepalive\n\n"
        except GeneratorExit:
            if listener in SSE_LISTENERS:
                SSE_LISTENERS.remove(listener)
    res = Response(event_generator(), mimetype="text/event-stream")
    res.headers["Cache-Control"] = "no-cache"
    res.headers["Connection"] = "keep-alive"
    res.headers["X-Accel-Buffering"] = "no"
    return res

# ================= ADMIN STATS & ANALYTICS =================

@app.route("/api/admin/stats", methods=["GET"])
@login_required("owner")
def admin_stats():
    conn = database.get_db_connection()
    cursor = conn.cursor()
    gym_id = session["gym_id"]

    # 1. Total Members
    cursor.execute("SELECT COUNT(*) FROM members WHERE gym_id = ? AND status NOT IN ('pending', 'rejected')", (gym_id,))
    t_members = cursor.fetchone()[0]

    # 2. Active Members (Active status and active membership duration)
    today = now_ist().strftime("%Y-%m-%d")
    cursor.execute("""
        SELECT COUNT(distinct member_id) FROM memberships
        WHERE gym_id = ? AND status = 'active' AND end_date >= ?
    """, (gym_id, today))
    act_members = cursor.fetchone()[0]

    # 3. Today's Checkins
    today_start = now_ist().strftime("%Y-%m-%d 00:00:00")
    cursor.execute("""
        SELECT COUNT(*) FROM attendance
        WHERE gym_id = ? AND status = 'success' AND check_in_time >= ?
    """, (gym_id, today_start))
    today_checkins = cursor.fetchone()[0]

    # 4. Today's Revenue
    cursor.execute("""
        SELECT SUM(amount) FROM payments
        WHERE gym_id = ? AND status = 'paid' AND payment_date >= ?
    """, (gym_id, today_start))
    today_revenue = cursor.fetchone()[0] or 0.0

    # 5. Monthly Revenue (Current Month)
    month_start = now_ist().strftime("%Y-%m-01 00:00:00")
    cursor.execute("""
        SELECT SUM(amount) FROM payments
        WHERE gym_id = ? AND status = 'paid' AND payment_date >= ?
    """, (gym_id, month_start))
    monthly_revenue = cursor.fetchone()[0] or 0.0

    # 6. Pending / Overdue Payments
    cursor.execute("SELECT COUNT(*), SUM(amount) FROM payments WHERE gym_id = ? AND status IN ('pending', 'overdue')", (gym_id,))
    row_pending = cursor.fetchone()
    pending_payments = row_pending[0] or 0
    pending_amount = row_pending[1] or 0.0

    # 6b. Pending Approval Payments
    cursor.execute("SELECT COUNT(*) FROM payments WHERE gym_id = ? AND status = 'pending_approval'", (gym_id,))
    pending_approvals = cursor.fetchone()[0] or 0

    # 7. Memberships Expiring (within 7 Days)
    next_week = (now_ist() + timedelta(days=7)).strftime("%Y-%m-%d")
    cursor.execute("""
        SELECT COUNT(*) FROM memberships
        WHERE gym_id = ? AND status = 'active' AND end_date >= ? AND end_date <= ?
    """, (gym_id, today, next_week))
    expiring_members = cursor.fetchone()[0]

    # 8. New Members This Week
    week_start = (now_ist() - timedelta(days=7)).strftime("%Y-%m-%d %H:%M:%S")
    cursor.execute("SELECT COUNT(*) FROM members WHERE gym_id = ? AND joined_at >= ? AND status NOT IN ('pending', 'rejected')", (gym_id, week_start))
    new_members_week = cursor.fetchone()[0]

    # 9. Chart Data: Monthly Revenue Last 6 Months
    revenue_chart = []
    for i in range(5, -1, -1):
        target_month = (now_ist() - timedelta(days=i*30))
        m_start = target_month.strftime("%Y-%m-01 00:00:00")
        m_end = (target_month + timedelta(days=31)).strftime("%Y-%m-01 00:00:00")
        m_label = target_month.strftime("%b")

        cursor.execute("SELECT SUM(amount) FROM payments WHERE gym_id = ? AND status = 'paid' AND payment_date >= ? AND payment_date < ?", (gym_id, m_start, m_end))
        rev = cursor.fetchone()[0] or 0.0
        revenue_chart.append({"month": m_label, "revenue": rev})

    # 10. Chart Data: Attendance Last 7 Days
    attendance_chart = []
    for i in range(6, -1, -1):
        target_day = (now_ist() - timedelta(days=i))
        d_start = target_day.strftime("%Y-%m-%d 00:00:00")
        d_end = target_day.strftime("%Y-%m-%d 23:59:59")
        d_label = target_day.strftime("%a")

        cursor.execute("SELECT COUNT(*) FROM attendance WHERE gym_id = ? AND status = 'success' AND check_in_time >= ? AND check_in_time <= ?", (gym_id, d_start, d_end))
        cnt = cursor.fetchone()[0]
        attendance_chart.append({"day": d_label, "count": cnt})

    # 11. Pending Payments List
    cursor.execute("""
        SELECT p.*, m.first_name, m.last_name, m.phone, pl.name as plan_name
        FROM payments p
        JOIN members m ON p.member_id = m.id
        LEFT JOIN memberships ms ON p.membership_id = ms.id
        LEFT JOIN plans pl ON ms.plan_id = pl.id
        WHERE p.gym_id = ? AND p.status IN ('pending', 'overdue')
        ORDER BY p.due_date ASC LIMIT 5
    """, (gym_id,))
    pending_payments_list = [dict(row) for row in cursor.fetchall()]

    # 12. Membership Expiring Soon List
    cursor.execute("""
        SELECT m.id as member_id, m.first_name, m.last_name, ms.end_date, pl.name as plan_name, p.id as payment_id
        FROM memberships ms
        JOIN members m ON ms.member_id = m.id
        LEFT JOIN plans pl ON ms.plan_id = pl.id
        LEFT JOIN payments p ON p.membership_id = ms.id AND p.status != 'paid'
        WHERE ms.gym_id = ? AND ms.status = 'active' AND ms.end_date >= ? AND ms.end_date <= ?
        ORDER BY ms.end_date ASC LIMIT 5
    """, (gym_id, today, next_week))
    expiring_members_list = [dict(row) for row in cursor.fetchall()]

    # 13. New Members Recent Joiners List
    cursor.execute("""
        SELECT m.id, m.first_name, m.last_name, m.profile_photo, m.joined_at, pl.name as plan_name
        FROM members m
        LEFT JOIN memberships ms ON ms.member_id = m.id AND ms.status = 'active'
        LEFT JOIN plans pl ON ms.plan_id = pl.id
        WHERE m.gym_id = ? AND m.status NOT IN ('pending', 'rejected')
        ORDER BY m.joined_at DESC LIMIT 5
    """, (gym_id,))
    new_members_list = [dict(row) for row in cursor.fetchall()]

    # 14. Recent Activity Log
    cursor.execute("""
        SELECT a.id, m.first_name, m.last_name, a.check_in_time, a.status, a.error_msg
        FROM attendance a
        JOIN members m ON a.member_id = m.id
        WHERE a.gym_id = ?
        ORDER BY a.check_in_time DESC LIMIT 5
    """, (gym_id,))
    recent_activities = []
    for row in cursor.fetchall():
        status_text = "checked in" if row["status"] == "success" else f"check-in failed: {row['error_msg']}"
        recent_activities.append({
            "id": row["id"],
            "name": f"{row['first_name']} {row['last_name']}",
            "time": row["check_in_time"],
            "description": status_text,
            "status": row["status"]
        })
        
    # Count pending registrations
    cursor.execute("SELECT COUNT(*) FROM members WHERE gym_id = ? AND status = 'pending'", (gym_id,))
    pending_regs_count = cursor.fetchone()[0] or 0

    # Win Back Members Count (15+ days absent)
    cursor.execute("""
        SELECT COUNT(distinct m.id) FROM members m
        LEFT JOIN (
            SELECT member_id, MAX(check_in_time) as max_time
            FROM attendance
            WHERE status = 'success' AND gym_id = ?
            GROUP BY member_id
        ) a ON m.id = a.member_id
        WHERE m.gym_id = ? AND m.status = 'active'
          AND (date_part('day', now() - COALESCE(a.max_time::timestamp, m.joined_at::timestamp)) >= 15)
    """, (gym_id, gym_id))
    win_back_count = cursor.fetchone()[0] or 0
    
    # Replaced Revenue analytics calculations for Total Revenue card
    cursor.execute("SELECT SUM(amount) FROM payments WHERE status = 'paid' AND gym_id = ?", (gym_id,))
    lifetime_revenue = cursor.fetchone()[0] or 0.0
    
    now_dt = now_ist()
    this_month_start = now_dt.strftime("%Y-%m-01 00:00:00")
    if now_dt.month == 1:
        last_month_start = f"{now_dt.year - 1}-12-01 00:00:00"
        last_month_end = f"{now_dt.year}-01-01 00:00:00"
    else:
        last_month_start = f"{now_dt.year}-{str(now_dt.month - 1).zfill(2)}-01 00:00:00"
        last_month_end = this_month_start
    cursor.execute("SELECT SUM(amount) FROM payments WHERE status = 'paid' AND payment_date >= ? AND payment_date < ? AND gym_id = ?", (last_month_start, last_month_end, gym_id))
    last_month_revenue = cursor.fetchone()[0] or 0.0
    
    if last_month_revenue > 0:
        growth_rate = round(((monthly_revenue - last_month_revenue) / last_month_revenue) * 100, 1)
    else:
        growth_rate = 100.0 if monthly_revenue > 0 else 0.0
        
    conn.close()
    
    return jsonify({
        "stats": {
            "total_members": t_members,
            "active_members": act_members,
            "today_checkins": today_checkins,
            "today_revenue": today_revenue,
            "monthly_revenue": monthly_revenue,
            "lifetime_revenue": lifetime_revenue,
            "growth_rate": growth_rate,
            "pending_payments": pending_payments,
            "pending_amount": pending_amount,
            "pending_approvals": pending_approvals,
            "expiring_members": expiring_members,
            "new_members_week": new_members_week,
            "pending_registrations_count": pending_regs_count,
            "win_back_members_count": win_back_count,
        },
        "charts": {
            "revenue": revenue_chart,
            "attendance": attendance_chart
        },
        "pending_payments_list": pending_payments_list,
        "expiring_members_list": expiring_members_list,
        "new_members_list": new_members_list,
        "recent_activity": recent_activities
    })

# ================= WIN BACK CRM ENDPOINTS =================

@app.route("/api/admin/win-back/members", methods=["GET"])
@login_required("owner")
def get_win_back_members():
    conn = database.get_db_connection()
    cursor = conn.cursor()
    gym_id = session["gym_id"]
    
    search = request.args.get("search", "").strip()
    days_filter = request.args.get("days", "15")
    start_date = request.args.get("start_date", "").strip()
    end_date = request.args.get("end_date", "").strip()
    page = int(request.args.get("page", 1))
    limit = int(request.args.get("limit", 25))
    offset = (page - 1) * limit

    where_clauses = ["m.gym_id = ?", "m.status = 'active'"]
    params = [gym_id]
    
    if search:
        where_clauses.append("(m.first_name ILIKE ? OR m.last_name ILIKE ? OR m.phone ILIKE ?)")
        params.extend([f"%{search}%", f"%{search}%", f"%{search}%"])
        
    sql = f"""
        SELECT m.id, m.first_name, m.last_name, m.phone, m.profile_photo, m.status, m.joined_at,
               ms.end_date as expiry_date, pl.name as plan_name,
               a.max_time as last_visit,
               date_part('day', now() - COALESCE(a.max_time::timestamp, m.joined_at::timestamp))::integer as days_inactive,
               wbi.interaction_type as last_interaction_type,
               wbi.contacted_at as last_interaction_time,
               wbi.follow_up_date as last_follow_up_date
        FROM members m
        LEFT JOIN memberships ms ON ms.member_id = m.id AND ms.status = 'active'
        LEFT JOIN plans pl ON ms.plan_id = pl.id
        LEFT JOIN (
            SELECT member_id, MAX(check_in_time) as max_time
            FROM attendance
            WHERE status = 'success' AND gym_id = ?
            GROUP BY member_id
        ) a ON m.id = a.member_id
        LEFT JOIN (
            SELECT w1.member_id, w1.interaction_type, w1.contacted_at, w1.follow_up_date
            FROM win_back_interactions w1
            JOIN (
                SELECT member_id, MAX(id) as max_id
                FROM win_back_interactions
                WHERE gym_id = ?
                GROUP BY member_id
            ) w2 ON w1.id = w2.max_id
        ) wbi ON m.id = wbi.member_id
        WHERE {' AND '.join(where_clauses)}
    """
    params_for_base = [gym_id, gym_id] + params
    
    outer_clauses = []
    outer_params = []
    
    if start_date and end_date:
        outer_clauses.append("COALESCE(last_visit::date, joined_at::date) BETWEEN ?::date AND ?::date")
        outer_params.extend([start_date, end_date])
    else:
        if days_filter == "30":
            outer_clauses.append("days_inactive >= 30")
        elif days_filter == "60":
            outer_clauses.append("days_inactive >= 60")
        else:
            outer_clauses.append("days_inactive >= 15")
            
    outer_sql = f"SELECT * FROM ({sql}) sub"
    if outer_clauses:
        outer_sql += f" WHERE {' AND '.join(outer_clauses)}"
        
    count_sql = f"SELECT COUNT(*) FROM ({outer_sql}) sub2"
    cursor.execute(count_sql, params_for_base + outer_params)
    total = cursor.fetchone()[0] or 0
    
    outer_sql += " ORDER BY days_inactive DESC LIMIT ? OFFSET ?"
    cursor.execute(outer_sql, params_for_base + outer_params + [limit, offset])
    rows = cursor.fetchall()
    conn.close()
    
    members = [dict(r) for r in rows]
    return jsonify({
        "data": members,
        "total": total,
        "page": page,
        "limit": limit
    })

@app.route("/api/admin/win-back/analytics", methods=["GET"])
@login_required("owner")
def get_win_back_analytics():
    conn = database.get_db_connection()
    cursor = conn.cursor()
    gym_id = session["gym_id"]
    
    cursor.execute("""
        SELECT 
            COUNT(CASE WHEN days_inactive >= 15 THEN 1 END) as total_win_back,
            COUNT(CASE WHEN days_inactive >= 15 AND days_inactive <= 30 THEN 1 END) as inactive_15_30,
            COUNT(CASE WHEN days_inactive > 30 AND days_inactive <= 60 THEN 1 END) as inactive_30_60,
            COUNT(CASE WHEN days_inactive > 60 THEN 1 END) as inactive_60_plus
        FROM (
            SELECT m.id,
                   date_part('day', now() - COALESCE(a.max_time::timestamp, m.joined_at::timestamp)) as days_inactive
            FROM members m
            LEFT JOIN (
                SELECT member_id, MAX(check_in_time) as max_time
                FROM attendance
                WHERE status = 'success' AND gym_id = ?
                GROUP BY member_id
            ) a ON m.id = a.member_id
            WHERE m.gym_id = ? AND m.status = 'active'
        ) sub
    """, (gym_id, gym_id))
    counts = cursor.fetchone()
    
    total_win_back = counts["total_win_back"] or 0
    inactive_15_30 = counts["inactive_15_30"] or 0
    inactive_30_60 = counts["inactive_30_60"] or 0
    inactive_60_plus = counts["inactive_60_plus"] or 0
    
    month_start = now_ist().strftime("%Y-%m-01 00:00:00")
    cursor.execute("""
        SELECT COUNT(*) FROM win_back_recoveries
        WHERE gym_id = ? AND recovery_date >= ?
    """, (gym_id, month_start))
    recovered_this_month = cursor.fetchone()[0] or 0
    
    cursor.execute("SELECT COUNT(*) FROM win_back_recoveries WHERE gym_id = ?", (gym_id,))
    total_recoveries = cursor.fetchone()[0] or 0
    
    divider = (total_win_back + total_recoveries)
    recovery_rate = round((total_recoveries / divider) * 100, 1) if divider > 0 else 0.0
    
    conn.close()
    
    return jsonify({
        "total_win_back": total_win_back,
        "inactive_15_30": inactive_15_30,
        "inactive_30_60": inactive_30_60,
        "inactive_60_plus": inactive_60_plus,
        "recovered_this_month": recovered_this_month,
        "recovery_rate": recovery_rate
    })

@app.route("/api/admin/win-back/interaction", methods=["POST"])
@login_required("owner")
def log_win_back_interaction():
    data = request.get_json() or {}
    member_id = data.get("member_id")
    interaction_type = data.get("interaction_type")
    notes = data.get("notes", "")
    follow_up_date = data.get("follow_up_date")
    
    if not member_id or not interaction_type:
        return jsonify({"error": "Missing required fields"}), 400
        
    gym_id = session["gym_id"]
    conn = database.get_db_connection()
    cursor = conn.cursor()
    
    now_time = now_ist().strftime("%Y-%m-%d %H:%M:%S")
    cursor.execute("""
        INSERT INTO win_back_interactions (member_id, gym_id, interaction_type, notes, follow_up_date, contacted_at)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (member_id, gym_id, interaction_type, notes, follow_up_date, now_time))
    
    log_action(cursor, "win_back_interaction", "member", member_id, {
        "interaction_type": interaction_type, "follow_up_date": follow_up_date
    })
    
    conn.commit()
    conn.close()
    
    return jsonify({"success": True})

@app.route("/api/admin/win-back/bulk-action", methods=["POST"])
@login_required("owner")
def log_win_back_bulk_action():
    data = request.get_json() or {}
    member_ids = data.get("member_ids")
    interaction_type = data.get("interaction_type", "contacted")
    notes = data.get("notes", "Bulk follow-up")
    
    if not member_ids or not isinstance(member_ids, list):
        return jsonify({"error": "Missing or invalid member_ids"}), 400
        
    gym_id = session["gym_id"]
    conn = database.get_db_connection()
    cursor = conn.cursor()
    
    now_time = now_ist().strftime("%Y-%m-%d %H:%M:%S")
    for mid in member_ids:
        cursor.execute("""
            INSERT INTO win_back_interactions (member_id, gym_id, interaction_type, notes, contacted_at)
            VALUES (?, ?, ?, ?, ?)
        """, (mid, gym_id, interaction_type, notes, now_time))
        log_action(cursor, "win_back_bulk_interaction", "member", mid, {
            "interaction_type": interaction_type
        })
        
    conn.commit()
    conn.close()
    
    return jsonify({"success": True})

@app.route("/api/admin/dashboard/pending-dues", methods=["GET"])
@login_required("owner")
def admin_dashboard_pending_dues():
    conn = database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT p.id, m.first_name, m.last_name, p.due_date, p.amount, pl.name as plan_name, p.status
        FROM payments p
        JOIN members m ON p.member_id = m.id
        LEFT JOIN memberships ms ON p.membership_id = ms.id
        LEFT JOIN plans pl ON ms.plan_id = pl.id
        WHERE p.gym_id = ? AND p.status IN ('pending', 'overdue')
        ORDER BY p.due_date ASC
    """, (session["gym_id"],))
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return jsonify({"data": rows})

@app.route("/api/admin/dashboard/expiring-soon", methods=["GET"])
@login_required("owner")
def admin_dashboard_expiring_soon():
    conn = database.get_db_connection()
    cursor = conn.cursor()
    today = now_ist().strftime("%Y-%m-%d")
    next_week = (now_ist() + timedelta(days=7)).strftime("%Y-%m-%d")
    cursor.execute("""
        SELECT m.id as member_id, m.first_name, m.last_name, ms.end_date, pl.name as plan_name,
               (SELECT p.amount FROM payments p WHERE p.member_id = m.id AND p.status IN ('pending', 'overdue') ORDER BY p.due_date ASC LIMIT 1) as amount_due
        FROM memberships ms
        JOIN members m ON ms.member_id = m.id
        LEFT JOIN plans pl ON ms.plan_id = pl.id
        WHERE ms.gym_id = ? AND ms.status = 'active' AND ms.end_date >= ? AND ms.end_date <= ?
        ORDER BY ms.end_date ASC
    """, (session["gym_id"], today, next_week))
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return jsonify({"data": rows})

# ================= PENDING APPROVALS WORKFLOW ENDPOINTS =================

@app.route("/api/admin/pending-approvals", methods=["GET"])
@login_required("owner")
def admin_get_pending_approvals():
    conn = database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT m.id, m.first_name, m.last_name, u.email, m.phone, m.joined_at, m.status, m.profile_photo
        FROM members m
        JOIN users u ON m.user_id = u.id
        WHERE m.gym_id = ? AND m.status = 'pending'
        ORDER BY m.joined_at DESC
    """, (session["gym_id"],))
    rows = cursor.fetchall()
    pending = [dict(r) for r in rows]
    conn.close()
    return jsonify(pending)

@app.route("/api/admin/pending-approvals/<int:id>/approve", methods=["POST"])
@login_required("owner")
def admin_approve_member(id):
    conn = database.get_db_connection()
    cursor = conn.cursor()

    # Check if member exists and is pending
    cursor.execute("SELECT m.id, m.first_name, m.last_name, u.email FROM members m JOIN users u ON m.user_id = u.id WHERE m.id = ? AND m.gym_id = ?", (id, session["gym_id"]))
    member = cursor.fetchone()
    if not member:
        conn.close()
        return jsonify({"error": "Member not found"}), 404
        
    try:
        cursor.execute("UPDATE members SET status = 'active' WHERE id = ? AND gym_id = ?", (id, session["gym_id"]))
        fullname = f"{member['first_name']} {member['last_name']}"
        log_action(cursor, "member_approved", "member", id, {"name": fullname, "email": member["email"]})
        conn.commit()

        broadcast_event("MEMBER_STATUS_CHANGED", {
            "member_id": id,
            "status": "active",
            "name": fullname,
            "email": member["email"]
        }, session["gym_id"])
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()

@app.route("/api/admin/pending-approvals/<int:id>/reject", methods=["POST"])
@login_required("owner")
def admin_reject_member(id):
    conn = database.get_db_connection()
    cursor = conn.cursor()
    
    # Check if member exists
    cursor.execute("SELECT m.id, m.first_name, m.last_name, u.email FROM members m JOIN users u ON m.user_id = u.id WHERE m.id = ? AND m.gym_id = ?", (id, session["gym_id"]))
    member = cursor.fetchone()
    if not member:
        conn.close()
        return jsonify({"error": "Member not found"}), 404

    try:
        cursor.execute("UPDATE members SET status = 'rejected' WHERE id = ? AND gym_id = ?", (id, session["gym_id"]))
        fullname = f"{member['first_name']} {member['last_name']}"
        log_action(cursor, "member_rejected", "member", id, {"name": fullname, "email": member["email"]})
        conn.commit()

        broadcast_event("MEMBER_STATUS_CHANGED", {
            "member_id": id,
            "status": "rejected",
            "name": fullname,
            "email": member["email"]
        }, session["gym_id"])
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()

# ================= MEMBER MANAGEMENT ENDPOINTS =================

@app.route("/api/admin/members", methods=["GET"])
@login_required("owner")
def admin_get_members():
    search = request.args.get("search", "").strip()
    status_filter = request.args.get("status", "").strip()
    page = request.args.get("page", 1, type=int)
    limit_param = request.args.get("limit", "25").strip()
    sort_by = request.args.get("sort_by", "joined_at").strip()
    sort_order = request.args.get("sort_order", "desc").strip()
    
    sort_mapping = {
        "id": "m.id",
        "first_name": "m.first_name",
        "phone": "m.phone",
        "joined_at": "m.joined_at",
        "status": "m.status",
        "plan_name": "plan_name",
        "end_date": "mb.end_date"
    }
    
    order_col = sort_mapping.get(sort_by, "m.joined_at")
    order_dir = "ASC" if sort_order.lower() == "asc" else "DESC"
    
    conn = database.get_db_connection()
    cursor = conn.cursor()
    
    count_query = """
        SELECT COUNT(DISTINCT m.id)
        FROM members m
        JOIN users u ON m.user_id = u.id
        WHERE m.gym_id = ?
    """

    query = """
        SELECT m.*, u.email,
               mb.id as membership_id, mb.end_date, mb.status as membership_status,
               p.name as plan_name,
               (SELECT MAX(check_in_time) FROM attendance WHERE member_id = m.id AND status = 'success') as last_checkin,
               (SELECT COUNT(*) FROM payments WHERE member_id = m.id AND status IN ('pending', 'overdue')) as pending_payment_count
        FROM members m
        JOIN users u ON m.user_id = u.id
        LEFT JOIN memberships mb ON mb.id = (
            SELECT id FROM memberships
            WHERE member_id = m.id
            ORDER BY CASE WHEN status = 'active' THEN 1 ELSE 2 END, end_date DESC, id DESC
            LIMIT 1
        )
        LEFT JOIN plans p ON mb.plan_id = p.id
        WHERE m.gym_id = ?
    """
    params = [session["gym_id"]]
    filter_sql = ""
    
    if search:
        filter_sql += " AND (m.first_name ILIKE ? OR m.last_name ILIKE ? OR m.phone ILIKE ? OR u.email ILIKE ?)"
        match = f"%{search}%"
        params.extend([match, match, match, match])
        
    if status_filter:
        filter_sql += " AND m.status = ?"
        params.append(status_filter)
    else:
        filter_sql += " AND m.status NOT IN ('pending', 'rejected')"
        
    count_query += filter_sql
    query += filter_sql
    
    cursor.execute(count_query, params)
    total = cursor.fetchone()[0]
    
    query += f" ORDER BY {order_col} {order_dir}"
    
    if limit_param.lower() != "all":
        try:
            limit = int(limit_param)
            offset = (page - 1) * limit
            query += " LIMIT ? OFFSET ?"
            params.extend([limit, offset])
        except ValueError:
            limit = 25
            offset = (page - 1) * limit
            query += " LIMIT ? OFFSET ?"
            params.extend([limit, offset])
    else:
        limit = total
        page = 1
        
    cursor.execute(query, params)
    rows = cursor.fetchall()
    
    members_list = []
    today = now_ist().strftime("%Y-%m-%d")

    # Collect rows whose membership lapsed since it was last read, and flip
    # their status in two batched UPDATEs after the loop instead of firing
    # up to 2 UPDATE statements per stale row inline (an N+1 pattern that
    # scaled with page size on every single member-list request).
    expired_member_ids = []
    expired_membership_ids = []

    for row in rows:
        m_dict = dict(row)
        end_date = m_dict.get("end_date")
        m_status = m_dict.get("status")

        if m_status == "active" and end_date and end_date < today:
            expired_member_ids.append(m_dict["id"])
            if m_dict.get("membership_id"):
                expired_membership_ids.append(m_dict["membership_id"])
            m_dict["status"] = "expired"
            m_dict["membership_status"] = "expired"

        members_list.append(m_dict)

    if expired_member_ids:
        cursor.execute("UPDATE members SET status = 'expired' WHERE id = ANY(?) AND gym_id = ?",
                        (expired_member_ids, session["gym_id"]))
    if expired_membership_ids:
        cursor.execute("UPDATE memberships SET status = 'expired' WHERE id = ANY(?) AND gym_id = ?",
                        (expired_membership_ids, session["gym_id"]))

    conn.commit()
    conn.close()
    
    return jsonify({
        "data": members_list,
        "total": total,
        "page": page,
        "limit": limit
    })

@app.route("/api/admin/members", methods=["POST"])
@login_required("owner")
def admin_create_member():
    data = request.get_json() or {}
    email = data.get("email")
    first_name = data.get("first_name")
    last_name = data.get("last_name") or ""
    phone = data.get("phone")
    emergency_name = data.get("emergency_contact_name")
    emergency_number = data.get("emergency_contact_number")
    legacy_emergency = data.get("emergency_contact")
    
    if (emergency_name is None and emergency_number is None) and legacy_emergency is not None:
        if "/" in legacy_emergency:
            parts = legacy_emergency.split("/", 1)
            emergency_name = parts[0].strip()
            emergency_number = parts[1].strip()
        else:
            emergency_name = ""
            emergency_number = legacy_emergency.strip()
            
    if legacy_emergency is None:
        if emergency_name and emergency_number:
            legacy_emergency = f"{emergency_name} / {emergency_number}"
        elif emergency_number:
            legacy_emergency = emergency_number
        else:
            legacy_emergency = ""

    password = data.get("password")
    plan_id = data.get("plan_id")
    
    if not all([email, first_name, phone, password, plan_id, emergency_name, emergency_number]):
        return jsonify({"error": "Missing required fields (including password, membership plan, and emergency contact)"}), 400
        
    conn = database.get_db_connection()
    cursor = conn.cursor()
    
    try:
        gym_id = session["gym_id"]
        
        # Verify Plan exists and get details
        cursor.execute("SELECT name, price, duration_months FROM plans WHERE id = ? AND gym_id = ?", (plan_id, gym_id))
        plan = cursor.fetchone()
        if not plan:
            conn.close()
            return jsonify({"error": "Selected membership plan not found"}), 404
            
        pw_hash = database.hash_password(password)
        cursor.execute("INSERT INTO users (email, password_hash, role, gym_id) VALUES (?, ?, 'member', ?)", (email, pw_hash, gym_id))
        u_id = cursor.lastrowid

        cursor.execute(
            "INSERT INTO members (user_id, first_name, last_name, phone, emergency_contact, emergency_contact_name, emergency_contact_number, status, gym_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)",
            (u_id, first_name, last_name, phone, legacy_emergency, emergency_name, emergency_number, gym_id)
        )
        member_id = cursor.lastrowid

        # Insert primary contact into emergency_contacts table for complete relational integrity
        if emergency_name or emergency_number:
            cursor.execute("""
                INSERT INTO emergency_contacts (member_id, gym_id, name, phone, relationship, contact_type)
                VALUES (?, ?, ?, ?, 'Primary Contact', 'primary')
            """, (member_id, gym_id, emergency_name or "", emergency_number or ""))

        # Calculate membership start/end dates
        start_date_str = data.get("start_date") or now_ist().strftime("%Y-%m-%d")
        custom_end_date_str = data.get("end_date")
        record_payment = data.get("record_payment", True)
        
        start_date = datetime.strptime(start_date_str, "%Y-%m-%d")
        if custom_end_date_str:
            custom_end_date = datetime.strptime(custom_end_date_str, "%Y-%m-%d")
            if custom_end_date <= start_date:
                conn.close()
                return jsonify({"error": "End date must be after the start date"}), 400
            end_date_str = custom_end_date_str
        else:
            end_date = start_date + timedelta(days=plan["duration_months"] * 30)
            end_date_str = end_date.strftime("%Y-%m-%d")
            
        # Create Fresh Membership
        cursor.execute("""
            INSERT INTO memberships (member_id, plan_id, status, start_date, end_date, price_paid, gym_id)
            VALUES (?, ?, 'active', ?, ?, ?, ?)
        """, (member_id, plan_id, start_date_str, end_date_str, plan["price"], gym_id))
        membership_id = cursor.lastrowid
        
        # Record Payment
        pay_status = "paid" if record_payment else "pending"
        pay_date = now_ist().strftime("%Y-%m-%d %H:%M:%S") if record_payment else None
        due_date = start_date_str if not record_payment else None
        
        cursor.execute("""
            INSERT INTO payments (membership_id, member_id, amount, status, payment_date, due_date, receipt_number, gym_id)
            VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
        """, (membership_id, member_id, plan["price"], pay_status, pay_date, due_date, gym_id))
        payment_id = cursor.lastrowid
        
        receipt = generate_receipt_number(cursor, gym_id, payment_id=payment_id)
        cursor.execute("UPDATE payments SET receipt_number = ? WHERE id = ?", (receipt, payment_id))

        # Create notifications
        cursor.execute(
            "INSERT INTO notifications (user_id, type, message, gym_id) VALUES (?, 'welcome', ?, ?)",
            (u_id, f"Welcome to GymOS, {first_name}! An account has been created for you by the Owner. Password: {password}", gym_id)
        )
        notif_msg = f"Your new membership '{plan['name']}' has been activated! Expires on: {end_date_str}."
        cursor.execute("INSERT INTO notifications (user_id, type, message, gym_id) VALUES (?, 'renewal', ?, ?)", (u_id, notif_msg, gym_id))
        
        log_action(cursor, "member_created_by_owner", "member", member_id, {"name": f"{first_name} {last_name}", "email": email})
        log_action(cursor, "plan_assigned", "member", member_id, {
            "plan_name": plan["name"], "plan_id": plan_id, "membership_id": membership_id,
            "payment_id": payment_id, "price": plan["price"], "record_payment": record_payment,
            "start_date": start_date_str, "end_date": end_date_str, "custom_end_date": bool(custom_end_date_str)
        })
        
        conn.commit()

        broadcast_event("MEMBER_CREATED", {
            "id": member_id,
            "name": f"{first_name} {last_name}",
            "email": email
        }, gym_id)

        return jsonify({"success": True, "member_id": member_id})
    except sqlite3.IntegrityError:
        return jsonify({"error": "Email already exists"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()

@app.route("/api/admin/members/<int:id>", methods=["GET"])
@login_required("owner")
def admin_member_detail(id):
    conn = database.get_db_connection()
    cursor = conn.cursor()
    
    # Member basic info
    cursor.execute("""
        SELECT m.*, u.email
        FROM members m
        JOIN users u ON m.user_id = u.id
        WHERE m.id = ? AND m.gym_id = ?
    """, (id, session["gym_id"]))
    member = cursor.fetchone()
    
    if not member:
        conn.close()
        return jsonify({"error": "Member not found"}), 404
        
    # Active/Latest membership
    cursor.execute("""
        SELECT ms.*, p.name as plan_name, p.duration_months, p.benefits
        FROM memberships ms
        JOIN plans p ON ms.plan_id = p.id
        WHERE ms.member_id = ?
        ORDER BY ms.end_date DESC LIMIT 1
    """, (id,))
    membership = cursor.fetchone()
    
    # Checked checkins
    cursor.execute("""
        SELECT * FROM attendance 
        WHERE member_id = ? 
        ORDER BY check_in_time DESC LIMIT 10
    """, (id,))
    checkins = [dict(row) for row in cursor.fetchall()]
    
    # Payments history
    cursor.execute("""
        SELECT * FROM payments 
        WHERE member_id = ? 
        ORDER BY created_at DESC
    """, (id,))
    payments = [dict(row) for row in cursor.fetchall()]
    
    conn.close()
    
    return jsonify({
        "member": dict(member),
        "membership": dict(membership) if membership else None,
        "checkins": checkins,
        "payments": payments
    })

@app.route("/api/admin/members/<int:id>", methods=["PUT"])
@login_required("owner")
def admin_update_member(id):
    data = request.get_json() or {}
    first_name = data.get("first_name")
    last_name = data.get("last_name") or ""
    phone = data.get("phone")
    emergency_name = data.get("emergency_contact_name")
    emergency_number = data.get("emergency_contact_number")
    emergency_relation = data.get("emergency_contact_relation")
    legacy_emergency = data.get("emergency_contact")
    
    if (emergency_name is None and emergency_number is None) and legacy_emergency is not None:
        if "/" in legacy_emergency:
            parts = legacy_emergency.split("/", 1)
            emergency_name = parts[0].strip()
            emergency_number = parts[1].strip()
        else:
            emergency_name = ""
            emergency_number = legacy_emergency.strip()
            
    if legacy_emergency is None:
        if emergency_name and emergency_number:
            legacy_emergency = f"{emergency_name} / {emergency_number}"
        elif emergency_number:
            legacy_emergency = emergency_number
        else:
            legacy_emergency = ""

    status = data.get("status")
    email = data.get("email")
    password = data.get("password")
    fee_pending = data.get("fee_pending")  # true/false/None (None = leave unchanged)
    dob, dob_error = parse_and_validate_dob(data.get("dob"))
    gender = data.get("gender")
    height = data.get("height")
    weight = data.get("weight")
    profile_photo = data.get("profile_photo")

    if not all([first_name, phone, status]):
        return jsonify({"error": "Missing required edit fields"}), 400
    if dob_error:
        return jsonify({"error": dob_error}), 400

    conn = database.get_db_connection()
    cursor = conn.cursor()

    try:
        # Check current member status & verify gym ownership
        cursor.execute("SELECT status, user_id FROM members WHERE id = ? AND gym_id = ?", (id, session["gym_id"]))
        old_m = cursor.fetchone()
        if not old_m:
            conn.close()
            return jsonify({"error": "Member not found"}), 404

        cursor.execute("""
            UPDATE members
            SET first_name = ?, last_name = ?, phone = ?, emergency_contact = ?, emergency_contact_name = ?, emergency_contact_number = ?, status = ?,
                dob = COALESCE(?, dob), gender = COALESCE(?, gender), height = COALESCE(?, height), weight = COALESCE(?, weight),
                emergency_contact_relation = COALESCE(?, emergency_contact_relation), profile_photo = COALESCE(?, profile_photo)
            WHERE id = ? AND gym_id = ?
        """, (first_name, last_name, phone, legacy_emergency, emergency_name, emergency_number, status,
               dob, gender, height, weight, emergency_relation, profile_photo, id, session["gym_id"]))

        # Upsert emergency_contacts primary record
        cursor.execute("SELECT id FROM emergency_contacts WHERE member_id = ? AND contact_type = 'primary' LIMIT 1", (id,))
        exist_ec = cursor.fetchone()
        if exist_ec:
            cursor.execute("""
                UPDATE emergency_contacts
                SET name = ?, phone = ?, relationship = COALESCE(?, relationship), updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
                WHERE id = ?
            """, (emergency_name or "", emergency_number or "", emergency_relation or "Primary Contact", exist_ec["id"]))
        elif emergency_name or emergency_number:
            cursor.execute("""
                INSERT INTO emergency_contacts (member_id, gym_id, name, phone, relationship, contact_type)
                VALUES (?, ?, ?, ?, ?, 'primary')
            """, (id, session["gym_id"], emergency_name or "", emergency_number or "", emergency_relation or "Primary Contact"))

        if email:
            cursor.execute("UPDATE users SET email = ? WHERE id = ?", (email, old_m["user_id"]))
        if password:
            pw_hash = database.hash_password(password)
            cursor.execute("UPDATE users SET password_hash = ? WHERE id = ?", (pw_hash, old_m["user_id"]))

        if fee_pending is not None:
            cursor.execute("SELECT id FROM payments WHERE member_id = ? ORDER BY created_at DESC LIMIT 1", (id,))
            latest_pay = cursor.fetchone()
            if latest_pay:
                if fee_pending:
                    cursor.execute("UPDATE payments SET status = 'pending' WHERE id = ?", (latest_pay["id"],))
                else:
                    cursor.execute(
                        "UPDATE payments SET status = 'paid', payment_date = ? WHERE id = ?",
                        (now_ist().strftime("%Y-%m-%d %H:%M:%S"), latest_pay["id"])
                    )

        # If status changed to suspended, also toggle memberships to suspended
        if status == "suspended":
            cursor.execute("UPDATE memberships SET status = 'suspended' WHERE member_id = ?", (id,))
            cursor.execute("UPDATE payments SET status = 'overdue' WHERE member_id = ? AND status = 'pending'", (id,))
            cursor.execute("INSERT INTO notifications (user_id, type, message, gym_id) VALUES (?, 'expiry', 'Your membership has been suspended by the Gym Owner.', ?)", (old_m["user_id"], session["gym_id"]))
        elif status == "active":
            # If status unsuspended, reactivate active end-dated memberships
            today = now_ist().strftime("%Y-%m-%d")
            cursor.execute("UPDATE memberships SET status = 'active' WHERE member_id = ? AND end_date >= ?", (id, today))

        log_action(cursor, "member_updated", "member", id, {
            "name": f"{first_name} {last_name}", "status": status,
            "prev_status": old_m["status"], "fee_pending": fee_pending
        })
        conn.commit()

        broadcast_event("MEMBER_UPDATED", {"id": id, "name": f"{first_name} {last_name}", "status": status, "profile_photo": profile_photo}, session["gym_id"])

        return jsonify({"success": True})
    except sqlite3.IntegrityError as e:
        conn.rollback()
        if "email" in str(e).lower():
            return jsonify({"error": "Email address already in use"}), 400
        return jsonify({"error": f"Update failed: {e}"}), 400
    except Exception as e:
        conn.rollback()
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()

@app.route("/api/admin/members/<int:id>", methods=["DELETE"])
@login_required("owner")
def admin_delete_member(id):
    conn = database.get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT user_id, first_name, last_name FROM members WHERE id = ? AND gym_id = ?", (id, session["gym_id"]))
    member = cursor.fetchone()
    if not member:
        conn.close()
        return jsonify({"error": "Member not found"}), 404

    user_id = member["user_id"]
    name = f"{member['first_name']} {member['last_name']}"

    cursor.execute("DELETE FROM emergency_contacts WHERE member_id = ?", (id,))
    cursor.execute("DELETE FROM body_stats WHERE member_id = ?", (id,))
    cursor.execute("DELETE FROM attendance WHERE member_id = ?", (id,))
    cursor.execute("DELETE FROM payments WHERE member_id = ?", (id,))
    cursor.execute("DELETE FROM memberships WHERE member_id = ?", (id,))
    cursor.execute("DELETE FROM members WHERE id = ?", (id,))
    cursor.execute("DELETE FROM users WHERE id = ?", (user_id,))
    log_action(cursor, "member_deleted", "member", id, {
        "name": name, "note": "purged member and all related child records"
    })
    conn.commit()
    conn.close()

    broadcast_event("MEMBER_DELETED", {"id": id, "name": name}, session["gym_id"])
    return jsonify({"success": True})

@app.route("/api/admin/members/<int:id>/assign-plan", methods=["POST"])
@login_required("owner")
def admin_assign_plan(id):
    data = request.get_json() or {}
    plan_id = data.get("plan_id")
    start_date_str = data.get("start_date") or now_ist().strftime("%Y-%m-%d")
    custom_end_date_str = data.get("end_date")  # optional override for a custom/prorated period
    record_payment = data.get("record_payment", True)

    if not plan_id:
        return jsonify({"error": "Membership plan ID is required"}), 400

    conn = database.get_db_connection()
    cursor = conn.cursor()

    gym_id = session["gym_id"]

    # 1. Verify Member exists
    cursor.execute("SELECT user_id, first_name, last_name, status FROM members WHERE id = ? AND gym_id = ?", (id, gym_id))
    member = cursor.fetchone()
    if not member:
        conn.close()
        return jsonify({"error": "Member not found"}), 404

    # 2. Get Plan duration and price
    cursor.execute("SELECT name, price, duration_months FROM plans WHERE id = ? AND gym_id = ?", (plan_id, gym_id))
    plan = cursor.fetchone()
    if not plan:
        conn.close()
        return jsonify({"error": "Selected plan not found"}), 404

    # Calculate end date
    try:
        start_date = datetime.strptime(start_date_str, "%Y-%m-%d")
    except ValueError:
        conn.close()
        return jsonify({"error": "Invalid start_date format, must be YYYY-MM-DD"}), 400

    if custom_end_date_str:
        try:
            custom_end_date = datetime.strptime(custom_end_date_str, "%Y-%m-%d")
        except ValueError:
            conn.close()
            return jsonify({"error": "Invalid end_date format, must be YYYY-MM-DD"}), 400
        if custom_end_date <= start_date:
            conn.close()
            return jsonify({"error": "End date must be after the start date"}), 400
        end_date_str = custom_end_date_str
    else:
        end_date = start_date + timedelta(days=plan["duration_months"] * 30)
        end_date_str = end_date.strftime("%Y-%m-%d")
    
    try:
        # Mark historical active memberships as expired/suspended to avoid double plans
        cursor.execute("UPDATE memberships SET status = 'expired' WHERE member_id = ? AND status = 'active'", (id,))
        
        # Create fresh membership
        cursor.execute("""
            INSERT INTO memberships (member_id, plan_id, status, start_date, end_date, price_paid, gym_id)
            VALUES (?, ?, 'active', ?, ?, ?, ?)
        """, (id, plan_id, start_date_str, end_date_str, plan["price"], gym_id))
        membership_id = cursor.lastrowid
        
        # Bring Member state back to active
        cursor.execute("UPDATE members SET status = 'active' WHERE id = ?", (id,))
        
        # Record payment
        pay_status = "paid" if record_payment else "pending"
        pay_date = now_ist().strftime("%Y-%m-%d %H:%M:%S") if record_payment else None
        due_date = start_date_str if not record_payment else None
        
        cursor.execute("""
            INSERT INTO payments (membership_id, member_id, amount, status, payment_date, due_date, receipt_number, gym_id)
            VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
        """, (membership_id, id, plan["price"], pay_status, pay_date, due_date, gym_id))
        payment_id = cursor.lastrowid
        
        receipt = generate_receipt_number(cursor, gym_id, payment_id=payment_id)
        cursor.execute("UPDATE payments SET receipt_number = ? WHERE id = ?", (receipt, payment_id))

        # Notifications
        notif_msg = f"Your new membership '{plan['name']}' has been activated! Expires on: {end_date_str}."
        cursor.execute("INSERT INTO notifications (user_id, type, message, gym_id) VALUES (?, 'renewal', ?, ?)", (member["user_id"], notif_msg, gym_id))

        log_action(cursor, "plan_assigned", "member", id, {
            "plan_name": plan["name"], "plan_id": plan_id, "membership_id": membership_id,
            "payment_id": payment_id, "price": plan["price"], "record_payment": record_payment,
            "start_date": start_date_str, "end_date": end_date_str, "custom_end_date": bool(custom_end_date_str)
        })
        conn.commit()

        broadcast_event("MEMBERSHIP_ASSIGNED", {
            "member_id": id,
            "member_name": f"{member['first_name']} {member['last_name']}",
            "plan_name": plan["name"],
            "expiry": end_date_str
        }, gym_id)
        
        return jsonify({"success": True, "membership_id": membership_id, "expiry": end_date_str})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()

# ================= MEMBERSHIP PLANS ENDPOINTS =================

@app.route("/api/admin/plans", methods=["GET"])
@login_required("owner")
def admin_get_plans():
    conn = database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM plans WHERE gym_id = ? ORDER BY price ASC", (session["gym_id"],))
    p_list = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return jsonify(p_list)

@app.route("/api/admin/plans", methods=["POST"])
@login_required("owner")
def admin_create_plan():
    data = request.get_json() or {}
    name = data.get("name")
    price = data.get("price")
    duration = data.get("duration_months")
    benefits = data.get("benefits", "")
    
    if not all([name, price is not None, duration]):
        return jsonify({"error": "Missing required plan fields"}), 400
        
    conn = database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO plans (name, price, duration_months, benefits, gym_id) VALUES (?, ?, ?, ?, ?)",
        (name, float(price), int(duration), benefits, session["gym_id"])
    )
    plan_id = cursor.lastrowid
    log_action(cursor, "plan_created", "plan", plan_id, {"name": name, "price": price, "duration_months": duration})
    conn.commit()
    conn.close()

    return jsonify({"success": True, "plan_id": plan_id})

@app.route("/api/admin/plans/<int:id>", methods=["PUT"])
@login_required("owner")
def admin_update_plan(id):
    data = request.get_json() or {}
    name = data.get("name")
    price = data.get("price")
    duration = data.get("duration_months")
    benefits = data.get("benefits", "")
    
    if not all([name, price is not None, duration]):
        return jsonify({"error": "Missing plan edit data"}), 400
        
    conn = database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        "UPDATE plans SET name = ?, price = ?, duration_months = ?, benefits = ? WHERE id = ? AND gym_id = ?",
        (name, float(price), int(duration), benefits, id, session["gym_id"])
    )
    log_action(cursor, "plan_updated", "plan", id, {"name": name, "price": price, "duration_months": duration})
    conn.commit()
    conn.close()
    return jsonify({"success": True})

@app.route("/api/admin/plans/<int:id>", methods=["DELETE"])
@login_required("owner")
def admin_delete_plan(id):
    conn = database.get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("DELETE FROM plans WHERE id = ? AND gym_id = ?", (id, session["gym_id"]))
        log_action(cursor, "plan_deleted", "plan", id, {})
        conn.commit()
        return jsonify({"success": True})
    except sqlite3.IntegrityError:
        return jsonify({"error": "Cannot delete plan. It has active memberships assigned."}), 400
    finally:
        conn.close()

# ================= ATTENDANCE ENDPOINTS =================

@app.route("/api/admin/attendance", methods=["GET"])
@login_required("owner")
def admin_get_attendance():
    date_filter = request.args.get("date", "").strip()
    month_filter = request.args.get("month", "").strip()  # "YYYY-MM"
    start_date_filter = request.args.get("start_date", "").strip()  # "YYYY-MM-DD"
    end_date_filter = request.args.get("end_date", "").strip()  # "YYYY-MM-DD"
    member_id_filter = request.args.get("member_id", "").strip()
    search = request.args.get("search", "").strip()
    page = request.args.get("page", 1, type=int)
    limit_param = request.args.get("limit", "25").strip()
    sort_by = request.args.get("sort_by", "check_in_time").strip()
    sort_order = request.args.get("sort_order", "desc").strip()
    
    sort_mapping = {
        "id": "a.id",
        "check_in_time": "a.check_in_time",
        "check_out_time": "a.check_out_time",
        "status": "a.status",
        "first_name": "m.first_name",
        "phone": "m.phone"
    }
    
    order_col = sort_mapping.get(sort_by, "a.check_in_time")
    order_dir = "ASC" if sort_order.lower() == "asc" else "DESC"
    
    conn = database.get_db_connection()
    cursor = conn.cursor()
    
    count_query = """
        SELECT COUNT(*)
        FROM attendance a
        JOIN members m ON a.member_id = m.id
        WHERE a.gym_id = ?
    """

    query = """
        SELECT a.id, a.check_in_time, a.check_out_time, a.status, a.attendance_state, a.attendance_date, a.error_msg,
               m.first_name, m.last_name, m.phone, m.id as member_id
        FROM attendance a
        JOIN members m ON a.member_id = m.id
        WHERE a.gym_id = ?
    """

    params = [session["gym_id"]]
    filter_sql = ""
    
    if date_filter:
        filter_sql += " AND a.check_in_time::date = ?"
        params.append(date_filter)

    if month_filter:
        filter_sql += " AND TO_CHAR(a.check_in_time::timestamp, 'YYYY-MM') = ?"
        params.append(month_filter)

    if start_date_filter:
        filter_sql += " AND a.check_in_time::date >= ?"
        params.append(start_date_filter)

    if end_date_filter:
        filter_sql += " AND a.check_in_time::date <= ?"
        params.append(end_date_filter)

    if member_id_filter:
        filter_sql += " AND a.member_id = ?"
        params.append(member_id_filter)

    if search:
        filter_sql += " AND (m.first_name ILIKE ? OR m.last_name ILIKE ? OR m.phone ILIKE ?)"
        match = f"%{search}%"
        params.extend([match, match, match])

    count_query += filter_sql
    query += filter_sql
    
    cursor.execute(count_query, params)
    total = cursor.fetchone()[0]
    
    query += f" ORDER BY {order_col} {order_dir}"
    
    if limit_param.lower() != "all":
        try:
            limit = int(limit_param)
            offset = (page - 1) * limit
            query += " LIMIT ? OFFSET ?"
            params.extend([limit, offset])
        except ValueError:
            limit = 25
            offset = (page - 1) * limit
            query += " LIMIT ? OFFSET ?"
            params.extend([limit, offset])
    else:
        limit = total
        page = 1
        
    cursor.execute(query, params)
    data = [dict(row) for row in cursor.fetchall()]
    conn.close()
    
    return jsonify({
        "data": data,
        "total": total,
        "page": page,
        "limit": limit
    })

@app.route("/api/admin/attendance/calendar-summary", methods=["GET"])
@login_required("owner")
def admin_attendance_calendar_summary():
    year = request.args.get("year", "").strip()
    month = request.args.get("month", "").strip()
    if not year or not month:
        return jsonify({"error": "year and month are required"}), 400

    year_month = f"{year}-{month.zfill(2)}"

    conn = database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT TO_CHAR(check_in_time::timestamp, 'DD') as day, COUNT(*) as cnt
        FROM attendance
        WHERE gym_id = ? AND status = 'success' AND TO_CHAR(check_in_time::timestamp, 'YYYY-MM') = ?
        GROUP BY day
    """, (session["gym_id"], year_month))
    counts = {row["day"]: row["cnt"] for row in cursor.fetchall()}
    conn.close()

    return jsonify({"counts": counts})

# ================= BILLING & PAYMENTS =================

@app.route("/api/admin/payments", methods=["GET"])
@login_required("owner")
def admin_get_payments():
    status_filter = request.args.get("status", "").strip()
    year_filter = request.args.get("year", "").strip()
    month_filter = request.args.get("month", "").strip()  # "01".."12"
    search = request.args.get("search", "").strip()
    page = request.args.get("page", 1, type=int)
    limit_param = request.args.get("limit", "25").strip()
    sort_by = request.args.get("sort_by", "created_at").strip()
    sort_order = request.args.get("sort_order", "desc").strip()
    
    sort_mapping = {
        "id": "p.id",
        "receipt_number": "p.receipt_number",
        "first_name": "m.first_name",
        "amount": "p.amount",
        "status": "p.status",
        "created_at": "p.created_at",
        "payment_date": "p.payment_date",
        "due_date": "p.due_date"
    }
    
    order_col = sort_mapping.get(sort_by, "p.created_at")
    order_dir = "ASC" if sort_order.lower() == "asc" else "DESC"
    
    conn = database.get_db_connection()
    cursor = conn.cursor()
    
    count_query = """
        SELECT COUNT(*)
        FROM payments p
        JOIN members m ON p.member_id = m.id
        LEFT JOIN memberships ms ON p.membership_id = ms.id
        LEFT JOIN plans pl ON ms.plan_id = pl.id
        WHERE p.gym_id = ?
    """

    query = """
        SELECT p.*, m.first_name, m.last_name, m.phone, pl.name as plan_name
        FROM payments p
        JOIN members m ON p.member_id = m.id
        LEFT JOIN memberships ms ON p.membership_id = ms.id
        LEFT JOIN plans pl ON ms.plan_id = pl.id
        WHERE p.gym_id = ?
    """

    status_map_db = {
        "Approved": "paid",
        "Pending": "pending",
        "Pending Approval": "pending_approval",
        "Rejected": "rejected",
        "Overdue": "overdue",
        "Draft": "draft",
        "Submitted": "submitted",
        "Cancelled": "cancelled"
    }
    db_status = status_map_db.get(status_filter, status_filter)

    params = [session["gym_id"]]
    filter_sql = ""
    
    if db_status:
        if db_status == "paid":
            filter_sql += " AND p.status IN ('paid', 'approved')"
        elif db_status == "pending_approval":
            filter_sql += " AND p.status IN ('pending_approval', 'submitted')"
        elif db_status == "pending":
            filter_sql += " AND p.status IN ('pending', 'draft')"
        else:
            filter_sql += " AND p.status = ?"
            params.append(db_status)

    if year_filter and month_filter:
        filter_sql += " AND TO_CHAR(p.payment_date::timestamp, 'YYYY-MM') = ?"
        params.append(f"{year_filter}-{month_filter.zfill(2)}")
    elif year_filter:
        filter_sql += " AND TO_CHAR(p.payment_date::timestamp, 'YYYY') = ?"
        params.append(year_filter)

    if search:
        filter_sql += " AND (m.first_name ILIKE ? OR m.last_name ILIKE ? OR m.phone ILIKE ? OR p.receipt_number ILIKE ?)"
        match = f"%{search}%"
        params.extend([match, match, match, match])
        
    count_query += filter_sql
    query += filter_sql
    
    cursor.execute(count_query, params)
    total = cursor.fetchone()[0]
    
    query += f" ORDER BY {order_col} {order_dir}"
    
    if limit_param.lower() != "all":
        try:
            limit = int(limit_param)
            offset = (page - 1) * limit
            query += " LIMIT ? OFFSET ?"
            params.extend([limit, offset])
        except ValueError:
            limit = 25
            offset = (page - 1) * limit
            query += " LIMIT ? OFFSET ?"
            params.extend([limit, offset])
    else:
        limit = total
        page = 1
        
    cursor.execute(query, params)
    data = [dict(row) for row in cursor.fetchall()]
    conn.close()

    status_map_ui = {
        "paid": "Approved",
        "approved": "Approved",
        "pending": "Pending",
        "draft": "Draft",
        "pending_approval": "Pending Approval",
        "submitted": "Pending Approval",
        "rejected": "Rejected",
        "cancelled": "Cancelled",
        "overdue": "Overdue"
    }
    for p in data:
        p["status"] = status_map_ui.get(p["status"], p["status"])
        if not p.get("due_date"):
            p["due_date"] = "—"
        if not p.get("payment_date"):
            p["payment_date"] = "—"
        if not p.get("payment_method"):
            p["payment_method"] = "—"
        if not p.get("rejection_reason"):
            p["rejection_reason"] = "—"
        if not p.get("transaction_reference"):
            p["transaction_reference"] = "—"
    
    return jsonify({
        "data": data,
        "total": total,
        "page": page,
        "limit": limit
    })

@app.route("/api/admin/payments/record", methods=["POST"])
@login_required("owner")
def admin_record_payment():
    data = request.get_json() or {}
    payment_id = data.get("payment_id")
    
    if not payment_id:
        return jsonify({"error": "Payment ID is required"}), 400
        
    conn = database.get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT * FROM payments WHERE id = ? AND gym_id = ?", (payment_id, session["gym_id"]))
    pay = cursor.fetchone()
    if not pay:
        conn.close()
        return jsonify({"error": "Payment ledger not found"}), 404

    pay_time = now_ist().strftime("%Y-%m-%d %H:%M:%S")
    
    try:
        # Mark payment as paid
        cursor.execute(
            "UPDATE payments SET status = 'paid', payment_date = ? WHERE id = ?",
            (pay_time, payment_id)
        )
        
        # If there's an associated membership, re-activate it
        membership_id = pay["membership_id"]
        if membership_id:
            cursor.execute("UPDATE memberships SET status = 'active' WHERE id = ?", (membership_id,))
            
        cursor.execute("UPDATE members SET status = 'active' WHERE id = ?", (pay["member_id"],))
        
        # Make a notification
        cursor.execute("SELECT user_id, first_name FROM members WHERE id = ?", (pay["member_id"],))
        m = cursor.fetchone()
        if m:
            cursor.execute(
                "INSERT INTO notifications (user_id, type, message, gym_id) VALUES (?, 'renewal', ?, ?)",
                (m["user_id"], f"Payment of ₹{pay['amount']} recorded successfully. Membership is set to ACTIVE.", session["gym_id"])
            )

        log_action(cursor, "payment_recorded_manual", "payment", payment_id, {
            "member_id": pay["member_id"], "amount": pay["amount"]
        })
        conn.commit()

        broadcast_event("PAYMENT_RECORDED", {
            "id": payment_id,
            "member_id": pay["member_id"],
            "amount": pay["amount"]
        }, session["gym_id"])

        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()

@app.route("/api/admin/payments/<int:id>/reminder", methods=["POST"])
@login_required("owner")
def admin_payment_reminder(id):
    conn = database.get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("""
        SELECT p.*, m.first_name, m.last_name, m.phone, pl.name as plan_name
        FROM payments p
        JOIN members m ON p.member_id = m.id
        LEFT JOIN memberships ms ON p.membership_id = ms.id
        LEFT JOIN plans pl ON ms.plan_id = pl.id
        WHERE p.id = ? AND p.gym_id = ?
    """, (id, session["gym_id"]))
    pay = cursor.fetchone()

    # Fetch dynamic gym name from settings or gyms
    gym_name = "Gym"
    if pay:
        cursor.execute("SELECT value FROM settings WHERE key = 'gym_name' AND gym_id = ?", (session["gym_id"],))
        sett = cursor.fetchone()
        if sett and sett["value"] and sett["value"].strip():
            gym_name = sett["value"].strip()
        else:
            cursor.execute("SELECT name FROM gyms WHERE id = ?", (session["gym_id"],))
            g_row = cursor.fetchone()
            if g_row and g_row["name"] and g_row["name"].strip():
                gym_name = g_row["name"].strip()
            else:
                app.logger.warning(f"Developer Warning: Gym business name not found for gym_id {session['gym_id']}. Using fallback 'Gym'.")

    conn.close()

    if not pay:
        return jsonify({"error": "Payment ledger not found"}), 404

    name = f"{pay['first_name']} {pay['last_name']}"
    phone = pay["phone"]
    amount = pay["amount"]
    due = pay["due_date"] or now_ist().strftime("%Y-%m-%d")
    plan = pay["plan_name"] or "Gym Membership"

    msg = f"Hello {name},\n\nYour membership payment of ₹{amount:.2f} for '{plan}' is due on {due}. Please renew or pay at counter.\n\nThank you!\n\n— {gym_name}"
    whatsapp_url = build_whatsapp_link(phone, msg)

    return jsonify({
        "phone": phone,
        "message": msg,
        "whatsapp_url": whatsapp_url
    })

@app.route("/api/admin/members/<int:id>/renewal-reminder", methods=["GET"])
@login_required("owner")
def admin_member_renewal_reminder(id):
    conn = database.get_db_connection()
    cursor = conn.cursor()

    cursor.execute("""
        SELECT m.first_name, m.last_name, m.phone, ms.end_date, pl.name as plan_name
        FROM members m
        JOIN memberships ms ON ms.member_id = m.id
        LEFT JOIN plans pl ON ms.plan_id = pl.id
        WHERE m.id = ? AND m.gym_id = ?
        ORDER BY ms.end_date DESC LIMIT 1
    """, (id, session["gym_id"]))
    row = cursor.fetchone()

    # Fetch dynamic gym name from settings or gyms
    gym_name = "Gym"
    if row:
        cursor.execute("SELECT value FROM settings WHERE key = 'gym_name' AND gym_id = ?", (session["gym_id"],))
        sett = cursor.fetchone()
        if sett and sett["value"] and sett["value"].strip():
            gym_name = sett["value"].strip()
        else:
            cursor.execute("SELECT name FROM gyms WHERE id = ?", (session["gym_id"],))
            g_row = cursor.fetchone()
            if g_row and g_row["name"] and g_row["name"].strip():
                gym_name = g_row["name"].strip()
            else:
                app.logger.warning(f"Developer Warning: Gym business name not found for gym_id {session['gym_id']}. Using fallback 'Gym'.")

    conn.close()

    if not row:
        return jsonify({"error": "No membership found for this member"}), 404

    name = f"{row['first_name']} {row['last_name']}"
    phone = row["phone"]
    end_date = row["end_date"]
    plan = row["plan_name"] or "Gym Membership"

    msg = f"Hello {name},\n\nYour '{plan}' membership is expiring on {end_date}. Please renew soon to continue uninterrupted access.\n\nThank you!\n\n— {gym_name}"
    whatsapp_url = build_whatsapp_link(phone, msg)

    return jsonify({
        "phone": phone,
        "message": msg,
        "whatsapp_url": whatsapp_url
    })

# ================= SETTINGS & QR ENDPOINTS =================

@app.route("/api/admin/settings/regenerate-qr-token", methods=["POST"])
@login_required("owner")
def admin_regenerate_qr_token():
    gym_id = session["gym_id"]
    new_token = f"gymos-token-{uuid.uuid4().hex[:10]}"
    conn = database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute("INSERT INTO settings (key, value, gym_id) VALUES ('qr_token', ?, ?) ON CONFLICT (gym_id, key) DO UPDATE SET value = EXCLUDED.value", (new_token, gym_id))
    cursor.execute("UPDATE gyms SET qr_code_token = ? WHERE id = ?", (new_token, gym_id))
    log_action(cursor, "qr_token_regenerated", "gym", gym_id, {"new_token": new_token})
    conn.commit()
    conn.close()

    broadcast_event("GYM_SETTINGS_UPDATED", {"qr_token": new_token}, gym_id)
    return jsonify({"success": True, "qr_token": new_token})

@app.route("/api/admin/settings", methods=["GET", "POST"])
@login_required("owner")
def admin_settings():
    conn = database.get_db_connection()
    cursor = conn.cursor()
    
    if request.method == "POST":
        data = request.get_json() or {}
        gym_name = data.get("gym_name")
        gym_phone = data.get("gym_phone")
        gym_address = data.get("gym_address")
        qr_token = data.get("qr_token")
        gym_logo = data.get("gym_logo") or data.get("gym_image_url") or ""
        gym_code = (data.get("gym_code") or "").strip().upper() or None
        gym_email = data.get("gym_email") or ""
        gst_number = data.get("gst_number") or ""
        receipt_footer = data.get("receipt_footer") or ""

        if not gym_name:
            conn.close()
            return jsonify({"error": "Gym name cannot be empty"}), 400

        gym_id = session["gym_id"]

        if gym_code:
            cursor.execute("SELECT id FROM gyms WHERE gym_code = ? AND id != ?", (gym_code, gym_id))
            if cursor.fetchone():
                conn.close()
                return jsonify({"error": "That Gym ID is already taken. Please choose another."}), 400

        cursor.execute("INSERT INTO settings (key, value, gym_id) VALUES ('gym_name', ?, ?) ON CONFLICT (gym_id, key) DO UPDATE SET value = EXCLUDED.value", (gym_name, gym_id))
        if gym_phone:
            cursor.execute("INSERT INTO settings (key, value, gym_id) VALUES ('gym_phone', ?, ?) ON CONFLICT (gym_id, key) DO UPDATE SET value = EXCLUDED.value", (gym_phone, gym_id))
        if gym_address:
            cursor.execute("INSERT INTO settings (key, value, gym_id) VALUES ('gym_address', ?, ?) ON CONFLICT (gym_id, key) DO UPDATE SET value = EXCLUDED.value", (gym_address, gym_id))
        if qr_token:
            cursor.execute("INSERT INTO settings (key, value, gym_id) VALUES ('qr_token', ?, ?) ON CONFLICT (gym_id, key) DO UPDATE SET value = EXCLUDED.value", (qr_token, gym_id))
        
        cursor.execute("INSERT INTO settings (key, value, gym_id) VALUES ('gym_email', ?, ?) ON CONFLICT (gym_id, key) DO UPDATE SET value = EXCLUDED.value", (gym_email, gym_id))
        cursor.execute("INSERT INTO settings (key, value, gym_id) VALUES ('gst_number', ?, ?) ON CONFLICT (gym_id, key) DO UPDATE SET value = EXCLUDED.value", (gst_number, gym_id))
        cursor.execute("INSERT INTO settings (key, value, gym_id) VALUES ('receipt_footer', ?, ?) ON CONFLICT (gym_id, key) DO UPDATE SET value = EXCLUDED.value", (receipt_footer, gym_id))
        cursor.execute("INSERT INTO settings (key, value, gym_id) VALUES ('gym_logo', ?, ?) ON CONFLICT (gym_id, key) DO UPDATE SET value = EXCLUDED.value", (gym_logo, gym_id))

        # Update gyms table
        try:
            cursor.execute("UPDATE gyms SET name = ?, phone = ?, address = ?, logo_url = ? WHERE id = ?", (gym_name, gym_phone, gym_address, gym_logo, gym_id))
        except Exception:
            cursor.execute("UPDATE gyms SET name = ?, phone = ?, address = ? WHERE id = ?", (gym_name, gym_phone, gym_address, gym_id))

        if qr_token:
            cursor.execute("UPDATE gyms SET qr_code_token = ? WHERE id = ?", (qr_token, gym_id))
        if gym_code:
            cursor.execute("UPDATE gyms SET gym_code = ? WHERE id = ?", (gym_code, gym_id))

        log_action(cursor, "settings_updated", "gym", gym_id, {
            "gym_name": gym_name, "gym_phone": gym_phone, "gym_address": gym_address,
            "gym_code": gym_code
        })
        conn.commit()
        conn.close()

        broadcast_event("GYM_SETTINGS_UPDATED", {"gym_name": gym_name, "gym_logo": gym_logo, "qr_token": qr_token}, gym_id)
        return jsonify({"success": True})

    # GET method
    cursor.execute("SELECT * FROM settings WHERE gym_id = ?", (session["gym_id"],))
    settings = {row["key"]: row["value"] for row in cursor.fetchall()}
    try:
        cursor.execute("SELECT gym_code, logo_url FROM gyms WHERE id = ?", (session["gym_id"],))
        gym_row = cursor.fetchone()
        if gym_row:
            settings["gym_code"] = gym_row["gym_code"]
            if gym_row["logo_url"]:
                settings["gym_logo"] = gym_row["logo_url"]
    except Exception:
        cursor.execute("SELECT gym_code FROM gyms WHERE id = ?", (session["gym_id"],))
        gym_row = cursor.fetchone()
        if gym_row:
            settings["gym_code"] = gym_row["gym_code"]

    conn.close()
    return jsonify(settings)

@app.route("/api/admin/owner-profile", methods=["POST"])
@login_required("owner")
def update_owner_profile():
    data = request.get_json() or {}
    first_name = data.get("first_name", "").strip()
    last_name = data.get("last_name", "").strip()
    profile_photo = data.get("profile_photo") # base64, "", or None (unchanged)

    if not first_name:
        return jsonify({"error": "First Name is required"}), 400

    conn = database.get_db_connection()
    cursor = conn.cursor()
    try:
        timestamp = now_ist().strftime("%Y-%m-%d %H:%M:%S")
        query_parts = ["first_name = ?", "last_name = ?"]
        params = [first_name, last_name]

        if profile_photo is not None:
            query_parts.append("profile_photo = ?")
            params.append(profile_photo)

        params.append(session["user_id"])
        sql = f"UPDATE users SET {', '.join(query_parts)} WHERE id = ?"
        cursor.execute(sql, tuple(params))
        conn.commit()

        cursor.execute("SELECT profile_photo FROM users WHERE id = ?", (session["user_id"],))
        updated_photo = cursor.fetchone()["profile_photo"] or ""

        return jsonify({
            "success": True,
            "profile": {
                "first_name": first_name,
                "last_name": last_name,
                "profile_photo": updated_photo
            },
            "updated_owner_name": f"{first_name} {last_name}".strip(),
            "updated_image_url": updated_photo,
            "updated_timestamp": timestamp
        })
    except Exception as e:
        conn.rollback()
        return jsonify({"error": f"Database update failed: {str(e)}"}), 500
    finally:
        conn.close()

@app.route("/api/owner/subscription-info", methods=["GET"])
@login_required("owner", allow_expired=True)
def owner_subscription_info():
    gym_id = session["gym_id"]
    conn = database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT subscription_status, subscription_end_date FROM gyms WHERE id = ?", (gym_id,))
    gym = cursor.fetchone()
    cursor.execute("SELECT id, name, price, duration_months FROM company_plans ORDER BY price ASC")
    plans = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return jsonify({
        "subscription_active": is_subscription_active(gym_id),
        "subscription_status": gym["subscription_status"] if gym else None,
        "subscription_end_date": gym["subscription_end_date"] if gym else None,
        "plans": plans
    })

@app.route("/api/admin/audit-log", methods=["GET"])
@login_required("owner")
def admin_audit_log():
    action_filter = request.args.get("action", "").strip()
    entity_type_filter = request.args.get("entity_type", "").strip()
    search = request.args.get("search", "").strip()
    page = request.args.get("page", 1, type=int)
    limit_param = request.args.get("limit", "50").strip()

    conn = database.get_db_connection()
    cursor = conn.cursor()

    count_query = "SELECT COUNT(*) FROM audit_log WHERE gym_id = ?"
    query = "SELECT * FROM audit_log WHERE gym_id = ?"
    params = [session["gym_id"]]
    filter_sql = ""

    if action_filter:
        filter_sql += " AND action = ?"
        params.append(action_filter)
    if entity_type_filter:
        filter_sql += " AND entity_type = ?"
        params.append(entity_type_filter)
    if search:
        filter_sql += " AND (actor_email ILIKE ? OR action ILIKE ? OR details ILIKE ?)"
        match = f"%{search}%"
        params.extend([match, match, match])

    count_query += filter_sql
    query += filter_sql

    cursor.execute(count_query, params)
    total = cursor.fetchone()[0]

    query += " ORDER BY created_at DESC, id DESC"
    try:
        limit = int(limit_param)
    except ValueError:
        limit = 50
    offset = (page - 1) * limit
    query += " LIMIT ? OFFSET ?"
    params.extend([limit, offset])

    cursor.execute(query, params)
    rows = []
    for row in cursor.fetchall():
        r = dict(row)
        if r.get("details"):
            try:
                r["details"] = json.loads(r["details"])
            except (TypeError, ValueError):
                pass
        rows.append(r)
    conn.close()

    return jsonify({"data": rows, "total": total, "page": page, "limit": limit})

# ================= LEADERBOARD, MANUAL CHECK-IN & PAYMENTS ENDPOINTS =================

@app.route("/api/leaderboard", methods=["GET"])
@login_required()
def get_leaderboard():
    conn = database.get_db_connection()
    cursor = conn.cursor()
    # Query top 10 members by check-in count in the last 30 days
    # (only successful checkins)
    cursor.execute("""
        SELECT m.id, m.first_name, m.last_name, m.profile_photo,
               COUNT(a.id) as checkin_count
        FROM members m
        JOIN attendance a ON m.id = a.member_id
        WHERE m.gym_id = ? AND a.status = 'success' AND a.check_in_time::date >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY m.id
        ORDER BY checkin_count DESC, m.first_name ASC
        LIMIT 10
    """, (session["gym_id"],))
    rows = cursor.fetchall()
    leaderboard = [dict(r) for r in rows]
    conn.close()
    return jsonify(leaderboard)

def check_and_record_win_back_recovery(cursor, member_id, gym_id):
    # Find the last successful check-in before this one (so offset 1)
    cursor.execute("""
        SELECT check_in_time FROM attendance
        WHERE member_id = ? AND gym_id = ? AND status = 'success'
        ORDER BY check_in_time DESC LIMIT 1 OFFSET 1
    """, (member_id, gym_id))
    last_row = cursor.fetchone()
    
    last_visit = None
    if last_row:
        last_visit = last_row["check_in_time"]
    else:
        # Fallback to joined_at
        cursor.execute("SELECT joined_at FROM members WHERE id = ? AND gym_id = ?", (member_id, gym_id))
        mem_row = cursor.fetchone()
        if mem_row:
            last_visit = mem_row["joined_at"]
            
    if last_visit:
        try:
            last_visit_clean = last_visit.split(".")[0]
            if ' ' in last_visit_clean:
                last_dt = datetime.strptime(last_visit_clean[:19], "%Y-%m-%d %H:%M:%S")
            else:
                last_dt = datetime.strptime(last_visit_clean[:10], "%Y-%m-%d")
            
            days_inactive = (now_ist() - last_dt).days
            if days_inactive >= 15:
                cursor.execute("""
                    INSERT INTO win_back_recoveries (member_id, gym_id, days_inactive, recovery_date)
                    VALUES (?, ?, ?, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
                """, (member_id, gym_id, days_inactive))
        except Exception as e:
            app.logger.error(f"Error recording win back recovery: {e}")

@app.route("/api/admin/members/<int:id>/check-in", methods=["POST"])
@login_required("owner")
def admin_manual_check_in(id):
    conn = database.get_db_connection()
    cursor = conn.cursor()
    
    gym_id = session["gym_id"]

    # Verify member exists
    cursor.execute("SELECT first_name, last_name, status, user_id FROM members WHERE id = ? AND gym_id = ?", (id, gym_id))
    mbr = cursor.fetchone()
    if not mbr:
        conn.close()
        return jsonify({"error": "Member not found"}), 404

    today_str = now_ist().strftime("%Y-%m-%d")
    now_time_str = now_ist().strftime("%Y-%m-%d %H:%M:%S")

    # Check if already checked in today
    cursor.execute("""
        SELECT id, check_out_time FROM attendance
        WHERE member_id = ? AND status = 'success' AND check_in_time::date = ?
        ORDER BY check_in_time DESC LIMIT 1
    """, (id, today_str))
    att_today = cursor.fetchone()
    if att_today:
        conn.close()
        if att_today["check_out_time"] is None:
            return jsonify({"error": "This member is already checked in."}), 409
        else:
            return jsonify({"error": "This member has already completed attendance today."}), 409

    try:
        cursor.execute("""
            INSERT INTO attendance (member_id, check_in_time, attendance_date, gym_id, attendance_state, status)
            VALUES (?, ?, ?, ?, 'checked_in', 'success')
        """, (id, now_time_str, today_str, gym_id))

        # Update member status to active if it was expired
        if mbr["status"] == "expired":
            cursor.execute("UPDATE members SET status = 'active' WHERE id = ?", (id,))
            
        check_and_record_win_back_recovery(cursor, id, gym_id)
        conn.commit()
        
        fullname = f"{mbr['first_name']} {mbr['last_name']}"
        broadcast_event("CHECKIN_SUCCESS", {
            "member_id": id,
            "name": fullname,
            "time": now_time_str,
            "manual": True
        }, gym_id)

        return jsonify({"success": True, "check_in_time": now_time_str})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()

@app.route("/api/admin/members/<int:id>/check-out", methods=["POST"])
@login_required("owner")
def admin_manual_check_out(id):
    conn = database.get_db_connection()
    cursor = conn.cursor()
    
    # Verify member exists
    cursor.execute("SELECT first_name, last_name, status, user_id FROM members WHERE id = ? AND gym_id = ?", (id, session["gym_id"]))
    mbr = cursor.fetchone()
    if not mbr:
        conn.close()
        return jsonify({"error": "Member not found"}), 404

    today_str = now_ist().strftime("%Y-%m-%d")
    now_time_str = now_ist().strftime("%Y-%m-%d %H:%M:%S")

    # Find active check-in
    cursor.execute("""
        SELECT id, check_in_time FROM attendance
        WHERE member_id = ? AND status = 'success' AND check_out_time IS NULL AND check_in_time::date = ?
        ORDER BY check_in_time DESC LIMIT 1
    """, (id, today_str))
    att = cursor.fetchone()
    if not att:
        conn.close()
        return jsonify({"error": "This member is not currently checked in."}), 400
        
    try:
        cursor.execute("""
            UPDATE attendance 
            SET check_out_time = ?, attendance_state = 'completed'
            WHERE id = ?
        """, (now_time_str, att["id"]))
        conn.commit()
        
        in_t = datetime.strptime(att["check_in_time"], "%Y-%m-%d %H:%M:%S")
        out_t = datetime.strptime(now_time_str, "%Y-%m-%d %H:%M:%S")
        diff = int((out_t - in_t).total_seconds() / 60)
        hours = diff // 60
        mins = diff % 60
        duration_str = f"{hours}h {mins}m" if hours > 0 else f"{mins}m"
        
        fullname = f"{mbr['first_name']} {mbr['last_name']}"
        broadcast_event("CHECKOUT_SUCCESS", {
            "member_id": id,
            "name": fullname,
            "check_in": att["check_in_time"],
            "check_out": now_time_str,
            "duration": duration_str,
            "manual": True
        }, session["gym_id"])
        
        return jsonify({"success": True, "check_out_time": now_time_str, "duration": duration_str})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()

@app.route("/api/member/plans", methods=["GET"])
@login_required("member")
def member_get_plans():
    conn = database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM plans WHERE gym_id = ? ORDER BY price ASC", (session["gym_id"],))
    p_list = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return jsonify(p_list)

@app.route("/api/member/payments/<int:id>/pay", methods=["POST"])
@login_required("member")
def member_submit_payment(id):
    data = request.get_json() or {}
    tx_ref = data.get("transaction_reference")
    if not tx_ref:
        return jsonify({"error": "Transaction reference is required"}), 400
        
    m_id = session.get("member_id")
    conn = database.get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT * FROM payments WHERE id = ? AND member_id = ?", (id, m_id))
    pay = cursor.fetchone()
    if not pay:
        conn.close()
        return jsonify({"error": "Billing record not found"}), 404
    app.logger.info(f"DEBUG: pay status in DB before submit is {pay['status']!r}")
    if pay["status"] in ("paid", "approved"):
        conn.close()
        return jsonify({"error": "Payment already completed"}), 400
        
    if pay["status"] == "pending_approval":
        conn.close()
        return jsonify({"error": "Payment is already pending approval"}), 400

    # Idempotency check: check if this transaction reference has already been used
    cursor.execute("SELECT id FROM payments WHERE transaction_reference = ? AND status IN ('paid', 'pending_approval', 'approved') AND id != ?", (tx_ref, id))
    if cursor.fetchone():
        conn.close()
        return jsonify({"error": "Transaction reference already submitted or exists"}), 400
        
    method = data.get("payment_method", "online")
    date = data.get("payment_date")
    receipt_url = data.get("receipt_file_url")
    receipt_type = data.get("receipt_file_type")

    try:
        # Auto-generate receipt number linked to payment ID
        receipt_no = generate_receipt_number(cursor, session["gym_id"], payment_id=id)
        
        # Update payment status to pending_approval and store details
        cursor.execute("""
            UPDATE payments 
            SET status = 'pending_approval', 
                receipt_number = ?, 
                transaction_reference = ?,
                payment_method = ?, 
                payment_date = ?, 
                receipt_file_url = ?, 
                receipt_file_type = ?,
                updated_at = (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
            WHERE id = ?
        """, (receipt_no, tx_ref, method, date, receipt_url, receipt_type, id))
        
        cursor.execute("SELECT user_id, first_name, last_name FROM members WHERE id = ?", (m_id,))
        m = cursor.fetchone()

        # Notify the Gym Owner
        cursor.execute("SELECT id FROM users WHERE role = 'owner' AND gym_id = ?", (session["gym_id"],))
        owners = cursor.fetchall()
        for owner in owners:
            cursor.execute("""
                INSERT INTO notifications (user_id, type, message)
                VALUES (?, 'payment', ?)
            """, (owner["id"], f"New payment of ₹{pay['amount']} submitted by {m['first_name']} {m['last_name']} and is awaiting review."))

        # Notify the Member
        if m and m["user_id"]:
            cursor.execute("""
                INSERT INTO notifications (user_id, type, message)
                VALUES (?, 'payment', 'Your payment has been submitted and is awaiting review.')
            """, (m["user_id"],))

        log_action(cursor, "payment_submitted_by_member", "payment", id, {
            "member_id": m_id, "amount": pay["amount"], "transaction_reference": tx_ref
        })

        # Broadcast payment approval requested
        broadcast_event("PAYMENT_REQUESTED", {
            "id": id,
            "member_id": m_id,
            "name": f"{m['first_name']} {m['last_name']}",
            "amount": pay["amount"],
            "reference": tx_ref
        }, session["gym_id"])
        conn.commit()
        return jsonify({"success": True})
    except sqlite3.IntegrityError:
        return jsonify({"error": "Transaction reference already submitted or exists"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()

@app.route("/api/member/purchase-plan", methods=["POST"])
@login_required("member")
def member_purchase_plan():
    data = request.get_json() or {}
    plan_id = data.get("plan_id")
    tx_ref = data.get("transaction_reference")
    if not plan_id or not tx_ref:
        return jsonify({"error": "Plan ID and Transaction reference are required"}), 400
        
    m_id = session.get("member_id")
    gym_id = session["gym_id"]
    conn = database.get_db_connection()
    cursor = conn.cursor()

    # Idempotency check: check if this transaction reference has already been used
    cursor.execute("SELECT id FROM payments WHERE transaction_reference = ? AND status IN ('paid', 'pending_approval', 'approved')", (tx_ref,))
    if cursor.fetchone():
        conn.close()
        return jsonify({"error": "Transaction reference already submitted or exists"}), 400

    # Get plan details
    cursor.execute("SELECT name, price, duration_months FROM plans WHERE id = ? AND gym_id = ?", (plan_id, gym_id))
    plan = cursor.fetchone()
    if not plan:
        conn.close()
        return jsonify({"error": "Plan not found"}), 404

    # Get member info
    cursor.execute("SELECT user_id, first_name, last_name FROM members WHERE id = ?", (m_id,))
    mbr = cursor.fetchone()
    if not mbr:
        conn.close()
        return jsonify({"error": "Member record missing"}), 404

    start_date_str = now_ist().strftime("%Y-%m-%d")
    end_date = now_ist() + timedelta(days=plan["duration_months"] * 30)
    end_date_str = end_date.strftime("%Y-%m-%d")

    method = data.get("payment_method", "online")
    date = data.get("payment_date")
    receipt_url = data.get("receipt_file_url")
    receipt_type = data.get("receipt_file_type")

    try:
        # Create a new membership with status suspended (awaits payment approval)
        cursor.execute("""
            INSERT INTO memberships (member_id, plan_id, status, start_date, end_date, price_paid, gym_id)
            VALUES (?, ?, 'suspended', ?, ?, ?, ?)
        """, (m_id, plan_id, start_date_str, end_date_str, plan["price"], gym_id))
        membership_id = cursor.lastrowid

        # Create payment request in pending_approval status with temp receipt
        cursor.execute("""
            INSERT INTO payments (membership_id, member_id, amount, status, receipt_number, transaction_reference, payment_method, payment_date, receipt_file_url, receipt_file_type, plan_id, gym_id)
            VALUES (?, ?, ?, 'pending_approval', NULL, ?, ?, ?, ?, ?, ?, ?)
        """, (membership_id, m_id, plan["price"], tx_ref, method, date, receipt_url, receipt_type, plan_id, gym_id))
        payment_id = cursor.lastrowid

        # Generate receipt number linked to payment ID
        receipt_no = generate_receipt_number(cursor, gym_id, payment_id=payment_id)
        cursor.execute("UPDATE payments SET receipt_number = ? WHERE id = ?", (receipt_no, payment_id))

        # Notify the Gym Owner
        cursor.execute("SELECT id FROM users WHERE role = 'owner' AND gym_id = ?", (gym_id,))
        owners = cursor.fetchall()
        for owner in owners:
            cursor.execute("""
                INSERT INTO notifications (user_id, type, message)
                VALUES (?, 'payment', ?)
            """, (owner["id"], f"New payment of ₹{plan['price']} submitted by {mbr['first_name']} {mbr['last_name']} and is awaiting review."))

        # Notify the Member
        if mbr and mbr["user_id"]:
            cursor.execute("""
                INSERT INTO notifications (user_id, type, message)
                VALUES (?, 'payment', 'Your payment has been submitted and is awaiting review.')
            """, (mbr["user_id"],))

        log_action(cursor, "plan_purchased_by_member", "payment", payment_id, {
            "member_id": m_id, "plan_id": plan_id, "plan_name": plan["name"],
            "membership_id": membership_id, "amount": plan["price"], "transaction_reference": tx_ref
        })
        conn.commit()

        broadcast_event("PAYMENT_REQUESTED", {
            "id": payment_id,
            "member_id": m_id,
            "name": f"{mbr['first_name']} {mbr['last_name']}",
            "amount": plan["price"],
            "reference": tx_ref
        }, gym_id)

        return jsonify({"success": True, "payment_id": payment_id})
    except sqlite3.IntegrityError:
        return jsonify({"error": "Transaction reference already submitted"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()

@app.route("/api/admin/payments/<int:id>/approve", methods=["POST"])
@login_required("owner")
def admin_approve_payment(id):
    conn = database.get_db_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT * FROM payments WHERE id = ? AND gym_id = ?", (id, session["gym_id"]))
    pay = cursor.fetchone()
    if not pay:
        conn.close()
        return jsonify({"error": "Payment not found"}), 404
        
    pay_time = now_ist().strftime("%Y-%m-%d %H:%M:%S")
    
    try:
        # Update payment status
        cursor.execute("""
            UPDATE payments 
            SET status = 'paid', 
                payment_date = ?, 
                reviewed_by = ?, 
                review_date = ?,
                updated_at = (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
            WHERE id = ?
        """, (pay_time, session["user_id"], pay_time, id))
        
        # Update associated membership to active (handling renewal extension)
        membership_id = pay["membership_id"]
        if membership_id:
            cursor.execute("SELECT plan_id, member_id, start_date, end_date FROM memberships WHERE id = ?", (membership_id,))
            new_m = cursor.fetchone()
            if new_m:
                # Find if there is another active membership ending in the future
                cursor.execute("""
                    SELECT end_date FROM memberships 
                    WHERE member_id = ? AND status = 'active' AND id != ? AND end_date >= ?
                    ORDER BY end_date DESC LIMIT 1
                """, (pay["member_id"], membership_id, now_ist().strftime("%Y-%m-%d")))
                existing_active = cursor.fetchone()
                if existing_active:
                    # Extend! Start date is the end date of the existing one, and new end date is extended by the duration.
                    prev_end = datetime.strptime(existing_active["end_date"], "%Y-%m-%d")
                    # Calculate duration in days of this new plan
                    cursor.execute("SELECT duration_months FROM plans WHERE id = ?", (new_m["plan_id"],))
                    pl = cursor.fetchone()
                    duration_days = (pl["duration_months"] * 30) if pl else 30
                    
                    new_start_str = existing_active["end_date"]
                    new_end_str = (prev_end + timedelta(days=duration_days)).strftime("%Y-%m-%d")
                    
                    cursor.execute("""
                        UPDATE memberships 
                        SET status = 'active', start_date = ?, end_date = ? 
                        WHERE id = ?
                    """, (new_start_str, new_end_str, membership_id))
                else:
                    cursor.execute("UPDATE memberships SET status = 'active' WHERE id = ?", (membership_id,))
            
        # Set member status to active
        cursor.execute("UPDATE members SET status = 'active' WHERE id = ?", (pay["member_id"],))
        
        # Notify member
        cursor.execute("SELECT user_id, first_name FROM members WHERE id = ?", (pay["member_id"],))
        m = cursor.fetchone()
        if m:
            cursor.execute(
                "INSERT INTO notifications (user_id, type, message, gym_id) VALUES (?, 'payment', 'Your membership payment has been approved.', ?)",
                (m["user_id"], session["gym_id"])
            )

        log_action(cursor, "payment_approved", "payment", id, {
            "member_id": pay["member_id"], "amount": pay["amount"], "membership_id": membership_id
        })
        conn.commit()

        broadcast_event("PAYMENT_RECORDED", {
            "id": id,
            "member_id": pay["member_id"],
            "amount": pay["amount"]
        }, session["gym_id"])
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()

@app.route("/api/admin/payments/<int:id>/reject", methods=["POST"])
@login_required("owner")
def admin_reject_payment(id):
    data = request.get_json() or {}
    reason = data.get("rejection_reason", "Receipt details are unclear.")
    
    conn = database.get_db_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT * FROM payments WHERE id = ? AND gym_id = ?", (id, session["gym_id"]))
    pay = cursor.fetchone()
    if not pay:
        conn.close()
        return jsonify({"error": "Payment not found"}), 404
        
    try:
        # Update status to 'rejected' and save rejection reason, and also mark reviewed_by and review_date
        review_time = now_ist().strftime("%Y-%m-%d %H:%M:%S")
        cursor.execute("""
            UPDATE payments 
            SET status = 'rejected', 
                rejection_reason = ?, 
                reviewed_by = ?, 
                review_date = ?,
                updated_at = (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
            WHERE id = ?
        """, (reason, session["user_id"], review_time, id))
        
        # Update associated membership to 'rejected'
        membership_id = pay["membership_id"]
        if membership_id:
            cursor.execute("UPDATE memberships SET status = 'rejected' WHERE id = ?", (membership_id,))
            
        # Notify member
        cursor.execute("SELECT user_id, first_name FROM members WHERE id = ?", (pay["member_id"],))
        m = cursor.fetchone()
        if m:
            msg = f"Your payment was rejected. Reason: {reason}. Please review the reason and upload a new receipt."
            cursor.execute(
                "INSERT INTO notifications (user_id, type, message, gym_id) VALUES (?, 'payment', ?, ?)",
                (m["user_id"], msg, session["gym_id"])
            )

        log_action(cursor, "payment_rejected", "payment", id, {
            "member_id": pay["member_id"], "amount": pay["amount"], "rejection_reason": reason
        })
        conn.commit()

        broadcast_event("PAYMENT_REJECTED", {
            "id": id,
            "member_id": pay["member_id"],
            "amount": pay["amount"],
            "rejection_reason": reason
        }, session["gym_id"])
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()

# ================= MEMBER PORTAL SPECIFIC ENDPOINTS =================

@app.route("/api/member/dashboard", methods=["GET"])
@login_required("member")
def member_dashboard():
    m_id = session.get("member_id")
    if not m_id:
        return jsonify({"error": "Associated member details not found"}), 400
        
    conn = database.get_db_connection()
    cursor = conn.cursor()
    
    # 1. Fetch Member status & full profile information
    cursor.execute("""
        SELECT m.*, u.email
        FROM members m
        JOIN users u ON m.user_id = u.id
        WHERE m.id = ?
    """, (m_id,))
    mb = cursor.fetchone()
    if not mb:
        conn.close()
        return jsonify({"error": "Member record missing"}), 404
        
    if mb["status"] == "suspended":
        conn.close()
        session.clear()
        return jsonify({"error": "Account suspended. Session closed."}), 403
    elif mb["status"] == "pending":
        conn.close()
        return jsonify({"error": "Your account is waiting for approval from the gym owner.", "status": "pending"}), 403
    elif mb["status"] == "rejected":
        conn.close()
        return jsonify({"error": "Your registration request was rejected. Please contact your gym.", "status": "rejected"}), 403
        
    if mb["status"] == "pending":
        conn.close()
        session.clear()
        return jsonify({"error": "Account pending approval. Session closed."}), 403
        
    # Get active/latest membership details
    cursor.execute("""
        SELECT ms.*, p.name as plan_name, p.benefits, p.duration_months
        FROM memberships ms
        JOIN plans p ON ms.plan_id = p.id
        WHERE ms.member_id = ?
        ORDER BY ms.end_date DESC LIMIT 1
    """, (m_id,))
    row = cursor.fetchone()
    
    membership_details = None
    days_remaining = 0
    today_str = now_ist().strftime("%Y-%m-%d")
    
    if row:
        membership_details = dict(row)
        end_dt = datetime.strptime(row["end_date"], "%Y-%m-%d")
        today_dt = datetime.strptime(today_str, "%Y-%m-%d")
        days_remaining = (end_dt - today_dt).days
        
        # Override to zero if expired
        if days_remaining < 0:
            days_remaining = 0
            
    # Calculate Attendance streak
    # Get checkout list of successful checkins in order
    cursor.execute("""
        SELECT check_in_time::date::text as check_date
        FROM attendance
        WHERE member_id = ? AND status = 'success'
        GROUP BY check_date
        ORDER BY check_date DESC
    """, (m_id,))
    checkin_dates = [datetime.strptime(row[0], "%Y-%m-%d") for row in cursor.fetchall()]
    
    streak = 0
    if checkin_dates:
        curr_chk = datetime.strptime(today_str, "%Y-%m-%d")
        
        # Check if the user checked-in today or yesterday to continue streak
        if checkin_dates[0] == curr_chk:
            streak = 1
            idx = 0
            while idx + 1 < len(checkin_dates):
                diff = (checkin_dates[idx] - checkin_dates[idx+1]).days
                if diff == 1:
                    streak += 1
                    idx += 1
                elif diff == 0:
                    idx += 1 # same day, ignore
                else:
                    break
        elif checkin_dates[0] == curr_chk - timedelta(days=1):
            streak = 1
            idx = 0
            while idx + 1 < len(checkin_dates):
                diff = (checkin_dates[idx] - checkin_dates[idx+1]).days
                if diff == 1:
                    streak += 1
                    idx += 1
                elif diff == 0:
                    idx += 1
                else:
                    break
                    
    # Today's check-in / check-out status
    cursor.execute("""
        SELECT check_in_time, check_out_time FROM attendance 
        WHERE member_id = ? AND status = 'success' AND check_in_time::date = ?
        ORDER BY check_in_time DESC LIMIT 1
    """, (m_id, today_str))
    today_att = cursor.fetchone()
    
    today_check_in = None
    today_check_out = None
    today_duration = None
    today_status = "Absent"
    today_checked = False
    
    if today_att:
        today_checked = True
        today_check_in = today_att["check_in_time"]
        today_check_out = today_att["check_out_time"]
        if today_check_out:
            today_status = "Checked Out"
            in_t = datetime.strptime(today_check_in, "%Y-%m-%d %H:%M:%S")
            out_t = datetime.strptime(today_check_out, "%Y-%m-%d %H:%M:%S")
            diff = int((out_t - in_t).total_seconds() / 60)
            hours = diff // 60
            mins = diff % 60
            today_duration = f"{hours}h {mins}m" if hours > 0 else f"{mins}m"
        else:
            today_status = "Checked In"
            today_duration = "Active"

    # Weekly attendance count (distinct days checked in last 7 days)
    cursor.execute("""
        SELECT COUNT(DISTINCT check_in_time::date)
        FROM attendance
        WHERE member_id = ? AND status = 'success' AND check_in_time::date >= CURRENT_DATE - INTERVAL '6 days'
    """, (m_id,))
    weekly_count = cursor.fetchone()[0]

    # Monthly attendance count (distinct days checked in current month)
    cursor.execute("""
        SELECT COUNT(DISTINCT check_in_time::date)
        FROM attendance
        WHERE member_id = ? AND status = 'success' AND TO_CHAR(check_in_time::timestamp, 'YYYY-MM') = TO_CHAR(CURRENT_DATE, 'YYYY-MM')
    """, (m_id,))
    monthly_count = cursor.fetchone()[0]

    # Fetch last 30 attendance history logs
    cursor.execute("""
        SELECT id, check_in_time, check_out_time, status, error_msg 
        FROM attendance 
        WHERE member_id = ? AND status = 'success'
        ORDER BY check_in_time DESC LIMIT 30
    """, (m_id,))
    attendance_history = [dict(r) for r in cursor.fetchall()]

    # Member notification center
    user_id = session["user_id"]
    cursor.execute("SELECT * FROM notifications WHERE user_id = ? AND gym_id = ? ORDER BY created_at DESC LIMIT 50", (user_id, session["gym_id"]))
    notifs = [dict(r) for r in cursor.fetchall()]
    
    # Payment status
    cursor.execute("""
        SELECT p.*, pl.name as plan_name 
        FROM payments p
        LEFT JOIN plans pl ON p.plan_id = pl.id
        WHERE p.member_id = ? ORDER BY p.created_at DESC
    """, (m_id,))
    billing_history = [dict(r) for r in cursor.fetchall()]
    
    status_map_ui = {
        "paid": "Approved",
        "approved": "Approved",
        "pending": "Pending",
        "draft": "Draft",
        "pending_approval": "Pending Approval",
        "submitted": "Pending Approval",
        "rejected": "Rejected",
        "cancelled": "Cancelled",
        "overdue": "Overdue"
    }
    for b in billing_history:
        b["status"] = status_map_ui.get(b["status"], b["status"])
        if not b.get("due_date"):
            b["due_date"] = "—"
        if not b.get("payment_date"):
            b["payment_date"] = "—"
        if not b.get("payment_method"):
            b["payment_method"] = "—"
        if not b.get("rejection_reason"):
            b["rejection_reason"] = "—"
        if not b.get("transaction_reference"):
            b["transaction_reference"] = "—"
    
    # Monthly Rank
    cursor.execute("""
        WITH ranks AS (
            SELECT member_id, COUNT(id) as cnt,
                   RANK() OVER (ORDER BY COUNT(id) DESC) as rnk
            FROM attendance
            WHERE gym_id = ? AND status = 'success' AND TO_CHAR(check_in_time::timestamp, 'YYYY-MM') = TO_CHAR(CURRENT_DATE, 'YYYY-MM')
            GROUP BY member_id
        )
        SELECT rnk FROM ranks WHERE member_id = ?
    """, (session["gym_id"], m_id))
    m_rnk_row = cursor.fetchone()
    monthly_rank = m_rnk_row[0] if m_rnk_row else 0

    # Gym Profile & Settings
    cursor.execute("SELECT key, value FROM settings WHERE gym_id = ?", (session["gym_id"],))
    gym_settings = {row["key"]: row["value"] for row in cursor.fetchall()}
    cursor.execute("SELECT name, phone, address, logo_url FROM gyms WHERE id = ?", (session["gym_id"],))
    gym_row = cursor.fetchone()
    gym_info = {
        "name": gym_row["name"] if (gym_row and gym_row["name"]) else "GymOS",
        "phone": gym_row["phone"] if (gym_row and gym_row["phone"]) else "",
        "address": gym_row["address"] if (gym_row and gym_row["address"]) else "",
        "logo_url": gym_row["logo_url"] if (gym_row and gym_row["logo_url"]) else ""
    }

    conn.close()

    return jsonify({
        "first_name": mb["first_name"],
        "last_name": mb["last_name"],
        "email": mb["email"],
        "phone": mb["phone"],
        "dob": mb["dob"],
        "gender": mb["gender"],
        "height": mb["height"],
        "weight": mb["weight"],
        "profile_photo": mb["profile_photo"],
        "emergency_contact": mb["emergency_contact"],
        "emergency_contact_name": mb["emergency_contact_name"],
        "emergency_contact_number": mb["emergency_contact_number"],
        "emergency_contact_relation": mb["emergency_contact_relation"],
        "status": mb["status"],
        "membership": membership_details,
        "days_remaining": days_remaining,
        "streak": streak,
        "today_checked": today_checked,
        "today_check_in": today_check_in,
        "today_check_out": today_check_out,
        "today_duration": today_duration,
        "today_status": today_status,
        "weekly_count": weekly_count,
        "monthly_count": monthly_count,
        "monthly_rank": monthly_rank,
        "attendance_history": attendance_history,
        "notifications": notifs,
        "billing_history": billing_history,
        "gym_settings": gym_settings,
        "gym_info": gym_info
    })

@app.route("/api/member/activity", methods=["GET"])
@login_required("member")
def member_activity_data():
    m_id = session.get("member_id")
    if not m_id:
        return jsonify({"error": "Associated member details not found"}), 400
        
    conn = database.get_db_connection()
    cursor = conn.cursor()
    
    try:
        # Get member info & status
        cursor.execute("SELECT status, first_name, last_name FROM members WHERE id = ?", (m_id,))
        mb = cursor.fetchone()
        if not mb:
            return jsonify({"error": "Member record missing"}), 404
            
        # 1. Fetch active plan details
        cursor.execute("""
            SELECT ms.*, p.name as plan_name
            FROM memberships ms
            JOIN plans p ON ms.plan_id = p.id
            WHERE ms.member_id = ? AND ms.status = 'active'
            ORDER BY ms.end_date DESC LIMIT 1
        """, (m_id,))
        plan_row = cursor.fetchone()
        if not plan_row:
            # Fallback to latest membership if no active one exists
            cursor.execute("""
                SELECT ms.*, p.name as plan_name
                FROM memberships ms
                JOIN plans p ON ms.plan_id = p.id
                WHERE ms.member_id = ?
                ORDER BY ms.end_date DESC LIMIT 1
            """, (m_id,))
            plan_row = cursor.fetchone()
        plan_name = plan_row["plan_name"] if plan_row else "No Plan"
        
        # 2. Fetch successful checkin history
        cursor.execute("""
            SELECT a.id, a.check_in_time, a.check_out_time, a.attendance_date, a.gym_id, a.attendance_state, g.name as gym_name
            FROM attendance a
            LEFT JOIN gyms g ON a.gym_id = g.id
            WHERE a.member_id = ? AND a.status = 'success'
            ORDER BY a.check_in_time DESC
        """, (m_id,))
        logs = [dict(r) for r in cursor.fetchall()]
        
        # 3. Calculate Streaks (Current & Longest) - Cross-compatible
        cursor.execute("""
            SELECT check_in_time
            FROM attendance
            WHERE member_id = ? AND status = 'success'
            ORDER BY check_in_time DESC
        """, (m_id,))
        raw_rows = cursor.fetchall()
        checkin_dates_set = sorted(list(set(r[0][:10] for r in raw_rows if r[0])), reverse=True)
        checkin_dates = [datetime.strptime(d, "%Y-%m-%d").date() for d in checkin_dates_set]
        
        today = now_ist().date()
        yesterday = today - timedelta(days=1)
        
        streak = 0
        if checkin_dates:
            if checkin_dates[0] == today or checkin_dates[0] == yesterday:
                streak = 1
                for i in range(len(checkin_dates) - 1):
                    if (checkin_dates[i] - checkin_dates[i+1]).days == 1:
                        streak += 1
                    else:
                        break
                        
        longest_streak = 0
        if checkin_dates:
            temp_streak = 1
            longest_streak = 1
            for i in range(len(checkin_dates) - 1):
                diff = (checkin_dates[i] - checkin_dates[i+1]).days
                if diff == 1:
                    temp_streak += 1
                    if temp_streak > longest_streak:
                        longest_streak = temp_streak
                elif diff > 1:
                    temp_streak = 1
                    
        # 4. Total Workout Hours, Average Duration, Max Duration
        total_seconds = 0
        max_seconds = 0
        durations = []
        for l in logs:
            if l.get("check_out_time"):
                try:
                    in_t = datetime.strptime(l["check_in_time"][:19], "%Y-%m-%d %H:%M:%S")
                    out_t = datetime.strptime(l["check_out_time"][:19], "%Y-%m-%d %H:%M:%S")
                    diff = max(0, (out_t - in_t).total_seconds())
                    durations.append(diff)
                    total_seconds += diff
                    if diff > max_seconds:
                        max_seconds = diff
                except Exception:
                    pass
                    
        total_hours = round(total_seconds / 3600.0, 1)
        total_hrs_int = int(total_seconds // 3600)
        total_mins_int = int((total_seconds % 3600) // 60)
        if total_hrs_int > 0:
            total_workout_formatted = f"{total_hrs_int}h {total_mins_int}m" if total_mins_int > 0 else f"{total_hrs_int}h"
        else:
            total_workout_formatted = f"{total_mins_int}m" if total_mins_int > 0 else "0m"

        avg_minutes = int((total_seconds / len(durations)) / 60) if durations else 0
        max_minutes = int(max_seconds / 60)
        
        # 5. Period counters - Portable SQL
        gym_id = session["gym_id"]
        week_start_str = (today - timedelta(days=6)).strftime("%Y-%m-%d 00:00:00")
        month_start_str = (today - timedelta(days=29)).strftime("%Y-%m-%d 00:00:00")
        year_start_str = today.strftime("%Y-01-01 00:00:00")

        cursor.execute("""
            SELECT COUNT(DISTINCT SUBSTR(check_in_time, 1, 10))
            FROM attendance
            WHERE member_id = ? AND status = 'success' AND check_in_time >= ?
        """, (m_id, week_start_str))
        weekly_visits = cursor.fetchone()[0]

        cursor.execute("""
            SELECT COUNT(DISTINCT SUBSTR(check_in_time, 1, 10))
            FROM attendance
            WHERE member_id = ? AND status = 'success' AND check_in_time >= ?
        """, (m_id, month_start_str))
        monthly_visits = cursor.fetchone()[0]

        cursor.execute("""
            SELECT COUNT(DISTINCT SUBSTR(check_in_time, 1, 10))
            FROM attendance
            WHERE member_id = ? AND status = 'success' AND check_in_time >= ?
        """, (m_id, year_start_str))
        yearly_visits = cursor.fetchone()[0]

        # 6. Single Source of Truth Leaderboards & Ranks
        # All Time
        cursor.execute("""
            SELECT m.id, m.first_name, m.last_name, m.profile_photo, COUNT(a.id) as checkin_count
            FROM members m
            LEFT JOIN attendance a ON m.id = a.member_id AND a.status = 'success'
            WHERE m.gym_id = ? AND m.status NOT IN ('pending', 'rejected')
            GROUP BY m.id, m.first_name, m.last_name, m.profile_photo
            ORDER BY checkin_count DESC, m.first_name ASC, m.id ASC
        """, (gym_id,))
        all_members_all_time = [dict(r) for r in cursor.fetchall()]
        leaderboard_all = []
        all_time_rank = 0
        for idx, u in enumerate(all_members_all_time):
            u["rank"] = idx + 1
            u["points"] = u["checkin_count"] * 100
            if u["id"] == m_id:
                all_time_rank = u["rank"]
            if idx < 10:
                leaderboard_all.append(u)

        # Monthly
        cursor.execute("""
            SELECT m.id, m.first_name, m.last_name, m.profile_photo, COUNT(a.id) as checkin_count
            FROM members m
            LEFT JOIN attendance a ON m.id = a.member_id AND a.status = 'success' AND a.check_in_time >= ?
            WHERE m.gym_id = ? AND m.status NOT IN ('pending', 'rejected')
            GROUP BY m.id, m.first_name, m.last_name, m.profile_photo
            ORDER BY checkin_count DESC, m.first_name ASC, m.id ASC
        """, (month_start_str, gym_id))
        all_members_monthly = [dict(r) for r in cursor.fetchall()]
        leaderboard_monthly = []
        monthly_rank = 0
        for idx, u in enumerate(all_members_monthly):
            u["rank"] = idx + 1
            u["points"] = u["checkin_count"] * 100
            if u["id"] == m_id:
                monthly_rank = u["rank"]
            if idx < 10:
                leaderboard_monthly.append(u)

        # Weekly
        cursor.execute("""
            SELECT m.id, m.first_name, m.last_name, m.profile_photo, COUNT(a.id) as checkin_count
            FROM members m
            LEFT JOIN attendance a ON m.id = a.member_id AND a.status = 'success' AND a.check_in_time >= ?
            WHERE m.gym_id = ? AND m.status NOT IN ('pending', 'rejected')
            GROUP BY m.id, m.first_name, m.last_name, m.profile_photo
            ORDER BY checkin_count DESC, m.first_name ASC, m.id ASC
        """, (week_start_str, gym_id))
        all_members_weekly = [dict(r) for r in cursor.fetchall()]
        leaderboard_weekly = []
        weekly_rank = 0
        for idx, u in enumerate(all_members_weekly):
            u["rank"] = idx + 1
            u["points"] = u["checkin_count"] * 100
            if u["id"] == m_id:
                weekly_rank = u["rank"]
            if idx < 10:
                leaderboard_weekly.append(u)
        
        # Points (100 * checkin count)
        points = len(logs) * 100
        
        # 7. Today status
        today_str = now_ist().strftime("%Y-%m-%d")
        cursor.execute("""
            SELECT check_in_time, check_out_time FROM attendance
            WHERE member_id = ? AND status = 'success' AND SUBSTR(check_in_time, 1, 10) = ?
            ORDER BY check_in_time DESC LIMIT 1
        """, (m_id, today_str))
        today_att = cursor.fetchone()
        today_status = "Absent"
        if today_att:
            today_status = "Checked Out" if today_att["check_out_time"] else "Checked In"
            
        # 9. Smart Insights
        insights = []
        insights.append(f"You've worked out {weekly_visits} days this week.")
        if avg_minutes > 0:
            hrs = avg_minutes // 60
            mins = avg_minutes % 60
            dur_str = f"{hrs}h {mins}m" if hrs > 0 else f"{mins}m"
            insights.append(f"Your average workout lasts {dur_str}.")
        else:
            insights.append("Log a check-out to calculate average workout duration.")
            
        insights.append(f"Your longest check-in streak is {longest_streak} days.")
        
        # Relative comparison with last month
        last_month_start_str = (today - timedelta(days=60)).strftime("%Y-%m-%d 00:00:00")
        cursor.execute("""
            SELECT COUNT(DISTINCT SUBSTR(check_in_time, 1, 10))
            FROM attendance
            WHERE member_id = ? AND status = 'success'
              AND check_in_time >= ? AND check_in_time < ?
        """, (m_id, last_month_start_str, month_start_str))
        last_month_count = cursor.fetchone()[0] or 0
        if monthly_visits > last_month_count:
            insights.append("You're more active this month than last month!")
        elif monthly_visits < last_month_count and last_month_count > 0:
            insights.append("You are slightly behind last month's pace. Push harder!")
        else:
            insights.append("Keep up your daily consistency!")
            
        monthly_goal = 12
        if monthly_visits < monthly_goal:
            insights.append(f"Only {monthly_goal - monthly_visits} visits left to reach your monthly goal.")
        else:
            insights.append("Congratulations! You've smashed your monthly visits goal! 🎉")
            
        # 10. Achievements checking
        achievements = [
            {
                "id": "first_workout",
                "name": "First Workout",
                "description": "Completed your first check-in.",
                "icon": "🏆",
                "unlocked": len(logs) >= 1,
                "requirement": "Complete 1 workout"
            },
            {
                "id": "streak_7",
                "name": "7 Day Streak",
                "description": "Maintained a 7-day workout streak.",
                "icon": "🔥",
                "unlocked": longest_streak >= 7,
                "requirement": "Streak of 7 consecutive days"
            },
            {
                "id": "checkin_30",
                "name": "30 Check-ins",
                "description": "Completed 30 gym visits.",
                "icon": "⚡",
                "unlocked": len(logs) >= 30,
                "requirement": "30 total check-ins"
            },
            {
                "id": "top_10",
                "name": "Top 10 Member",
                "description": "Ranked in the top 10 members this month.",
                "icon": "👑",
                "unlocked": (monthly_rank <= 10 and monthly_rank > 0),
                "requirement": "Reach Top 10 monthly rank"
            },
            {
                "id": "hours_100",
                "name": "100 Workout Hours",
                "description": "Spent 100 hours training in the gym.",
                "icon": "💪",
                "unlocked": total_hours >= 100.0,
                "requirement": "100 total workout hours"
            },
            {
                "id": "monthly_champion",
                "name": "Monthly Champion",
                "description": "Achieved #1 rank or visited 20 times in a month.",
                "icon": "🎯",
                "unlocked": (monthly_rank == 1 or monthly_visits >= 20),
                "requirement": "Rank #1 or 20 visits in a single month"
            }
        ]
        
        visits_by_dow = [0] * 7
        workout_hours_by_week = [0.0] * 4

        return jsonify({
            "first_name": mb["first_name"],
            "last_name": mb["last_name"],
            "status": mb["status"],
            "plan_name": plan_name,
            "streak": streak,
            "longest_streak": longest_streak,
            "total_workout_hours": total_hours,
            "total_workout_formatted": total_workout_formatted,
            "avg_duration_minutes": avg_minutes,
            "max_duration_minutes": max_minutes,
            "weekly_visits": weekly_visits,
            "monthly_visits": monthly_visits,
            "yearly_visits": yearly_visits,
            "weekly_rank": weekly_rank,
            "monthly_rank": monthly_rank,
            "all_time_rank": all_time_rank,
            "points": points,
            "today_status": today_status,
            "logs": logs,
            "insights": insights,
            "achievements": achievements,
            "chart_visits_by_dow": visits_by_dow,
            "chart_hours_by_week": workout_hours_by_week,
            "leaderboard_weekly": leaderboard_weekly,
            "leaderboard_monthly": leaderboard_monthly,
            "leaderboard_all": leaderboard_all
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()
@app.route("/api/member/qr-token", methods=["GET"])
@login_required("member")
def member_get_qr_token():
    conn = database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT value FROM settings WHERE key = 'qr_token' AND gym_id = ?", (session["gym_id"],))
    row = cursor.fetchone()
    conn.close()
    return jsonify({"qr_token": row["value"] if row else None})

@app.route("/api/member/attendance/active", methods=["GET"])
@login_required("member")
def member_get_active_attendance():
    m_id = session.get("member_id")
    if not m_id:
        return jsonify({"error": "Member session not found"}), 401
    
    gym_id = session["gym_id"]
    today_str = now_ist().strftime("%Y-%m-%d")
    
    conn = database.get_db_connection()
    cursor = conn.cursor()
    
    # 1. Check for currently active session (checked in, not checked out yet)
    cursor.execute("""
        SELECT id, check_in_time, check_out_time, attendance_date, attendance_state, gym_id
        FROM attendance
        WHERE member_id = ? AND status = 'success' AND check_in_time::date = ? AND check_out_time IS NULL
        ORDER BY check_in_time DESC LIMIT 1
    """, (m_id, today_str))
    active_att = cursor.fetchone()
    
    if active_att:
        conn.close()
        return jsonify({
            "state": "checked_in",
            "server_time": now_ist().strftime("%Y-%m-%d %H:%M:%S"),
            "session": {
                "id": active_att["id"],
                "check_in_time": active_att["check_in_time"],
                "attendance_date": active_att["attendance_date"],
                "gym_id": active_att["gym_id"]
            }
        })
        
    # 2. Check if member completed a session today
    cursor.execute("""
        SELECT id, check_in_time, check_out_time, attendance_date, attendance_state, gym_id
        FROM attendance
        WHERE member_id = ? AND status = 'success' AND check_in_time::date = ? AND check_out_time IS NOT NULL
        ORDER BY check_out_time DESC LIMIT 1
    """, (m_id, today_str))
    completed_att = cursor.fetchone()
    
    conn.close()
    
    if completed_att:
        in_t = datetime.strptime(completed_att["check_in_time"], "%Y-%m-%d %H:%M:%S")
        out_t = datetime.strptime(completed_att["check_out_time"], "%Y-%m-%d %H:%M:%S")
        diff = int((out_t - in_t).total_seconds() / 60)
        hours = diff // 60
        mins = diff % 60
        duration_str = f"{hours}h {mins}m" if hours > 0 else f"{mins}m"
        
        return jsonify({
            "state": "completed",
            "server_time": now_ist().strftime("%Y-%m-%d %H:%M:%S"),
            "session": {
                "id": completed_att["id"],
                "check_in_time": completed_att["check_in_time"],
                "check_out_time": completed_att["check_out_time"],
                "duration": duration_str,
                "attendance_date": completed_att["attendance_date"]
            }
        })
        
    return jsonify({
        "state": "not_checked_in",
        "server_time": now_ist().strftime("%Y-%m-%d %H:%M:%S"),
        "session": None
    })

@app.route("/api/member/check-out", methods=["POST"])
@login_required("member")
def member_direct_check_out():
    m_id = session.get("member_id")
    gym_id = session["gym_id"]
    today_str = now_ist().strftime("%Y-%m-%d")
    now_time_str = now_ist().strftime("%Y-%m-%d %H:%M:%S")
    
    conn = database.get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT first_name, last_name FROM members WHERE id = ?", (m_id,))
    mbr = cursor.fetchone()
    if not mbr:
        conn.close()
        return jsonify({"error": "Member records not found."}), 404
        
    cursor.execute("""
        SELECT id, check_in_time FROM attendance
        WHERE member_id = ? AND status = 'success' AND check_in_time::date = ? AND check_out_time IS NULL
        ORDER BY check_in_time DESC LIMIT 1
    """, (m_id, today_str))
    active_att = cursor.fetchone()
    
    if not active_att:
        conn.close()
        return jsonify({"error": "No active check-in session found to check out."}), 400
        
    try:
        cursor.execute("""
            UPDATE attendance
            SET check_out_time = ?, attendance_state = 'completed'
            WHERE id = ?
        """, (now_time_str, active_att["id"]))
        conn.commit()
        
        in_t = datetime.strptime(active_att["check_in_time"], "%Y-%m-%d %H:%M:%S")
        out_t = datetime.strptime(now_time_str, "%Y-%m-%d %H:%M:%S")
        diff = int((out_t - in_t).total_seconds() / 60)
        hours = diff // 60
        mins = diff % 60
        duration_str = f"{hours}h {mins}m" if hours > 0 else f"{mins}m"
        
        fullname = f"{mbr['first_name']} {mbr['last_name']}"
        broadcast_event("CHECKOUT_SUCCESS", {
            "member_id": m_id,
            "name": fullname,
            "check_in": active_att["check_in_time"],
            "check_out": now_time_str,
            "duration": duration_str
        }, gym_id)
        
        return jsonify({
            "success": True,
            "type": "checkout",
            "check_in_time": active_att["check_in_time"],
            "check_out_time": now_time_str,
            "duration": duration_str,
            "message": f"Great job today, {mbr['first_name']}!"
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()

@app.route("/api/member/check-in", methods=["POST"])
@app.route("/api/member/attendance/scan", methods=["POST"])
@login_required("member")
def member_check_in():
    data = request.get_json() or {}
    qr_token = data.get("qr_token")
    action = data.get("action", "scan")
    m_id = session.get("member_id")
    
    if not qr_token:
        return jsonify({"error": "Scan is empty. Access details missing."}), 400
        
    gym_id = session["gym_id"]
    conn = database.get_db_connection()
    cursor = conn.cursor()

    # 1. Fetch current gymapp settings qr token
    cursor.execute("SELECT value FROM settings WHERE key = 'qr_token' AND gym_id = ?", (gym_id,))
    row = cursor.fetchone()
    expected_token = row["value"] if row else None

    if qr_token != expected_token:
        conn.close()
        return jsonify({"error": "Invalid Gym QR code scanned."}), 400

    # Get user profile status
    cursor.execute("SELECT first_name, last_name, status, user_id FROM members WHERE id = ?", (m_id,))
    mbr = cursor.fetchone()
    if not mbr:
        conn.close()
        return jsonify({"error": "Member records not found."}), 404

    # Edge case: suspended account
    if mbr["status"] == "suspended":
        cursor.execute("INSERT INTO attendance (member_id, status, error_msg, gym_id) VALUES (?, 'failed', 'Account suspended', ?)", (m_id, gym_id))
        conn.commit()
        conn.close()
        return jsonify({"error": "Check-in failed. Member is suspended."}), 403
    elif mbr["status"] == "pending":
        conn.close()
        return jsonify({"error": "Check-in failed. Member registration is pending approval."}), 403
    elif mbr["status"] == "rejected":
        conn.close()
        return jsonify({"error": "Check-in failed. Member registration was rejected."}), 403

    # Edge case: expired profile
    today_str = now_ist().strftime("%Y-%m-%d")
    cursor.execute("""
        SELECT * FROM memberships
        WHERE member_id = ? AND status = 'active' AND end_date >= ?
    """, (m_id, today_str))
    active_m = cursor.fetchone()

    if not active_m:
        # Mark member expired if it was active
        if mbr["status"] == "active":
            cursor.execute("UPDATE members SET status = 'expired' WHERE id = ?", (m_id,))

        cursor.execute("INSERT INTO attendance (member_id, status, error_msg, gym_id) VALUES (?, 'failed', 'Membership expired', ?)", (m_id, gym_id))
        conn.commit()
        conn.close()
        return jsonify({"error": "Check-in failed. Membership has expired."}), 403
        
    # Check if they already completed a session today
    cursor.execute("""
        SELECT id FROM attendance
        WHERE member_id = ? AND status = 'success' AND check_in_time::date = ? AND check_out_time IS NOT NULL
        LIMIT 1
    """, (m_id, today_str))
    completed_today = cursor.fetchone()
    if completed_today:
        conn.close()
        return jsonify({
            "completed_today": True,
            "message": "You have already completed your workout for today."
        }), 409

    cursor.execute("""
        SELECT id, check_in_time, check_out_time, attendance_state FROM attendance
        WHERE member_id = ? AND status = 'success' AND check_in_time::date = ? AND check_out_time IS NULL
        ORDER BY check_in_time DESC LIMIT 1
    """, (m_id, today_str))
    latest_att = cursor.fetchone()

    now_time_str = now_ist().strftime("%Y-%m-%d %H:%M:%S")

    if latest_att and action != "checkout":
        conn.close()
        return jsonify({
            "requires_checkout_confirmation": True,
            "check_in_time": latest_att["check_in_time"],
            "message": "You already checked in today. Do you want to check out now?"
        }), 409

    if action == "checkout" and not latest_att:
        conn.close()
        return jsonify({"error": "There is no active check-in to check out."}), 409

    try:
        if latest_att:
            cursor.execute("""
                UPDATE attendance 
                SET check_out_time = ?, attendance_state = 'completed'
                WHERE id = ?
            """, (now_time_str, latest_att["id"]))
            conn.commit()
            
            in_t = datetime.strptime(latest_att["check_in_time"], "%Y-%m-%d %H:%M:%S")
            out_t = datetime.strptime(now_time_str, "%Y-%m-%d %H:%M:%S")
            diff = int((out_t - in_t).total_seconds() / 60)
            hours = diff // 60
            mins = diff % 60
            duration_str = f"{hours}h {mins}m" if hours > 0 else f"{mins}m"
            
            fullname = f"{mbr['first_name']} {mbr['last_name']}"
            broadcast_event("CHECKOUT_SUCCESS", {
                "member_id": m_id,
                "name": fullname,
                "check_in": latest_att["check_in_time"],
                "check_out": now_time_str,
                "duration": duration_str
            }, gym_id)
            
            return jsonify({
                "success": True,
                "type": "checkout",
                "check_in_time": latest_att["check_in_time"],
                "check_out_time": now_time_str,
                "duration": duration_str,
                "message": f"Great job today, {mbr['first_name']}!"
            })
        else:
            cursor.execute("""
                INSERT INTO attendance (member_id, check_in_time, attendance_date, gym_id, attendance_state, status)
                VALUES (?, ?, ?, ?, 'checked_in', 'success')
            """, (m_id, now_time_str, today_str, gym_id))
            check_and_record_win_back_recovery(cursor, m_id, gym_id)
            conn.commit()
            
            fullname = f"{mbr['first_name']} {mbr['last_name']}"
            broadcast_event("CHECKIN_SUCCESS", {
                "member_id": m_id,
                "name": fullname,
                "time": now_time_str
            }, gym_id)
            
            return jsonify({
                "success": True,
                "type": "checkin",
                "check_in_time": now_time_str,
                "message": f"Have a great workout, {mbr['first_name']}! 💪"
            })
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()

@app.route("/api/member/emergency-contacts", methods=["GET", "POST"])
@login_required("member")
def member_emergency_contacts():
    member_id, gym_id = session.get("member_id"), session.get("gym_id")
    if not member_id or not gym_id:
        return jsonify({"error": "Member session not found"}), 401
    conn = database.get_db_connection()
    cursor = conn.cursor()
    try:
        if request.method == "GET":
            # 1. Fetch Primary Contact from member profile
            cursor.execute("SELECT emergency_contact_name, emergency_contact_number, emergency_contact_relation FROM members WHERE id = ? AND gym_id = ?", (member_id, gym_id))
            m_row = cursor.fetchone()
            contacts = []
            if m_row and m_row["emergency_contact_name"] and m_row["emergency_contact_number"]:
                contacts.append({
                    "id": "primary",
                    "name": m_row["emergency_contact_name"],
                    "phone": m_row["emergency_contact_number"],
                    "relationship": m_row["emergency_contact_relation"] or "",
                    "contact_type": "primary"
                })
            # 2. Fetch Secondary Contact(s) from emergency_contacts table
            cursor.execute("SELECT id, name, phone, relationship FROM emergency_contacts WHERE member_id = ? AND gym_id = ? AND contact_type = 'secondary' ORDER BY id ASC", (member_id, gym_id))
            for row in cursor.fetchall():
                contacts.append({
                    "id": row["id"],
                    "name": row["name"],
                    "phone": row["phone"],
                    "relationship": row["relationship"] or "",
                    "contact_type": "secondary"
                })
            return jsonify({"success": True, "contacts": contacts})

        data = request.get_json() or {}
        name, phone = (data.get("name") or "").strip(), (data.get("phone") or "").strip()
        relationship = (data.get("relationship") or "").strip() or None
        if not name or not phone:
            return jsonify({"error": "Contact name and phone number are required"}), 400

        # Enforce max 2 contacts limit
        cursor.execute("SELECT COUNT(*) FROM emergency_contacts WHERE member_id = ? AND gym_id = ? AND contact_type = 'secondary'", (member_id, gym_id))
        sec_count = cursor.fetchone()[0]
        if sec_count >= 1:
            return jsonify({"error": "You can add a maximum of 2 emergency contacts."}), 400

        cursor.execute("INSERT INTO emergency_contacts (member_id, gym_id, name, phone, relationship, contact_type) VALUES (?, ?, ?, ?, ?, 'secondary')", (member_id, gym_id, name, phone, relationship))
        contact_id = cursor.lastrowid
        log_action(cursor, "emergency_contact_added", "emergency_contact", contact_id, {"member_id": member_id}, gym_id)
        conn.commit()
        return jsonify({"success": True, "id": contact_id}), 201
    except Exception as e:
        conn.rollback()
        return jsonify({"error": f"Unable to save emergency contact: {str(e)}"}), 500
    finally:
        conn.close()

@app.route("/api/member/emergency-contacts/<contact_id>", methods=["PUT", "DELETE"])
@login_required("member")
def member_emergency_contact_detail(contact_id):
    member_id, gym_id = session.get("member_id"), session.get("gym_id")
    conn = database.get_db_connection()
    cursor = conn.cursor()
    try:
        if contact_id == "primary":
            if request.method == "DELETE":
                return jsonify({"error": "The primary contact cannot be deleted directly. Please replace it or promote the secondary contact."}), 400
            
            data = request.get_json() or {}
            name, phone = (data.get("name") or "").strip(), (data.get("phone") or "").strip()
            relationship = (data.get("relationship") or "").strip() or None
            if not name or not phone:
                return jsonify({"error": "Contact name and phone number are required"}), 400
            
            legacy = f"{name} / {phone}"
            cursor.execute("""
                UPDATE members 
                SET emergency_contact = ?, emergency_contact_name = ?, emergency_contact_number = ?, emergency_contact_relation = ? 
                WHERE id = ? AND gym_id = ?
            """, (legacy, name, phone, relationship, member_id, gym_id))
            action = "emergency_contact_updated"
            logged_id = 0
        else:
            try:
                c_id = int(contact_id)
            except ValueError:
                return jsonify({"error": "Invalid contact ID"}), 400
            
            cursor.execute("SELECT id FROM emergency_contacts WHERE id = ? AND member_id = ? AND gym_id = ? AND contact_type = 'secondary'", (c_id, member_id, gym_id))
            if not cursor.fetchone():
                return jsonify({"error": "Emergency contact not found"}), 404
            
            if request.method == "DELETE":
                cursor.execute("DELETE FROM emergency_contacts WHERE id = ? AND member_id = ? AND gym_id = ? AND contact_type = 'secondary'", (c_id, member_id, gym_id))
                action = "emergency_contact_deleted"
            else:
                data = request.get_json() or {}
                name, phone = (data.get("name") or "").strip(), (data.get("phone") or "").strip()
                relationship = (data.get("relationship") or "").strip() or None
                if not name or not phone:
                    return jsonify({"error": "Contact name and phone number are required"}), 400
                cursor.execute("UPDATE emergency_contacts SET name = ?, phone = ?, relationship = ?, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ? AND member_id = ? AND gym_id = ? AND contact_type = 'secondary'", (name, phone, relationship, c_id, member_id, gym_id))
                action = "emergency_contact_updated"
            logged_id = c_id
            
        log_action(cursor, action, "emergency_contact", logged_id, {"member_id": member_id}, gym_id)
        conn.commit()
        return jsonify({"success": True})
    except Exception as e:
        conn.rollback()
        return jsonify({"error": f"Unable to modify emergency contact: {str(e)}"}), 500
    finally:
        conn.close()

@app.route("/api/member/profile", methods=["PUT"])
@login_required("member")
def member_update_profile():
    data = request.get_json() or {}
    m_id = session.get("member_id")

    # Photo update handling
    photo_provided = "profile_photo" in data
    photo = data.get("profile_photo")
    if photo_provided and photo and len(photo) > 3_000_000:
        return jsonify({"error": "Image is too large. Please choose a photo under 2 MB."}), 400

    # DOB validation only if DOB is explicitly provided
    dob_provided = "dob" in data
    dob = None
    dob_has_value = False
    if dob_provided and data.get("dob") is not None and str(data.get("dob")).strip() != "":
        dob, dob_error = parse_and_validate_dob(data.get("dob"))
        if dob_error:
            return jsonify({"error": dob_error}), 400
        dob_has_value = True

    phone = data.get("phone")
    first_name = (data.get("first_name") or "").strip()
    last_name = (data.get("last_name") or "").strip()
    emergency_name = data.get("emergency_contact_name")
    emergency_number = data.get("emergency_contact_number")
    emergency_relation = data.get("emergency_contact_relation")
    legacy_emergency = data.get("emergency_contact")
    
    if (emergency_name is None and emergency_number is None) and legacy_emergency is not None:
        if "/" in legacy_emergency:
            parts = legacy_emergency.split("/", 1)
            emergency_name = parts[0].strip()
            emergency_number = parts[1].strip()
        else:
            emergency_name = ""
            emergency_number = legacy_emergency.strip()
            
    if legacy_emergency is None:
        if emergency_name and emergency_number:
            legacy_emergency = f"{emergency_name} / {emergency_number}"
        elif emergency_number:
            legacy_emergency = emergency_number
        else:
            legacy_emergency = ""

    conn = database.get_db_connection()
    cursor = conn.cursor()

    if not phone:
        cursor.execute("SELECT phone FROM members WHERE id = ? AND gym_id = ?", (m_id, session["gym_id"]))
        existing_row = cursor.fetchone()
        if existing_row:
            phone = existing_row["phone"] or ""

    if not phone and not photo_provided:
        conn.close()
        return jsonify({"error": "Phone number is required"}), 400

    try:
        cursor.execute("""
            UPDATE members
            SET first_name = COALESCE(NULLIF(?, ''), first_name),
                last_name = COALESCE(NULLIF(?, ''), last_name),
                phone = COALESCE(NULLIF(?, ''), phone),
                dob = CASE WHEN ? THEN ? ELSE dob END,
                emergency_contact = COALESCE(NULLIF(?, ''), emergency_contact),
                emergency_contact_name = COALESCE(NULLIF(?, ''), emergency_contact_name),
                emergency_contact_number = COALESCE(NULLIF(?, ''), emergency_contact_number),
                emergency_contact_relation = COALESCE(?, emergency_contact_relation),
                profile_photo = CASE WHEN ? THEN ? ELSE profile_photo END
            WHERE id = ? AND gym_id = ?
        """, (first_name, last_name, phone, dob_has_value, dob, legacy_emergency, emergency_name,
               emergency_number, emergency_relation, photo_provided, photo, m_id, session["gym_id"]))
        log_action(cursor, "member_profile_updated_self", "member", m_id, {"phone": phone})
        conn.commit()

        broadcast_event("MEMBER_PROFILE_UPDATED", {"id": m_id, "phone": phone, "profile_photo": photo}, session["gym_id"])
        return jsonify({"success": True, "profile_photo": photo})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()

@app.route("/api/member/preferences", methods=["POST"])
@login_required("member")
def member_save_preferences():
    m_id = session.get("member_id")
    if not m_id:
        return jsonify({"error": "Member session not found"}), 401
        
    data = request.get_json() or {}
    if not (data.get("dob") or "").strip():
        return jsonify({"error": "Date of birth is required."}), 400
    dob, dob_error = parse_and_validate_dob(data.get("dob"))
    if dob_error:
        return jsonify({"error": dob_error}), 400

    conn = database.get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("""
            UPDATE members
            SET preferences_completed = TRUE, dob = ?, gender = ?, height = ?, weight = ?
            WHERE id = ? AND gym_id = ?
        """, (dob, data.get("gender"), data.get("height"), data.get("weight"), m_id, session["gym_id"]))
        log_action(cursor, "member_preferences_completed", "member", m_id, data)

        # Create initial body_stats record if height/weight provided
        weight = data.get("weight")
        height_val = data.get("height")
        if weight and height_val:
            cursor.execute("""
                INSERT INTO body_stats (member_id, weight, height, goal_weight, gym_id)
                VALUES (?, ?, ?, NULL, ?)
            """, (m_id, float(weight), float(height_val), session["gym_id"]))

        conn.commit()
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()

@app.route("/api/member/password", methods=["PUT"])
@login_required("member")
def member_change_password():
    data = request.get_json() or {}
    current_password = data.get("current_password") or ""
    new_password = data.get("new_password") or ""
    if len(new_password) < 8:
        return jsonify({"error": "New password must be at least 8 characters"}), 400
    conn = database.get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT password_hash FROM users WHERE id = ? AND gym_id = ?", (session["user_id"], session["gym_id"]))
        user = cursor.fetchone()
        if not user or not database.verify_password(user["password_hash"], current_password):
            return jsonify({"error": "Current password is incorrect"}), 400
        cursor.execute("UPDATE users SET password_hash = ? WHERE id = ? AND gym_id = ?", (database.hash_password(new_password), session["user_id"], session["gym_id"]))
        log_action(cursor, "member_password_changed", "user", session["user_id"], gym_id=session["gym_id"])
        conn.commit()
        return jsonify({"success": True})
    except Exception as e:
        conn.rollback()
        return jsonify({"error": "Unable to update password"}), 500
    finally:
        conn.close()

@app.route("/api/member/body-stats", methods=["GET"])
@login_required("member")
def get_member_body_stats():
    m_id = session.get("member_id")
    if not m_id:
        return jsonify({"error": "Member session not found"}), 401
    
    conn = database.get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("""
            SELECT id, weight, height, goal_weight, created_at 
            FROM body_stats 
            WHERE member_id = ? AND gym_id = ?
            ORDER BY created_at ASC
        """, (m_id, session["gym_id"]))
        rows = cursor.fetchall()
        
        # Backfill from audit log details if body_stats is empty
        if not rows:
            cursor.execute("""
                SELECT details, created_at FROM audit_log 
                WHERE entity_type = 'member' AND entity_id = ? AND action = 'member_preferences_completed'
                ORDER BY created_at DESC LIMIT 1
            """, (m_id,))
            audit_row = cursor.fetchone()
            if audit_row:
                import json
                try:
                    details = json.loads(audit_row["details"])
                    weight_val = details.get("weight")
                    height_val = details.get("height")
                    if weight_val and height_val:
                        cursor.execute("""
                            INSERT INTO body_stats (member_id, weight, height, goal_weight, gym_id, created_at)
                            VALUES (?, ?, ?, NULL, ?, ?)
                        """, (m_id, float(weight_val), float(height_val), session["gym_id"], audit_row["created_at"]))
                        conn.commit()
                        
                        cursor.execute("""
                            SELECT id, weight, height, goal_weight, created_at 
                            FROM body_stats 
                            WHERE member_id = ? AND gym_id = ?
                            ORDER BY created_at ASC
                        """, (m_id, session["gym_id"]))
                        rows = cursor.fetchall()
                except Exception as e:
                    print("Error parsing audit log for stats backfill:", e)
        
        stats_list = [dict(r) for r in rows]
        return jsonify({"success": True, "stats": stats_list})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()

@app.route("/api/member/body-stats", methods=["POST"])
@login_required("member")
def add_member_body_stats():
    m_id = session.get("member_id")
    if not m_id:
        return jsonify({"error": "Member session not found"}), 401
        
    data = request.get_json() or {}
    weight = data.get("weight") # in kg
    height = data.get("height") # in cm
    goal_weight = data.get("goal_weight") # in kg (optional)
    
    if weight is None or height is None:
        return jsonify({"error": "Weight and height are required"}), 400
        
    conn = database.get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("""
            INSERT INTO body_stats (member_id, weight, height, goal_weight, gym_id)
            VALUES (?, ?, ?, ?, ?)
        """, (m_id, float(weight), float(height), float(goal_weight) if goal_weight is not None else None, session["gym_id"]))
        conn.commit()
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()

@app.route("/api/member/notifications/read", methods=["POST"])
@login_required("member")
def member_read_notifications():
    user_id = session["user_id"]
    conn = database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE notifications SET read_status = 1 WHERE user_id = ?", (user_id,))
    conn.commit()
    conn.close()
    return jsonify({"success": True})

# ================= REVENUE ANALYTICS SERVICE =================

class AnalyticsService:
    @staticmethod
    def get_overview(gym_id):
        conn = database.get_db_connection()
        cursor = conn.cursor()
        
        # 1. Lifetime Revenue
        cursor.execute("SELECT SUM(amount) FROM payments WHERE status = 'paid' AND gym_id = ?", (gym_id,))
        lifetime_revenue = cursor.fetchone()[0] or 0.0
        
        # 2. This Month Revenue
        now_dt = now_ist()
        this_month_start = now_dt.strftime("%Y-%m-01 00:00:00")
        if now_dt.month == 12:
            next_month_start = f"{now_dt.year + 1}-01-01 00:00:00"
        else:
            next_month_start = f"{now_dt.year}-{str(now_dt.month + 1).zfill(2)}-01 00:00:00"
            
        cursor.execute("SELECT SUM(amount) FROM payments WHERE status = 'paid' AND payment_date >= ? AND payment_date < ? AND gym_id = ?", (this_month_start, next_month_start, gym_id))
        this_month_revenue = cursor.fetchone()[0] or 0.0
        
        # 3. Last Month Revenue
        if now_dt.month == 1:
            last_month_start = f"{now_dt.year - 1}-12-01 00:00:00"
            last_month_end = f"{now_dt.year}-01-01 00:00:00"
        else:
            last_month_start = f"{now_dt.year}-{str(now_dt.month - 1).zfill(2)}-01 00:00:00"
            last_month_end = this_month_start
            
        cursor.execute("SELECT SUM(amount) FROM payments WHERE status = 'paid' AND payment_date >= ? AND payment_date < ? AND gym_id = ?", (last_month_start, last_month_end, gym_id))
        last_month_revenue = cursor.fetchone()[0] or 0.0
        
        # 4. Growth Rate
        if last_month_revenue > 0:
            growth_rate = round(((this_month_revenue - last_month_revenue) / last_month_revenue) * 100, 1)
        else:
            growth_rate = 100.0 if this_month_revenue > 0 else 0.0
            
        # 5. Average Monthly Revenue (Last 12 months)
        cursor.execute("""
            SELECT AVG(month_sum) FROM (
                SELECT TO_CHAR(payment_date::timestamp, 'YYYY-MM') as month, SUM(amount) as month_sum
                FROM payments
                WHERE status = 'paid' AND gym_id = ?
                  AND payment_date::date >= CURRENT_DATE - INTERVAL '12 months'
                GROUP BY month
            ) sub
        """, (gym_id,))
        avg_monthly_rev = cursor.fetchone()[0] or 0.0
        
        # 6. Active Members
        cursor.execute("SELECT COUNT(*) FROM members WHERE status = 'active' AND gym_id = ?", (gym_id,))
        active_members = cursor.fetchone()[0] or 0
        
        # 7. ARPU (Revenue / Active Members)
        arpu = round(this_month_revenue / active_members, 1) if active_members > 0 else 0.0
        
        # 8. Outstanding Dues
        cursor.execute("SELECT SUM(amount) FROM payments WHERE status IN ('pending', 'overdue') AND gym_id = ?", (gym_id,))
        outstanding_dues = cursor.fetchone()[0] or 0.0
        
        # 9. Collection Rate (Paid / Expected) for this month
        cursor.execute("""
            SELECT SUM(amount) FROM payments 
            WHERE status IN ('pending', 'overdue') 
              AND due_date >= ? AND due_date < ? AND gym_id = ?
        """, (this_month_start, next_month_start, gym_id))
        outstanding_due_this_month = cursor.fetchone()[0] or 0.0
        
        expected_this_month = this_month_revenue + outstanding_due_this_month
        if expected_this_month > 0:
            collection_rate = round((this_month_revenue / expected_this_month) * 100, 1)
        else:
            collection_rate = 100.0
            
        # 10. Last 12 Months Revenue Trend
        cursor.execute("""
            SELECT TO_CHAR(payment_date::timestamp, 'YYYY-MM') as month, SUM(amount) as revenue
            FROM payments
            WHERE status = 'paid' AND gym_id = ?
              AND payment_date::date >= CURRENT_DATE - INTERVAL '12 months'
            GROUP BY month
            ORDER BY month ASC
        """, (gym_id,))
        monthly_trend = [dict(row) for row in cursor.fetchall()]
        
        # 11. Plan Breakdown
        cursor.execute("""
            SELECT pl.name as plan_name, SUM(p.amount) as revenue
            FROM payments p
            JOIN memberships ms ON p.membership_id = ms.id
            JOIN plans pl ON ms.plan_id = pl.id
            WHERE p.status = 'paid' AND p.gym_id = ?
            GROUP BY plan_name
        """, (gym_id,))
        plan_breakdown = [dict(row) for row in cursor.fetchall()]
        
        # 12. Payment Method Analytics
        cursor.execute("""
            SELECT COALESCE(payment_method, 'online') as method, SUM(amount) as revenue, COUNT(*) as cnt
            FROM payments
            WHERE status = 'paid' AND gym_id = ?
            GROUP BY method
        """, (gym_id,))
        method_rows = cursor.fetchall()
        total_payment_count = sum(r["cnt"] for r in method_rows) or 1
        payment_methods = []
        for r in method_rows:
            payment_methods.append({
                "method": r["method"],
                "revenue": r["revenue"],
                "percentage": round((r["cnt"] / total_payment_count) * 100, 1)
            })
            
        # 13. Membership Analytics
        cursor.execute("""
            SELECT status, COUNT(*) as count FROM members
            WHERE gym_id = ? AND status NOT IN ('pending', 'rejected')
            GROUP BY status
        """, (gym_id,))
        membership_breakdown = {row["status"]: row["count"] for row in cursor.fetchall()}
        
        # 14. Top Performing Months
        cursor.execute("""
            SELECT TO_CHAR(payment_date::timestamp, 'YYYY-MM') as month, SUM(amount) as revenue
            FROM payments
            WHERE status = 'paid' AND gym_id = ?
            GROUP BY month
            ORDER BY revenue DESC LIMIT 3
        """, (gym_id,))
        top_months = [dict(row) for row in cursor.fetchall()]

        # 15. Dynamic Business Insights
        insights = []
        
        cursor.execute("""
            SELECT SUM(amount) FROM payments 
            WHERE status IN ('pending', 'overdue')
              AND due_date >= ? AND due_date < ? AND gym_id = ?
        """, (last_month_start, last_month_end, gym_id))
        last_month_dues = cursor.fetchone()[0] or 0.0
        if last_month_dues > 0:
            due_growth = round(((outstanding_due_this_month - last_month_dues) / last_month_dues) * 100, 1)
            if due_growth > 5:
                insights.append({
                    "type": "warning",
                    "title": "Pending dues increased",
                    "text": f"Pending dues increased by {due_growth}% compared to last month. Consider sending payment reminders."
                })
                
        if growth_rate > 0:
            insights.append({
                "type": "success",
                "title": "Revenue Increased",
                "text": f"Revenue increased by {growth_rate}% compared to last month. Keep up the high renewal numbers!"
            })
        elif growth_rate < 0:
            insights.append({
                "type": "warning",
                "title": "Revenue Declined",
                "text": f"Revenue declined by {abs(growth_rate)}% compared to last month. Focus on expiring memberships."
            })
            
        cursor.execute("""
            SELECT TO_CHAR(check_in_time::timestamp, 'FMDay') as day_of_week, COUNT(*) as cnt
            FROM attendance
            WHERE status = 'success' AND gym_id = ?
              AND check_in_time::date >= CURRENT_DATE - INTERVAL '30 days'
            GROUP BY day_of_week
            ORDER BY cnt ASC
        """, (gym_id,))
        day_rows = cursor.fetchall()
        if day_rows:
            lowest_day = day_rows[0]["day_of_week"].strip()
            insights.append({
                "type": "info",
                "title": "Attendance Insights",
                "text": f"Attendance is lowest on {lowest_day}s. Consider running a challenge or promotion on {lowest_day}s."
            })
            
        today = now_ist().strftime("%Y-%m-%d")
        next_week = (now_ist() + timedelta(days=7)).strftime("%Y-%m-%d")
        cursor.execute("""
            SELECT COUNT(*) FROM memberships
            WHERE status = 'active' AND end_date >= ? AND end_date <= ? AND gym_id = ?
        """, (today, next_week, gym_id))
        due_soon_cnt = cursor.fetchone()[0] or 0
        if due_soon_cnt > 0:
            insights.append({
                "type": "info",
                "title": "Renewal Reminder Opportunity",
                "text": f"{due_soon_cnt} memberships are due to expire within the next 7 days. Send renewal reminders today."
            })
            
        cursor.execute("SELECT COUNT(*) FROM win_back_recoveries WHERE gym_id = ? AND recovery_date >= ?", (gym_id, this_month_start))
        rec_cnt = cursor.fetchone()[0] or 0
        if rec_cnt > 0:
            insights.append({
                "type": "success",
                "title": "Recovery Campaign Working",
                "text": f"{rec_cnt} inactive members returned and checked in this month."
            })

        # 16. AI Recommendations Action Cards
        recommendations = []
        
        cursor.execute("SELECT COUNT(DISTINCT member_id) FROM payments WHERE status IN ('pending', 'overdue') AND gym_id = ?", (gym_id,))
        pending_members_cnt = cursor.fetchone()[0] or 0
        if outstanding_dues > 0:
            recommendations.append({
                "type": "recover_revenue",
                "title": "Recover Revenue",
                "text": f"Recover ₹{int(outstanding_dues):,} by contacting {pending_members_cnt} members with pending dues.",
                "button_text": "View Members",
                "tab": "pending-dues"
            })
            
        if due_soon_cnt > 0:
            recommendations.append({
                "type": "renew_memberships",
                "title": "Renew Memberships",
                "text": f"{due_soon_cnt} memberships expire this week. Send bulk renewal reminders now.",
                "button_text": "Send Reminders",
                "tab": "expiring-soon"
            })
            
        cursor.execute("""
            SELECT COUNT(distinct m.id) FROM members m
            LEFT JOIN (
                SELECT member_id, MAX(check_in_time) as max_time
                FROM attendance
                WHERE status = 'success' AND gym_id = ?
                GROUP BY member_id
            ) a ON m.id = a.member_id
            WHERE m.gym_id = ? AND m.status = 'active'
              AND (date_part('day', now() - COALESCE(a.max_time::timestamp, m.joined_at::timestamp)) >= 15)
        """, (gym_id, gym_id))
        win_back_cnt = cursor.fetchone()[0] or 0
        if win_back_cnt > 0:
            recommendations.append({
                "type": "win_back",
                "title": "Win Back Members",
                "text": f"{win_back_cnt} members haven't visited in 15 days. Initiate follow-up workflow.",
                "button_text": "Open Win Back",
                "tab": "win-back"
            })
            
        cursor.execute("""
            SELECT COUNT(distinct m.id) FROM members m
            JOIN memberships ms ON ms.member_id = m.id
            JOIN plans pl ON ms.plan_id = pl.id
            JOIN (
                SELECT member_id, COUNT(*) as visit_cnt 
                FROM attendance 
                WHERE status = 'success' AND check_in_time >= ? AND gym_id = ?
                GROUP BY member_id
            ) a ON m.id = a.member_id
            WHERE m.gym_id = ? AND ms.status = 'active' 
              AND pl.name ILIKE '%%monthly%%' AND a.visit_cnt >= 12
        """, (this_month_start, gym_id, gym_id))
        upsell_cnt = cursor.fetchone()[0] or 0
        if upsell_cnt > 0:
            recommendations.append({
                "type": "upsell",
                "title": "Upsell Opportunity",
                "text": f"{upsell_cnt} frequent monthly members qualify for annual value plans. Potential upside: ₹{upsell_cnt * 6000:,}",
                "button_text": "View Candidates",
                "tab": "members"
            })
            
        conn.close()
        
        return {
            "lifetime_revenue": lifetime_revenue,
            "this_month_revenue": this_month_revenue,
            "last_month_revenue": last_month_revenue,
            "growth_rate": growth_rate,
            "avg_monthly_revenue": avg_monthly_rev,
            "arpu": arpu,
            "outstanding_dues": outstanding_dues,
            "collection_rate": collection_rate,
            "monthly_trend": monthly_trend,
            "plan_breakdown": plan_breakdown,
            "payment_methods": payment_methods,
            "membership_breakdown": membership_breakdown,
            "top_months": top_months,
            "insights": insights,
            "recommendations": recommendations
        }

    @staticmethod
    def compare_months(gym_id, m1, m2):
        conn = database.get_db_connection()
        cursor = conn.cursor()
        
        metrics = {}
        for idx, m_str in enumerate([m1, m2], 1):
            m_start = f"{m_str}-01 00:00:00"
            if m_str.endswith("12"):
                y = int(m_str[:4])
                m_end = f"{y+1}-01-01 00:00:00"
            else:
                y = m_str[:4]
                m = str(int(m_str[5:]) + 1).zfill(2)
                m_end = f"{y}-{m}-01 00:00:00"
                
            cursor.execute("SELECT SUM(amount) FROM payments WHERE status = 'paid' AND payment_date >= ? AND payment_date < ? AND gym_id = ?", (m_start, m_end, gym_id))
            rev = cursor.fetchone()[0] or 0.0
            
            cursor.execute("SELECT COUNT(*) FROM members WHERE joined_at >= ? AND joined_at < ? AND gym_id = ?", (m_start, m_end, gym_id))
            new_m = cursor.fetchone()[0] or 0
            
            cursor.execute("SELECT COUNT(*) FROM payments WHERE status = 'paid' AND due_date >= ? AND due_date < ? AND gym_id = ?", (m_start, m_end, gym_id))
            ren = cursor.fetchone()[0] or 0
            
            cursor.execute("SELECT SUM(amount) FROM payments WHERE status = 'paid' AND payment_date >= ? AND payment_date < ? AND gym_id = ?", (m_start, m_end, gym_id))
            collected = cursor.fetchone()[0] or 0.0
            cursor.execute("SELECT SUM(amount) FROM payments WHERE status IN ('pending', 'overdue') AND due_date >= ? AND due_date < ? AND gym_id = ?", (m_start, m_end, gym_id))
            pending = cursor.fetchone()[0] or 0.0
            
            tot_exp = collected + pending
            rec_rate = round((collected / tot_exp) * 100, 1) if tot_exp > 0 else 100.0
            
            cursor.execute("SELECT COUNT(*) FROM attendance WHERE status = 'success' AND check_in_time >= ? AND check_in_time < ? AND gym_id = ?", (m_start, m_end, gym_id))
            att_cnt = cursor.fetchone()[0] or 0
            
            cursor.execute("""
                SELECT TO_CHAR(check_in_time::timestamp, 'YYYY-MM-DD') as d, COUNT(*) as cnt
                FROM attendance
                WHERE status = 'success' AND check_in_time >= ? AND check_in_time < ? AND gym_id = ?
                GROUP BY d
                ORDER BY cnt DESC LIMIT 1
            """, (m_start, m_end, gym_id))
            peak_row = cursor.fetchone()
            peak_day = peak_row["d"] if peak_row else "N/A"
            
            cursor.execute("SELECT COUNT(*) FROM win_back_recoveries WHERE recovery_date >= ? AND recovery_date < ? AND gym_id = ?", (m_start, m_end, gym_id))
            win_backs = cursor.fetchone()[0] or 0
            
            metrics[f"m{idx}"] = {
                "revenue": rev,
                "new_members": new_m,
                "renewals": ren,
                "collected": collected,
                "pending": pending,
                "recovery_rate": rec_rate,
                "attendance": att_cnt,
                "peak_day": peak_day,
                "win_backs": win_backs
            }
            
        conn.close()
        
        m1_data = metrics["m1"]
        m2_data = metrics["m2"]
        
        rev_diff = m2_data["revenue"] - m1_data["revenue"]
        rev_pct = round((rev_diff / m1_data["revenue"] * 100), 1) if m1_data["revenue"] > 0 else 100.0
        
        return {
            "m1": m1_data,
            "m2": m2_data,
            "comparison": {
                "revenue_diff": rev_diff,
                "revenue_pct": rev_pct,
                "new_members_diff": m2_data["new_members"] - m1_data["new_members"],
                "renewals_diff": m2_data["renewals"] - m1_data["renewals"],
                "collected_diff": m2_data["collected"] - m1_data["collected"],
                "pending_diff": m2_data["pending"] - m1_data["pending"],
                "attendance_diff": m2_data["attendance"] - m1_data["attendance"],
                "win_backs_diff": m2_data["win_backs"] - m1_data["win_backs"]
            }
        }

@app.route("/api/admin/analytics/overview", methods=["GET"])
@login_required("owner")
def admin_analytics_overview():
    try:
        gym_id = session["gym_id"]
        data = AnalyticsService.get_overview(gym_id)
        return jsonify(data)
    except Exception as e:
        app.logger.error(f"Error in analytics overview: {e}")
        return jsonify({"error": str(e)}), 500

@app.route("/api/admin/analytics/compare", methods=["GET"])
@login_required("owner")
def admin_analytics_compare():
    try:
        gym_id = session["gym_id"]
        m1 = request.args.get("month1", "").strip()
        m2 = request.args.get("month2", "").strip()
        if not m1 or not m2:
            return jsonify({"error": "month1 and month2 parameters are required"}), 400
        data = AnalyticsService.compare_months(gym_id, m1, m2)
        return jsonify(data)
    except Exception as e:
        app.logger.error(f"Error in analytics comparison: {e}")
        return jsonify({"error": str(e)}), 500

@app.route("/service-worker.js")
def serve_service_worker():
    return send_file(os.path.join(app.static_folder, "service-worker.js"), mimetype="application/javascript")

@app.route("/manifest.json")
def serve_manifest():
    return send_file(os.path.join(app.static_folder, "manifest.json"), mimetype="application/json")

# Start Flask server
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    # Keep the reloader opt-in so automated and production-style runs start once.
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"
    ssl_context = None
    if os.environ.get("HTTPS", "0") == "1":
        cert_file = os.environ.get("SSL_CERT_FILE", ".dev-certs/gymos-cert.pem")
        key_file = os.environ.get("SSL_KEY_FILE", ".dev-certs/gymos-key.pem")
        if not os.path.exists(cert_file) or not os.path.exists(key_file):
            raise RuntimeError("HTTPS is enabled but no development certificate was found. Run ./run_https.sh first.")
        ssl_context = (cert_file, key_file)
    # threaded=True: without it, Flask's dev server handles one request at a
    # time for the whole process - every static asset and API call during
    # page load queues behind whatever request is currently in flight.
    app.run(host="0.0.0.0", port=port, debug=debug, ssl_context=ssl_context, threaded=True)
