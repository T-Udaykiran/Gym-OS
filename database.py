import hashlib
import os

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
        created_at TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
    );
    """)

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
        status TEXT CHECK(status IN ('active', 'suspended', 'expired', 'pending', 'rejected')) DEFAULT 'pending',
        profile_photo TEXT,
        joined_at TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
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

    # Create Settings table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        key TEXT UNIQUE NOT NULL,
        value TEXT NOT NULL
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

    conn.commit()
    seed_data(conn)
    conn.close()

def seed_data(conn):
    cursor = conn.cursor()

    # Check if database is already seeded
    cursor.execute("SELECT COUNT(*) FROM users")
    if cursor.fetchone()[0] > 0:
        return

    print("Seeding database with default mock data...")

    # 1. Add Default Owner Account
    owner_pw = hash_password("password123")
    cursor.execute(
        "INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)",
        ("owner@gymos.com", owner_pw, "owner")
    )
    owner_user_id = cursor.lastrowid

    # 2. Add Gym Info
    cursor.execute(
        "INSERT INTO gyms (name, phone, address, qr_code_token) VALUES (?, ?, ?, ?)",
        ("GymOS Fitness Center", "+1234567890", "123 Gym Street, Wellness City", "gymos-token-xyz-123")
    )
    gym_id = cursor.lastrowid

    # 3. Add Settings
    cursor.execute("INSERT INTO settings (key, value) VALUES ('gym_name', 'GymOS Fitness Center')")
    cursor.execute("INSERT INTO settings (key, value) VALUES ('gym_phone', '+1234567890')")
    cursor.execute("INSERT INTO settings (key, value) VALUES ('gym_address', '123 Gym Street, Wellness City')")
    cursor.execute("INSERT INTO settings (key, value) VALUES ('qr_token', 'gymos-token-xyz-123')")

    # 4. Add Default Membership Plans
    cursor.execute("""
    INSERT INTO plans (name, price, duration_months, benefits) VALUES
    ('Monthly Fitness Pass', 999.0, 1, 'Full gym floor access + 1 free trainer consultation'),
    ('Quarterly Power Pack', 2499.0, 3, 'Full gym floor access + locker access + personalized diet chart'),
    ('Annual Elite Membership', 7999.0, 12, 'Full gym floor access + locker access + unlimited group classes + 5 guest passes')
    """)

    conn.commit()
    print("Database seeding completed.")

if __name__ == "__main__":
    init_db()
    print("Database initialized successfully.")
