import hashlib
import os
import random
import re
import string
from datetime import datetime, timedelta

from dotenv import load_dotenv

import supabase_db

load_dotenv()

SUPABASE_DB_HOST = os.environ.get("SUPABASE_DB_HOST")
SUPABASE_DB_PORT = os.environ.get("SUPABASE_DB_PORT", "6543")
SUPABASE_DB_USER = os.environ.get("SUPABASE_DB_USER")
SUPABASE_DB_PASSWORD = os.environ.get("SUPABASE_DB_PASSWORD")
SUPABASE_DB_NAME = os.environ.get("SUPABASE_DB_NAME", "postgres")

def get_db_connection():
    return supabase_db.connect(
        host=SUPABASE_DB_HOST,
        port=SUPABASE_DB_PORT,
        user=SUPABASE_DB_USER,
        password=SUPABASE_DB_PASSWORD,
        dbname=SUPABASE_DB_NAME,
    )

def hash_password(password, salt=None):
    if not salt:
        salt = os.urandom(16).hex()
    hashed = hashlib.sha256((password + salt).encode('utf-8')).hexdigest()
    return f"{salt}:{hashed}"

def verify_password(stored_password, provided_password):
    try:
        salt, hashed = stored_password.split(":")
        test_hashed = hashlib.sha256((provided_password + salt).encode('utf-8')).hexdigest()
        return test_hashed == hashed
    except Exception:
        return False

def generate_gym_code(name):
    """Human-typeable public 'Gym ID' members search for at registration."""
    slug = re.sub(r'[^A-Z0-9]', '', (name or 'GYM').upper())[:8] or 'GYM'
    suffix = ''.join(random.choices(string.ascii_uppercase + string.digits, k=4))
    return f"{slug}-{suffix}"

def unique_gym_code(cursor, name):
    for _ in range(10):
        code = generate_gym_code(name)
        cursor.execute("SELECT 1 FROM gyms WHERE gym_code = ?", (code,))
        if not cursor.fetchone():
            return code
    raise RuntimeError("Could not generate a unique gym code")

