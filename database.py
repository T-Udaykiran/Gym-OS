import sqlite3
import hashlib
import os
import json
import shutil
from datetime import datetime, timedelta

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
PACKAGED_DB_FILE = os.path.join(PROJECT_DIR, "gymos.db")

# Vercel mounts the deployed project as read-only.  SQLite needs a writable
# directory, so use the only writable location available to a serverless
# function.  The copy is a cold-start seed only; it is not durable storage.
if os.environ.get("VERCEL") or os.environ.get("VERCEL_ENV"):
    DB_FILE = os.path.join("/tmp", "gymos.db")
    if not os.path.exists(DB_FILE) and os.path.exists(PACKAGED_DB_FILE):
        shutil.copy2(PACKAGED_DB_FILE, DB_FILE)
else:
    DB_FILE = PACKAGED_DB_FILE

def get_db_connection():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    # Enable foreign keys
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn

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
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT CHECK(role IN ('owner', 'member')) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # Create Gym table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS gyms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT,
        address TEXT,
        qr_code_token TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # Create Members table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER UNIQUE NOT NULL,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        emergency_contact TEXT,
        status TEXT CHECK(status IN ('active', 'suspended', 'expired', 'pending', 'rejected')) DEFAULT 'pending',
        profile_photo TEXT,
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );
    """)

    # Create Membership Plans table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        price REAL NOT NULL,
        duration_months INTEGER NOT NULL,
        benefits TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # Create Memberships table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS memberships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER NOT NULL,
        plan_id INTEGER NOT NULL,
        status TEXT CHECK(status IN ('active', 'suspended', 'expired')) DEFAULT 'active',
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        price_paid REAL NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE,
        FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE RESTRICT
    );
    """)

    # Create Attendance table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER NOT NULL,
        check_in_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        check_out_time TIMESTAMP,
        status TEXT CHECK(status IN ('success', 'failed')) NOT NULL,
        error_msg TEXT,
        FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
    );
    """)

    # Lightweight migrations for attendance records created before the mobile
    # scanner flow was introduced.
    attendance_columns = {row[1] for row in cursor.execute("PRAGMA table_info(attendance)")}
    if "attendance_date" not in attendance_columns:
        cursor.execute("ALTER TABLE attendance ADD COLUMN attendance_date TEXT")
    if "gym_id" not in attendance_columns:
        cursor.execute("ALTER TABLE attendance ADD COLUMN gym_id INTEGER")
    if "attendance_state" not in attendance_columns:
        cursor.execute("ALTER TABLE attendance ADD COLUMN attendance_state TEXT DEFAULT 'checked_in'")
    cursor.execute("UPDATE attendance SET attendance_date = date(check_in_time) WHERE attendance_date IS NULL")
    cursor.execute("UPDATE attendance SET gym_id = 1 WHERE gym_id IS NULL")
    cursor.execute("UPDATE attendance SET attendance_state = CASE WHEN check_out_time IS NULL THEN 'checked_in' ELSE 'completed' END WHERE attendance_state IS NULL")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_attendance_member_day ON attendance(member_id, attendance_date)")

    # Create Payments table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        membership_id INTEGER,
        member_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        status TEXT CHECK(status IN ('paid', 'pending', 'overdue', 'pending_approval')) DEFAULT 'paid',
        payment_date TIMESTAMP,
        due_date TEXT,
        receipt_number TEXT UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (membership_id) REFERENCES memberships (id) ON DELETE SET NULL,
        FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
    );
    """)

    # Create Notifications table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        type TEXT CHECK(type IN ('payment', 'expiry', 'welcome', 'renewal')) NOT NULL,
        message TEXT NOT NULL,
        read_status INTEGER CHECK(read_status IN (0, 1)) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );
    """)

    # Create Settings table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        value TEXT NOT NULL
    );
    """)

    # Migration: Update members status CHECK constraint to support 'pending' and 'rejected'
    # (older databases only allowed active/suspended/expired, which made every new
    # registration raise a CHECK-constraint IntegrityError since new members are
    # inserted with status='pending').
    cursor.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='members'")
    sql_row = cursor.fetchone()
    if sql_row:
        sql = sql_row[0]
        if "'pending'" not in sql:
            conn.commit()  # foreign_keys pragma is a no-op inside an open transaction
            cursor.execute("PRAGMA foreign_keys=OFF;")
            cursor.execute("ALTER TABLE members RENAME TO members_old;")
            cursor.execute("""
            CREATE TABLE members (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER UNIQUE NOT NULL,
                first_name TEXT NOT NULL,
                last_name TEXT NOT NULL,
                phone TEXT NOT NULL,
                emergency_contact TEXT,
                status TEXT CHECK(status IN ('active', 'suspended', 'expired', 'pending', 'rejected')) DEFAULT 'pending',
                profile_photo TEXT,
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
            );
            """)
            cursor.execute("""
            INSERT INTO members (id, user_id, first_name, last_name, phone, emergency_contact, status, profile_photo, joined_at)
            SELECT id, user_id, first_name, last_name, phone, emergency_contact, status, profile_photo, joined_at
            FROM members_old;
            """)
            cursor.execute("DROP TABLE members_old;")
            conn.commit()
            cursor.execute("PRAGMA foreign_keys=ON;")

    # Migration: Update payments status CHECK constraint to support 'pending_approval'
    cursor.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='payments'")
    sql_row = cursor.fetchone()
    if sql_row:
        sql = sql_row[0]
        if "pending_approval" not in sql:
            cursor.execute("PRAGMA foreign_keys=OFF;")
            cursor.execute("ALTER TABLE payments RENAME TO payments_old;")
            cursor.execute("""
            CREATE TABLE payments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                membership_id INTEGER,
                member_id INTEGER NOT NULL,
                amount REAL NOT NULL,
                status TEXT CHECK(status IN ('paid', 'pending', 'overdue', 'pending_approval')) DEFAULT 'paid',
                payment_date TIMESTAMP,
                due_date TEXT,
                receipt_number TEXT UNIQUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (membership_id) REFERENCES memberships (id) ON DELETE SET NULL,
                FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
            );
            """)
            cursor.execute("""
            INSERT INTO payments (id, membership_id, member_id, amount, status, payment_date, due_date, receipt_number, created_at)
            SELECT id, membership_id, member_id, amount, status, payment_date, due_date, receipt_number, created_at
            FROM payments_old;
            """)
            cursor.execute("DROP TABLE payments_old;")
            cursor.execute("PRAGMA foreign_keys=ON;")

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
    
    conn.commit()
    print("Database seeding completed.")

if __name__ == "__main__":
    init_db()
    print("Database initialized successfully.")
