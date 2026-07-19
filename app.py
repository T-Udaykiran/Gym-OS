import os
import sys
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

# Global list of active SSE event queues
SSE_LISTENERS = []


def broadcast_event(event_type, payload):
    event_data = {
        "type": event_type,
        "payload": payload,
        "timestamp": now_ist().isoformat()
    }
    # Create copy of list to prevent modification during iteration
    for q in list(SSE_LISTENERS):
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

def log_action(cursor, action, entity_type=None, entity_id=None, details=None):
    """Write one audit_log row for a state-changing action.

    Snapshots the actor's email/role at write time (not just their id) and
    never references entity_type/entity_id via a foreign key, so the log
    entry survives even if the actor's account or the entity itself is
    later deleted - that's the whole point of an audit trail.
    """
    cursor.execute(
        "INSERT INTO audit_log (actor_user_id, actor_email, actor_role, action, entity_type, entity_id, details) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            session.get("user_id"),
            session.get("email"),
            session.get("role"),
            action,
            entity_type,
            entity_id,
            json.dumps(details) if details is not None else None,
        ),
    )

# Helper decorator for authentication & role protection
def login_required(role=None):
    def decorator(f):
        from functools import wraps
        @wraps(f)
        def wrapper(*args, **kwargs):
            if "user_id" not in session:
                return jsonify({"error": "Unauthorized. Please login."}), 401
            if role and session.get("role") != role:
                return jsonify({"error": "Forbidden. Insufficient permissions."}), 403
            return f(*args, **kwargs)
        return wrapper
    return decorator

@app.route("/")
def index():
    return send_file(os.path.join(app.static_folder, "index.html"))

# ================= AUTHENTICATION ENDPOINTS =================

@app.route("/api/auth/register", methods=["POST"])
def auth_register():
    data = request.get_json() or {}
    email = data.get("email")
    password = data.get("password")
    first_name = data.get("first_name")
    last_name = data.get("last_name") or ""
    phone = data.get("phone")
    emergency = data.get("emergency_contact")

    if not all([email, password, first_name, phone]):
        return jsonify({"error": "Missing required registration fields"}), 400

    conn = database.get_db_connection()
    cursor = conn.cursor()
    
    try:
        # Create User
        password_hash = database.hash_password(password)
        cursor.execute(
            "INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'member')",
            (email, password_hash)
        )
        user_id = cursor.lastrowid
        
        # Create Member (status default is 'pending' and requires owner approval)
        cursor.execute(
            "INSERT INTO members (user_id, first_name, last_name, phone, emergency_contact, status) VALUES (?, ?, ?, ?, ?, 'pending')",
            (user_id, first_name, last_name, phone, emergency)
        )
        member_id = cursor.lastrowid
        
        # Create a welcome notification
        cursor.execute(
            "INSERT INTO notifications (user_id, type, message) VALUES (?, 'welcome', ?)",
            (user_id, f"Welcome to GymOS, {first_name}! Access granted once approved. Please see the owner to purchase a membership plan.")
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
        })
        
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

@app.route("/api/auth/login", methods=["POST"])
def auth_login():
    data = request.get_json() or {}
    email = data.get("email")
    password = data.get("password")
    
    if not email or not password:
        return jsonify({"error": "Email and password are required"}), 400
        
    conn = database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT id, email, password_hash, role FROM users WHERE email = ?", (email,))
    user = cursor.fetchone()
    
    if not user or not database.verify_password(user["password_hash"], password):
        conn.close()
        return jsonify({"error": "Invalid email or password"}), 401
        
    user_id = user["id"]
    role = user["role"]
    
    member_id = None
    if role == "member":
        cursor.execute("SELECT id, status, first_name, last_name FROM members WHERE user_id = ?", (user_id,))
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
            
    session["user_id"] = user_id
    session["role"] = role
    session["email"] = user["email"]
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
            "member_id": member_id
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

    cursor.execute("SELECT id, role FROM users WHERE email = ?", (email,))
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
        cursor.execute("SELECT phone FROM gyms ORDER BY id LIMIT 1")
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
def sse_stream():
    def event_generator():
        q = queue.Queue()
        SSE_LISTENERS.append(q)
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
            if q in SSE_LISTENERS:
                SSE_LISTENERS.remove(q)
    return Response(event_generator(), mimetype="text/event-stream")

# ================= ADMIN STATS & ANALYTICS =================

