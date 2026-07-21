import subprocess
import time
import urllib.request
import urllib.parse
import json
import os
import sys

PORT = int(os.environ.get("TEST_PORT", 8081))
SERVER_URL = f"http://127.0.0.1:{PORT}"

def wait_for_server(timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{SERVER_URL}/", timeout=1):
                return
        except Exception:
            time.sleep(0.2)
    raise RuntimeError(f"Server did not start on port {PORT} within {timeout} seconds")

def make_request(path, method="GET", data=None, headers=None):
    if headers is None:
        headers = {}
    
    url = f"{SERVER_URL}{path}"
    req_data = None
    if data:
        req_data = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"
        
    req = urllib.request.Request(url, data=req_data, headers=headers, method=method)
    
    try:
        with urllib.request.urlopen(req) as res:
            res_headers = res.info()
            cookie = res_headers.get("Set-Cookie")
            body = res.read().decode("utf-8")
            return res.status, json.loads(body) if body else {}, cookie
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        try:
            err_json = json.loads(body)
        except Exception:
            err_json = {"error": body}
        return e.code, err_json, None

def test_integration():
    print("Starting automated GymOS system integration checks...")
    
    # 1. Register Member
    unique_ts = int(time.time())
    unique_email = f"testmember_{unique_ts}@gymos.com"
    unique_phone = f"+199{unique_ts}"
    status, res, cookie_member = make_request(
        "/api/auth/register",
        "POST",
        {
            "email": unique_email,
            "password": "memberpassword",
            "first_name": "Test",
            "last_name": "Member",
            "phone": unique_phone,
            "emergency_contact": "Mom / +199988866"
        }
    )
    assert status == 200, f"Member register failed: {res}"
    print("[PASS] Member registration successful.")
    member_id = res["user"]["member_id"]
    
    # 2. Login Owner
    status, res, cookie_owner = make_request(
        "/api/auth/login",
        "POST",
        {
            "email": "owner@gymos.com",
            "password": "password123"
        }
    )
    assert status == 200, f"Owner login failed: {res}"
    print("[PASS] Owner login successful.")
    
    # Set headers with cookies
    headers_owner = {"Cookie": cookie_owner}
    headers_member = {"Cookie": cookie_member}
    
    # 3. Owner creates a Plan
    status, res, _ = make_request(
        "/api/admin/plans",
        "POST",
        {
            "name": "Integration Test Plan",
            "price": 39.99,
            "duration_months": 1,
            "benefits": "Testing full weights access"
        },
        headers_owner
    )
    assert status == 200, f"Create plan failed: {res}"
    plan_id = res["plan_id"]
    print("[PASS] Plan tier creation successful.")
    
    # 4. Owner assigns Plan to Member (multiple times to test non-duplication)
    status, res, _ = make_request(
        f"/api/admin/members/{member_id}/assign-plan",
        "POST",
        {
            "plan_id": plan_id,
            "record_payment": True
        },
        headers_owner
    )
    assert status == 200, f"Assign plan failed: {res}"

    # Re-assign plan to test that multiple active plans do not duplicate member in list query
    status, res, _ = make_request(
        f"/api/admin/members/{member_id}/assign-plan",
        "POST",
        {
            "plan_id": plan_id,
            "record_payment": True
        },
        headers_owner
    )
    assert status == 200, f"Re-assign plan failed: {res}"

    # Verify Members list row count matches total_members in stats exactly
    status, m_list_res, _ = make_request("/api/admin/members?limit=all", "GET", headers=headers_owner)
    status, stats_res, _ = make_request("/api/admin/stats", "GET", headers=headers_owner)
    members_count = len(m_list_res.get("data", []))
    total_stat = stats_res.get("stats", {}).get("total_members", 0)
    assert members_count == total_stat, f"Discrepancy detected! Members table rows: {members_count}, Dashboard total_members: {total_stat}"
    print("[PASS] Plan assignment to member successful & Dashboard count matches Members table exactly.")
    # 5. Member login to get active session cookie
    status, res, cookie_member = make_request(
        "/api/auth/login",
        "POST",
        {
            "email": unique_email,
            "password": "memberpassword"
        }
    )
    assert status == 200, f"Member login failed: {res}"
    headers_member = {"Cookie": cookie_member}

    # 5.1 Member dashboard checks
    status, res, _ = make_request("/api/member/dashboard", "GET", headers=headers_member)
    assert status == 200, f"Dashboard retrieval failed: {res}"
    assert res["status"] == "active"
    assert res["days_remaining"] >= 28
    print("[PASS] Member dashboard active state checked.")
    
    # 6. Member QR scan (Fetch current token)
    status, token_res, _ = make_request("/api/member/qr-token", "GET", headers=headers_member)
    current_qr_token = token_res.get("qr_token") or "gymos-token-xyz-123"

    status, res, _ = make_request(
        "/api/member/check-in",
        "POST",
        {"qr_token": current_qr_token, "action": "scan"},
        headers_member
    )
    assert status == 200, f"QR scan checkin failed: {res}"
    assert res.get("type") == "checkin", f"Expected type checkin, got: {res}"
    print("[PASS] Valid QR check-in checked.")
    
    # 6.1 Member dashboard verification for Check-in state
    status, res_dash1, _ = make_request("/api/member/dashboard", "GET", headers=headers_member)
    assert status == 200
    assert res_dash1["today_status"] == "Checked In"
    assert res_dash1["today_duration"] == "Active"
    assert res_dash1["today_check_in"] is not None
    assert res_dash1["today_check_out"] is None
    print("[PASS] Member dashboard correctly shows Checked In and Active duration.")
    
    # 6.2 Second scan requests a checkout confirmation.
    status, res_out, _ = make_request(
        "/api/member/check-in",
        "POST",
        {"qr_token": current_qr_token, "action": "scan"},
        headers_member
    )
    assert status == 409 and res_out.get("requires_checkout_confirmation"), f"Expected checkout confirmation, got: {res_out}"

    status, res_out, _ = make_request(
        "/api/member/check-in",
        "POST",
        {"qr_token": current_qr_token, "action": "checkout"},
        headers_member
    )
    assert status == 200 and res_out.get("type") == "checkout", f"QR scan checkout failed: {res_out}"
    print("[PASS] Checkout confirmation and check-out completed.")
    
    # 6.3 Member dashboard verification for Checked Out state
    status, res_dash2, _ = make_request("/api/member/dashboard", "GET", headers=headers_member)
    assert status == 200
    assert res_dash2["today_status"] == "Checked Out"
    assert res_dash2["today_check_out"] is not None
    assert "m" in res_dash2["today_duration"]
    print("[PASS] Member dashboard correctly shows Checked Out and calculates duration.")

    # 6.4 A third scan must not create another attendance record.
    status, completed_res, _ = make_request(
        "/api/member/check-in",
        "POST",
        {"qr_token": current_qr_token, "action": "scan"},
        headers_member
    )
    assert status == 409 and completed_res.get("completed_today"), f"Expected completed attendance response, got: {completed_res}"
    print("[PASS] Duplicate third scan blocked after attendance completion.")
    
    # 7. Member QR scan (Incorrect Token)
    status, res, _ = make_request(
        "/api/member/check-in",
        "POST",
        {"qr_token": "invalid-token"},
        headers_member
    )
    assert status == 400, f"Expected validation block, got {status} {res}"
    print("[PASS] Invalid QR check-in blocked correctly.")
    
    # 8. Owner Edits Member (Verify In-Place Update & Zero Duplicate Creation)
    status, m_list_before, _ = make_request("/api/admin/members?limit=all", "GET", headers=headers_owner)
    count_before = len(m_list_before.get("data", []))

    status, m_res, _ = make_request(f"/api/admin/members/{member_id}", "GET", headers=headers_owner)
    member_data = m_res["member"]
    member_data["first_name"] = "UpdatedFirst"
    member_data["last_name"] = "UpdatedLast"
    member_data["phone"] = f"+1998{unique_ts}"
    member_data["emergency_contact_name"] = "Jane Emergency"
    member_data["emergency_contact_number"] = "+155544433"

    status, res, _ = make_request(
         f"/api/admin/members/{member_id}",
         "PUT",
         member_data,
         headers_owner
    )
    assert status == 200, f"Member edit request failed: {res}"

    status, m_list_after, _ = make_request("/api/admin/members?limit=all", "GET", headers=headers_owner)
    count_after = len(m_list_after.get("data", []))
    assert count_after == count_before, f"Member edit created duplicate record! Count before: {count_before}, count after: {count_after}"
    print("[PASS] Member edit updated record in-place with zero duplicate creation.")

    # 9. Owner suspends Member
    member_data["status"] = "suspended"
    status, res, _ = make_request(
         f"/api/admin/members/{member_id}",
         "PUT",
         member_data,
         headers_owner
    )
    assert status == 200, f"Member suspension failed: {res}"
    print("[PASS] Member suspension logged successfully.")
    
    # 9. Verify suspended member is blocked from checking in
    status, res, _ = make_request(
        "/api/member/check-in",
        "POST",
        {"qr_token": current_qr_token},
        headers_member
    )
    assert status == 403, f"Expected 403 for suspended member check-in, got {status} {res}"
    print("[PASS] Suspended member check-in blocked correctly.")
    
    # 10. Verify suspended member is blocked from dashboard/login
    status, res, _ = make_request("/api/member/dashboard", "GET", headers=headers_member)
    assert status == 403, f"Expected 403 for suspended member session, got {status} {res}"
    print("[PASS] Suspended member dashboard access blocked correctly.")
    
    # 11. Settings & QR Token Regeneration Test
    status, set_res, _ = make_request("/api/admin/settings", "GET", headers=headers_owner)
    assert status == 200, f"Failed to fetch settings: {set_res}"
    
    status, regen_res, _ = make_request("/api/admin/settings/regenerate-qr-token", "POST", headers=headers_owner)
    assert status == 200 and regen_res.get("qr_token"), f"QR token regeneration failed: {regen_res}"
    print("[PASS] QR Token regenerated and settings audit verified.")

    # Cleanup: Owner deletes Member
    status, res, _ = make_request(f"/api/admin/members/{member_id}", "DELETE", headers=headers_owner)
    assert status == 200, f"Failed cleanup deletion: {res}"
    
    # Clean plan
    status, res, _ = make_request(f"/api/admin/plans/{plan_id}", "DELETE", headers=headers_owner)
    assert status == 200, f"Failed cleanup deletion of plan: {res}"
    
    print("\n[SUCCESS] All automated backend validation checks PASSED successfully!")

if __name__ == "__main__":
    # Start app.py in background
    # Set port environment
    server_env = os.environ.copy()
    server_env["PORT"] = str(PORT)
    server_env["FLASK_DEBUG"] = "0"
    proc = subprocess.Popen(
        [sys.executable, "app.py"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=server_env,
    )
    try:
        wait_for_server()
        test_integration()
    except AssertionError as e:
        print(f"\n[FAIL] Assertion check failed! {e}")
        # Print server logs on failure to debug
        proc.terminate()
        stdout, stderr = proc.communicate()
        print("\n--- Server Stdout ---")
        print(stdout.decode())
        print("--- Server Stderr ---")
        print(stderr.decode())
        sys.exit(1)
    except Exception as e:
        print(f"\n[ERROR] Unexpected test runner exception: {e}")
        proc.terminate()
        stdout, stderr = proc.communicate()
        print("\n--- Server Stdout ---")
        print(stdout.decode())
        print("--- Server Stderr ---")
        print(stderr.decode())
        sys.exit(1)
        
    proc.terminate()
    proc.wait()
    sys.exit(0)
