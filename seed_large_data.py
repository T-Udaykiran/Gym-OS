import sqlite3
import os
import random
from datetime import datetime, timedelta
import database

def main():
    print("Starting large-scale GymOS DB seeding...")
    
    # Remove existing db if it exists to start fresh
    if os.path.exists(database.DB_FILE):
        try:
            os.remove(database.DB_FILE)
            print("Deleted old database file.")
        except Exception as e:
            print(f"Could not remove database file: {e}")

    # Re-initialize the &schema
    database.init_db()
    
    conn = database.get_db_connection()
    cursor = conn.cursor()
    
    # 1. Clear database seeded rows (except owner account)
    cursor.execute("DELETE FROM attendance")
    cursor.execute("DELETE FROM payments")
    cursor.execute("DELETE FROM memberships")
    cursor.execute("DELETE FROM notifications")
    cursor.execute("DELETE FROM members")
    cursor.execute("DELETE FROM users WHERE role = 'member'")
    cursor.execute("DELETE FROM plans")
    cursor.execute("DELETE FROM settings")
    
    # 2. Insert Settings
    cursor.execute("INSERT INTO settings (key, value) VALUES ('gym_name', 'GymOS Fitness Center')")
    cursor.execute("INSERT INTO settings (key, value) VALUES ('gym_phone', '+919876543210')")
    cursor.execute("INSERT INTO settings (key, value) VALUES ('settingsQRToken', 'gymos-token-xyz-123')")
    cursor.execute("INSERT INTO settings (key, value) VALUES ('qr_token', 'gymos-token-xyz-123')")
    cursor.execute("INSERT INTO settings (key, value) VALUES ('gym_address', '45, Premium Ring Road, HSR Layout, Bengaluru, Karnataka - 560102')")
    
    # 3. Add 12 Membership Plans
    plans_data = [
        # Name, Price (Rupees), Duration, Benefits
        ("Monthly Basic", 1500.0, 1, "Gym Access, Cardio Section"),
        ("Monthly Premium", 2500.0, 1, "Gym, Cardio, Steam Room, 2 Guest Passes"),
        ("Monthly Elite", 4000.0, 1, "All Access + Pool, Sauna, Towel service, 1 PT session"),
        
        ("Quarterly Basic", 4000.0, 3, "Gym Access, Cardio Section (Bulk savings)"),
        ("Quarterly Premium", 6500.0, 3, "Gym, Cardio, Steam, Locker, 4 Guest Passes"),
        ("Quarterly Elite", 10000.0, 3, "All Access + Pool, Sauna, Towel, Locker, 3 PT sessions"),
        
        ("Half-Yearly Basic", 7500.0, 6, "Gym Access, Cardio (Best budget 6m)"),
        ("Half-Yearly Premium", 12000.0, 6, "Gym, Cardio, Steam, Locker, Towels, 8 Guest Passes"),
        ("Half-Yearly Elite", 18000.0, 6, "All Access + Locker, Towel, Pool, Sauna, 6 PT sessions"),
        
        ("Yearly Basic", 13000.0, 12, "Gym Access, Cardio (Super Saver 12m)"),
        ("Yearly Premium", 20000.0, 12, "Gym, Cardio, Steam, Locker, Towels, unlimited Guest Passes"),
        ("Yearly Elite", 32000.0, 12, "All Access Premium + Pool, Sauna, Own Locker, 12 PT sessions + Free T-Shirt")
    ]
    
    cursor.executemany(
        "INSERT INTO plans (name, price, duration_months, benefits) VALUES (?, ?, ?, ?)",
        plans_data
    )
    
    cursor.execute("SELECT id, name, price, duration_months FROM plans")
    plans = [{"id": r[0], "name": r[1], "price": r[2], "duration_months": r[3]} for r in cursor.fetchall()]
    
    # Indian names bank
    first_names = [
        "Aarav", "Vihaan", "Arjun", "Aditya", "Sai", "Krishna", "Rohit", "Rahul", "Deepak", "Ramesh",
        "Suresh", "Amit", "Vikram", "Rohan", "Akash", "Anand", "Sanjay", "Sunil", "Anil", "Manoj",
        "Rajesh", "Harish", "Vinay", "Sandeep", "Alok", "Ajay", "Vijay", "Dinesh", "Naveen", "Vivek",
        "Manish", "Gaurav", "Saurav", "Raj", "Aman", "Karan", "Kabir", "Yash", "Ishan", "Dev",
        "Veer", "Kunal", "Pranav", "Ritvik", "Sameer", "Tushar", "Varun", "Vikas", "Abhishek", "Rishi",
        "Neha", "Priya", "Ananya", "Riya", "Diya", "Pooja", "Sneha", "Kiran", "Shruti", "Tanvi",
        "Shreya", "Kriti", "Aditi", "Anjali", "Swati", "Nisha", "Meera", "Jyoti", "Divya", "Payal"
    ]
    
    last_names = [
        "Sharma", "Verma", "Patel", "Kumar", "Singh", "Joshi", "Gupta", "Mehta", "Reddy", "Rao",
        "Nair", "Pillai", "Bhat", "Iyer", "Iyengar", "Das", "Sen", "Roy", "Banerjee", "Chatterjee",
        "Mukherjee", "Bose", "Dutta", "Ghose", "Saxena", "Srivastava", "Dwivedi", "Trivedi", "Mishra", "Pandey",
        "Shukla", "Tiwari", "Choudhury", "Deshmukh", "Kulkarni", "Patil", "Shinde", "More", "Gowda", "Hegde",
        "Shenoy", "Pai", "Nayak", "Prabhu", "Menon", "Kurian", "Mathew", "Varghese", "Joseph", "Nandamuri"
    ]
    
    num_members = 2550
    print(f"Generating {num_members} members...")
    
    # We distribute members across status categories to hit explicit dashboard requirements:
    # 1800 Active Members (with active plans)
    # 700 Expired Members (with expired plans)
    # 50 Suspended Members (with suspended plans)
    statuses = (['active'] * 1800) + (['expired'] * 700) + (['suspended'] * 50)
    random.shuffle(statuses)
    
    today = datetime.now()
    
    pending_records_to_create = 100
    expiring_soon_records_to_create = 50
    renewals_to_create = 350
    
    pending_count = 0
    expiring_count = 0
    renewal_count = 0
    
    member_password_hash = database.hash_password("password123")
    
    members_list = []
    for i in range(num_members):
        fn = first_names[i % len(first_names)]
        ln = last_names[(i // len(first_names)) % len(last_names)]
        
        email = f"{fn.lower()}.{ln.lower()}{i+1}@gymos.in"
        phone = f"+919876{i:06d}"
        emergency = f"+919988{i:06d}"
        status = statuses[i]
        
        # Insert User
        cursor.execute(
            "INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)",
            (email, member_password_hash, "member")
        )
        user_id = cursor.lastrowid
        
        # Joined date spread over the last 365 days
        joined_days_ago = random.randint(10, 365)
        joined_at = (today - timedelta(days=joined_days_ago, hours=random.randint(0, 23))).strftime("%Y-%m-%d %H:%M:%S")
        
        # Insert Member
        cursor.execute(
            "INSERT INTO members (user_id, first_name, last_name, phone, emergency_contact, status, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (user_id, fn, ln, phone, emergency, status, joined_at)
        )
        member_id = cursor.lastrowid
        members_list.append((member_id, status, joined_days_ago, joined_at, fn, ln, user_id))
        
    print("Users & Members created.")
    
    # 12 Months of revenue history. We need to make sure:
    # 1. Total revenue exists for every month of the past year.
    # 2. For the CURRENT month (today), sum of paid payments is EXACTLY ₹5,42,000.
    monthly_revenue_targets = {
        (today - timedelta(days=i*30)).strftime("%Y-%m"): (542000 if i == 0 else random.randint(480000, 560000))
        for i in range(12)
    }
    
    print("Target monthly revenues:", monthly_revenue_targets)
    payments_by_month = {m: [] for m in monthly_revenue_targets}
    payments_count = 0
    
    for member_id, m_status, joined_days, joined_at_str, fn, ln, user_id in members_list:
        joined_dt = datetime.strptime(joined_at_str, "%Y-%m-%d %H:%M:%S")
        
        # Check if renewal
        is_renewal = False
        if renewal_count < renewals_to_create and joined_days > 120:
            is_renewal = True
            renewal_count += 1
            
        # Create historical membership if renewal
        if is_renewal:
            past_plan = random.choice(plans[:6]) # Let's use lower duration plans for historical
            past_start = joined_dt
            past_duration_days = past_plan["duration_months"] * 30
            past_end = past_start + timedelta(days=past_duration_days)
            
            # Make sure past end date is strictly in the past (before today)
            if past_end > today:
                # Truncate duration or shift start date backwards
                past_start = today - timedelta(days=past_duration_days + random.randint(10, 30))
                past_end = past_start + timedelta(days=past_duration_days)
                
            cursor.execute(
                "INSERT INTO memberships (member_id, plan_id, status, start_date, end_date, price_paid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (member_id, past_plan["id"], "expired", past_start.strftime("%Y-%m-%d"), past_end.strftime("%Y-%m-%d"), past_plan["price"], past_start.strftime("%Y-%m-%d %H:%M:%S"))
            )
            past_membership_id = cursor.lastrowid
            
            # Payment for expired membership
            pay_month = past_start.strftime("%Y-%m")
            pay_date = (past_start + timedelta(hours=2)).strftime("%Y-%m-%d %H:%M:%S")
            receipt = f"RC-EXP-{member_id}-{random.randint(1000, 9999)}"
            cursor.execute(
                "INSERT INTO payments (membership_id, member_id, amount, status, payment_date, receipt_number, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (past_membership_id, member_id, past_plan["price"], "paid", pay_date, receipt, past_start.strftime("%Y-%m-%d %H:%M:%S"))
            )
            payments_count += 1
            if pay_month in payments_by_month:
                payments_by_month[pay_month].append((cursor.lastrowid, past_plan["price"]))
                
            # Current membership starts after past membership ends
            start_dt = past_end + timedelta(days=1)
        else:
            start_dt = joined_dt
            
        # Select current plan
        # If expiring soon: plan should end in 1 to 7 days.
        is_expiring_soon = False
        if m_status == 'active' and expiring_count < expiring_soon_records_to_create:
            is_expiring_soon = True
            expiring_count += 1
            
        plan = random.choice(plans)
        plan_id = plan["id"]
        price = plan["price"]
        duration = plan["duration_months"]
        
        # Calculate current end date
        if is_expiring_soon:
            end_dt = today + timedelta(days=random.randint(1, 7))
            start_dt = end_dt - timedelta(days=duration * 30)
        elif m_status == 'active':
            # It starts in the past and ends in the future
            start_dt = today - timedelta(days=random.randint(1, min(joined_days, max(2, duration*20))))
            end_dt = start_dt + timedelta(days=duration * 30)
            if end_dt <= today:
                # Push end date to future
                end_dt = today + timedelta(days=random.randint(10, 90))
        elif m_status == 'expired':
            # It ended in the past
            end_dt = today - timedelta(days=random.randint(1, 100))
            start_dt = end_dt - timedelta(days=duration * 30)
        else: # suspended
            # Starts in past, ends in future
            start_dt = today - timedelta(days=random.randint(1, min(joined_days, max(2, duration*20))))
            end_dt = start_dt + timedelta(days=duration * 30)
            
        # Double check that start_dt <= today and start_dt <= end_dt
        if start_dt > today:
            start_dt = today - timedelta(days=1)
        if end_dt <= start_dt:
            end_dt = start_dt + timedelta(days=duration * 30)
            
        start_str = start_dt.strftime("%Y-%m-%d")
        end_str = end_dt.strftime("%Y-%m-%d")
        
        cursor.execute(
            "INSERT INTO memberships (member_id, plan_id, status, start_date, end_date, price_paid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (member_id, plan_id, m_status, start_str, end_str, price, start_dt.strftime("%Y-%m-%d %H:%M:%S"))
        )
        membership_id = cursor.lastrowid
        
        # Determine payment status
        # If chosen for pending list (exactly 100 pending/overdue records)
        is_pending = False
        if m_status in ('active', 'suspended') and pending_count < pending_records_to_create:
            is_pending = True
            pending_count += 1
            
        if is_pending:
            p_status = random.choice(['pending', 'overdue'])
            due_str = (today + timedelta(days=random.randint(-15, 15))).strftime("%Y-%m-%d")
            cursor.execute(
                "INSERT INTO payments (membership_id, member_id, amount, status, due_date, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (membership_id, member_id, price, p_status, due_str, start_dt.strftime("%Y-%m-%d %H:%M:%S"))
            )
        else: # Paid membership payment
            pay_dt = start_dt + timedelta(hours=random.randint(1, 23))
            
            # Make sure payment date is not in the future
            if pay_dt > today:
                pay_dt = today - timedelta(minutes=random.randint(5, 120))
                
            pay_month = pay_dt.strftime("%Y-%m")
            receipt = f"RC-PAY-{member_id}-{random.randint(1000, 9999)}"
            
            cursor.execute(
                "INSERT INTO payments (membership_id, member_id, amount, status, payment_date, receipt_number, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (membership_id, member_id, price, "paid", pay_dt.strftime("%Y-%m-%d %H:%M:%S"), receipt, start_dt.strftime("%Y-%m-%d %H:%M:%S"))
            )
            payments_count += 1
            if pay_month in payments_by_month:
                payments_by_month[pay_month].append((cursor.lastrowid, price))
                
    print(f"Base payments generated: {payments_count} paid records.")
    
    # Fill monthly revenue targets exactly by scaling the payments
    for month_str, target_val in monthly_revenue_targets.items():
        records = payments_by_month[month_str]
        if len(records) == 0:
            continue
            
        current_sum = sum(price for r_id, price in records)
        delta = target_val - current_sum
        
        # Distribute delta across records
        chunk = delta / len(records)
        for r_id, old_price in records:
            new_amount = round(old_price + chunk, 2)
            cursor.execute("UPDATE payments SET amount = ? WHERE id = ?", (new_amount, r_id))
            
        # Ensure exact match by adjusting the last record
        cursor.execute("SELECT SUM(amount) FROM payments WHERE status = 'paid' AND payment_date LIKE ?", (f"{month_str}%",))
        actual_sum = cursor.fetchone()[0] or 0.0
        final_discrepancy = target_val - actual_sum
        if final_discrepancy != 0.0:
            last_record_id = records[-1][0]
            cursor.execute("SELECT amount FROM payments WHERE id = ?", (last_record_id,))
            current_amt = cursor.fetchone()[0]
            cursor.execute("UPDATE payments SET amount = ? WHERE id = ?", (round(current_amt + final_discrepancy, 2), last_record_id))
            
    print("Monthly revenue targets aligned.")
    
    # Seed Attendance Logs (4000 total)
    print("Seeding attendance records...")
    active_member_ids = [m[0] for m in members_list if m[1] == 'active']
    
    # 172 checkins today
    today_checkins_pool = random.sample(active_member_ids, 172)
    for idx, member_id in enumerate(today_checkins_pool):
        if idx % 2 == 0:
            checkin_dt = today.replace(hour=7, minute=30, second=0) + timedelta(minutes=idx % 120)
        else:
            checkin_dt = today.replace(hour=18, minute=0, second=0) + timedelta(minutes=idx % 150)
            
        # 150 check-outs, 22 active check-ins
        checkout_str = None
        if idx < 150:
            checkout_dt = checkin_dt + timedelta(minutes=random.randint(45, 90))
            checkout_str = checkout_dt.strftime("%Y-%m-%d %H:%M:%S")
            
        cursor.execute(
            "INSERT INTO attendance (member_id, check_in_time, check_out_time, status) VALUES (?, ?, ?, 'success')",
            (member_id, checkin_dt.strftime("%Y-%m-%d %H:%M:%S"), checkout_str)
        )
        
    print(f"Seeded today's check-in metrics: 172.")
    
    # Historical check-in logs over the remaining 364 days.
    hist_checkins_needed = 4000 - 172
    for _ in range(hist_checkins_needed):
        days_ago = random.randint(1, 364)
        ch_date = today - timedelta(days=days_ago, hours=random.randint(6, 21), minutes=random.randint(0, 59))
        m_id = random.choice(active_member_ids)
        att_status = 'success' if random.random() > 0.05 else 'failed'
        err_msg = None if att_status == 'success' else random.choice(["Card Invalid", "Plan Expired", "Suspended Account"])
        
        checkout_str = None
        if att_status == 'success':
            checkout_str = (ch_date + timedelta(minutes=random.randint(45, 90))).strftime("%Y-%m-%d %H:%M:%S")
            
        cursor.execute(
            "INSERT INTO attendance (member_id, check_in_time, check_out_time, status, error_msg) VALUES (?, ?, ?, ?, ?)",
            (m_id, ch_date.strftime("%Y-%m-%d %H:%M:%S"), checkout_str, att_status, err_msg)
        )
        
    print(f"Attendance seeded: total 4000 records.")
    
    # Seed 500 Notifications
    print("Generating 500 notifications...")
    cursor.execute("SELECT id, user_id FROM members")
    member_user_records = cursor.fetchall()
    
    notif_types = ['payment', 'expiry', 'welcome', 'renewal']
    notif_messages = {
        'welcome': "Welcome to GymOS! Your onboarding registration is complete. Show this app at checkout.",
        'expiry': "Alert: Your membership plan tier will renew/expire shortly. Please check pending invoices.",
        'payment': "Success: We recorded your monthly subscription dues transaction.",
        'renewal': "Thanks! Your plan upgrade has been updated. Streak active."
    }
    
    for _ in range(500):
        m = random.choice(member_user_records)
        m_u_id = m['user_id']
        ntype = random.choice(notif_types)
        msg = notif_messages[ntype]
        read = random.choice([0, 1])
        n_days_ago = random.randint(0, 180)
        n_date = (today - timedelta(days=n_days_ago)).strftime("%Y-%m-%d %H:%M:%S")
        
        cursor.execute(
            "INSERT INTO notifications (user_id, type, message, read_status, created_at) VALUES (?, ?, ?, ?, ?)",
            (m_u_id, ntype, msg, read, n_date)
        )
        
    print("Seeded 500 notifications.")
    
    # Validate calculations
    cursor.execute("SELECT COUNT(*) FROM members")
    print("Total members:", cursor.fetchone()[0])
    
    cursor.execute("SELECT COUNT(*) FROM attendance")
    print("Total attendance:", cursor.fetchone()[0])
    
    cursor.execute("SELECT COUNT(*) FROM payments")
    print("Total payments:", cursor.fetchone()[0])
    
    cursor.execute("SELECT COUNT(*) FROM notifications")
    print("Total notifications:", cursor.fetchone()[0])
    
    # Verify monthly revenue of today
    cursor.execute("""
        SELECT SUM(amount) FROM payments 
        WHERE status = 'paid' AND payment_date >= ? AND payment_date <= ?
    """, (today.strftime("%Y-%m-01 00:00:00"), today.strftime("%Y-%m-%d 23:59:59")))
    print("This month revenue (target: ₹542,000):", cursor.fetchone()[0])
    
    conn.commit()
    conn.close()
    print("Large-scale seeding successful!")

if __name__ == '__main__':
    main()
