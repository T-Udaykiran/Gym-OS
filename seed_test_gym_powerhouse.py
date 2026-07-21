"""
One-off script to create a fully isolated test gym ("PowerHouse Fitness")
with a production-scale, realistic dataset, for load/QA testing.

This does NOT touch any other gym's data: every row it writes carries the
newly-created gym_id (or a member_id that belongs to it), and the only
statements without a WHERE clause are single-row INSERTs of brand new
records. Re-running this script creates a second, independent test gym
rather than mutating the first (safe to re-run, but not idempotent).

Mirrors the real business logic already in this codebase rather than
inventing a new shape:
  - Gym + owner creation follows app.py's company_create_gym /
    company_mark_gym_paid (POST /api/company/gyms, .../mark-paid).
  - Member fields follow app.py's auth_register (first/last name, phone,
    emergency contact name+number, gym_id) plus the dob/gender/height/weight
    fields the member Personalize step writes.
  - Membership/payment/attendance/notification shapes and the CHECK
    constraints they must satisfy come straight from database.py's schema.

Bulk tables (members, memberships, payments, attendance, notifications,
body_stats) are written with psycopg2.extras.execute_values in batches -
the sqlite-compatible SupabaseCursor.executemany() in supabase_db.py loops
one row per network round trip, which is fine for the app's normal request
volume but would take on the order of an hour for ~65,000 attendance rows
against a remote pooler. This script drops to the raw psycopg2 connection
(SupabaseConnection._raw) only for those bulk inserts; single-row/setup
statements still go through database.py's real helpers (hash_password,
generate_gym_code, unique_gym_code) so they're produced exactly the way the
app itself would produce them.

Everything runs inside one transaction and is only committed after the
row-count/relationship checks at the bottom pass - if anything is out of
the requested bands, it rolls back instead of leaving partial data.
"""

import random
from datetime import datetime, timedelta

from psycopg2.extras import execute_values

import database

random.seed(42)

GYM_NAME = "PowerHouse Fitness"
OWNER_NAME = "Rajesh Kumar"
OWNER_PHONE = "9876543210"
OWNER_EMAIL = "owner@powerhousegym.test"
OWNER_PASSWORD = "Gym@12345"
GYM_ADDRESS = "Banjara Hills, Hyderabad"

NUM_MEMBERS = 1000
EMAIL_DOMAIN = "powerhousegym.test"

MALE_FIRST = ["Aarav", "Vihaan", "Arjun", "Aditya", "Sai", "Krishna", "Rohit", "Rahul", "Deepak", "Ramesh",
              "Suresh", "Amit", "Vikram", "Rohan", "Akash", "Anand", "Sanjay", "Sunil", "Anil", "Manoj",
              "Rajesh", "Harish", "Vinay", "Sandeep", "Alok", "Ajay", "Vijay", "Dinesh", "Naveen", "Vivek",
              "Manish", "Gaurav", "Saurav", "Raj", "Aman", "Karan", "Kabir", "Yash", "Ishan", "Dev"]
FEMALE_FIRST = ["Neha", "Priya", "Ananya", "Riya", "Diya", "Pooja", "Sneha", "Kiran", "Shruti", "Tanvi",
                "Shreya", "Kriti", "Aditi", "Anjali", "Swati", "Nisha", "Meera", "Jyoti", "Divya", "Payal",
                "Kavya", "Isha", "Nikita", "Simran", "Rhea", "Aisha", "Radha", "Lakshmi", "Deepika", "Bhavna"]
LAST_NAMES = ["Sharma", "Verma", "Patel", "Kumar", "Singh", "Joshi", "Gupta", "Mehta", "Reddy", "Rao",
              "Nair", "Pillai", "Bhat", "Iyer", "Das", "Sen", "Roy", "Banerjee", "Saxena", "Srivastava",
              "Mishra", "Pandey", "Shukla", "Tiwari", "Deshmukh", "Kulkarni", "Patil", "Shinde", "Gowda", "Hegde",
              "Menon", "Mathew", "Varghese", "Joseph", "Chatterjee", "Bose", "Dutta", "Trivedi", "Dwivedi", "Rathi"]