@app.route("/api/admin/stats", methods=["GET"])
@login_required("owner")
def admin_stats():
    conn = database.get_db_connection()
    cursor = conn.cursor()
    
    # 1. Total Members
    cursor.execute("SELECT COUNT(*) FROM members WHERE status NOT IN ('pending', 'rejected')")
    t_members = cursor.fetchone()[0]
    
    # 2. Active Members (Active status and active membership duration)
    today = now_ist().strftime("%Y-%m-%d")
    cursor.execute("""
        SELECT COUNT(distinct member_id) FROM memberships 
        WHERE status = 'active' AND end_date >= ?
    """, (today,))
    act_members = cursor.fetchone()[0]
    
    # 3. Today's Checkins
    today_start = now_ist().strftime("%Y-%m-%d 00:00:00")
    cursor.execute("""
        SELECT COUNT(*) FROM attendance 
        WHERE status = 'success' AND check_in_time >= ?
    """, (today_start,))
    today_checkins = cursor.fetchone()[0]
    
    # 4. Today's Revenue
    cursor.execute("""
        SELECT SUM(amount) FROM payments 
        WHERE status = 'paid' AND payment_date >= ?
    """, (today_start,))
    today_revenue = cursor.fetchone()[0] or 0.0
    
    # 5. Monthly Revenue (Current Month)
    month_start = now_ist().strftime("%Y-%m-01 00:00:00")
    cursor.execute("""
        SELECT SUM(amount) FROM payments 
        WHERE status = 'paid' AND payment_date >= ?
    """, (month_start,))
    monthly_revenue = cursor.fetchone()[0] or 0.0
    
    # 6. Pending / Overdue Payments
    cursor.execute("SELECT COUNT(*), SUM(amount) FROM payments WHERE status IN ('pending', 'overdue')")
    row_pending = cursor.fetchone()
    pending_payments = row_pending[0] or 0
    pending_amount = row_pending[1] or 0.0

    # 6b. Pending Approval Payments
    cursor.execute("SELECT COUNT(*) FROM payments WHERE status = 'pending_approval'")
    pending_approvals = cursor.fetchone()[0] or 0
    
    # 7. Memberships Expiring (within 7 Days)
    next_week = (now_ist() + timedelta(days=7)).strftime("%Y-%m-%d")
    cursor.execute("""
        SELECT COUNT(*) FROM memberships 
        WHERE status = 'active' AND end_date >= ? AND end_date <= ?
    """, (today, next_week))
    expiring_members = cursor.fetchone()[0]
    
    # 8. New Members This Week
    week_start = (now_ist() - timedelta(days=7)).strftime("%Y-%m-%d %H:%M:%S")
    cursor.execute("SELECT COUNT(*) FROM members WHERE joined_at >= ? AND status NOT IN ('pending', 'rejected')", (week_start,))
    new_members_week = cursor.fetchone()[0]
    
    # 9. Chart Data: Monthly Revenue Last 6 Months
    revenue_chart = []
    for i in range(5, -1, -1):
        target_month = (now_ist() - timedelta(days=i*30))
        m_start = target_month.strftime("%Y-%m-01 00:00:00")
        m_end = (target_month + timedelta(days=31)).strftime("%Y-%m-01 00:00:00")
        m_label = target_month.strftime("%b")
        
        cursor.execute("SELECT SUM(amount) FROM payments WHERE status = 'paid' AND payment_date >= ? AND payment_date < ?", (m_start, m_end))
        rev = cursor.fetchone()[0] or 0.0
        revenue_chart.append({"month": m_label, "revenue": rev})
        
    # 10. Chart Data: Attendance Last 7 Days
    attendance_chart = []
    for i in range(6, -1, -1):
        target_day = (now_ist() - timedelta(days=i))
        d_start = target_day.strftime("%Y-%m-%d 00:00:00")
        d_end = target_day.strftime("%Y-%m-%d 23:59:59")
        d_label = target_day.strftime("%a")
        
        cursor.execute("SELECT COUNT(*) FROM attendance WHERE status = 'success' AND check_in_time >= ? AND check_in_time <= ?", (d_start, d_end))
        cnt = cursor.fetchone()[0]
        attendance_chart.append({"day": d_label, "count": cnt})
        
    # 11. Pending Payments List
    cursor.execute("""
        SELECT p.*, m.first_name, m.last_name, m.phone, pl.name as plan_name
        FROM payments p
        JOIN members m ON p.member_id = m.id
        LEFT JOIN memberships ms ON p.membership_id = ms.id
        LEFT JOIN plans pl ON ms.plan_id = pl.id
        WHERE p.status IN ('pending', 'overdue')
        ORDER BY p.due_date ASC LIMIT 5
    """)
    pending_payments_list = [dict(row) for row in cursor.fetchall()]
    
    # 12. Membership Expiring Soon List
    cursor.execute("""
        SELECT m.id as member_id, m.first_name, m.last_name, ms.end_date, pl.name as plan_name, p.id as payment_id
        FROM memberships ms
        JOIN members m ON ms.member_id = m.id
        LEFT JOIN plans pl ON ms.plan_id = pl.id
        LEFT JOIN payments p ON p.membership_id = ms.id AND p.status != 'paid'
        WHERE ms.status = 'active' AND ms.end_date >= ? AND ms.end_date <= ?
        ORDER BY ms.end_date ASC LIMIT 5
    """, (today, next_week))
    expiring_members_list = [dict(row) for row in cursor.fetchall()]
    
    # 13. New Members Recent Joiners List
    cursor.execute("""
        SELECT m.id, m.first_name, m.last_name, m.joined_at, pl.name as plan_name
        FROM members m
        LEFT JOIN memberships ms ON ms.member_id = m.id AND ms.status = 'active'
        LEFT JOIN plans pl ON ms.plan_id = pl.id
        WHERE m.status NOT IN ('pending', 'rejected')
        ORDER BY m.joined_at DESC LIMIT 5
    """)
    new_members_list = [dict(row) for row in cursor.fetchall()]
    
    # 14. Recent Activity Log
    cursor.execute("""
        SELECT a.id, m.first_name, m.last_name, a.check_in_time, a.status, a.error_msg 
        FROM attendance a
        JOIN members m ON a.member_id = m.id
        ORDER BY a.check_in_time DESC LIMIT 5
    """)
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
    cursor.execute("SELECT COUNT(*) FROM members WHERE status = 'pending'")
    pending_regs_count = cursor.fetchone()[0] or 0
    
    conn.close()
    
    return jsonify({
        "stats": {
            "total_members": t_members,
            "active_members": act_members,
            "today_checkins": today_checkins,
            "today_revenue": today_revenue,
            "monthly_revenue": monthly_revenue,
            "pending_payments": pending_payments,
            "pending_amount": pending_amount,
            "pending_approvals": pending_approvals,
            "expiring_members": expiring_members,
            "new_members_week": new_members_week,
            "pending_registrations_count": pending_regs_count,
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
        WHERE p.status IN ('pending', 'overdue')
        ORDER BY p.due_date ASC
    """)
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
        WHERE ms.status = 'active' AND ms.end_date >= ? AND ms.end_date <= ?
        ORDER BY ms.end_date ASC
    """, (today, next_week))
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
        WHERE m.status = 'pending'
        ORDER BY m.joined_at DESC
    """)
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
    cursor.execute("SELECT m.id, m.first_name, m.last_name, u.email FROM members m JOIN users u ON m.user_id = u.id WHERE m.id = ?", (id,))
    member = cursor.fetchone()
    if not member:
        conn.close()
        return jsonify({"error": "Member not found"}), 404
        
    try:
        cursor.execute("UPDATE members SET status = 'active' WHERE id = ?", (id,))
        fullname = f"{member['first_name']} {member['last_name']}"
        log_action(cursor, "member_approved", "member", id, {"name": fullname, "email": member["email"]})
        conn.commit()

        broadcast_event("MEMBER_STATUS_CHANGED", {
            "member_id": id,
            "status": "active",
            "name": fullname,
            "email": member["email"]
        })
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
    cursor.execute("SELECT m.id, m.first_name, m.last_name, u.email FROM members m JOIN users u ON m.user_id = u.id WHERE m.id = ?", (id,))
    member = cursor.fetchone()
    if not member:
        conn.close()
        return jsonify({"error": "Member not found"}), 404
        
    try:
        cursor.execute("UPDATE members SET status = 'rejected' WHERE id = ?", (id,))
        fullname = f"{member['first_name']} {member['last_name']}"
        log_action(cursor, "member_rejected", "member", id, {"name": fullname, "email": member["email"]})
        conn.commit()

        broadcast_event("MEMBER_STATUS_CHANGED", {
            "member_id": id,
            "status": "rejected",
            "name": fullname,
            "email": member["email"]
        })
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
        SELECT COUNT(*)
        FROM members m
        JOIN users u ON m.user_id = u.id
        LEFT JOIN memberships mb ON m.id = mb.member_id AND mb.status = 'active'
        LEFT JOIN plans p ON mb.plan_id = p.id
        WHERE 1=1
    """
    
    query = """
        SELECT m.*, u.email,
               mb.id as membership_id, mb.end_date, mb.status as membership_status,
               p.name as plan_name,
               (SELECT MAX(check_in_time) FROM attendance WHERE member_id = m.id AND status = 'success') as last_checkin,
               (SELECT COUNT(*) FROM payments WHERE member_id = m.id AND status IN ('pending', 'overdue')) as pending_payment_count
        FROM members m
        JOIN users u ON m.user_id = u.id
        LEFT JOIN memberships mb ON m.id = mb.member_id AND mb.status = 'active'
        LEFT JOIN plans p ON mb.plan_id = p.id
        WHERE 1=1
    """
    params = []
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
    
    for row in rows:
        m_dict = dict(row)
        end_date = m_dict.get("end_date")
        m_status = m_dict.get("status")
        
        if m_status == "active" and end_date and end_date < today:
            cursor.execute("UPDATE members SET status = 'expired' WHERE id = ?", (m_dict["id"],))
            cursor.execute("UPDATE memberships SET status = 'expired' WHERE id = ?", (m_dict["membership_id"],))
            m_dict["status"] = "expired"
            m_dict["membership_status"] = "expired"
            
        members_list.append(m_dict)
            
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
    emergency = data.get("emergency_contact", "")
    password = data.get("password") or "password123" # default signup password
    
    if not all([email, first_name, phone]):
        return jsonify({"error": "Missing required fields"}), 400
        
    conn = database.get_db_connection()
    cursor = conn.cursor()
    
    try:
        pw_hash = database.hash_password(password)
        cursor.execute("INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'member')", (email, pw_hash))
        u_id = cursor.lastrowid
        
        cursor.execute(
            "INSERT INTO members (user_id, first_name, last_name, phone, emergency_contact, status) VALUES (?, ?, ?, ?, ?, 'active')",
            (u_id, first_name, last_name, phone, emergency)
        )
        member_id = cursor.lastrowid
        
        cursor.execute(
            "INSERT INTO notifications (user_id, type, message) VALUES (?, 'welcome', ?)",
            (u_id, f"Welcome to GymOS, {first_name}! An account has been created for you by the Owner. Password: {password}")
        )
        
        log_action(cursor, "member_created_by_owner", "member", member_id, {"name": f"{first_name} {last_name}", "email": email})
        conn.commit()

        broadcast_event("MEMBER_CREATED", {
            "id": member_id,
            "name": f"{first_name} {last_name}",
            "email": email
        })

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
        WHERE m.id = ?
    """, (id,))
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
    emergency = data.get("emergency_contact")
    status = data.get("status")
    email = data.get("email")
    password = data.get("password")
    fee_pending = data.get("fee_pending")  # true/false/None (None = leave unchanged)

    if not all([first_name, phone, status]):
        return jsonify({"error": "Missing required edit fields"}), 400

    conn = database.get_db_connection()
    cursor = conn.cursor()

    try:
        # Check current status
        cursor.execute("SELECT status, user_id FROM members WHERE id = ?", (id,))
        old_m = cursor.fetchone()
        if not old_m:
            conn.close()
            return jsonify({"error": "Member not found"}), 404

        cursor.execute("""
            UPDATE members
            SET first_name = ?, last_name = ?, phone = ?, emergency_contact = ?, status = ?
            WHERE id = ?
        """, (first_name, last_name, phone, emergency, status, id))

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
            cursor.execute("INSERT INTO notifications (user_id, type, message) VALUES (?, 'expiry', 'Your membership has been suspended by the Gym Owner.')", (old_m["user_id"],))
        elif status == "active":
            # If status unsuspended, reactivate active end-dated memberships
            today = now_ist().strftime("%Y-%m-%d")
            cursor.execute("UPDATE memberships SET status = 'active' WHERE member_id = ? AND end_date >= ?", (id, today))

        log_action(cursor, "member_updated", "member", id, {
            "name": f"{first_name} {last_name}", "status": status,
            "prev_status": old_m["status"], "fee_pending": fee_pending
        })
        conn.commit()

        broadcast_event("MEMBER_UPDATED", {"id": id, "name": f"{first_name} {last_name}", "status": status})

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
    
    cursor.execute("SELECT user_id, first_name, last_name FROM members WHERE id = ?", (id,))
    member = cursor.fetchone()
    if not member:
        conn.close()
        return jsonify({"error": "Member not found"}), 404
        
    user_id = member["user_id"]
    name = f"{member['first_name']} {member['last_name']}"

    cursor.execute("DELETE FROM users WHERE id = ?", (user_id,))
    log_action(cursor, "member_deleted", "member", id, {
        "name": name, "note": "cascades to memberships/payments/attendance/notifications"
    })
    conn.commit()
    conn.close()

    broadcast_event("MEMBER_DELETED", {"id": id, "name": name})
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

    # 1. Verify Member exists
    cursor.execute("SELECT user_id, first_name, last_name, status FROM members WHERE id = ?", (id,))
    member = cursor.fetchone()
    if not member:
        conn.close()
        return jsonify({"error": "Member not found"}), 404

    # 2. Get Plan duration and price
    cursor.execute("SELECT name, price, duration_months FROM plans WHERE id = ?", (plan_id,))
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
            INSERT INTO memberships (member_id, plan_id, status, start_date, end_date, price_paid)
            VALUES (?, ?, 'active', ?, ?, ?)
        """, (id, plan_id, start_date_str, end_date_str, plan["price"]))
        membership_id = cursor.lastrowid
        
        # Bring Member state back to active
        cursor.execute("UPDATE members SET status = 'active' WHERE id = ?", (id,))
        
        # Record payment
        pay_status = "paid" if record_payment else "pending"
        pay_date = now_ist().strftime("%Y-%m-%d %H:%M:%S") if record_payment else None
        due_date = start_date_str if not record_payment else None
        receipt = f"RC-{int(now_ist().timestamp())}-{id}"
        
        cursor.execute("""
            INSERT INTO payments (membership_id, member_id, amount, status, payment_date, due_date, receipt_number)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (membership_id, id, plan["price"], pay_status, pay_date, due_date, receipt))
        payment_id = cursor.lastrowid

        # Notifications
        notif_msg = f"Your new membership '{plan['name']}' has been activated! Expires on: {end_date_str}."
        cursor.execute("INSERT INTO notifications (user_id, type, message) VALUES (?, 'renewal', ?)", (member["user_id"], notif_msg))

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
        })
        
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
    cursor.execute("SELECT * FROM plans ORDER BY price ASC")
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
        "INSERT INTO plans (name, price, duration_months, benefits) VALUES (?, ?, ?, ?)",
        (name, float(price), int(duration), benefits)
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
        "UPDATE plans SET name = ?, price = ?, duration_months = ?, benefits = ? WHERE id = ?",
        (name, float(price), int(duration), benefits, id)
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
        cursor.execute("DELETE FROM plans WHERE id = ?", (id,))
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
        WHERE 1=1
    """
    
    query = """
        SELECT a.id, a.check_in_time, a.check_out_time, a.status, a.attendance_state, a.attendance_date, a.error_msg,
               m.first_name, m.last_name, m.phone, m.id as member_id
        FROM attendance a
        JOIN members m ON a.member_id = m.id
        WHERE 1=1
    """
    
    params = []
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
        WHERE status = 'success' AND TO_CHAR(check_in_time::timestamp, 'YYYY-MM') = ?
        GROUP BY day
    """, (year_month,))
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
        WHERE 1=1
    """
    
    query = """
        SELECT p.*, m.first_name, m.last_name, m.phone, pl.name as plan_name
        FROM payments p
        JOIN members m ON p.member_id = m.id
        LEFT JOIN memberships ms ON p.membership_id = ms.id
        LEFT JOIN plans pl ON ms.plan_id = pl.id
        WHERE 1=1
    """
    
    params = []
    filter_sql = ""
    
    if status_filter:
        filter_sql += " AND p.status = ?"
        params.append(status_filter)

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
    
    cursor.execute("SELECT * FROM payments WHERE id = ?", (payment_id,))
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
                "INSERT INTO notifications (user_id, type, message) VALUES (?, 'renewal', ?)",
                (m["user_id"], f"Payment of ${pay['amount']} recorded successfully. Membership is set to ACTIVE.")
            )
            
        log_action(cursor, "payment_recorded_manual", "payment", payment_id, {
            "member_id": pay["member_id"], "amount": pay["amount"]
        })
        conn.commit()

        broadcast_event("PAYMENT_RECORDED", {
            "id": payment_id,
            "member_id": pay["member_id"],
            "amount": pay["amount"]
        })

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
        WHERE p.id = ?
    """, (id,))
    pay = cursor.fetchone()
    conn.close()
    
    if not pay:
        return jsonify({"error": "Payment ledger not found"}), 404
        
    name = f"{pay['first_name']} {pay['last_name']}"
    phone = pay["phone"]
    amount = pay["amount"]
    due = pay["due_date"] or now_ist().strftime("%Y-%m-%d")
    plan = pay["plan_name"] or "Gym Membership"

    msg = f"Hello {name}, your membership payment of ₹{amount:.2f} for '{plan}' is due on {due}. Please renew or pay at counter. Thank you! - GymOS Fitness"
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
        WHERE m.id = ?
        ORDER BY ms.end_date DESC LIMIT 1
    """, (id,))
    row = cursor.fetchone()
    conn.close()

    if not row:
        return jsonify({"error": "No membership found for this member"}), 404

    name = f"{row['first_name']} {row['last_name']}"
    phone = row["phone"]
    end_date = row["end_date"]
    plan = row["plan_name"] or "Gym Membership"

    msg = f"Hello {name}, your '{plan}' membership is expiring on {end_date}. Please renew soon to continue uninterrupted access. Thank you! - GymOS Fitness"
    whatsapp_url = build_whatsapp_link(phone, msg)

    return jsonify({
        "phone": phone,
        "message": msg,
        "whatsapp_url": whatsapp_url
    })

