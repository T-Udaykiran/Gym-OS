"""
One-off script to seed demo members + attendance history for a client demo
of the Leaderboard screen. Safe to run against whichever database is
currently configured (local sqlite or Turso, same as the app).

All demo accounts use emails matching demo_*@gymdemo.local so they're easy
to find and remove later:

    DELETE FROM users WHERE email LIKE 'demo_%@gymdemo.local';

(members/attendance rows cascade-delete via the FOREIGN KEY ... ON DELETE
CASCADE already defined on those tables.)
"""

import random
from datetime import datetime, timedelta

import database

# (first_name, last_name, total_checkins_over_last_30_days)
DEMO_MEMBERS = [
    ("Arjun", "Reddy", 24),
    ("Priya", "Sharma", 21),
    ("Karthik", "Rao", 19),
    ("Sneha", "Iyer", 17),
    ("Vikram", "Singh", 15),
    ("Ananya", "Nair", 12),
    ("Rahul", "Verma", 9),
    ("Divya", "Menon", 6),
]


def main():
    database.init_db()
    conn = database.get_db_connection()
    cursor = conn.cursor()

    created = []
    for idx, (first, last, checkin_count) in enumerate(DEMO_MEMBERS, start=1):
        email = f"demo_{first.lower()}{idx}@gymdemo.local"
        phone = f"9800000{idx:03d}"
        password_hash = database.hash_password("demo-not-a-real-login")

        cursor.execute(
            "INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'member')",
            (email, password_hash),
        )
        user_id = cursor.lastrowid

        cursor.execute(
            "INSERT INTO members (user_id, first_name, last_name, phone, emergency_contact, status) "
            "VALUES (?, ?, ?, ?, ?, 'active')",
            (user_id, first, last, phone, "Demo Contact / 9999999999"),
        )
        member_id = cursor.lastrowid

        # Spread check-ins across the last 30 days, most recent days weighted
        # so the weekly leaderboard also has enough data to look populated.
        days_used = random.sample(range(0, 30), k=min(checkin_count, 30))
        for day_offset in days_used:
            checkin_dt = datetime.now() - timedelta(days=day_offset)
            checkin_dt = checkin_dt.replace(
                hour=random.randint(6, 20), minute=random.randint(0, 59), second=0
            )
            checkout_dt = checkin_dt + timedelta(minutes=random.randint(35, 90))
            date_str = checkin_dt.strftime("%Y-%m-%d")
            cursor.execute(
                "INSERT INTO attendance (member_id, check_in_time, check_out_time, status, "
                "attendance_date, gym_id, attendance_state) VALUES (?, ?, ?, 'success', ?, 1, 'completed')",
                (
                    member_id,
                    checkin_dt.strftime("%Y-%m-%d %H:%M:%S"),
                    checkout_dt.strftime("%Y-%m-%d %H:%M:%S"),
                    date_str,
                ),
            )

        conn.commit()
        created.append((email, member_id, len(days_used)))
        print(f"Created {first} {last} (member_id={member_id}) with {len(days_used)} check-ins")

    conn.close()
    print(f"\nDone. Seeded {len(created)} demo members.")
    print("To remove later: DELETE FROM users WHERE email LIKE 'demo_%@gymdemo.local';")


if __name__ == "__main__":
    main()
