import subprocess
import time
import urllib.request
import urllib.parse
import json
import os
import sys

PORT = 8000
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
    status, res, cookie_member = make_request(
        "/api/auth/register",
        "POST",
        {
            "email": "testmember@gymos.com",
            "password": "memberpassword",
            "first_name": "Test",
            "last_name": "Member",
            "phone": "+199988877",
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
    
    # 4. Owner assigns Plan to Member
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
    print("[PASS] Plan assignment to member successful.")
    # 5. Member login to get active session cookie
    status, res, cookie_member = make_request(
        "/api/auth/login",
        "POST",
        {
            "email": "testmember@gymos.com",
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
    
    # 6. Member QR scan (Correct Token - First scan: Check-in)
    status, res, _ = make_request(
        "/api/member/check-in",
        "POST",
        {"qr_token": "gymos-token-xyz-123", "action": "scan"},
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
        {"qr_token": "gymos-token-xyz-123", "action": "scan"},
        headers_member
    )
    assert status == 409 and res_out.get("requires_checkout_confirmation"), f"Expected checkout confirmation, got: {res_out}"

    status, res_out, _ = make_request(
        "/api/member/check-in",
        "POST",
        {"qr_token": "gymos-token-xyz-123", "action": "checkout"},
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
        {"qr_token": "gymos-token-xyz-123", "action": "scan"},
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
    
    # 8. Owner suspends Member
    # First get member details to pass validation details in PUT
    status, m_res, _ = make_request(f"/api/admin/members/{member_id}", "GET", headers=headers_owner)
    member_data = m_res["member"]
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
        {"qr_token": "gymos-token-xyz-123"},
        headers_member
    )
    assert status == 403, f"Expected 403 for suspended member check-in, got {status} {res}"
    print("[PASS] Suspended member check-in blocked correctly.")
    
    # 10. Verify suspended member is blocked from dashboard/login
    status, res, _ = make_request("/api/member/dashboard", "GET", headers=headers_member)
    assert status == 403, f"Expected 403 for suspended member session, got {status} {res}"
    print("[PASS] Suspended member dashboard access blocked correctly.")
    
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