# ================= SETTINGS & QR ENDPOINTS =================

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
        gym_image_url = data.get("gym_image_url")

        if not gym_name:
            conn.close()
            return jsonify({"error": "Gym name cannot be empty"}), 400

        cursor.execute("INSERT INTO settings (key, value) VALUES ('gym_name', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", (gym_name,))
        if gym_phone:
            cursor.execute("INSERT INTO settings (key, value) VALUES ('gym_phone', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", (gym_phone,))
        if gym_address:
            cursor.execute("INSERT INTO settings (key, value) VALUES ('gym_address', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", (gym_address,))
        if qr_token:
            cursor.execute("INSERT INTO settings (key, value) VALUES ('qr_token', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", (qr_token,))
        if gym_image_url is not None:
            cursor.execute("INSERT INTO settings (key, value) VALUES ('gym_image_url', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", (gym_image_url,))
            
        # Update gyms table
        cursor.execute("UPDATE gyms SET name = ?, phone = ?, address = ?, qr_code_token = ? WHERE id = 1", (gym_name, gym_phone, gym_address, qr_token))

        log_action(cursor, "settings_updated", "gym", 1, {
            "gym_name": gym_name, "gym_phone": gym_phone, "gym_address": gym_address, "qr_token_changed": bool(qr_token)
        })
        conn.commit()
        conn.close()

        broadcast_event("GYM_SETTINGS_UPDATED", {"gym_name": gym_name})
        return jsonify({"success": True})
        
    # GET method
    cursor.execute("SELECT * FROM settings")
    settings = {row["key"]: row["value"] for row in cursor.fetchall()}
    conn.close()
    return jsonify(settings)

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

    count_query = "SELECT COUNT(*) FROM audit_log WHERE 1=1"
    query = "SELECT * FROM audit_log WHERE 1=1"
    params = []
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
        WHERE a.status = 'success' AND a.check_in_time::date >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY m.id
        ORDER BY checkin_count DESC, m.first_name ASC
        LIMIT 10
    """)
    rows = cursor.fetchall()
    leaderboard = [dict(r) for r in rows]
    conn.close()
    return jsonify(leaderboard)

@app.route("/api/admin/members/<int:id>/check-in", methods=["POST"])
@login_required("owner")
def admin_manual_check_in(id):
    conn = database.get_db_connection()
    cursor = conn.cursor()
    
    # Verify member exists
    cursor.execute("SELECT first_name, last_name, status, user_id FROM members WHERE id = ?", (id,))
    mbr = cursor.fetchone()
    if not mbr:
        conn.close()
        return jsonify({"error": "Member not found"}), 404
        
    today_str = now_ist().strftime("%Y-%m-%d")
    now_time_str = now_ist().strftime("%Y-%m-%d %H:%M:%S")
    
    # Check if already checked in today
    cursor.execute("""
        SELECT id FROM attendance 
        WHERE member_id = ? AND status = 'success' AND check_in_time::date = ?
        ORDER BY check_in_time DESC LIMIT 1
    """, (id, today_str))
    if cursor.fetchone():
        conn.close()
        return jsonify({"error": "Member has already logged attendance today."}), 409
        
    try:
        cursor.execute("SELECT id FROM gyms ORDER BY id LIMIT 1")
        gym = cursor.fetchone()
        gym_id = gym["id"] if gym else None
        
        cursor.execute("""
            INSERT INTO attendance (member_id, check_in_time, attendance_date, gym_id, attendance_state, status)
            VALUES (?, ?, ?, ?, 'checked_in', 'success')
        """, (id, now_time_str, today_str, gym_id))
        
        # Update member status to active if it was expired
        if mbr["status"] == "expired":
            cursor.execute("UPDATE members SET status = 'active' WHERE id = ?", (id,))
            
        conn.commit()
        
        fullname = f"{mbr['first_name']} {mbr['last_name']}"
        broadcast_event("CHECKIN_SUCCESS", {
            "member_id": id,
            "name": fullname,
            "time": now_time_str,
            "manual": True
        })
        
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
    cursor.execute("SELECT first_name, last_name, status, user_id FROM members WHERE id = ?", (id,))
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
        return jsonify({"error": "No active check-in session found for today."}), 400
        
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
        })
        
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
    cursor.execute("SELECT * FROM plans ORDER BY price ASC")
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
        
    if pay["status"] == "paid":
        conn.close()
        return jsonify({"error": "Payment already completed"}), 400
        
    try:
        # Update payment status to pending_approval and store receipt_number
        cursor.execute("""
            UPDATE payments 
            SET status = 'pending_approval', receipt_number = ? 
            WHERE id = ?
        """, (tx_ref, id))
        
        cursor.execute("SELECT user_id, first_name, last_name FROM members WHERE id = ?", (m_id,))
        m = cursor.fetchone()

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
        })
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
    conn = database.get_db_connection()
    cursor = conn.cursor()
    
    # Get plan details
    cursor.execute("SELECT name, price, duration_months FROM plans WHERE id = ?", (plan_id,))
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
    
    try:
        # Create a new membership with status suspended (awaits payment approval)
        cursor.execute("""
            INSERT INTO memberships (member_id, plan_id, status, start_date, end_date, price_paid)
            VALUES (?, ?, 'suspended', ?, ?, ?)
        """, (m_id, plan_id, start_date_str, end_date_str, plan["price"]))
        membership_id = cursor.lastrowid
        
        # Create payment request in pending_approval status
        cursor.execute("""
            INSERT INTO payments (membership_id, member_id, amount, status, receipt_number)
            VALUES (?, ?, ?, 'pending_approval', ?)
        """, (membership_id, m_id, plan["price"], tx_ref))
        payment_id = cursor.lastrowid

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
        })

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
    
    cursor.execute("SELECT * FROM payments WHERE id = ?", (id,))
    pay = cursor.fetchone()
    if not pay:
        conn.close()
        return jsonify({"error": "Payment not found"}), 404
        
    pay_time = now_ist().strftime("%Y-%m-%d %H:%M:%S")
    
    try:
        # Update payment status
        cursor.execute(
            "UPDATE payments SET status = 'paid', payment_date = ? WHERE id = ?",
            (pay_time, id)
        )
        
        # Update associated membership to active
        membership_id = pay["membership_id"]
        if membership_id:
            cursor.execute("UPDATE memberships SET status = 'active' WHERE id = ?", (membership_id,))
            
        # Set member status to active
        cursor.execute("UPDATE members SET status = 'active' WHERE id = ?", (pay["member_id"],))
        
        # Notify member
        cursor.execute("SELECT user_id, first_name FROM members WHERE id = ?", (pay["member_id"],))
        m = cursor.fetchone()
        if m:
            cursor.execute(
                "INSERT INTO notifications (user_id, type, message) VALUES (?, 'renewal', ?)",
                (m["user_id"], f"Payment of ₹{pay['amount']} has been approved! Your membership is active.")
            )
            
        log_action(cursor, "payment_approved", "payment", id, {
            "member_id": pay["member_id"], "amount": pay["amount"], "membership_id": membership_id
        })
        conn.commit()

        broadcast_event("PAYMENT_RECORDED", {
            "id": id,
            "member_id": pay["member_id"],
            "amount": pay["amount"]
        })
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()

@app.route("/api/admin/payments/<int:id>/reject", methods=["POST"])
@login_required("owner")
def admin_reject_payment(id):
    conn = database.get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT * FROM payments WHERE id = ?", (id,))
    pay = cursor.fetchone()
    if not pay:
        conn.close()
        return jsonify({"error": "Payment not found"}), 404
        
    try:
        # Reset payment status to pending and clear transaction reference
        cursor.execute(
            "UPDATE payments SET status = 'pending', receipt_number = NULL WHERE id = ?",
            (id,)
        )
        
        # Notify member
        cursor.execute("SELECT user_id, first_name FROM members WHERE id = ?", (pay["member_id"],))
        m = cursor.fetchone()
        if m:
            cursor.execute(
                "INSERT INTO notifications (user_id, type, message) VALUES (?, 'payment', ?)",
                (m["user_id"], f"Your payment request for ₹{pay['amount']} was rejected by the owner. Please verify details.")
            )
            
        log_action(cursor, "payment_rejected", "payment", id, {
            "member_id": pay["member_id"], "amount": pay["amount"]
        })
        conn.commit()

        broadcast_event("PAYMENT_REJECTED", {
            "id": id,
            "member_id": pay["member_id"],
            "amount": pay["amount"]
        })
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
    
    # 1. Fetch Member status information
    cursor.execute("SELECT status, first_name, last_name FROM members WHERE id = ?", (m_id,))
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
    cursor.execute("SELECT * FROM notifications WHERE user_id = ? AND read_status = 0 ORDER BY created_at DESC LIMIT 10", (user_id,))
    notifs = [dict(r) for r in cursor.fetchall()]
    
    # Payment status
    cursor.execute("SELECT * FROM payments WHERE member_id = ? ORDER BY created_at DESC", (m_id,))
    billing_history = [dict(r) for r in cursor.fetchall()]
    
    # Monthly Rank
    cursor.execute("""
        WITH ranks AS (
            SELECT member_id, COUNT(id) as cnt,
                   RANK() OVER (ORDER BY COUNT(id) DESC) as rnk
            FROM attendance
            WHERE status = 'success' AND TO_CHAR(check_in_time::timestamp, 'YYYY-MM') = TO_CHAR(CURRENT_DATE, 'YYYY-MM')
            GROUP BY member_id
        )
        SELECT rnk FROM ranks WHERE member_id = ?
    """, (m_id,))
    m_rnk_row = cursor.fetchone()
    monthly_rank = m_rnk_row[0] if m_rnk_row else 0

    cursor.execute("SELECT value FROM settings WHERE key = 'gym_image_url'")
    gym_image_row = cursor.fetchone()

    conn.close()

    return jsonify({
        "first_name": mb["first_name"],
        "last_name": mb["last_name"],
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
        "gym_image_url": gym_image_row["value"] if gym_image_row else None
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
        
        # 3. Calculate Streaks (Current & Longest)
        cursor.execute("""
            SELECT check_in_time::date::text as check_date
            FROM attendance
            WHERE member_id = ? AND status = 'success'
            GROUP BY check_date
            ORDER BY check_date DESC
        """, (m_id,))
        checkin_dates = [datetime.strptime(row[0], "%Y-%m-%d").date() for row in cursor.fetchall()]
        
        today = now_ist().date()
        yesterday = today - timedelta(days=1)
        
        streak = 0
        if checkin_dates:
            if checkin_dates[0] == today or checkin_dates[0] == yesterday:
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
            if l["check_out_time"]:
                in_t = datetime.strptime(l["check_in_time"], "%Y-%m-%d %H:%M:%S")
                out_t = datetime.strptime(l["check_out_time"], "%Y-%m-%d %H:%M:%S")
                diff = (out_t - in_t).total_seconds()
                durations.append(diff)
                total_seconds += diff
                if diff > max_seconds:
                    max_seconds = diff
                    
        total_hours = round(total_seconds / 3600.0, 1)
        avg_minutes = int((total_seconds / len(durations)) / 60) if durations else 0
        max_minutes = int(max_seconds / 60)
        
        # 5. Period counters
        cursor.execute("""
            SELECT COUNT(DISTINCT check_in_time::date)
            FROM attendance
            WHERE member_id = ? AND status = 'success' AND check_in_time::date >= CURRENT_DATE - INTERVAL '6 days'
        """, (m_id,))
        weekly_visits = cursor.fetchone()[0]

        cursor.execute("""
            SELECT COUNT(DISTINCT check_in_time::date)
            FROM attendance
            WHERE member_id = ? AND status = 'success' AND TO_CHAR(check_in_time::timestamp, 'YYYY-MM') = TO_CHAR(CURRENT_DATE, 'YYYY-MM')
        """, (m_id,))
        monthly_visits = cursor.fetchone()[0]

        cursor.execute("""
            SELECT COUNT(DISTINCT check_in_time::date)
            FROM attendance
            WHERE member_id = ? AND status = 'success' AND TO_CHAR(check_in_time::timestamp, 'YYYY') = TO_CHAR(CURRENT_DATE, 'YYYY')
        """, (m_id,))
        yearly_visits = cursor.fetchone()[0]

        # 6. Ranks (Weekly, Monthly, All-time)
        cursor.execute("""
            WITH ranks AS (
                SELECT member_id, COUNT(id) as cnt,
                       RANK() OVER (ORDER BY COUNT(id) DESC) as rnk
                FROM attendance
                WHERE status = 'success' AND check_in_time::date >= CURRENT_DATE - INTERVAL '6 days'
                GROUP BY member_id
            )
            SELECT rnk FROM ranks WHERE member_id = ?
        """, (m_id,))
        w_rnk_row = cursor.fetchone()
        weekly_rank = w_rnk_row[0] if w_rnk_row else 0

        cursor.execute("""
            WITH ranks AS (
                SELECT member_id, COUNT(id) as cnt,
                       RANK() OVER (ORDER BY COUNT(id) DESC) as rnk
                FROM attendance
                WHERE status = 'success' AND check_in_time::date >= CURRENT_DATE - INTERVAL '29 days'
                GROUP BY member_id
            )
            SELECT rnk FROM ranks WHERE member_id = ?
        """, (m_id,))
        m_rnk_row = cursor.fetchone()
        monthly_rank = m_rnk_row[0] if m_rnk_row else 0
        
        cursor.execute("""
            WITH ranks AS (
                SELECT member_id, COUNT(id) as cnt,
                       RANK() OVER (ORDER BY COUNT(id) DESC) as rnk
                FROM attendance
                WHERE status = 'success'
                GROUP BY member_id
            )
            SELECT rnk FROM ranks WHERE member_id = ?
        """, (m_id,))
        a_rnk_row = cursor.fetchone()
        all_time_rank = a_rnk_row[0] if a_rnk_row else 0
        
        # Points (100 * checkin count)
        points = len(logs) * 100
        
        # 7. Today status
        today_str = now_ist().strftime("%Y-%m-%d")
        cursor.execute("""
            SELECT check_in_time, check_out_time FROM attendance
            WHERE member_id = ? AND status = 'success' AND check_in_time::date = ?
            ORDER BY check_in_time DESC LIMIT 1
        """, (m_id, today_str))
        today_att = cursor.fetchone()
        today_status = "Absent"
        if today_att:
            today_status = "Checked Out" if today_att["check_out_time"] else "Checked In"
            
        # 8. Leaderboards Top 10 lists
        # Weekly
        cursor.execute("""
            SELECT m.id, m.first_name, m.last_name, m.profile_photo, COUNT(a.id) as checkin_count
            FROM members m
            JOIN attendance a ON m.id = a.member_id
            WHERE a.status = 'success' AND a.check_in_time::date >= CURRENT_DATE - INTERVAL '6 days'
            GROUP BY m.id
            ORDER BY checkin_count DESC, m.first_name ASC LIMIT 10
        """)
        leaderboard_weekly = [dict(r) for r in cursor.fetchall()]
        for idx, u in enumerate(leaderboard_weekly):
            u["rank"] = idx + 1
            u["points"] = u["checkin_count"] * 100
            
        # Monthly
        cursor.execute("""
            SELECT m.id, m.first_name, m.last_name, m.profile_photo, COUNT(a.id) as checkin_count
            FROM members m
            JOIN attendance a ON m.id = a.member_id
            WHERE a.status = 'success' AND a.check_in_time::date >= CURRENT_DATE - INTERVAL '29 days'
            GROUP BY m.id
            ORDER BY checkin_count DESC, m.first_name ASC LIMIT 10
        """)
        leaderboard_monthly = [dict(r) for r in cursor.fetchall()]
        for idx, u in enumerate(leaderboard_monthly):
            u["rank"] = idx + 1
            u["points"] = u["checkin_count"] * 100
            
        # All Time
        cursor.execute("""
            SELECT m.id, m.first_name, m.last_name, m.profile_photo, COUNT(a.id) as checkin_count
            FROM members m
            JOIN attendance a ON m.id = a.member_id
            WHERE a.status = 'success'
            GROUP BY m.id
            ORDER BY checkin_count DESC, m.first_name ASC LIMIT 10
        """)
        leaderboard_all = [dict(r) for r in cursor.fetchall()]
        for idx, u in enumerate(leaderboard_all):
            u["rank"] = idx + 1
            u["points"] = u["checkin_count"] * 100
            
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
        cursor.execute("""
            SELECT COUNT(DISTINCT check_in_time::date)
            FROM attendance
            WHERE member_id = ? AND status = 'success'
              AND TO_CHAR(check_in_time::timestamp, 'YYYY-MM') = TO_CHAR(CURRENT_DATE - INTERVAL '1 month', 'YYYY-MM')
        """, (m_id,))
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
        
        # 11. Chart data details (visits by day of week and weekly hours)
        cursor.execute("""
            SELECT EXTRACT(DOW FROM check_in_time::timestamp)::int as dow, COUNT(id) as cnt
            FROM attendance
            WHERE member_id = ? AND status = 'success' AND TO_CHAR(check_in_time::timestamp, 'YYYY-MM') = TO_CHAR(CURRENT_DATE, 'YYYY-MM')
            GROUP BY dow
        """, (m_id,))
        dow_counts = {int(r["dow"]): r["cnt"] for r in cursor.fetchall()}
        visits_by_dow = [dow_counts.get(i, 0) for i in range(7)]
        
        # Workout hours by week (last 4 weeks)
        workout_hours_by_week = []
        for w in range(4):
            offset_start = w * 7
            offset_end = (w + 1) * 7
            cursor.execute(f"""
                SELECT check_in_time, check_out_time
                FROM attendance
                WHERE member_id = ? AND status = 'success'
                  AND check_in_time::date <= CURRENT_DATE - INTERVAL '{offset_start} days'
                  AND check_in_time::date > CURRENT_DATE - INTERVAL '{offset_end} days'
            """, (m_id,))
            week_logs = cursor.fetchall()
            week_seconds = 0
            for wl in week_logs:
                if wl["check_out_time"]:
                    in_t = datetime.strptime(wl["check_in_time"], "%Y-%m-%d %H:%M:%S")
                    out_t = datetime.strptime(wl["check_out_time"], "%Y-%m-%d %H:%M:%S")
                    week_seconds += (out_t - in_t).total_seconds()
            workout_hours_by_week.append(round(week_seconds / 3600.0, 1))
        workout_hours_by_week.reverse()

        return jsonify({
            "first_name": mb["first_name"],
            "last_name": mb["last_name"],
            "status": mb["status"],
            "plan_name": plan_name,
            "streak": streak,
            "longest_streak": longest_streak,
            "total_workout_hours": total_hours,
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
    cursor.execute("SELECT value FROM settings WHERE key = 'qr_token'")
    row = cursor.fetchone()
    conn.close()
    return jsonify({"qr_token": row["value"] if row else None})

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
        
    conn = database.get_db_connection()
    cursor = conn.cursor()
    
    # 1. Fetch current gymapp settings qr token
    cursor.execute("SELECT value FROM settings WHERE key = 'qr_token'")
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
        cursor.execute("INSERT INTO attendance (member_id, status, error_msg) VALUES (?, 'failed', 'Account suspended')", (m_id,))
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
            
        cursor.execute("INSERT INTO attendance (member_id, status, error_msg) VALUES (?, 'failed', 'Membership expired')", (m_id,))
        conn.commit()
        conn.close()
        return jsonify({"error": "Check-in failed. Membership has expired."}), 403
        
    # Members can check in/out multiple times per day (e.g. a morning and an
    # evening session) — only an *open* session (no check-out yet) blocks a
    # fresh check-in and instead asks whether to check out.
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
            })
            
            return jsonify({
                "success": True,
                "type": "checkout",
                "check_in_time": latest_att["check_in_time"],
                "check_out_time": now_time_str,
                "duration": duration_str,
                "message": f"Great job today, {mbr['first_name']}!"
            })
        else:
            cursor.execute("SELECT id FROM gyms ORDER BY id LIMIT 1")
            gym = cursor.fetchone()
            gym_id = gym["id"] if gym else None
            cursor.execute("""
                INSERT INTO attendance (member_id, check_in_time, attendance_date, gym_id, attendance_state, status)
                VALUES (?, ?, ?, ?, 'checked_in', 'success')
            """, (m_id, now_time_str, today_str, gym_id))
            conn.commit()
            
            fullname = f"{mbr['first_name']} {mbr['last_name']}"
            broadcast_event("CHECKIN_SUCCESS", {
                "member_id": m_id,
                "name": fullname,
                "time": now_time_str
            })
            
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

@app.route("/api/member/profile", methods=["PUT"])
@login_required("member")
def member_update_profile():
    data = request.get_json() or {}
    phone = data.get("phone")
    emergency = data.get("emergency_contact")
    photo = data.get("profile_photo")
    m_id = session.get("member_id")
    
    if not phone:
        return jsonify({"error": "Phone number is required"}), 400
        
    conn = database.get_db_connection()
    cursor = conn.cursor()
    
    try:
        cursor.execute("""
            UPDATE members
            SET phone = ?, emergency_contact = ?, profile_photo = ?
            WHERE id = ?
        """, (phone, emergency, photo, m_id))
        log_action(cursor, "member_profile_updated_self", "member", m_id, {"phone": phone})
        conn.commit()

        broadcast_event("MEMBER_PROFILE_UPDATED", {"id": m_id, "phone": phone})
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
    app.run(host="0.0.0.0", port=port, debug=debug, ssl_context=ssl_context)