def init_db():
    conn = get_db_connection()
    cursor = conn.cursor()

    # Create Users table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT CHECK(role IN ('owner', 'member')) NOT NULL,
        first_name TEXT,
        last_name TEXT,
        profile_photo TEXT,
        created_at TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
    );
    """)
    cursor.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT")
    cursor.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT")
    cursor.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo TEXT")

    # Create Gym table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS gyms (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT,
        address TEXT,
        qr_code_token TEXT NOT NULL,
        updated_at TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
    );
    """)

    # Create Members table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS members (
        id SERIAL PRIMARY KEY,
        user_id INTEGER UNIQUE NOT NULL,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        emergency_contact TEXT,
        emergency_contact_name TEXT,
        emergency_contact_number TEXT,
        emergency_contact_relation TEXT,
        status TEXT CHECK(status IN ('active', 'suspended', 'expired', 'pending', 'rejected')) DEFAULT 'pending',
        profile_photo TEXT,
        joined_at TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
        preferences_completed BOOLEAN DEFAULT FALSE,
        dob TEXT,
        gender TEXT,
        height REAL,
        weight REAL,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );
    """)

    # Create Membership Plans table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS plans (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        price REAL NOT NULL,
        duration_months INTEGER NOT NULL,
        benefits TEXT,
        created_at TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
    );
    """)

    # Create Memberships table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS memberships (
        id SERIAL PRIMARY KEY,
        member_id INTEGER NOT NULL,
        plan_id INTEGER NOT NULL,
        status TEXT CHECK(status IN ('active', 'suspended', 'expired')) DEFAULT 'active',
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        price_paid REAL NOT NULL,
        created_at TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
        FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE,
        FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE RESTRICT
    );
    """)

    # Create Attendance table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS attendance (
        id SERIAL PRIMARY KEY,
        member_id INTEGER NOT NULL,
        check_in_time TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
        check_out_time TEXT,
        status TEXT CHECK(status IN ('success', 'failed')) NOT NULL,
        error_msg TEXT,
        attendance_date TEXT,
        gym_id INTEGER,
        attendance_state TEXT DEFAULT 'checked_in',
        FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
    );
    """)
    cursor.execute("UPDATE attendance SET attendance_date = check_in_time::date::text WHERE attendance_date IS NULL")
    cursor.execute("UPDATE attendance SET gym_id = 1 WHERE gym_id IS NULL")
    cursor.execute("UPDATE attendance SET attendance_state = CASE WHEN check_out_time IS NULL THEN 'checked_in' ELSE 'completed' END WHERE attendance_state IS NULL")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_attendance_member_day ON attendance(member_id, attendance_date)")

    # Create Payments table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        membership_id INTEGER,
        member_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        status TEXT CHECK(status IN ('paid', 'pending', 'overdue', 'pending_approval')) DEFAULT 'paid',
        payment_date TEXT,
        due_date TEXT,
        receipt_number TEXT UNIQUE,
        created_at TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
        FOREIGN KEY (membership_id) REFERENCES memberships (id) ON DELETE SET NULL,
        FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
    );
    """)

    # Create Notifications table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        type TEXT CHECK(type IN ('payment', 'expiry', 'welcome', 'renewal')) NOT NULL,
        message TEXT NOT NULL,
        read_status INTEGER CHECK(read_status IN (0, 1)) DEFAULT 0,
        created_at TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );
    """)

    # A member may have multiple emergency contacts. This is deliberately a
    # first-class, gym-scoped record rather than browser-local profile state.
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS emergency_contacts (
        id SERIAL PRIMARY KEY,
        member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        gym_id INTEGER NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        relationship TEXT,
        contact_type TEXT CHECK(contact_type IN ('primary', 'secondary')) DEFAULT 'secondary',
        created_at TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
        updated_at TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
    );
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_emergency_contacts_member_gym ON emergency_contacts(member_id, gym_id)")

    # Create Settings table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        key TEXT UNIQUE NOT NULL,
        value TEXT NOT NULL
    );
    """)

    # Create Body Stats table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS body_stats (
        id SERIAL PRIMARY KEY,
        member_id INTEGER NOT NULL,
        weight REAL NOT NULL,
        height REAL NOT NULL,
        goal_weight REAL,
        created_at TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
        FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
    );
    """)

    # Create Audit Log table. Deliberately has NO foreign keys: it must
    # survive the deletion of the user/member/payment/etc it describes, so
    # "what happened to this record" stays answerable after the record
    # itself is gone. actor_email/actor_role are snapshotted at write time
    # for the same reason (the actor's account could later be deleted too).
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS audit_log (
        id SERIAL PRIMARY KEY,
        actor_user_id INTEGER,
        actor_email TEXT,
        actor_role TEXT,
        action TEXT NOT NULL,
        entity_type TEXT,
        entity_id INTEGER,
        details TEXT,
        created_at TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
    );
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id)")

    # Win Back CRM tables
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS win_back_recoveries (
        id SERIAL PRIMARY KEY,
        member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        gym_id INTEGER NOT NULL DEFAULT 1,
        days_inactive INTEGER NOT NULL,
        recovery_date TEXT NOT NULL
    );
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_win_back_recoveries_gym ON win_back_recoveries(gym_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_win_back_recoveries_member ON win_back_recoveries(member_id)")

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS win_back_interactions (
        id SERIAL PRIMARY KEY,
        member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        gym_id INTEGER NOT NULL DEFAULT 1,
        interaction_type TEXT CHECK(interaction_type IN ('whatsapp', 'call', 'follow_up', 'contacted')) NOT NULL,
        notes TEXT,
        contacted_at TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
        follow_up_date TEXT
    );
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_win_back_interactions_gym ON win_back_interactions(gym_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_win_back_interactions_member ON win_back_interactions(member_id)")

    conn.commit()
    _migrate_multi_tenancy(cursor)
    conn.commit()
    seed_data(conn)
    conn.close()

def _migrate_multi_tenancy(cursor):
    """Turn the single-gym schema into a multi-tenant one.

    Every gym-scoped table gets a gym_id column, defaulted to 1 so existing
    rows (from before multi-tenancy existed) automatically become "tenant
    #1" in one statement - no separate backfill pass needed. Idempotent:
    safe to run on every startup, both for the already-migrated production
    database and for a brand new one.
    """
    for table in ("users", "members", "plans", "memberships", "payments", "notifications", "settings", "body_stats"):
        cursor.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS gym_id INTEGER NOT NULL DEFAULT 1")
    cursor.execute("ALTER TABLE members ADD COLUMN IF NOT EXISTS preferences_completed BOOLEAN DEFAULT FALSE")
    cursor.execute("ALTER TABLE members ADD COLUMN IF NOT EXISTS emergency_contact_name TEXT")
    cursor.execute("ALTER TABLE members ADD COLUMN IF NOT EXISTS emergency_contact_number TEXT")
    cursor.execute("ALTER TABLE members ADD COLUMN IF NOT EXISTS emergency_contact_relation TEXT")
    cursor.execute("ALTER TABLE members ADD COLUMN IF NOT EXISTS dob TEXT")
    cursor.execute("ALTER TABLE members ADD COLUMN IF NOT EXISTS gender TEXT")
    cursor.execute("ALTER TABLE members ADD COLUMN IF NOT EXISTS height REAL")
    cursor.execute("ALTER TABLE members ADD COLUMN IF NOT EXISTS weight REAL")
    cursor.execute("ALTER TABLE gyms ADD COLUMN IF NOT EXISTS logo_url TEXT")
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS emergency_contacts (
            id SERIAL PRIMARY KEY,
            member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
            gym_id INTEGER NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
            name TEXT NOT NULL, phone TEXT NOT NULL, relationship TEXT,
            contact_type TEXT CHECK(contact_type IN ('primary', 'secondary')) DEFAULT 'secondary',
            created_at TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
            updated_at TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
        )
    """)
    # Deduplicate member phones per gym if legacy duplicates exist
    cursor.execute("SELECT id, phone, gym_id FROM members ORDER BY id ASC")
    m_rows = cursor.fetchall()
    seen_keys = set()
    for m in m_rows:
        key = (m["gym_id"], m["phone"])
        if key in seen_keys and m["phone"]:
            cursor.execute("UPDATE members SET phone = ? WHERE id = ?", (f"{m['phone']}_{m['id']}", m["id"]))
        else:
            seen_keys.add(key)

    cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_members_gym_phone ON members(gym_id, phone)")
    cursor.execute("ALTER TABLE emergency_contacts ADD COLUMN IF NOT EXISTS contact_type TEXT CHECK(contact_type IN ('primary', 'secondary')) DEFAULT 'secondary'")
    
    # Backfill emergency contacts
    cursor.execute("SELECT id, emergency_contact, emergency_contact_name, emergency_contact_number FROM members")
    rows = cursor.fetchall()
    for row in rows:
        m_id = row["id"]
        ec = row["emergency_contact"]
        ec_name = row["emergency_contact_name"]
        ec_num = row["emergency_contact_number"]
        if ec and not ec_name and not ec_num:
            if "/" in ec:
                parts = ec.split("/", 1)
                name = parts[0].strip()
                num = parts[1].strip()
            else:
                name = ""
                num = ec.strip()
            cursor.execute("UPDATE members SET emergency_contact_name = ?, emergency_contact_number = ? WHERE id = ?", (name, num, m_id))

    # Clean up duplicate primary contacts that were mistakenly copied to the emergency_contacts table
    cursor.execute("""
        DELETE FROM emergency_contacts 
        WHERE (member_id, name, phone) IN (
            SELECT id, emergency_contact_name, emergency_contact_number FROM members
        )
    """)

    cursor.execute("ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS gym_id INTEGER")

    # settings used to be unique on `key` alone (one gym); now every gym has
    # its own gym_name/phone/qr_token/etc, so it must be unique per gym.
    cursor.execute("ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_key_key")
    cursor.execute("""
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settings_gym_key_unique') THEN
                ALTER TABLE settings ADD CONSTRAINT settings_gym_key_unique UNIQUE (gym_id, key);
            END IF;
        END $$;
    """)

    # gyms becomes the tenant table: a public Gym ID members search for at
    # registration, which user account owns it, and its (manually-managed,
    # no payment gateway yet) subscription state.
    cursor.execute("ALTER TABLE gyms ADD COLUMN IF NOT EXISTS gym_code TEXT")
    cursor.execute("ALTER TABLE gyms ADD COLUMN IF NOT EXISTS owner_user_id INTEGER")
    cursor.execute("ALTER TABLE gyms ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'active'")
    cursor.execute("ALTER TABLE gyms ADD COLUMN IF NOT EXISTS subscription_end_date TEXT")
    cursor.execute("ALTER TABLE gyms ADD COLUMN IF NOT EXISTS subscription_plan_id INTEGER")
    cursor.execute("""
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gyms_gym_code_key') THEN
                ALTER TABLE gyms ADD CONSTRAINT gyms_gym_code_key UNIQUE (gym_code);
            END IF;
        END $$;
    """)

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS company_users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
    );
    """)

    # Subscription tiers the company sells to gym owners (Monthly, Annual,
    # ...) - distinct from `plans`, which are the gym's own member-facing
    # membership tiers.
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS company_plans (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        price REAL NOT NULL,
        duration_months INTEGER NOT NULL,
        created_at TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
    );
    """)

    # One row per subscription period a gym has paid for, mirroring how
    # memberships+payments track a member's plan history. gyms.subscription_
    # status/subscription_end_date are the fast-access "current state",
    # updated whenever the company marks a new payment received here.
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS company_subscriptions (
        id SERIAL PRIMARY KEY,
        gym_id INTEGER NOT NULL,
        company_plan_id INTEGER,
        status TEXT CHECK(status IN ('active', 'expired')) DEFAULT 'active',
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        amount_paid REAL,
        payment_date TEXT,
        notes TEXT,
        created_at TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
        FOREIGN KEY (gym_id) REFERENCES gyms (id) ON DELETE CASCADE,
        FOREIGN KEY (company_plan_id) REFERENCES company_plans (id) ON DELETE SET NULL
    );
    """)

    # Backfill the pre-existing gym (tenant #1) with a gym_code/owner/active
    # subscription so it keeps working exactly as before under the new model.
    cursor.execute("SELECT id, name, gym_code, owner_user_id FROM gyms ORDER BY id LIMIT 1")
    existing_gym = cursor.fetchone()
    if existing_gym and not existing_gym["gym_code"]:
        code = unique_gym_code(cursor, existing_gym["name"])
        cursor.execute("SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1")
        existing_owner = cursor.fetchone()
        grandfathered_end_date = (datetime.utcnow() + timedelta(days=365)).strftime("%Y-%m-%d")
        cursor.execute(
            "UPDATE gyms SET gym_code = ?, owner_user_id = ?, subscription_status = 'active', "
            "subscription_end_date = ? WHERE id = ?",
            (code, existing_owner["id"] if existing_owner else None, grandfathered_end_date, existing_gym["id"])
        )

    # Seed starter company subscription tiers (editable later from the
    # Company Portal) so "mark paid" has something to pick from immediately.
    cursor.execute("SELECT COUNT(*) FROM company_plans")
    if cursor.fetchone()[0] == 0:
        cursor.execute("""
        INSERT INTO company_plans (name, price, duration_months) VALUES
        ('Monthly', 999.0, 1),
        ('Annual', 9999.0, 12)
        """)

    # Payments table extension for end-to-end workflow
    cursor.execute("ALTER TABLE payments ADD COLUMN IF NOT EXISTS gym_id INTEGER")
    cursor.execute("ALTER TABLE payments ADD COLUMN IF NOT EXISTS plan_id INTEGER")
    cursor.execute("ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_method TEXT")
    cursor.execute("ALTER TABLE payments ADD COLUMN IF NOT EXISTS receipt_file_url TEXT")
    cursor.execute("ALTER TABLE payments ADD COLUMN IF NOT EXISTS receipt_file_type TEXT")
    cursor.execute("ALTER TABLE payments ADD COLUMN IF NOT EXISTS review_date TEXT")
    cursor.execute("ALTER TABLE payments ADD COLUMN IF NOT EXISTS reviewed_by INTEGER")
    cursor.execute("ALTER TABLE payments ADD COLUMN IF NOT EXISTS rejection_reason TEXT")
    cursor.execute("ALTER TABLE payments ADD COLUMN IF NOT EXISTS updated_at TEXT")
    cursor.execute("ALTER TABLE payments ADD COLUMN IF NOT EXISTS transaction_reference TEXT")
    try:
        cursor.execute("ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check")
    except Exception:
        pass
    try:
        cursor.execute("ALTER TABLE payments ADD CONSTRAINT payments_status_check CHECK(status IN ('paid', 'pending', 'overdue', 'pending_approval', 'rejected', 'draft', 'submitted', 'approved', 'cancelled'))")
    except Exception:
        pass
    try:
        cursor.execute("ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_status_check")
    except Exception:
        pass
    try:
        cursor.execute("ALTER TABLE memberships ADD CONSTRAINT memberships_status_check CHECK(status IN ('active', 'suspended', 'expired', 'rejected', 'cancelled'))")
    except Exception:
        pass
    try:
        cursor.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_txn_ref 
            ON payments (transaction_reference) 
            WHERE (transaction_reference IS NOT NULL AND transaction_reference != '')
        """)
    except Exception:
        pass


def seed_data(conn):
    cursor = conn.cursor()

    # Check if database is already seeded
    cursor.execute("SELECT COUNT(*) FROM users")
    if cursor.fetchone()[0] > 0:
        return

    print("Seeding database with default mock data...")

    # 1. Add Gym Info first (owner_user_id is filled in once the owner exists)
    cursor.execute(
        "INSERT INTO gyms (name, phone, address, qr_code_token) VALUES (?, ?, ?, ?)",
        ("GymOS Fitness Center", "+1234567890", "123 Gym Street, Wellness City", "gymos-token-xyz-123")
    )
    gym_id = cursor.lastrowid
    gym_code = unique_gym_code(cursor, "GymOS Fitness Center")
    grandfathered_end_date = (datetime.utcnow() + timedelta(days=365)).strftime("%Y-%m-%d")
    cursor.execute(
        "UPDATE gyms SET gym_code = ?, subscription_status = 'active', subscription_end_date = ? WHERE id = ?",
        (gym_code, grandfathered_end_date, gym_id)
    )

    # 2. Add Default Owner Account
    owner_pw = hash_password("password123")
    cursor.execute(
        "INSERT INTO users (email, password_hash, role, gym_id, first_name, last_name) VALUES (?, ?, ?, ?, ?, ?)",
        ("owner@gymos.com", owner_pw, "owner", gym_id, "Ramesh", "Kumar")
    )
    owner_user_id = cursor.lastrowid
    cursor.execute("UPDATE gyms SET owner_user_id = ? WHERE id = ?", (owner_user_id, gym_id))

    # 3. Add Settings
    cursor.execute("INSERT INTO settings (key, value, gym_id) VALUES ('gym_name', 'GymOS Fitness Center', ?)", (gym_id,))
    cursor.execute("INSERT INTO settings (key, value, gym_id) VALUES ('gym_phone', '+1234567890', ?)", (gym_id,))
    cursor.execute("INSERT INTO settings (key, value, gym_id) VALUES ('gym_address', '123 Gym Street, Wellness City', ?)", (gym_id,))
    cursor.execute("INSERT INTO settings (key, value, gym_id) VALUES ('qr_token', 'gymos-token-xyz-123', ?)", (gym_id,))

    # 4. Add Default Membership Plans
    cursor.execute("""
    INSERT INTO plans (name, price, duration_months, benefits, gym_id) VALUES
    ('Monthly Fitness Pass', 999.0, 1, 'Full gym floor access + 1 free trainer consultation', ?),
    ('Quarterly Power Pack', 2499.0, 3, 'Full gym floor access + locker access + personalized diet chart', ?),
    ('Annual Elite Membership', 7999.0, 12, 'Full gym floor access + locker access + unlimited group classes + 5 guest passes', ?)
    """, (gym_id, gym_id, gym_id))

    conn.commit()
    print("Database seeding completed.")

if __name__ == "__main__":
    init_db()
    print("Database initialized successfully.")