RELATIONS = ["Father", "Mother", "Spouse", "Sibling", "Friend"]

PLAN_TIERS = [
    ("Monthly", 1, 1800.0),
    ("Quarterly", 3, 4800.0),
    ("Half-Yearly", 6, 8800.0),
    ("Annual", 12, 15800.0),
]

PAYMENT_METHODS = ["cash", "upi", "card", "online"]


def now():
    return datetime.now()


def build_member_plan(status_bucket, tier_idx, joined_days_ago, today):
    """Returns (membership_status, start_date, end_date, is_expiring_soon)."""
    tier_name, duration_months, price = PLAN_TIERS[tier_idx]
    duration_days = duration_months * 30

    if status_bucket == "suspended":
        end_dt = today - timedelta(days=random.randint(1, 60))
        start_dt = end_dt - timedelta(days=duration_days)
        return "suspended", start_dt, end_dt, False

    if status_bucket == "expiring_soon":
        end_dt = today + timedelta(days=random.randint(1, 7))
        start_dt = end_dt - timedelta(days=duration_days)
        return "active", start_dt, end_dt, True

    # active / fee_due: healthy membership window, comfortably in the future
    start_dt = today - timedelta(days=random.randint(1, min(joined_days_ago, max(2, duration_days // 2))))
    end_dt = start_dt + timedelta(days=duration_days)
    if end_dt <= today:
        end_dt = today + timedelta(days=random.randint(15, 90))
    return "active", start_dt, end_dt, False


def main():
    print("=" * 70)
    print("Seeding isolated test gym: PowerHouse Fitness")
    print("=" * 70)

    database.init_db()
    conn = database.get_db_connection()
    cur = conn.cursor()

    # ---- 1. Gym + owner (mirrors company_create_gym / mark-paid) ----
    qr_token = f"gymos-{database.generate_gym_code(GYM_NAME).lower()}"
    cur.execute(
        "INSERT INTO gyms (name, phone, address, qr_code_token) VALUES (?, ?, ?, ?)",
        (GYM_NAME, OWNER_PHONE, GYM_ADDRESS, qr_token),
    )
    gym_id = cur.lastrowid
    gym_code = database.unique_gym_code(cur, GYM_NAME)

    owner_pw_hash = database.hash_password(OWNER_PASSWORD)
    cur.execute(
        "INSERT INTO users (email, password_hash, role, gym_id) VALUES (?, ?, 'owner', ?)",
        (OWNER_EMAIL, owner_pw_hash, gym_id),
    )
    owner_user_id = cur.lastrowid

    today_str = now().strftime("%Y-%m-%d")
    sub_end = (now() + timedelta(days=365)).strftime("%Y-%m-%d")
    cur.execute(
        "UPDATE gyms SET gym_code = ?, owner_user_id = ?, subscription_status = 'active', "
        "subscription_end_date = ? WHERE id = ?",
        (gym_code, owner_user_id, sub_end, gym_id),
    )

    cur.execute("INSERT INTO settings (key, value, gym_id) VALUES ('gym_name', ?, ?)", (GYM_NAME, gym_id))
    cur.execute("INSERT INTO settings (key, value, gym_id) VALUES ('gym_phone', ?, ?)", (OWNER_PHONE, gym_id))
    cur.execute("INSERT INTO settings (key, value, gym_id) VALUES ('gym_address', ?, ?)", (GYM_ADDRESS, gym_id))
    cur.execute("INSERT INTO settings (key, value, gym_id) VALUES ('qr_token', ?, ?)", (qr_token, gym_id))
    cur.execute("INSERT INTO settings (key, value, gym_id) VALUES ('owner_name', ?, ?)", (OWNER_NAME, gym_id))

    print(f"Gym created: id={gym_id}, gym_code={gym_code}")

    # ---- 2. Plans (one per tier, matching the requested distribution) ----
    plan_ids = []
    for tier_name, duration_months, price in PLAN_TIERS:
        cur.execute(
            "INSERT INTO plans (name, price, duration_months, benefits, gym_id) VALUES (?, ?, ?, ?, ?)",
            (f"{tier_name} Plan", price, duration_months, "Full gym floor access + locker", gym_id),
        )
        plan_ids.append(cur.lastrowid)
    print(f"Plans created: {plan_ids}")

    conn.commit()  # gym/owner/plans are committed immediately; bulk data below is its own transaction

    # ---- 3. Bulk generation (raw psycopg2 for batched inserts) ----
    raw = conn._raw  # underlying psycopg2 connection - see supabase_db.py
    raw.autocommit = False
    bcur = raw.cursor()

    today = now()

    # Status buckets: 700 active / 150 expiring_soon / 100 fee_due / 50 suspended
    status_buckets = (["active"] * 700) + (["expiring_soon"] * 150) + (["fee_due"] * 100) + (["suspended"] * 50)
    random.shuffle(status_buckets)

    # Plan tiers: 400 Monthly / 300 Quarterly / 200 Half-Yearly / 100 Annual
    tier_assignment = ([0] * 400) + ([1] * 300) + ([2] * 200) + ([3] * 100)
    random.shuffle(tier_assignment)

    print(f"Generating {NUM_MEMBERS} members...")

    users_rows = []
    member_plan = []  # per-index: (email, phone, gender, dob, height, weight, emergency_name, emergency_number,
                       #             joined_at_dt, status_bucket, tier_idx)
    used_phones = set()
    used_emails = set()

    for i in range(NUM_MEMBERS):
        gender = "male" if random.random() < 0.55 else "female"
        first = random.choice(MALE_FIRST if gender == "male" else FEMALE_FIRST)
        last = random.choice(LAST_NAMES)

        email = f"{first.lower()}.{last.lower()}{i+1}@{EMAIL_DOMAIN}"
        phone = f"7{600000000 + i:09d}"
        emergency_number = f"8{500000000 + i:09d}"
        assert phone not in used_phones and email not in used_emails
        used_phones.add(phone)
        used_emails.add(email)

        age_years = random.randint(18, 55)
        dob = (today - timedelta(days=age_years * 365 + random.randint(0, 364))).strftime("%Y-%m-%d")

        if gender == "male":
            height = round(random.uniform(160, 190), 1)
            weight = round(random.uniform(58, 95), 1)
        else:
            height = round(random.uniform(150, 175), 1)
            weight = round(random.uniform(45, 78), 1)

        emergency_name = f"{random.choice(MALE_FIRST + FEMALE_FIRST)} {random.choice(LAST_NAMES)}"
        emergency_relation = random.choice(RELATIONS)

        joined_days_ago = random.randint(15, 365)
        joined_at_dt = today - timedelta(days=joined_days_ago, hours=random.randint(0, 23))

        status_bucket = status_buckets[i]
        tier_idx = tier_assignment[i]

        users_rows.append((email, database.hash_password("Member@12345"), "member", gym_id))
        member_plan.append({
            "first": first, "last": last, "email": email, "phone": phone,
            "gender": gender, "dob": dob, "height": height, "weight": weight,
            "emergency_name": emergency_name, "emergency_number": emergency_number,
            "emergency_relation": emergency_relation,
            "joined_at": joined_at_dt, "joined_days_ago": joined_days_ago,
            "status_bucket": status_bucket, "tier_idx": tier_idx,
        })

    user_ids = [r[0] for r in execute_values(
        bcur, "INSERT INTO users (email, password_hash, role, gym_id) VALUES %s RETURNING id",
        users_rows, fetch=True,
    )]
    print(f"  {len(user_ids)} users created.")

    members_rows = []
    for m, user_id in zip(member_plan, user_ids):
        m_status = "suspended" if m["status_bucket"] == "suspended" else "active"
        legacy_emergency = f"{m['emergency_name']} / {m['emergency_number']}"
        members_rows.append((
            user_id, m["first"], m["last"], m["phone"],
            legacy_emergency, m["emergency_name"], m["emergency_number"], m["emergency_relation"],
            m_status, m["joined_at"].strftime("%Y-%m-%d %H:%M:%S"), True,
            m["dob"], m["gender"], m["height"], m["weight"], gym_id,
        ))

    member_ids = [r[0] for r in execute_values(
        bcur,
        """INSERT INTO members
           (user_id, first_name, last_name, phone, emergency_contact, emergency_contact_name,
            emergency_contact_number, emergency_contact_relation, status, joined_at,
            preferences_completed, dob, gender, height, weight, gym_id)
           VALUES %s RETURNING id""",
        members_rows, fetch=True,
    )]
    print(f"  {len(member_ids)} members created.")

    for m, member_id in zip(member_plan, member_ids):
        m["member_id"] = member_id

    # ---- 4. Memberships + payments ----
    print("Generating memberships and payments...")
    memberships_rows = []
    for m in member_plan:
        tier_name, duration_months, price = PLAN_TIERS[m["tier_idx"]]
        mem_status, start_dt, end_dt, is_expiring = build_member_plan(
            m["status_bucket"], m["tier_idx"], m["joined_days_ago"], today
        )
        m["plan_id"] = plan_ids[m["tier_idx"]]
        m["plan_price"] = price
        m["membership_status"] = mem_status
        m["membership_start"] = start_dt
        m["membership_end"] = end_dt
        memberships_rows.append((
            m["member_id"], m["plan_id"], mem_status,
            start_dt.strftime("%Y-%m-%d"), end_dt.strftime("%Y-%m-%d"), price,
            start_dt.strftime("%Y-%m-%d %H:%M:%S"), gym_id,
        ))

    membership_ids = [r[0] for r in execute_values(
        bcur,
        """INSERT INTO memberships (member_id, plan_id, status, start_date, end_date, price_paid, created_at, gym_id)
           VALUES %s RETURNING id""",
        memberships_rows, fetch=True,
    )]
    for m, membership_id in zip(member_plan, membership_ids):
        m["membership_id"] = membership_id

    payments_rows = []
    receipt_counter = 0

    def next_receipt():
        nonlocal receipt_counter
        receipt_counter += 1
        return f"RC-PH-{gym_id}-{receipt_counter:06d}"

    for m in member_plan:
        price = m["plan_price"]
        pay_dt = m["membership_start"] + timedelta(hours=random.randint(1, 20))
        if pay_dt > today:
            pay_dt = today - timedelta(minutes=random.randint(5, 500))
        method = random.choice(PAYMENT_METHODS)

        if m["status_bucket"] == "fee_due":
            # Outstanding dues: no paid record yet for the current cycle.
            due_dt = today + timedelta(days=random.randint(-10, 10))
            payments_rows.append((
                m["membership_id"], m["member_id"], price, random.choice(["pending", "overdue"]),
                None, due_dt.strftime("%Y-%m-%d"), None,
                m["membership_start"].strftime("%Y-%m-%d %H:%M:%S"), gym_id, m["plan_id"], method,
            ))
        else:
            discount = random.random() < 0.15
            amount = round(price * random.uniform(0.85, 0.95), 2) if discount else price

            partial = (not discount) and random.random() < 0.55
            if partial:
                first_amount = round(amount * random.uniform(0.4, 0.6), 2)
                payments_rows.append((
                    m["membership_id"], m["member_id"], first_amount, "paid",
                    pay_dt.strftime("%Y-%m-%d %H:%M:%S"), None, next_receipt(),
                    m["membership_start"].strftime("%Y-%m-%d %H:%M:%S"), gym_id, m["plan_id"], method,
                ))
                remainder_due = (pay_dt + timedelta(days=15)).strftime("%Y-%m-%d")
                payments_rows.append((
                    m["membership_id"], m["member_id"], round(amount - first_amount, 2), "pending",
                    None, remainder_due, None,
                    m["membership_start"].strftime("%Y-%m-%d %H:%M:%S"), gym_id, m["plan_id"], method,
                ))
            else:
                payments_rows.append((
                    m["membership_id"], m["member_id"], amount, "paid",
                    pay_dt.strftime("%Y-%m-%d %H:%M:%S"), None, next_receipt(),
                    m["membership_start"].strftime("%Y-%m-%d %H:%M:%S"), gym_id, m["plan_id"], method,
                ))

        # Renewal history for members whose tenure comfortably exceeds one plan cycle.
        duration_days = PLAN_TIERS[m["tier_idx"]][1] * 30
        if m["joined_days_ago"] > duration_days and random.random() < 0.95:
            num_renewals = random.choice([2, 3, 3, 4, 4])
            cycle_start = m["membership_start"]
            for _ in range(num_renewals):
                cycle_start = cycle_start - timedelta(days=duration_days + random.randint(0, 5))
                if cycle_start < m["joined_at"]:
                    break
                renewal_pay_dt = cycle_start + timedelta(hours=random.randint(1, 20))
                payments_rows.append((
                    m["membership_id"], m["member_id"], price, "paid",
                    renewal_pay_dt.strftime("%Y-%m-%d %H:%M:%S"), None, next_receipt(),
                    cycle_start.strftime("%Y-%m-%d %H:%M:%S"), gym_id, m["plan_id"], random.choice(PAYMENT_METHODS),
                ))

        # Occasional add-on purchases (PT sessions, guest passes) - a smaller,
        # independent payment not tied to the membership renewal cycle.
        if random.random() < 0.55:
            addon_amount = round(random.uniform(300, 1500), 2)
            addon_dt = m["joined_at"] + timedelta(days=random.randint(1, max(1, m["joined_days_ago"] - 1)),
                                                   hours=random.randint(1, 20))
            if addon_dt > today:
                addon_dt = today - timedelta(minutes=random.randint(5, 500))
            payments_rows.append((
                m["membership_id"], m["member_id"], addon_amount, "paid",
                addon_dt.strftime("%Y-%m-%d %H:%M:%S"), None, next_receipt(),
                addon_dt.strftime("%Y-%m-%d %H:%M:%S"), gym_id, m["plan_id"], random.choice(PAYMENT_METHODS),
            ))

    for chunk_start in range(0, len(payments_rows), 2000):
        execute_values(
            bcur,
            """INSERT INTO payments
               (membership_id, member_id, amount, status, payment_date, due_date, receipt_number,
                created_at, gym_id, plan_id, payment_method)
               VALUES %s""",
            payments_rows[chunk_start:chunk_start + 2000],
        )
    print(f"  {len(payments_rows)} payments created.")

    # ---- 5. Attendance ----
    print("Generating attendance history...")
    attendance_rows = []
    checkinable = [m for m in member_plan if m["status_bucket"] != "suspended"]

    def sample_time_of_day():
        r = random.random()
        if r < 0.35:
            return random.randint(6, 9), random.randint(0, 59)
        elif r < 0.55:
            return random.randint(12, 14), random.randint(0, 59)
        else:
            return random.randint(17, 21), random.randint(0, 59)

    today_checkin_members = random.sample(checkinable, min(220, len(checkinable)))
    today_checkin_ids = {m["member_id"] for m in today_checkin_members}

    for m in checkinable:
        session_count = random.randint(15, 120)
        max_days_back = max(m["joined_days_ago"], 1)
        for s in range(session_count):
            if s == 0 and m["member_id"] in today_checkin_ids:
                day_offset = 0
            else:
                # Recency-weighted: more sessions in recent weeks than long ago.
                day_offset = int(random.triangular(0, max_days_back, 0))
            hour, minute = sample_time_of_day()
            # Slight weekday bias: redraw once if a weekend day was picked and we lose the reroll.
            candidate = today - timedelta(days=day_offset)
            if candidate.weekday() >= 5 and random.random() < 0.4:
                day_offset = max(0, day_offset - 1)
            check_in = (today - timedelta(days=day_offset)).replace(hour=hour, minute=minute, second=0, microsecond=0)
            if check_in > today:
                check_in = today - timedelta(minutes=random.randint(1, 30))
            duration_min = random.randint(30, 100)
            check_out = check_in + timedelta(minutes=duration_min)
            still_active = (day_offset == 0 and check_out > today and random.random() < 0.1)
            check_out_str = None if still_active else check_out.strftime("%Y-%m-%d %H:%M:%S")
            attendance_rows.append((
                m["member_id"], check_in.strftime("%Y-%m-%d %H:%M:%S"), check_out_str, "success", None,
                check_in.strftime("%Y-%m-%d"), gym_id, "checked_in" if still_active else "completed",
            ))

    for chunk_start in range(0, len(attendance_rows), 5000):
        execute_values(
            bcur,
            """INSERT INTO attendance
               (member_id, check_in_time, check_out_time, status, error_msg, attendance_date, gym_id, attendance_state)
               VALUES %s""",
            attendance_rows[chunk_start:chunk_start + 5000],
        )
    print(f"  {len(attendance_rows)} attendance records created.")

    # ---- 6. Body stats ----
    print("Generating body stats history...")
    body_stats_rows = []
    for m in member_plan:
        entries = random.randint(3, 6)
        base_weight = m["weight"]
        trend = random.uniform(-0.15, 0.1)  # kg/week drift, some losing some gaining
        goal_weight = round(base_weight + (-4 if trend < 0 else 3), 1)
        w = base_weight
        span_days = min(m["joined_days_ago"], 300)
        checkpoints = sorted(random.sample(range(0, span_days + 1), min(entries, span_days + 1)) or [0])
        for days_ago in reversed(checkpoints):
            w = max(40.0, round(w + trend * random.uniform(0.5, 1.5) + random.uniform(-0.6, 0.6), 1))
            created = (today - timedelta(days=days_ago)).strftime("%Y-%m-%d %H:%M:%S")
            body_stats_rows.append((m["member_id"], w, m["height"], goal_weight, created, gym_id))

    for chunk_start in range(0, len(body_stats_rows), 2000):
        execute_values(
            bcur,
            "INSERT INTO body_stats (member_id, weight, height, goal_weight, created_at, gym_id) VALUES %s",
            body_stats_rows[chunk_start:chunk_start + 2000],
        )
    print(f"  {len(body_stats_rows)} body_stats records created.")
    print("  NOTE: body_stats has no body_fat_pct/muscle_pct columns in the current schema -")
    print("  only weight/height/goal_weight are tracked, so those two metrics were not fabricated.")

    # ---- 7. Notifications ----
    # Schema only allows type IN ('payment','expiry','welcome','renewal') - no dedicated
    # check-in/workout-reminder type exists, so those concepts are folded into the closest
    # real type below rather than bypassing the CHECK constraint.
    print("Generating notifications...")
    notif_rows = []
    for m, user_id in zip(member_plan, user_ids):
        notif_rows.append((
            user_id, "welcome",
            f"Welcome to PowerHouse Fitness, {m['first']}! Your membership is now active.",
            random.choice([0, 1]), (m["joined_at"]).strftime("%Y-%m-%d %H:%M:%S"), gym_id,
        ))
        if m["status_bucket"] == "expiring_soon":
            notif_rows.append((
                user_id, "expiry",
                f"Your {PLAN_TIERS[m['tier_idx']][0]} membership expires on {m['membership_end'].strftime('%d %b %Y')}. Renew to keep your streak going!",
                random.choice([0, 1]), (today - timedelta(days=random.randint(0, 2))).strftime("%Y-%m-%d %H:%M:%S"), gym_id,
            ))
        if m["status_bucket"] == "fee_due":
            notif_rows.append((
                user_id, "payment",
                f"Payment due: Rs.{m['plan_price']:.0f} pending for your {PLAN_TIERS[m['tier_idx']][0]} plan. Please clear dues to avoid suspension.",
                random.choice([0, 1]), (today - timedelta(days=random.randint(0, 5))).strftime("%Y-%m-%d %H:%M:%S"), gym_id,
            ))
        else:
            notif_rows.append((
                user_id, "payment",
                "Payment received successfully. Thank you for training with us - see you at your next check-in!",
                random.choice([0, 1]), (m["membership_start"] + timedelta(hours=3)).strftime("%Y-%m-%d %H:%M:%S"), gym_id,
            ))
        if random.random() < 0.3:
            notif_rows.append((
                user_id, "renewal",
                f"Reminder: keep up the momentum - your next workout session is due. Check in at {GYM_NAME} today!",
                random.choice([0, 1]), (today - timedelta(days=random.randint(0, 20))).strftime("%Y-%m-%d %H:%M:%S"), gym_id,
            ))

    for chunk_start in range(0, len(notif_rows), 2000):
        execute_values(
            bcur,
            "INSERT INTO notifications (user_id, type, message, read_status, created_at, gym_id) VALUES %s",
            notif_rows[chunk_start:chunk_start + 2000],
        )
    print(f"  {len(notif_rows)} notifications created.")

    # ---- 8. Verification, BEFORE commit ----
    print("\n" + "=" * 70)
    print("Validating before commit...")
    print("=" * 70)

    checks = {}
    bcur.execute("SELECT COUNT(*) FROM members WHERE gym_id = %s", (gym_id,))
    checks["total_members"] = bcur.fetchone()[0]

    bcur.execute("SELECT COUNT(*) FROM attendance WHERE gym_id = %s", (gym_id,))
    checks["total_attendance"] = bcur.fetchone()[0]

    bcur.execute("SELECT COUNT(*) FROM payments WHERE gym_id = %s", (gym_id,))
    checks["total_payments"] = bcur.fetchone()[0]

    bcur.execute("SELECT COUNT(*) FROM notifications WHERE gym_id = %s", (gym_id,))
    checks["total_notifications"] = bcur.fetchone()[0]

    bcur.execute("SELECT COUNT(DISTINCT phone) FROM members WHERE gym_id = %s", (gym_id,))
    checks["distinct_phones"] = bcur.fetchone()[0]

    bcur.execute("""
        SELECT COUNT(*) FROM attendance a
        LEFT JOIN members m ON a.member_id = m.id AND m.gym_id = %s
        WHERE a.gym_id = %s AND m.id IS NULL
    """, (gym_id, gym_id))
    checks["orphan_attendance"] = bcur.fetchone()[0]

    bcur.execute("""
        SELECT COUNT(*) FROM payments p
        LEFT JOIN members m ON p.member_id = m.id AND m.gym_id = %s
        WHERE p.gym_id = %s AND m.id IS NULL
    """, (gym_id, gym_id))
    checks["orphan_payments"] = bcur.fetchone()[0]

    bcur.execute("""
        SELECT COUNT(*) FROM notifications n
        JOIN users u ON n.user_id = u.id
        LEFT JOIN members m ON m.user_id = u.id AND m.gym_id = %s
        WHERE n.gym_id = %s AND u.role = 'member' AND m.id IS NULL
    """, (gym_id, gym_id))
    checks["orphan_notifications"] = bcur.fetchone()[0]

    for k, v in checks.items():
        print(f"  {k}: {v}")

    problems = []
    if checks["total_members"] != NUM_MEMBERS:
        problems.append(f"expected {NUM_MEMBERS} members, got {checks['total_members']}")
    if checks["distinct_phones"] != NUM_MEMBERS:
        problems.append("duplicate phone numbers within this gym")
    if not (50000 <= checks["total_attendance"] <= 80000):
        problems.append(f"attendance count {checks['total_attendance']} outside 50,000-80,000 band")
    if not (3000 <= checks["total_payments"] <= 5000):
        problems.append(f"payment count {checks['total_payments']} outside 3,000-5,000 band")
    if checks["orphan_attendance"] or checks["orphan_payments"] or checks["orphan_notifications"]:
        problems.append("orphaned rows found (see orphan_* counts above)")

    if problems:
        print("\nVALIDATION FAILED - rolling back, no data committed:")
        for p in problems:
            print(f"  - {p}")
        raw.rollback()
        conn.rollback()
        return

    raw.commit()
    print("\nAll checks passed. Committing.")

    print("\n" + "=" * 70)
    print("DELIVERABLES")
    print("=" * 70)
    print(f"Gym ID: {gym_id}")
    print(f"Gym Name: {GYM_NAME}")
    print(f"Gym Code: {gym_code}")
    print(f"Owner Name: {OWNER_NAME}")
    print(f"Owner Email: {OWNER_EMAIL}")
    print(f"Owner Password: {OWNER_PASSWORD}")
    print(f"Total Members: {checks['total_members']}")
    print(f"Total Attendance Records: {checks['total_attendance']}")
    print(f"Total Payments: {checks['total_payments']}")
    print(f"Total Notifications: {checks['total_notifications']}")
    print(f"Total Body Stats Records: {len(body_stats_rows)}")

    conn.close()


if __name__ == "__main__":
    main()
