// GymOS Admin App Controller
let currentTab = 'dashboard';
let gymSettings = {};
let sseSource = null;
let revenueLineChart = null;
let attendanceDonutChart = null;

// Every owner-portal API call goes through fetch(), so intercepting it here
// catches a 402 "subscription inactive" response no matter which of the many
// call sites triggered it, without needing to touch each one individually.
let subscriptionModalShown = false;
const _nativeFetch = window.fetch;
window.fetch = async function (...args) {
    const res = await _nativeFetch(...args);
    if (res.status === 402) {
        let payload = null;
        try { payload = await res.clone().json(); } catch (e) { /* not JSON */ }
        if (payload && payload.subscription_expired) {
            showSubscriptionExpiredModal();
        }
    }
    return res;
};

async function showSubscriptionExpiredModal() {
    if (subscriptionModalShown) return;
    subscriptionModalShown = true;

    const overlay = document.getElementById('subscriptionExpiredOverlay');
    overlay.style.display = 'flex';
    if (sseSource) sseSource.close();

    try {
        const res = await _nativeFetch('/api/owner/subscription-info');
        const data = await res.json();
        const plansEl = document.getElementById('subscriptionExpiredPlans');
        if (data.plans && data.plans.length > 0) {
            plansEl.innerHTML = data.plans.map(p => `
                <div style="display:flex; justify-content:space-between; align-items:center; padding: 12px 16px; border: 1px solid var(--border-color); border-radius: var(--radius-md);">
                    <span style="font-weight:600; font-size:13.5px;">${p.name} (${p.duration_months} ${p.duration_months === 1 ? 'month' : 'months'})</span>
                    <span style="font-weight:700;">${formatINRCurrency(p.price)}</span>
                </div>
            `).join('');
        }
    } catch (err) {
        console.error('Failed to load subscription plans', err);
    }
}

// Pagination, Sorting & Bulk Selection State
let memberPage = 1;
let memberLimit = 25;
let memberTotal = 0;
let memberSortBy = 'first_name';
let memberSortOrder = 'asc';
let selectedMembers = new Set();

let attendancePage = 1;
let attendanceLimit = 25;
let attendanceTotal = 0;
let attendanceSortBy = 'check_in_time';
let attendanceSortOrder = 'desc';
let selectedAttendance = new Set();

let paymentPage = 1;
let paymentLimit = 25;
let paymentTotal = 0;
let paymentSortBy = 'created_at';
let paymentSortOrder = 'desc';
let selectedPayments = new Set();

// DOM selectors
const loginOverlay = document.getElementById('loginOverlay');
const appLayout = document.getElementById('appLayout');
const loginForm = document.getElementById('loginForm');
const loginError = document.getElementById('loginError');
const ssePulse = document.getElementById('ssePulse');
const sseStatusText = document.getElementById('sseStatusText');

// Boot check
document.addEventListener('DOMContentLoaded', () => {
    checkUserSession();
    setupNavigation();
    setupFormHandlers();
    setHeaderDates();
    if (typeof initializeOwnerNotifications === 'function') initializeOwnerNotifications();

    window.addEventListener('online', () => {
        showToast('Internet restored. Sync active.', 'success');
        fetchDashboardStats();
    });
    window.addEventListener('offline', () => {
        showToast('Internet connection lost. Operational offline mode enabled.', 'warning');
    });
});

// Indian Currency Formatter (₹)
function formatINRCurrency(value) {
    return '₹' + parseFloat(value).toLocaleString('en-IN', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    });
}

function setHeaderDates() {
    const today = new Date();
    const optionsLong = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
    const dateStrLong = today.toLocaleDateString('en-IN', optionsLong);
    const headerDateEl = document.getElementById('realTimeHeaderDate');
    if (headerDateEl) {
        headerDateEl.innerText = dateStrLong;
    }

    const optionsShort = { day: 'numeric', month: 'short', year: 'numeric' };
    const dateStrShort = today.toLocaleDateString('en-IN', optionsShort);
    const calTrigger = document.getElementById('currentCalendarDisplayTrigger');
    if (calTrigger) {
        calTrigger.querySelector('span').innerText = dateStrShort;
    }
}

// Toast helper
function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    let icon = '';
    if (type === 'success') {
        icon = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`;
    } else if (type === 'error') {
        icon = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`;
    } else {
        icon = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
    }

    toast.innerHTML = `${icon}<div style="font-size: 14px; font-weight: 500; color: var(--text-primary);">${message}</div>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) reverse forwards';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// Modal handling
function openModal(modalId) {
    document.getElementById(modalId).classList.add('active');
    if (modalId === 'assignPlanModal') {
        document.getElementById('assignStartDate').value = new Date().toISOString().split('T')[0];
        fetchRegisterPlans('assignPlanSelect');
    } else if (modalId === 'recordPaymentModal') {
        fetchPendingPaymentsDropDown();
    } else if (modalId === 'gymQRModal') {
        drawGymQR();
    } else if (modalId === 'addMemberModal') {
        fetchRegisterPlans('mPlanSelect', true);
        document.getElementById('mPlanOptionsSection').style.display = 'none';
        document.getElementById('mCustomPlanDates').style.display = 'none';
        document.getElementById('mCustomPlanToggle').checked = false;
        document.getElementById('mCustomStartDate').value = new Date().toISOString().split('T')[0];
        document.getElementById('mCustomEndDate').value = '';
        document.getElementById('mRecordPayment').checked = true;
    }
}

function closeModal(modalId) {
    const el = document.getElementById(modalId);
    if (el) el.classList.remove('active');
}

// Custom UI Confirmation & Alert Dialog System
let customConfirmResolve = null;

function showConfirmDialog({ title = 'Confirm Action', message = 'Are you sure you want to proceed?', confirmText = 'Confirm', type = 'warning' } = {}) {
    return new Promise((resolve) => {
        customConfirmResolve = resolve;
        const titleEl = document.getElementById('customConfirmTitle');
        const msgEl = document.getElementById('customConfirmMessage');
        const btnOk = document.getElementById('customConfirmSubmitBtn');
        const iconEl = document.getElementById('customConfirmIcon');

        if (titleEl) titleEl.innerText = title;
        if (msgEl) msgEl.innerText = message;
        if (btnOk) {
            btnOk.innerText = confirmText;
            if (type === 'danger') {
                btnOk.style.backgroundColor = 'var(--danger, #ef4444)';
                btnOk.style.borderColor = 'var(--danger, #ef4444)';
                btnOk.style.color = '#ffffff';
            } else {
                btnOk.style.backgroundColor = 'var(--accent, #c7ff24)';
                btnOk.style.borderColor = 'var(--accent, #c7ff24)';
                btnOk.style.color = '#000000';
            }
        }
        if (iconEl) {
            iconEl.className = `ui-dialog-icon ${type}`;
        }

        openModal('customConfirmModal');
    });
}

function handleCustomConfirmOk() {
    closeModal('customConfirmModal');
    if (customConfirmResolve) {
        customConfirmResolve(true);
        customConfirmResolve = null;
    }
}

function handleCustomConfirmCancel() {
    closeModal('customConfirmModal');
    if (customConfirmResolve) {
        customConfirmResolve(false);
        customConfirmResolve = null;
    }
}

function showAlertDialog({ title = 'Notification', message = '', type = 'info' } = {}) {
    const titleEl = document.getElementById('customAlertTitle');
    const msgEl = document.getElementById('customAlertMessage');
    const iconEl = document.getElementById('customAlertIcon');

    if (titleEl) titleEl.innerText = title;
    if (msgEl) msgEl.innerText = message;
    if (iconEl) iconEl.className = `ui-dialog-icon ${type}`;

    openModal('customAlertModal');
}

// Dashboard KPI drill-down (Pending Dues / Expiring Soon)
async function fetchPendingDuesPage() {
    const body = document.getElementById('pendingDuesTableBody');
    body.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--text-tertiary); padding:16px 0;">Loading…</td></tr>';

    try {
        const res = await fetch('/api/admin/dashboard/pending-dues');
        const data = await res.json();
        const rows = data.data || [];

        let total = 0;
        rows.forEach(r => total += (r.amount || 0));
        document.getElementById('pendingDuesTotalInfo').innerText = `Total: ${formatINRCurrency(total)} (${rows.length} member${rows.length === 1 ? '' : 's'})`;

        if (rows.length === 0) {
            body.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--text-tertiary); padding:16px 0;">No pending dues!</td></tr>';
            return;
        }

        body.innerHTML = rows.map(r => {
            const badge = r.status === 'overdue' ? 'badge-suspended' : 'badge-expired';
            return `
                <tr>
                    <td style="font-weight:600;">${r.first_name} ${r.last_name}</td>
                    <td>${r.due_date || '—'}</td>
                    <td style="font-weight:700;">${formatINRCurrency(r.amount)}</td>
                    <td>${r.plan_name || 'No Plan'}</td>
                    <td><span class="badge ${badge}">${r.status}</span></td>
                    <td style="text-align:right;"><button class="btn-comms-circle btn-comms-whatsapp" style="display:inline-flex;" onclick="sendPaymentReminder(${r.id})" title="Send WhatsApp reminder"><svg fill="currentColor" viewBox="0 0 24 24" width="14" height="14"><path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946C.06 5.348 5.397.01 12.008.01c3.202.001 6.212 1.246 8.477 3.514 2.266 2.268 3.507 5.28 3.505 8.484-.004 6.657-5.34 11.997-11.953 11.997-2.005-.001-3.973-.503-5.722-1.465L0 24zm6.59-4.846c1.6.95 3.188 1.449 4.825 1.451 5.436 0 9.86-4.37 9.864-9.799.002-2.63-1.023-5.101-2.885-6.965C16.59 1.977 14.113.953 11.5.953c-5.44 0-9.866 4.372-9.87 9.802 0 1.814.49 3.518 1.42 5.061l-.995 3.633 3.738-.971z"/></svg></button></td>
                </tr>
            `;
        }).join('');
    } catch (err) {
        body.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--danger);">Failed to load pending dues.</td></tr>';
    }
}

async function downloadPendingDuesCSV() {
    try {
        const res = await fetch('/api/admin/dashboard/pending-dues');
        const data = await res.json();
        const rows = data.data || [];

        if (rows.length === 0) {
            showToast('No pending dues to export.', 'warning');
            return;
        }

        let csvContent = "data:text/csv;charset=utf-8,Member Name,Due Date,Amount Due,Plan,Status\n";
        rows.forEach(r => {
            csvContent += `"${r.first_name} ${r.last_name}","${r.due_date || ''}","${r.amount}","${r.plan_name || 'No Plan'}","${r.status}"\n`;
        });

        const link = document.createElement("a");
        link.setAttribute("href", encodeURI(csvContent));
        link.setAttribute("download", "pending-dues.csv");
        document.body.appendChild(link);
        link.click();
        link.remove();
    } catch (err) {
        showToast('Failed to download pending dues', 'error');
    }
}

async function fetchExpiringSoonPage() {
    const body = document.getElementById('expiringSoonTableBody');
    body.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-tertiary); padding:16px 0;">Loading…</td></tr>';

    try {
        const res = await fetch('/api/admin/dashboard/expiring-soon');
        const data = await res.json();
        const rows = data.data || [];

        const infoText = `Total: ${rows.length} member${rows.length === 1 ? '' : 's'}`;
        const totalInfoEl = document.getElementById('expiringSoonTotalInfo');
        if (totalInfoEl) totalInfoEl.innerText = infoText;
        const footerTotalEl = document.getElementById('expiringSoonFooterTotalInfo');
        if (footerTotalEl) footerTotalEl.innerText = infoText;

        if (rows.length === 0) {
            body.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-tertiary); padding:16px 0;">No memberships expiring soon.</td></tr>';
            return;
        }

        body.innerHTML = rows.map(r => {
            const amount = r.amount_due != null ? formatINRCurrency(r.amount_due) : '—';
            return `
                <tr>
                    <td style="font-weight:600;">${r.first_name} ${r.last_name}</td>
                    <td>${r.end_date || '—'}</td>
                    <td style="font-weight:700;">${amount}</td>
                    <td>${r.plan_name || 'No Plan'}</td>
                    <td style="text-align:right;"><button class="btn-send-whatsapp-remind" onclick="sendRenewalReminder(${r.member_id})">Alert</button></td>
                </tr>
            `;
        }).join('');
    } catch (err) {
        console.error('Failed to load expiring memberships', err);
        body.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--danger);">Failed to load expiring memberships.</td></tr>';
    }
}

async function downloadExpiringSoonCSV() {
    try {
        const res = await fetch('/api/admin/dashboard/expiring-soon');
        const data = await res.json();
        const rows = data.data || [];

        if (rows.length === 0) {
            showToast('No memberships expiring soon to export.', 'warning');
            return;
        }

        let csvContent = "data:text/csv;charset=utf-8,Member Name,Due Date,Amount Due,Plan\n";
        rows.forEach(r => {
            csvContent += `"${r.first_name} ${r.last_name}","${r.end_date || ''}","${r.amount_due != null ? r.amount_due : ''}","${r.plan_name || 'No Plan'}"\n`;
        });

        const link = document.createElement("a");
        link.setAttribute("href", encodeURI(csvContent));
        link.setAttribute("download", "expiring-soon.csv");
        document.body.appendChild(link);
        link.click();
        link.remove();
    } catch (err) {
        showToast('Failed to download expiring soon list', 'error');
    }
}

// Forgot Password flow (Owner login)
function openForgotPasswordFlow(event) {
    if (event) event.preventDefault();
    document.getElementById('forgotPasswordForm').reset();
    document.getElementById('forgotPasswordError').style.display = 'none';
    
    // Reset admin modal to Phase 1
    document.getElementById('fpEmail').disabled = false;
    document.getElementById('adminFpResetBlock').style.display = 'none';
    document.getElementById('btnAdminSendOtp').style.display = 'block';
    document.getElementById('btnAdminResetPassword').style.display = 'none';
    
    openModal('forgotPasswordModal');
}

function closeForgotPasswordFlow() {
    closeModal('forgotPasswordModal');
}

async function sendAdminOtp() {
    const errorBox = document.getElementById('forgotPasswordError');
    errorBox.style.display = 'none';

    const email = document.getElementById('fpEmail').value.trim();
    if (!email) {
        errorBox.innerText = 'Email address is required';
        errorBox.style.display = 'block';
        return;
    }

    const btn = document.getElementById('btnAdminSendOtp');
    btn.disabled = true;
    btn.innerText = 'Sending...';

    try {
        const res = await fetch('/api/auth/forgot-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const data = await res.json();

        if (data.success) {
            showToast('Verification code sent to your email.', 'success');
            
            // Move to Phase 2
            document.getElementById('fpEmail').disabled = true;
            document.getElementById('adminFpResetBlock').style.display = 'flex';
            btn.style.display = 'none';
            document.getElementById('btnAdminResetPassword').style.display = 'block';
        } else {
            errorBox.innerText = data.error || 'Failed to send OTP';
            errorBox.style.display = 'block';
        }
    } catch (err) {
        errorBox.innerText = 'Failed request: server offline';
        errorBox.style.display = 'block';
    } finally {
        btn.disabled = false;
        btn.innerText = 'Send OTP';
    }
}

async function resetAdminPassword() {
    const errorBox = document.getElementById('forgotPasswordError');
    errorBox.style.display = 'none';

    const email = document.getElementById('fpEmail').value.trim();
    const otp = document.getElementById('fpOtp').value.trim();
    const new_password = document.getElementById('fpNewPassword').value;

    if (!otp || otp.length !== 6) {
        errorBox.innerText = 'Please enter a valid 6-digit OTP code';
        errorBox.style.display = 'block';
        return;
    }
    if (!new_password || new_password.length < 8) {
        errorBox.innerText = 'Password must be at least 8 characters';
        errorBox.style.display = 'block';
        return;
    }

    const btn = document.getElementById('btnAdminResetPassword');
    btn.disabled = true;
    btn.innerText = 'Resetting...';

    try {
        const res = await fetch('/api/auth/reset-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, otp, new_password })
        });
        const data = await res.json();

        if (data.success) {
            closeModal('forgotPasswordModal');
            showToast('Password reset. Please sign in with your new password.', 'success');
            document.getElementById('loginEmail').value = email;
        } else {
            errorBox.innerText = data.error || 'Password reset failed';
            errorBox.style.display = 'block';
        }
    } catch (err) {
        errorBox.innerText = 'Failed request: server offline';
        errorBox.style.display = 'block';
    } finally {
        btn.disabled = false;
        btn.innerText = 'Reset Password';
    }
}

function submitForgotPassword(event) {
    if (event) event.preventDefault();
    const isResetPhase = document.getElementById('adminFpResetBlock').style.display === 'flex';
    if (isResetPhase) {
        resetAdminPassword();
    } else {
        sendAdminOtp();
    }
}

// Auth validation
async function checkUserSession() {
    const splashLoader = document.getElementById('authSplashLoader');
    try {
        const res = await fetch('/api/auth/me');
        const data = await res.json();
        if (data.user && data.user.role === 'owner') {
            localStorage.setItem('gymos_owner_auth', 'true');
            if (splashLoader) splashLoader.style.display = 'none';
            document.documentElement.classList.remove('auth-session-precheck');
            loginOverlay.style.display = 'none';
            appLayout.style.display = 'flex';

            const ownerDisplayName = (data.user.first_name || data.user.last_name) ? `${data.user.first_name || ''} ${data.user.last_name || ''}`.trim() : "Owner";
            const ownerFirstName = data.user.first_name || "Owner";
            const ownerEmail = data.user.email || "";

            document.getElementById('profileOwnerName').innerText = ownerDisplayName;
            const roleEl = document.getElementById('profileOwnerRole');
            if (roleEl) roleEl.innerText = `Owner Operator • ${ownerEmail}`;
            document.getElementById('greetingUser').innerText = ownerFirstName;
            updateTimeBasedGreeting();

            // Populate Settings Owner Profile Form inputs
            const ownerFirstInput = document.getElementById('settingsOwnerFirstName');
            const ownerLastInput = document.getElementById('settingsOwnerLastName');
            if (ownerFirstInput) ownerFirstInput.value = data.user.first_name || '';
            if (ownerLastInput) ownerLastInput.value = data.user.last_name || '';

            const avatarDiv = document.getElementById('profileOwnerAvatar') || document.querySelector('.owner-profile-card .owner-avatar');
            if (avatarDiv) {
                if (data.user.profile_photo) {
                    avatarDiv.innerHTML = `<img src="${data.user.profile_photo}" style="width:100%; height:100%; object-fit:cover; border-radius:50%;" alt="Avatar">`;
                } else {
                    const initials = ((data.user.first_name ? data.user.first_name[0] : '') + (data.user.last_name ? data.user.last_name[0] : '')).toUpperCase() || 'OW';
                    avatarDiv.innerText = initials;
                    avatarDiv.innerHTML = initials;
                }
            }

            const profilePreview = document.getElementById('ownerPhotoPreview');
            const profileFallback = document.getElementById('ownerPhotoFallback');
            const profileRemoveBtn = document.getElementById('btnRemoveOwnerPhoto');
            if (profilePreview && profileFallback) {
                if (data.user.profile_photo) {
                    profilePreview.src = data.user.profile_photo;
                    profilePreview.style.display = 'block';
                    profileFallback.style.display = 'none';
                    if (profileRemoveBtn) profileRemoveBtn.style.display = 'inline-block';
                } else {
                    profilePreview.src = '';
                    profilePreview.style.display = 'none';
                    profileFallback.style.display = 'block';
                    if (profileRemoveBtn) profileRemoveBtn.style.display = 'none';
                }
            }

            startApp();
        } else {
            localStorage.removeItem('gymos_owner_auth');
            if (splashLoader) splashLoader.style.display = 'none';
            document.documentElement.classList.remove('auth-session-precheck');
            loginOverlay.style.display = 'flex';
            appLayout.style.display = 'none';
        }
    } catch (err) {
        console.error('Session validation error', err);
        localStorage.removeItem('gymos_owner_auth');
        if (splashLoader) splashLoader.style.display = 'none';
        document.documentElement.classList.remove('auth-session-precheck');
        loginOverlay.style.display = 'flex';
        appLayout.style.display = 'none';
    }
}

function startApp() {
    // Only fetch dashboard stats and gym settings immediately on boot.
    // Non-dashboard tabs (members, attendance, payments, plans) are loaded on demand via showTab().
    fetchDashboardStats();
    fetchGymSettings();
    initSSEConnection();
}

// SSE Connection
function initSSEConnection() {
    if (sseSource) sseSource.close();
    sseSource = new EventSource('/api/stream');

    sseSource.onopen = () => {
        ssePulse.className = 'indicator-dot online';
        sseStatusText.innerText = 'Sync Active';
    };

    sseSource.onerror = () => {
        ssePulse.className = 'indicator-dot';
        sseStatusText.innerText = 'Sync Offline';
    };

    sseSource.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'CHECKIN_SUCCESS' || data.type === 'CHECKOUT_SUCCESS') {
            showToast(data.type === 'CHECKOUT_SUCCESS' ? `Entrance: ${data.payload.name} checked out!` : `Entrance: ${data.payload.name} checked in!`, 'success');
            if (data.type === 'CHECKIN_SUCCESS') {
                injectCheckinStreamItem(data.payload);
            } else if (data.type === 'CHECKOUT_SUCCESS') {
                injectCheckoutStreamItem(data.payload);
            }
            fetchDashboardStats();
            if (currentTab === 'attendance') fetchAttendance();
            if (currentTab === 'reports') populateReportsTab();
        } else if (data.type === 'MEMBER_REGISTERED' || data.type === 'MEMBER_CREATED') {
            showToast(`New registration pending approval: ${data.payload.name}!`, 'info');
            fetchDashboardStats();
            if (currentTab === 'members') fetchMembers();
            if (currentTab === 'pending-approvals') fetchPendingApprovals();
        } else if (data.type === 'PAYMENT_RECORDED' || data.type === 'PAYMENT_REQUESTED' || data.type === 'PAYMENT_REJECTED') {
            if (data.type === 'PAYMENT_REQUESTED') {
                showToast(`Payment approval requested by ${data.payload.name}!`, 'info');
            } else if (data.type === 'PAYMENT_REJECTED') {
                showToast(`Payment request was rejected.`, 'info');
            } else {
                showToast(`Payment of ${formatINRCurrency(data.payload.amount)} logged.`, 'success');
            }
            fetchDashboardStats();
            if (currentTab === 'payments') fetchPayments();
            if (currentTab === 'reminders') populateRemindersTab();
            if (currentTab === 'reports') populateReportsTab();
        } else if (data.type === 'GYM_SETTINGS_UPDATED') {
            showToast(`Gym settings updated.`, 'info');
            fetchGymSettings();
        }
    };
}

function injectCheckinStreamItem(item) {
    const stream = document.getElementById('sseCheckinStream');
    if (!stream) return;
    const nodes = stream.querySelectorAll('.timeline-item-nodes');
    if (nodes.length >= 5) nodes[nodes.length - 1].remove();

    const d = new Date(item.time);
    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const div = document.createElement('div');
    div.className = 'timeline-item-nodes';
    div.innerHTML = `
        <div class="timeline-color-node timeline-bg-success"></div>
        <div class="timeline-block-body">
            <div class="timeline-text-content"><strong>${item.name}</strong> checked in</div>
            <div class="timeline-stamp-time">${timeStr}</div>
        </div>
    `;
    stream.insertBefore(div, stream.firstChild);
}

function injectCheckoutStreamItem(item) {
    const stream = document.getElementById('sseCheckinStream');
    if (!stream) return;
    const nodes = stream.querySelectorAll('.timeline-item-nodes');
    if (nodes.length >= 5) nodes[nodes.length - 1].remove();

    const d = new Date(item.check_out);
    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const div = document.createElement('div');
    div.className = 'timeline-item-nodes';
    div.innerHTML = `
        <div class="timeline-color-node timeline-bg-warning" style="background-color: var(--accent);"></div>
        <div class="timeline-block-body">
            <div class="timeline-text-content"><strong>${item.name}</strong> checked out (${item.duration})</div>
            <div class="timeline-stamp-time">${timeStr}</div>
        </div>
    `;
    stream.insertBefore(div, stream.firstChild);
}

// Navigation
function setupNavigation() {
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const tab = link.getAttribute('data-tab');
            showTab(tab);
        });
    });
}

function toggleMobileSidebar(isOpen) {
    const sidebar = document.getElementById('adminSidebar');
    const backdrop = document.getElementById('sidebarBackdrop');
    if (sidebar && backdrop) {
        if (isOpen) {
            sidebar.classList.add('sidebar-open');
            backdrop.classList.add('active');
        } else {
            sidebar.classList.remove('sidebar-open');
            backdrop.classList.remove('active');
        }
    }
}

function showTab(tabName) {
    // Auto-close mobile sidebar drawer
    toggleMobileSidebar(false);
    
    // Close floating popovers
    if (typeof closeNotificationPopover === 'function') closeNotificationPopover();
    
    // Hide revenue-analytics and win-back for now
    if (tabName === 'revenue-analytics' || tabName === 'win-back') {
        tabName = 'dashboard';
    }

    currentTab = tabName;
    clearAllSelections();
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));

    document.querySelectorAll(`.nav-link[data-tab="${tabName}"]`).forEach(l => l.classList.add('active'));

    document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
    const tabEl = document.getElementById(`${tabName}Tab`);
    if (tabEl) tabEl.classList.add('active');

    // Refresh data
    if (tabName === 'dashboard') fetchDashboardStats();
    if (tabName === 'members') fetchMembers();
    if (tabName === 'attendance') fetchAttendance();
    if (tabName === 'payments') fetchPayments();
    if (tabName === 'plans') fetchPlans();
    if (tabName === 'settings') fetchGymSettings();
    if (tabName === 'reports') populateReportsTab();
    if (tabName === 'reminders') populateRemindersTab();
    if (tabName === 'pending-approvals') fetchPendingApprovals();
    if (tabName === 'pending-dues') fetchPendingDuesPage();
    if (tabName === 'expiring-soon') fetchExpiringSoonPage();
    if (tabName === 'win-back') { fetchWinBackMembers(); fetchWinBackAnalytics(); }
    if (tabName === 'revenue-analytics') { fetchRevenueAnalyticsOverview(); }
    if (tabName === 'notifications' && typeof filterNotificationHistory === 'function') filterNotificationHistory();
}

function triggerGlobalSearch(query) {
    showTab('members');
    const searchField = document.getElementById('memberSearch');
    if (searchField) {
        searchField.value = query;
        fetchMembers();
    }
}

let rawDashboardStats = null;

// Fetch stats and render dashboard elements
async function fetchDashboardStats() {
    // Set loading indicator on KPI values
    const kpiElements = ['statActiveMembers', 'statNewMembersWeek', 'statTodayCheckins', 'statMonthlyRevenue', 'statPendingPayments', 'statExpiredCount', 'statWinBackCount'];
    kpiElements.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerText = '...';
    });
    
    try {
        const res = await fetch('/api/admin/stats');
        const data = await res.json();
        rawDashboardStats = data;

        // Update Pending Approvals KPI Card
        const pendingCount = data.stats.pending_registrations_count || 0;
        document.getElementById('statPendingApprovalsCount').innerText = pendingCount;
        document.getElementById('statPendingApprovalsSub').innerText = `${pendingCount} Member${pendingCount === 1 ? '' : 's'} Waiting`;

        // Update Sidebar Nav Badge for Pending Approvals
        const approvalsBadgeEl = document.getElementById('pendingApprovalsBadge');
        if (approvalsBadgeEl) {
            if (pendingCount > 0) {
                approvalsBadgeEl.innerText = pendingCount;
                approvalsBadgeEl.style.display = 'inline-block';
            } else {
                approvalsBadgeEl.style.display = 'none';
            }
        }

        // Update nav badge count for pending payments
        const badgeEl = document.getElementById('paymentsBadge');
        if (badgeEl) {
            if (data.stats.pending_approvals > 0) {
                badgeEl.innerText = data.stats.pending_approvals;
                badgeEl.style.display = 'inline-block';
            } else {
                badgeEl.style.display = 'none';
            }
        }

        // Fetch Leaderboard
        fetchAdminLeaderboard();

        // Render dashboard data
        renderDashboardData();

    } catch (err) {
        console.error('Stats loading failed', err);
    }
}

function renderDashboardData() {
    if (!rawDashboardStats) return;

    const stats = rawDashboardStats.stats;

    // Render raw default charts
    renderRevenueChart(rawDashboardStats.charts.revenue);
    renderAttendanceChart(rawDashboardStats.charts.attendance);

    // Render KPI Cards
    document.getElementById('statActiveMembers').innerText = stats.total_members;
    document.getElementById('statNewMembersWeek').innerText = stats.new_members_week;
    document.getElementById('statTodayCheckins').innerText = stats.today_checkins;
    document.getElementById('statLifetimeRevenue').innerText = formatINRCurrency(stats.lifetime_revenue || 0);
    const growthTrend = document.getElementById('statRevenueGrowthTrend');
    const growthVal = document.getElementById('statRevenueGrowthVal');
    const growthArrow = document.getElementById('statRevenueGrowthArrow');
    if (growthTrend && growthVal && growthArrow) {
        const rate = stats.growth_rate || 0;
        growthVal.innerText = `${Math.abs(rate)}%`;
        if (rate >= 0) {
            growthArrow.innerText = '↑';
            growthTrend.style.color = '#22c55e';
        } else {
            growthArrow.innerText = '↓';
            growthTrend.style.color = '#ef4444';
        }
    }
    document.getElementById('statPendingPayments').innerText = stats.pending_payments;
    document.getElementById('statPendingAmountVal').innerText = `${formatINRCurrency(stats.pending_amount)} total`;
    document.getElementById('statExpiredCount').innerText = stats.expiring_members;
    document.getElementById('statWinBackCount').innerText = stats.win_back_members_count || 0;

    // Donut Chart & ratios
    renderAttendanceDonut(stats.today_checkins, stats.active_members);

    // New Members list (Bottom row left column)
    const joinersList = document.getElementById('dashboardNewMembersList');
    joinersList.innerHTML = '';
    const newList = rawDashboardStats.new_members_list || [];

    if (newList.length === 0) {
        joinersList.innerHTML = '<div style="font-size:13px; text-align:center; color:var(--text-tertiary); padding:16px;">No registrations.</div>';
    } else {
        newList.forEach(m => {
            const div = document.createElement('div');
            div.className = 'recent-joiner-item';
            div.innerHTML = `
                ${MemberAvatar.html(m, { size: 36 })}
                <div class="joiner-details">
                    <span class="joiner-name">${m.first_name} ${m.last_name}</span>
                    <span class="joiner-plan-date">${m.plan_name || 'No Plan'} &bull; ${new Date(m.joined_at).toLocaleDateString()}</span>
                </div>
            `;
            joinersList.appendChild(div);
        });
    }

    // Timeline feed checkin nodes
    const stream = document.getElementById('sseCheckinStream');
    stream.innerHTML = '';
    const filteredActivity = rawDashboardStats.recent_activity || [];

    if (filteredActivity.length === 0) {
        stream.innerHTML = '<div style="font-size:13px; text-align:center; color:var(--text-tertiary); padding:16px 0;">Waiting for checks...</div>';
    } else {
        filteredActivity.forEach(act => {
            const div = document.createElement('div');
            div.className = 'timeline-item-nodes';
            const actColorClass = act.status === 'success' ? 'timeline-bg-success' : 'timeline-bg-warning';
            const actTime = new Date(act.time);
            const timeStr = actTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            div.innerHTML = `
                <div class="timeline-color-node ${actColorClass}"></div>
                <div class="timeline-block-body">
                    <div class="timeline-text-content"><strong>${act.name}</strong> ${act.description}</div>
                    <div class="timeline-stamp-time">${timeStr}</div>
                </div>
            `;
            stream.appendChild(div);
        });
    }
}

// Global variable for Attendance Chart instance to re-draw correctly
let dashboardAttendanceChartInstance = null;

// Monthly Attendance Calendar (Attendance tab)
let attendanceCalendarDate = new Date();

function openMonthlyAttendanceModal() {
    attendanceCalendarDate = new Date();
    document.getElementById('attendanceCalendarDayListWrap').style.display = 'none';
    openModal('attendanceMonthlyModal');
    renderAttendanceCalendar();
}

function changeAttendanceCalendarMonth(offset) {
    attendanceCalendarDate.setMonth(attendanceCalendarDate.getMonth() + offset);
    document.getElementById('attendanceCalendarDayListWrap').style.display = 'none';
    renderAttendanceCalendar();
}

async function renderAttendanceCalendar() {
    const year = attendanceCalendarDate.getFullYear();
    const month = attendanceCalendarDate.getMonth();
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    document.getElementById('attendanceCalendarMonthLabel').innerText = `${monthNames[month]} ${year}`;

    const monthStr = String(month + 1).padStart(2, '0');
    let counts = {};
    try {
        const res = await fetch(`/api/admin/attendance/calendar-summary?year=${year}&month=${monthStr}`);
        const data = await res.json();
        counts = data.counts || {};
    } catch (err) {
        console.error('Failed to load attendance calendar summary', err);
    }

    const grid = document.getElementById('attendanceCalendarGrid');
    grid.innerHTML = '';

    const firstDayIndex = new Date(year, month, 1).getDay();
    const adjustedFirstDayIndex = firstDayIndex === 0 ? 6 : firstDayIndex - 1;
    const lastDay = new Date(year, month + 1, 0).getDate();

    for (let i = 0; i < adjustedFirstDayIndex; i++) {
        grid.appendChild(document.createElement('div'));
    }

    for (let d = 1; d <= lastDay; d++) {
        const dayStr = String(d).padStart(2, '0');
        const cnt = counts[dayStr] || 0;
        const cell = document.createElement('div');
        cell.style.cssText = 'padding:8px 0; border-radius:8px; cursor:pointer; font-size:13px; font-weight:700;';
        cell.style.background = cnt > 0 ? 'var(--accent)' : 'var(--bg-raised)';
        cell.style.color = cnt > 0 ? 'var(--sidebar-dark)' : 'var(--text-primary)';
        cell.innerHTML = `${d}${cnt > 0 ? `<div style="font-size:9px; font-weight:600;">${cnt}</div>` : ''}`;
        cell.onclick = () => loadAttendanceCalendarDay(`${year}-${monthStr}-${dayStr}`);
        grid.appendChild(cell);
    }
}

async function loadAttendanceCalendarDay(dateStr) {
    const wrap = document.getElementById('attendanceCalendarDayListWrap');
    const body = document.getElementById('attendanceCalendarDayListBody');
    document.getElementById('attendanceCalendarDayListTitle').innerText = `Check-ins on ${dateStr}`;
    wrap.style.display = 'block';
    body.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:12px;">Loading…</td></tr>';

    try {
        const res = await fetch(`/api/admin/attendance?date=${dateStr}&limit=all`);
        const data = await res.json();
        const rows = (data.data || []).filter(r => r.status === 'success');

        if (rows.length === 0) {
            body.innerHTML = '<tr><td colspan="3" style="text-align:center; color:var(--text-tertiary); padding:12px;">No check-ins on this date.</td></tr>';
            return;
        }

        body.innerHTML = rows.map(r => `
            <tr>
                <td style="font-weight:600;">${r.first_name} ${r.last_name}</td>
                <td>${r.check_in_time ? formatDisplayTime(r.check_in_time) : '—'}</td>
                <td>${r.check_out_time ? formatDisplayTime(r.check_out_time) : '—'}</td>
            </tr>
        `).join('');
    } catch (err) {
        body.innerHTML = '<tr><td colspan="3" style="text-align:center; color:var(--danger);">Failed to load check-ins.</td></tr>';
    }
}

function formatDisplayTime(dateTimeStr) {
    const d = new Date(dateTimeStr.replace(' ', 'T'));
    if (isNaN(d.getTime())) return dateTimeStr;
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function downloadMonthlyAttendance() {
    const year = attendanceCalendarDate.getFullYear();
    const monthStr = String(attendanceCalendarDate.getMonth() + 1).padStart(2, '0');

    try {
        const res = await fetch(`/api/admin/attendance?month=${year}-${monthStr}&limit=all`);
        const data = await res.json();
        const rows = (data.data || []).filter(r => r.status === 'success');

        if (rows.length === 0) {
            showToast('No attendance records for this month.', 'warning');
            return;
        }

        let csvContent = "data:text/csv;charset=utf-8,Member Name,Check-in Time,Check-out Time\n";
        rows.forEach(r => {
            csvContent += `"${r.first_name} ${r.last_name}","${r.check_in_time || ''}","${r.check_out_time || ''}"\n`;
        });

        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `attendance-${year}-${monthStr}.csv`);
        document.body.appendChild(link);
        link.click();
        link.remove();
    } catch (err) {
        showToast('Failed to download monthly attendance', 'error');
    }
}

function renderAttendanceChart(chartData) {
    const canvas = document.getElementById('attendanceBarChart');
    if (!canvas) return;

    if (dashboardAttendanceChartInstance) dashboardAttendanceChartInstance.destroy();

    const labels = chartData.map(item => item.day);
    const counts = chartData.map(item => item.count);

    dashboardAttendanceChartInstance = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Check-ins',
                data: counts,
                backgroundColor: 'rgba(234, 179, 8, 0.7)',
                borderColor: '#eab308',
                borderWidth: 1.5,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { color: '#94a3b8', stepSize: 1 }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: '#94a3b8' }
                }
            }
        }
    });
}

// Chart renders
function renderRevenueChart(chartData) {
    const canvas = document.getElementById('revenueLineChart');
    if (!canvas) return;

    if (revenueLineChart) revenueLineChart.destroy();

    const labels = chartData.map(d => d.month);
    const dataPoints = chartData.map(d => d.revenue);

    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 220);
    gradient.addColorStop(0, 'rgba(59, 130, 246, 0.2)');
    gradient.addColorStop(1, 'rgba(59, 130, 246, 0.0)');

    revenueLineChart = new Chart(canvas, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Revenue',
                data: dataPoints,
                borderColor: '#3b82f6',
                borderWidth: 3,
                pointBackgroundColor: '#ffffff',
                pointBorderColor: '#3b82f6',
                pointBorderWidth: 2,
                pointRadius: 4,
                pointHoverRadius: 6,
                backgroundColor: gradient,
                fill: true,
                tension: 0.3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function (c) { return ' ' + formatINRCurrency(c.raw); }
                    }
                }
            },
            scales: {
                y: {
                    grid: { color: '#f1f5f9' },
                    ticks: {
                        callback: function (val) { return '₹' + parseInt(val).toLocaleString('en-IN'); },
                        font: { family: 'Outfit, sans-serif', size: 10 }
                    }
                },
                x: {
                    grid: { display: false },
                    ticks: { font: { family: 'Outfit, sans-serif', size: 10 } }
                }
            }
        }
    });
}

function renderAttendanceDonut(todayCheckins, activeMembers) {
    const canvas = document.getElementById('attendanceDonutChart');
    if (!canvas) return;

    if (attendanceDonutChart) attendanceDonutChart.destroy();

    const checkedIn = todayCheckins;
    const notVisited = Math.max(0, activeMembers - todayCheckins);
    const total = checkedIn + notVisited;

    const checkedPct = total ? Math.round((checkedIn / total) * 100) : 0;
    const notVisitedPct = total ? Math.round((notVisited / total) * 100) : 0;

    document.getElementById('donutCheckedInCount').innerText = `${checkedIn} (${checkedPct}%)`;
    document.getElementById('donutNotVisitedCount').innerText = `${notVisited} (${notVisitedPct}%)`;
    document.getElementById('checkinRatioPercentText').innerText = `${checkedPct}% of active members`;

    attendanceDonutChart = new Chart(canvas, {
        type: 'doughnut',
        data: {
            labels: ['Checked In', 'Not Visited'],
            datasets: [{
                data: [checkedIn, notVisited],
                backgroundColor: ['#10b981', '#cbd5e1'],
                borderWidth: 2,
                borderColor: '#ffffff',
                hoverOffset: 3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '72%',
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function (c) { return ' ' + c.label + ': ' + c.raw; }
                    }
                }
            }
        }
    });
}

// ================= ORDER & FILTER MODAL CONTROLLER =================
let currentOrderFilterTab = 'members';
let modalSortDirection = 'desc';

function openOrderFilterModal(tabName) {
    currentOrderFilterTab = tabName || currentTab;
    const modal = document.getElementById('orderFilterModal');
    if (!modal) return;

    const titleEl = document.getElementById('orderModalTitle');
    const subtitleEl = document.getElementById('orderModalSubtitle');
    const filterLabel = document.getElementById('orderModalFilterLabel');
    const filterSelect = document.getElementById('orderModalFilterSelect');
    const sortBySelect = document.getElementById('orderModalSortBy');
    const pageSizeSelect = document.getElementById('orderModalPageSize');

    filterSelect.innerHTML = '';
    sortBySelect.innerHTML = '';

    if (currentOrderFilterTab === 'members') {
        titleEl.innerText = 'Filter & Order Members';
        subtitleEl.innerText = 'Sort and refine member directory records';
        filterLabel.innerText = 'Member Status';
        
        filterSelect.innerHTML = `
            <option value="all">All Members</option>
            <option value="active">Active Members</option>
            <option value="suspended">Suspended Members</option>
            <option value="expired">Expired Members</option>
            <option value="pending">Pending Approval</option>
        `;
        const curStatus = document.getElementById('memberStatusFilter')?.value || 'all';
        filterSelect.value = curStatus;

        sortBySelect.innerHTML = `
            <option value="first_name">Member Name</option>
            <option value="joined_at">Registration Date</option>
            <option value="status">Account Status</option>
            <option value="membership_number">Member ID</option>
        `;
        sortBySelect.value = memberSortBy || 'first_name';
        modalSortDirection = memberSortOrder || 'asc';
        pageSizeSelect.value = memberLimit || '25';

    } else if (currentOrderFilterTab === 'attendance') {
        titleEl.innerText = 'Filter & Order Attendance';
        subtitleEl.innerText = 'Sort and refine check-in & check-out logs';
        filterLabel.innerText = 'Time Range / Date';

        filterSelect.innerHTML = `
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="last7days">Last 7 Days</option>
            <option value="thismonth">This Month</option>
            <option value="all">All Logs</option>
        `;
        const curDate = document.getElementById('attendanceDateFilter')?.value || 'today';
        filterSelect.value = curDate;

        sortBySelect.innerHTML = `
            <option value="check_in_time">Check-In Timestamp</option>
            <option value="name">Member Name</option>
        `;
        sortBySelect.value = attendanceSortBy || 'check_in_time';
        modalSortDirection = attendanceSortOrder || 'desc';
        pageSizeSelect.value = attendanceLimit || '25';

    } else if (currentOrderFilterTab === 'payments') {
        titleEl.innerText = 'Filter & Order Payments';
        subtitleEl.innerText = 'Sort and refine membership transactions';
        filterLabel.innerText = 'Payment Status';

        filterSelect.innerHTML = `
            <option value="all">All Payments</option>
            <option value="paid">Paid</option>
            <option value="pending">Pending</option>
            <option value="overdue">Overdue</option>
        `;
        const curStatus = document.getElementById('paymentStatusFilter')?.value || 'all';
        filterSelect.value = curStatus;

        sortBySelect.innerHTML = `
            <option value="created_at">Transaction Date</option>
            <option value="amount">Amount</option>
            <option value="name">Member Name</option>
        `;
        sortBySelect.value = paymentSortBy || 'created_at';
        modalSortDirection = paymentSortOrder || 'desc';
        pageSizeSelect.value = paymentLimit || '25';
    }

    setModalSortDirection(modalSortDirection);
    openModal('orderFilterModal');
}

function setModalSortDirection(dir) {
    modalSortDirection = dir;
    const btnDesc = document.getElementById('btnSortDesc');
    const btnAsc = document.getElementById('btnSortAsc');
    if (btnDesc && btnAsc) {
        if (dir === 'desc') {
            btnDesc.classList.add('active');
            btnAsc.classList.remove('active');
        } else {
            btnDesc.classList.remove('active');
            btnAsc.classList.add('active');
        }
    }
}

function applyOrderModalFilters() {
    const filterSelect = document.getElementById('orderModalFilterSelect');
    const sortBySelect = document.getElementById('orderModalSortBy');
    const pageSizeSelect = document.getElementById('orderModalPageSize');

    const filterVal = filterSelect ? filterSelect.value : 'all';
    const sortByVal = sortBySelect ? sortBySelect.value : '';
    const pageSizeVal = pageSizeSelect ? pageSizeSelect.value : '25';

    if (currentOrderFilterTab === 'members') {
        const statusEl = document.getElementById('memberStatusFilter');
        const sizeEl = document.getElementById('memberPageSize');
        if (statusEl) statusEl.value = filterVal;
        if (sizeEl) sizeEl.value = pageSizeVal;
        memberSortBy = sortByVal;
        memberSortOrder = modalSortDirection;
        memberPage = 1;
        updateFilterButtonIndicator('memberFilterBtn', filterVal !== 'all' || memberSortBy !== 'first_name' || memberSortOrder !== 'asc');
        fetchMembers();
    } else if (currentOrderFilterTab === 'attendance') {
        const dateEl = document.getElementById('attendanceDateFilter');
        const sizeEl = document.getElementById('attendancePageSize');
        if (dateEl) dateEl.value = filterVal;
        if (sizeEl) sizeEl.value = pageSizeVal;
        attendanceSortBy = sortByVal;
        attendanceSortOrder = modalSortDirection;
        attendancePage = 1;
        updateFilterButtonIndicator('attendanceFilterBtn', filterVal !== 'today' || attendanceSortBy !== 'check_in_time' || attendanceSortOrder !== 'desc');
        fetchAttendance();
    } else if (currentOrderFilterTab === 'payments') {
        const statusEl = document.getElementById('paymentStatusFilter');
        const sizeEl = document.getElementById('paymentPageSize');
        if (statusEl) statusEl.value = filterVal;
        if (sizeEl) sizeEl.value = pageSizeVal;
        paymentSortBy = sortByVal;
        paymentSortOrder = modalSortDirection;
        paymentPage = 1;
        updateFilterButtonIndicator('paymentFilterBtn', filterVal !== 'all' || paymentSortBy !== 'created_at' || paymentSortOrder !== 'desc');
        fetchPayments();
    }

    closeModal('orderFilterModal');
}

function resetOrderModalFilters() {
    if (currentOrderFilterTab === 'members') {
        const statusEl = document.getElementById('memberStatusFilter');
        const sizeEl = document.getElementById('memberPageSize');
        if (statusEl) statusEl.value = 'all';
        if (sizeEl) sizeEl.value = '25';
        memberSortBy = 'first_name';
        memberSortOrder = 'asc';
        memberPage = 1;
        updateFilterButtonIndicator('memberFilterBtn', false);
        fetchMembers();
    } else if (currentOrderFilterTab === 'attendance') {
        const dateEl = document.getElementById('attendanceDateFilter');
        const sizeEl = document.getElementById('attendancePageSize');
        if (dateEl) dateEl.value = 'today';
        if (sizeEl) sizeEl.value = '25';
        attendanceSortBy = 'check_in_time';
        attendanceSortOrder = 'desc';
        attendancePage = 1;
        updateFilterButtonIndicator('attendanceFilterBtn', false);
        fetchAttendance();
    } else if (currentOrderFilterTab === 'payments') {
        const statusEl = document.getElementById('paymentStatusFilter');
        const sizeEl = document.getElementById('paymentPageSize');
        if (statusEl) statusEl.value = 'all';
        if (sizeEl) sizeEl.value = '25';
        paymentSortBy = 'created_at';
        paymentSortOrder = 'desc';
        paymentPage = 1;
        updateFilterButtonIndicator('paymentFilterBtn', false);
        fetchPayments();
    }
    closeModal('orderFilterModal');
}

function updateFilterButtonIndicator(btnId, hasActiveFilters) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    const dot = btn.querySelector('.active-filter-dot');
    if (hasActiveFilters) {
        btn.classList.add('active');
        if (dot) dot.style.display = 'inline-block';
    } else {
        btn.classList.remove('active');
        if (dot) dot.style.display = 'none';
    }
}

window.openOrderFilterModal = openOrderFilterModal;
window.setModalSortDirection = setModalSortDirection;
window.applyOrderModalFilters = applyOrderModalFilters;
window.resetOrderModalFilters = resetOrderModalFilters;

// Members tab directory loading
async function fetchMembers() {
    const search = document.getElementById('memberSearch').value;
    const status = document.getElementById('memberStatusFilter').value;
    const pageSize = document.getElementById('memberPageSize').value;
    memberLimit = pageSize;
    const tbody = document.getElementById('membersTableBody');

    try {
        const res = await fetch(`/api/admin/members?search=${encodeURIComponent(search)}&status=${status}&page=${memberPage}&limit=${memberLimit}&sort_by=${memberSortBy}&sort_order=${memberSortOrder}`);
        const result = await res.json();
        const members = result.data;
        memberTotal = result.total;

        cleanupPortaledDotsMenus();
        tbody.innerHTML = '';
        if (members.length === 0) {
            tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-tertiary); padding: 40px 0;">No members matching criteria.</td></tr>';
            document.getElementById('memberPaginationInfo').textContent = 'Showing 0 to 0 of 0 entries';
            document.getElementById('memberPaginationControls').innerHTML = '';
            return;
        }

        members.forEach(m => {
            const tr = document.createElement('tr');
            tr.id = `member-row-${m.id}`;
            if (selectedMembers.has(m.id)) {
                tr.classList.add('selected');
            }

            const badge = m.status === 'active' ? 'badge-active' : (m.status === 'suspended' ? 'badge-suspended' : 'badge-expired');
            const initial = ((m.first_name ? m.first_name[0] : '') + (m.last_name ? m.last_name[0] : '')).toUpperCase() || 'M';
            const planName = m.plan_name || 'No Plan';
            const expiryCell = m.end_date ? m.end_date : 'N/A';
            const isChecked = selectedMembers.has(m.id) ? 'checked' : '';

            const avatarHtml = MemberAvatar.html(m, { size: 36 });

            tr.innerHTML = `
                <td class="col-checkbox">
                    <input type="checkbox" class="table-checkbox row-checkbox" data-id="${m.id}" ${isChecked} onchange="toggleRowSelection('membersTable', ${m.id}, this)">
                </td>
                <td>
                    <div class="member-avatar-cell">
                        ${avatarHtml}
                        <div class="member-profile-desc">
                            <span class="member-fullname-bold">${m.first_name} ${m.last_name}</span>
                            <span class="member-email-dim">${m.email}</span>
                        </div>
                    </div>
                </td>
                <td class="col-id" data-label="Member ID"><span class="member-id-monospace">${m.membership_number || '--'}</span></td>
                <td class="col-phone" data-label="Phone Number">${m.phone}</td>
                <td class="col-joined" data-label="Joined Date">${new Date(m.joined_at).toLocaleDateString()}</td>
                <td class="col-status" data-label="Status">
                    <span class="badge ${badge}">${m.status}</span>
                    ${m.pending_payment_count > 0 ? '<span class="badge badge-suspended" style="margin-left:4px;" title="Fee pending">Fee Due</span>' : ''}
                </td>
                <td class="col-plan" data-label="Plan">
                    <div style="font-weight: 600;">${planName}</div>
                </td>
                <td class="col-expiry" data-label="Expiry Date">${expiryCell}</td>
                <td class="col-last-in" data-label="Last Check-in">${m.last_checkin ? new Date(m.last_checkin).toLocaleDateString() + ' ' + new Date(m.last_checkin).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Never'}</td>
                <td style="text-align: right;" class="col-actions">
                    <div class="dots-dropdown">
                        <button class="btn btn-ghost" style="padding: 6px;" onclick="toggleDotsMenu('member-dots-${m.id}', event)">•••</button>
                        <div id="member-dots-${m.id}" class="dots-dropdown-menu">
                            <button class="dots-dropdown-item" onclick="openEditMemberModal(${m.id})">Edit Member</button>
                            <button class="dots-dropdown-item" onclick="triggerAssignModal(${m.id}, '${m.first_name} ${m.last_name}')">Assign Plan</button>
                            <button class="dots-dropdown-item" style="color: var(--success-dark);" onclick="adminManualCheckIn(${m.id})">Manual Check-In</button>
                            <button class="dots-dropdown-item" style="color: var(--accent-dark);" onclick="adminManualCheckOut(${m.id})">Manual Check-Out</button>
                            <button class="dots-dropdown-item" style="color: var(--warning-dark);" onclick="toggleSuspendMember(${m.id}, '${m.status}')">
                                ${m.status === 'pending' ? 'Approve Member' : (m.status === 'suspended' ? 'Activate Member' : 'Suspend Member')}
                            </button>
                            <button class="dots-dropdown-item" style="color: var(--danger-dark);" onclick="deleteMember(${m.id})">Delete Member</button>
                        </div>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });

        const startEntry = (memberPage - 1) * memberLimit + 1;
        const endEntry = Math.min(memberPage * memberLimit, memberTotal);
        document.getElementById('memberPaginationInfo').textContent = `Showing ${startEntry} to ${endEntry} of ${memberTotal} entries`;

        renderPaginationControls('memberPaginationControls', memberPage, Math.ceil(memberTotal / memberLimit), (newPage) => {
            memberPage = newPage;
            fetchMembers();
        });

        applySavedColumnVisibility('membersTable');
        updateSelectAllCheckboxState('membersTable');

    } catch (err) {
        console.error('Fetch members error', err);
    }
}

// Attendance
async function fetchAttendance() {
    const search = document.getElementById('attendanceSearch').value;
    const dateStr = document.getElementById('attendanceDateFilter').value;
    const pageSize = document.getElementById('attendancePageSize').value;
    attendanceLimit = pageSize;
    const tbody = document.getElementById('attendanceTableBody');

    try {
        const res = await fetch(`/api/admin/attendance?search=${encodeURIComponent(search)}&date=${dateStr}&page=${attendancePage}&limit=${attendanceLimit}&sort_by=${attendanceSortBy}&sort_order=${attendanceSortOrder}`);
        const result = await res.json();
        const logs = result.data;
        attendanceTotal = result.total;

        tbody.innerHTML = '';
        if (logs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-tertiary); padding: 40px 0;">No check-in activity matches.</td></tr>';
            document.getElementById('attendancePaginationInfo').textContent = 'Showing 0 to 0 of 0 entries';
            document.getElementById('attendancePaginationControls').innerHTML = '';
            return;
        }

        logs.forEach(log => {
            const tr = document.createElement('tr');
            tr.id = `attendance-row-${log.id}`;
            if (selectedAttendance.has(log.id)) {
                tr.classList.add('selected');
            }

            const checkinDate = new Date(log.check_in_time);
            const displayTime = checkinDate.toLocaleDateString() + ' ' + checkinDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            
            let displayCheckout = 'Active';
            let durationStr = 'Active';
            if (log.check_out_time) {
                const checkoutDate = new Date(log.check_out_time);
                displayCheckout = checkoutDate.toLocaleDateString() + ' ' + checkoutDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                
                const diff = Math.floor((checkoutDate - checkinDate) / 60000);
                const hrs = Math.floor(diff / 60);
                const mins = diff % 60;
                durationStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
            } else if (log.status === 'failed') {
                displayCheckout = '—';
                durationStr = '—';
            }
            
            const isChecked = selectedAttendance.has(log.id) ? 'checked' : '';

            tr.innerHTML = `
                <td class="col-checkbox">
                    <input type="checkbox" class="table-checkbox row-checkbox" data-id="${log.id}" ${isChecked} onchange="toggleRowSelection('attendanceTable', ${log.id}, this)">
                </td>
                <td style="font-weight:600;">${log.first_name} ${log.last_name}</td>
                <td class="col-phone" data-label="Phone">${log.phone}</td>
                <td class="col-in" data-label="Check-in">${displayTime}</td>
                <td class="col-out" data-label="Check-out">${displayCheckout}</td>
                <td class="col-duration" data-label="Duration" style="font-weight:500;">${durationStr}</td>
                <td data-label="Actions">
                    <button class="btn btn-ghost" style="padding: 6px 12px; font-size:13px;" onclick="openMemberAttendanceModal(${log.member_id}, '${(log.first_name + ' ' + log.last_name).replace(/'/g, "\\'")}')">View Attendance</button>
                </td>
            `;
            tbody.appendChild(tr);
        });

        const startEntry = (attendancePage - 1) * attendanceLimit + 1;
        const endEntry = Math.min(attendancePage * attendanceLimit, attendanceTotal);
        document.getElementById('attendancePaginationInfo').textContent = `Showing ${startEntry} to ${endEntry} of ${attendanceTotal} entries`;

        renderPaginationControls('attendancePaginationControls', attendancePage, Math.ceil(attendanceTotal / attendanceLimit), (newPage) => {
            attendancePage = newPage;
            fetchAttendance();
        });

        applySavedColumnVisibility('attendanceTable');
        updateSelectAllCheckboxState('attendanceTable');

    } catch (err) {
        console.error('Fetch attendance error', err);
    }
}

// Per-member attendance history popup
let currentAttendanceMemberId = null;

function openMemberAttendanceModal(memberId, memberName) {
    currentAttendanceMemberId = memberId;
    document.getElementById('memberAttendanceName').textContent = memberName;
    document.getElementById('memberAttendanceViewMode').value = 'all';
    document.getElementById('memberAttendanceMonth').style.display = 'none';
    document.getElementById('memberAttendanceStart').style.display = 'none';
    document.getElementById('memberAttendanceEnd').style.display = 'none';
    document.getElementById('memberAttendanceRangeDash').style.display = 'none';
    document.getElementById('memberAttendanceMonth').value = new Date().toISOString().slice(0, 7);
    openModal('memberAttendanceModal');
    fetchMemberAttendanceHistory();
}

function onMemberAttendanceViewModeChange() {
    const mode = document.getElementById('memberAttendanceViewMode').value;
    document.getElementById('memberAttendanceMonth').style.display = mode === 'monthly' ? 'inline-block' : 'none';
    document.getElementById('memberAttendanceStart').style.display = mode === 'custom' ? 'inline-block' : 'none';
    document.getElementById('memberAttendanceEnd').style.display = mode === 'custom' ? 'inline-block' : 'none';
    document.getElementById('memberAttendanceRangeDash').style.display = mode === 'custom' ? 'inline' : 'none';
    fetchMemberAttendanceHistory();
}

async function fetchMemberAttendanceHistory() {
    if (!currentAttendanceMemberId) return;
    const mode = document.getElementById('memberAttendanceViewMode').value;
    const tbody = document.getElementById('memberAttendanceHistoryBody');
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding: 24px 0; color: var(--text-tertiary);">Loading...</td></tr>';

    let url = `/api/admin/attendance?member_id=${currentAttendanceMemberId}&limit=all&sort_by=check_in_time&sort_order=desc`;
    if (mode === 'monthly') {
        const month = document.getElementById('memberAttendanceMonth').value;
        if (month) url += `&month=${month}`;
    } else if (mode === 'custom') {
        const start = document.getElementById('memberAttendanceStart').value;
        const end = document.getElementById('memberAttendanceEnd').value;
        if (start) url += `&start_date=${start}`;
        if (end) url += `&end_date=${end}`;
    }

    try {
        const res = await fetch(url);
        const result = await res.json();
        const logs = result.data;

        tbody.innerHTML = '';
        if (logs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding: 24px 0; color: var(--text-tertiary);">No attendance records for this period.</td></tr>';
            document.getElementById('memberAttendanceSummary').textContent = '';
            return;
        }

        logs.forEach(log => {
            const tr = document.createElement('tr');
            const checkinDate = new Date(log.check_in_time);
            const displayIn = checkinDate.toLocaleDateString() + ' ' + checkinDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            let displayOut = 'Active';
            let durationStr = 'Active';
            if (log.check_out_time) {
                const checkoutDate = new Date(log.check_out_time);
                displayOut = checkoutDate.toLocaleDateString() + ' ' + checkoutDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const diff = Math.floor((checkoutDate - checkinDate) / 60000);
                const hrs = Math.floor(diff / 60);
                const mins = diff % 60;
                durationStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
            } else if (log.status === 'failed') {
                displayOut = '—';
                durationStr = '—';
            }

            const label = log.status === 'failed' ? 'Failed' : (log.attendance_state === 'completed' || log.check_out_time ? 'Completed' : 'Checked in');
            const badgeClass = log.status === 'failed' ? 'badge-suspended' : (label === 'Completed' ? 'badge-active' : 'badge-expired');

            tr.innerHTML = `
                <td>${displayIn}</td>
                <td>${displayOut}</td>
                <td>${durationStr}</td>
                <td><span class="badge ${badgeClass}">${label}</span></td>
            `;
            tbody.appendChild(tr);
        });

        document.getElementById('memberAttendanceSummary').textContent = `${result.total} check-in${result.total === 1 ? '' : 's'} in this period.`;
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding: 24px 0; color: var(--danger);">Failed to load attendance.</td></tr>';
    }
}

// Payments Directory
async function fetchPayments() {
    const status = document.getElementById('paymentStatusFilter').value;
    const search = document.getElementById('paymentSearch').value;
    const pageSize = document.getElementById('paymentPageSize').value;
    paymentLimit = pageSize;
    const tbody = document.getElementById('paymentsTableBody');

    // Show skeleton loader
    if (tbody) {
        tbody.innerHTML = '';
        for (let i = 0; i < 5; i++) {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td class="col-checkbox"><span class="skeleton-loader" style="display: inline-block; width: 16px; height: 16px;"></span></td>
                <td class="col-receipt"><span class="skeleton-loader" style="display: inline-block; width: 100px; height: 16px;"></span></td>
                <td>
                    <span class="skeleton-loader" style="display: inline-block; width: 120px; height: 18px; margin-bottom: 4px;"></span><br>
                    <span class="skeleton-loader" style="display: inline-block; width: 160px; height: 14px;"></span>
                </td>
                <td class="col-amount"><span class="skeleton-loader" style="display: inline-block; width: 60px; height: 16px;"></span></td>
                <td class="col-status"><span class="skeleton-loader" style="display: inline-block; width: 80px; height: 20px;"></span></td>
                <td class="col-date"><span class="skeleton-loader" style="display: inline-block; width: 80px; height: 16px;"></span></td>
                <td style="text-align: right;"><span class="skeleton-loader" style="display: inline-block; width: 24px; height: 24px;"></span></td>
            `;
            tbody.appendChild(tr);
        }
    }

    try {
        const res = await fetch(`/api/admin/payments?status=${status}&search=${encodeURIComponent(search)}&page=${paymentPage}&limit=${paymentLimit}&sort_by=${paymentSortBy}&sort_order=${paymentSortOrder}`);
        const result = await res.json();
        const payments = result.data;
        paymentTotal = result.total;

        cleanupPortaledDotsMenus();
        tbody.innerHTML = '';
        if (payments.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-tertiary); padding: 40px 0;">No billing records found.</td></tr>';
            document.getElementById('paymentPaginationInfo').textContent = 'Showing 0 to 0 of 0 entries';
            document.getElementById('paymentPaginationControls').innerHTML = '';
            return;
        }

        payments.forEach(p => {
            const tr = document.createElement('tr');
            tr.id = `payment-row-${p.id}`;
            if (selectedPayments.has(p.id)) {
                tr.classList.add('selected');
            }

            const badge = p.status === 'Approved' ? 'badge-active' : (p.status === 'Pending Approval' ? 'badge-pending-approval' : (p.status === 'Overdue' ? 'badge-suspended' : 'badge-expired'));
            const isChecked = selectedPayments.has(p.id) ? 'checked' : '';

            let actionBtn = '';
            if (p.status === 'Pending Approval') {
                actionBtn = `
                    <button class="dots-dropdown-item" style="color: var(--accent); font-weight: 600;" onclick="openReviewPaymentModal(${JSON.stringify(p).replace(/"/g, '&quot;')})">Review Payment</button>
                    <button class="dots-dropdown-item" style="color: var(--success-dark);" onclick="adminApprovePayment(${p.id})">Approve Payment</button>
                    <button class="dots-dropdown-item" style="color: var(--danger-dark);" onclick="adminRejectPayment(${p.id})">Reject Payment</button>
                `;
            } else if (p.status !== 'Approved') {
                actionBtn = `
                    <button class="dots-dropdown-item" onclick="triggerManualPaymentForm(${p.id})">Record Pay</button>
                    <button class="dots-dropdown-item" style="color: var(--warning-dark);" onclick="triggerWhatsAppModal(${p.id})">WhatsApp Alert</button>
                `;
            } else {
                actionBtn = `<button class="dots-dropdown-item" style="color: var(--accent);" onclick="generateMockReceipt(${p.id}, '${p.first_name} ${p.last_name}', '${p.plan_name}', ${p.amount}, '${p.payment_date}', '${p.receipt_number || ''}', '${p.payment_method || ''}')">Print Receipt</button>`;
            }

            if (p.receipt_file_url && p.receipt_file_url !== '—') {
                actionBtn += `<button class="dots-dropdown-item" style="color: var(--accent);" onclick="openReviewPaymentModal(${JSON.stringify(p).replace(/"/g, '&quot;')})">View Receipt Proof</button>`;
            }

            const dateVal = p.status === 'Approved' ? (p.payment_date || '—') : `Due: ${p.due_date || '—'}`;

            tr.innerHTML = `
                <td class="col-checkbox">
                    <input type="checkbox" class="table-checkbox row-checkbox" data-id="${p.id}" ${isChecked} onchange="toggleRowSelection('paymentsTable', ${p.id}, this)">
                </td>
                <td class="col-receipt" data-label="Receipt" style="font-family: monospace; font-size:13px; font-weight:600;">${p.receipt_number || 'PENDING'}</td>
                <td style="font-weight: 500;">
                    <div style="font-size: 13.5px; font-weight: 700; color: var(--text-primary);">${p.first_name} ${p.last_name}</div>
                    <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">Plan: ${p.plan_name || '—'}</div>
                    <div style="font-size: 11.5px; color: var(--text-tertiary); margin-top: 1px;">ID: ${p.member_id} | Phone: ${p.phone || '—'}</div>
                </td>
                <td class="col-amount" data-label="Amount">${formatINRCurrency(p.amount)}</td>
                <td class="col-status" data-label="Status">
                    <span class="badge ${badge}">${p.status}</span>
                    <div style="font-size: 11px; color: var(--text-secondary); margin-top: 4px;">Method: ${p.payment_method ? p.payment_method.toUpperCase() : '—'}</div>
                </td>
                <td class="col-date" data-label="Date/Due">${dateVal}</td>
                <td style="text-align: right;" class="col-actions">
                    <div class="dots-dropdown">
                        <button class="btn btn-ghost" style="padding: 6px;" onclick="toggleDotsMenu('payment-dots-${p.id}', event)">•••</button>
                        <div id="payment-dots-${p.id}" class="dots-dropdown-menu">
                            ${actionBtn}
                        </div>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });

        const startEntry = (paymentPage - 1) * paymentLimit + 1;
        const endEntry = Math.min(paymentPage * paymentLimit, paymentTotal);
        document.getElementById('paymentPaginationInfo').textContent = `Showing ${startEntry} to ${endEntry} of ${paymentTotal} entries`;

        renderPaginationControls('paymentPaginationControls', paymentPage, Math.ceil(paymentTotal / paymentLimit), (newPage) => {
            paymentPage = newPage;
            fetchPayments();
        });

        applySavedColumnVisibility('paymentsTable');
        updateSelectAllCheckboxState('paymentsTable');

    } catch (err) {
        console.error('Fetch payments error', err);
    }
}

// Membership Categories CRUD
async function fetchPlans() {
    const container = document.getElementById('plansContainer');
    try {
        const res = await fetch('/api/admin/plans');
        const plans = await res.json();

        container.innerHTML = '';
        if (plans.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: var(--text-tertiary); padding: 40px 0; grid-column: 1/-1;">No subscription plans created. Click Create New Plan above.</p>';
            return;
        }

        plans.forEach(plan => {
            const card = document.createElement('div');
            card.className = 'card';
            card.style.display = 'flex';
            card.style.flexDirection = 'column';
            card.style.justifyContent = 'space-between';

            card.innerHTML = `
                <div>
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
                        <h3 style="font-size: 20px; font-weight: 600;">${plan.name}</h3>
                        <span class="badge badge-active" style="padding: 2px 8px; font-size:11.5px;">${plan.duration_months} ${plan.duration_months === 1 ? 'Month' : 'Months'}</span>
                    </div>
                    <div style="font-size: 30px; font-weight: 700; color: var(--text-primary); margin-bottom: 16px;">
                        ${formatINRCurrency(plan.price)}
                    </div>
                    <div style="height: 1px; background-color: var(--border-color); margin-bottom: 16px;"></div>
                    <p style="font-size: 13.5px; color: var(--text-secondary); line-height: 1.5; margin-bottom: 24px;">
                        <strong>Benefits:</strong><br>${plan.benefits || 'Basic gym membership access'}
                    </p>
                </div>
                <div style="display: flex; gap: 8px; border-top: 1px solid var(--bg-raised); padding-top: 14px; margin-top: auto;">
                    <button class="btn btn-ghost" style="flex-grow: 1; padding: 8px 12px; font-size:13.5px;" onclick="triggerEditPlan(${JSON.stringify(plan).replace(/"/g, '&quot;')})">Edit</button>
                    <button class="btn btn-ghost" style="flex-grow: 1; padding: 8px 12px; font-size:13.5px; color: var(--danger-dark);" onclick="deletePlan(${plan.id})">Delete</button>
                </div>
            `;
            container.appendChild(card);
        });
    } catch (err) {
        console.error('Fetch plans error', err);
    }
}

// Dropdown injections helpers
async function fetchRegisterPlans(selectId = 'assignPlanSelect', includeNoPlanOption = false) {
    const select = document.getElementById(selectId);
    try {
        const res = await fetch('/api/admin/plans');
        const plans = await res.json();
        select.innerHTML = includeNoPlanOption
            ? '<option value="">No plan &mdash; add later</option>'
            : '<option value="" disabled selected>Select Membership Plan Tier</option>';
        plans.forEach(plan => {
            select.innerHTML += `<option value="${plan.id}">${plan.name} (${formatINRCurrency(plan.price)} - ${plan.duration_months}m)</option>`;
        });
    } catch (err) {
        console.error(err);
    }
}

async function fetchPendingPaymentsDropDown() {
    const select = document.getElementById('recordPaymentSelect');
    const summaryBox = document.getElementById('paymentAmountSummary');
    summaryBox.style.display = 'none';

    try {
        const res = await fetch('/api/admin/payments?limit=all');
        const resData = await res.json();
        const paymentsList = resData.data || [];
        const pendingList = paymentsList.filter(p => p.status !== 'paid');

        select.innerHTML = '<option value="" disabled selected>Select outstanding billing line</option>';

        if (pendingList.length === 0) {
            select.innerHTML = '<option value="" disabled>No outstanding member balances.</option>';
            return;
        }

        pendingList.forEach(p => {
            select.innerHTML += `<option value="${p.id}" data-amount="${p.amount}">${p.first_name} ${p.last_name} (${p.plan_name || 'Membership'} - ${formatINRCurrency(p.amount)})</option>`;
        });

        select.onchange = () => {
            const selectedOpt = select.options[select.selectedIndex];
            const amount = selectedOpt.getAttribute('data-amount');
            if (amount) {
                document.getElementById('paymentAmountVal').innerText = formatINRCurrency(amount);
                summaryBox.style.display = 'block';
            } else {
                summaryBox.style.display = 'none';
            }
        };
    } catch (err) {
        console.error(err);
    }
}

// Triggers
function triggerAssignModal(mbrId, name) {
    closeAllDotsMenus();
    fetchRegisterPlans('assignPlanSelect');
    document.getElementById('assignMemberId').value = mbrId;
    document.getElementById('assignMemberName').innerText = name;
    if (document.getElementById('assignStartDate')) {
        document.getElementById('assignStartDate').value = new Date().toISOString().split('T')[0];
    }
    openModal('assignPlanModal');
}

let editMemberCurrentStatus = 'active';

async function openEditMemberModal(mbrId) {
    closeAllDotsMenus();
    try {
        const res = await fetch(`/api/admin/members/${mbrId}`);
        const data = await res.json();
        if (!res.ok) {
            showToast(data.error || 'Failed to load member', 'error');
            return;
        }

        const m = data.member;
        editMemberCurrentStatus = m.status;
        document.getElementById('editMemberId').value = m.id;
        document.getElementById('emFirstName').value = m.first_name || '';
        document.getElementById('emLastName').value = m.last_name || '';
        document.getElementById('emEmail').value = m.email || '';
        document.getElementById('emPhone').value = m.phone || '';
        document.getElementById('emEmergencyName').value = m.emergency_contact_name || '';
        document.getElementById('emEmergencyNumber').value = m.emergency_contact_number || '';
        document.getElementById('emPassword').value = '';
        document.getElementById('emPlan').value = data.membership ? data.membership.plan_name : 'No Plan';

        const pendingPayment = (data.payments || []).find(p => p.status === 'pending' || p.status === 'overdue');
        document.getElementById('emFeePending').value = pendingPayment ? 'true' : 'false';

        openModal('editMemberModal');
    } catch (err) {
        showToast('Failed to load member details', 'error');
    }
}

function triggerManualPaymentForm(paymentId) {
    openModal('recordPaymentModal');
    setTimeout(() => {
        const select = document.getElementById('recordPaymentSelect');
        select.value = paymentId;
        if (select.onchange) select.onchange();
    }, 300);
}

async function triggerWhatsAppModal(paymentId) {
    try {
        const res = await fetch(`/api/admin/payments/${paymentId}/reminder`, { method: 'POST' });
        const data = await res.json();

        const cleanMsg = data.message || '';
        const cleanPhone = data.phone || '';
        const waUrl = WhatsAppUtility.buildWhatsAppUrl(cleanPhone, cleanMsg);

        document.getElementById('whatsappPreviewTxt').innerText = cleanMsg;
        document.getElementById('whatsappTriggerLink').href = waUrl || '#';
        
        document.getElementById('whatsappTriggerLink').onclick = function(e) {
            if (!waUrl) {
                e.preventDefault();
                showToast("Member does not have a valid WhatsApp number.", "warning");
                return;
            }
            closeModal('whatsappModal');
        };

        openModal('whatsappModal');
    } catch (err) {
        showToast('Failed to generate reminder link', 'error');
    }
}

// One-click reminders for the Pending Dues / Expiring Soon dashboard panels:
// skip the preview modal and open WhatsApp with the message already filled in.
// (WhatsApp's click-to-chat links can only pre-fill a message - the recipient
// still has to hit Send in WhatsApp itself, since there's no way to submit a
// message from a plain web link without the paid WhatsApp Business API.)
async function sendPaymentReminder(paymentId) {
    try {
        const res = await fetch(`/api/admin/payments/${paymentId}/reminder`, { method: 'POST' });
        const data = await res.json();
        if (data.message && data.phone) {
            WhatsAppUtility.openWhatsApp(data.phone, data.message);
        } else {
            showToast(data.error || 'Failed to generate reminder link', 'error');
        }
    } catch (err) {
        showToast('Failed to generate reminder link', 'error');
    }
}

async function sendRenewalReminder(memberId) {
    try {
        const res = await fetch(`/api/admin/members/${memberId}/renewal-reminder`);
        const data = await res.json();
        if (data.message && data.phone) {
            WhatsAppUtility.openWhatsApp(data.phone, data.message);
        } else {
            showToast(data.error || 'Failed to generate reminder link', 'error');
        }
    } catch (err) {
        showToast('Failed to generate reminder link', 'error');
    }
}

function triggerEditPlan(plan) {
    document.getElementById('editPlanId').value = plan.id;
    document.getElementById('pName').value = plan.name;
    document.getElementById('pPrice').value = plan.price;
    document.getElementById('pDuration').value = plan.duration_months;
    document.getElementById('pBenefits').value = plan.benefits || '';
    document.getElementById('planModalTitle').innerText = 'Edit Membership Plan';
    openModal('addPlanModal');
}

// Side tab populates
async function populateRemindersTab() {
    const tbody = document.getElementById('remindersTabTableBody');
    if (!tbody) return;

    try {
        const res = await fetch('/api/admin/payments');
        const payments = await res.json();
        const pendingList = payments.filter(p => p.status !== 'paid');

        tbody.innerHTML = '';
        if (pendingList.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-tertiary); padding: 40px 0;">No pending member balances found.</td></tr>';
            return;
        }

        pendingList.forEach(p => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="font-weight:600;">${p.first_name} ${p.last_name}</td>
                <td>${p.plan_name || 'Membership Plan'}</td>
                <td style="font-weight:700; color:var(--danger-dark);">${formatINRCurrency(p.amount)}</td>
                <td><span class="badge ${p.status === 'overdue' ? 'badge-suspended' : 'badge-expired'}">${p.status}</span></td>
                <td style="text-align: right;">
                    <button class="btn btn-ghost" style="padding: 6px 12px; font-size: 12.5px; color: var(--warning-dark);" onclick="triggerWhatsAppModal(${p.id})">WhatsApp Alert</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        console.error(err);
    }
}

async function populateReportsTab() {
    try {
        const res = await fetch('/api/admin/stats');
        const data = await res.json();

        document.getElementById('reportCheckinsCount').innerText = data.stats.today_checkins;
        document.getElementById('reportRevenueVal').innerText = formatINRCurrency(data.stats.monthly_revenue);
        document.getElementById('reportOutstandingVal').innerText = formatINRCurrency(data.stats.pending_amount);
    } catch (err) {
        console.error(err);
    }

    setupRevenueFilterDefaults();
    fetchRevenueList();
}

function setupRevenueFilterDefaults() {
    const yearSelect = document.getElementById('revenueYearFilter');
    const monthSelect = document.getElementById('revenueMonthFilter');
    if (!yearSelect || yearSelect.options.length > 0) return; // already initialized

    const now = new Date();
    const currentYear = now.getFullYear();
    for (let y = currentYear; y >= currentYear - 4; y--) {
        const opt = document.createElement('option');
        opt.value = y;
        opt.innerText = y;
        yearSelect.appendChild(opt);
    }
    yearSelect.value = currentYear;
    monthSelect.value = String(now.getMonth() + 1).padStart(2, '0');
}

async function fetchRevenueList() {
    const year = document.getElementById('revenueYearFilter').value;
    const month = document.getElementById('revenueMonthFilter').value;
    const body = document.getElementById('revenueTableBody');
    body.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:16px;">Loading…</td></tr>';

    try {
        const res = await fetch(`/api/admin/payments?status=paid&year=${year}&month=${month}&limit=all`);
        const data = await res.json();
        const rows = data.data || [];

        let total = 0;
        rows.forEach(r => total += r.amount);
        document.getElementById('revenueTotalInfo').innerText = `Total: ${formatINRCurrency(total)} (${rows.length} payments)`;

        if (rows.length === 0) {
            body.innerHTML = '<tr><td colspan="3" style="text-align:center; color:var(--text-tertiary); padding:16px;">No revenue recorded for this month.</td></tr>';
            return;
        }

        body.innerHTML = rows.map(r => `
            <tr>
                <td style="font-weight:600;">${r.first_name} ${r.last_name}</td>
                <td style="font-weight:700;">${formatINRCurrency(r.amount)}</td>
                <td>${r.plan_name || 'No Plan'}</td>
            </tr>
        `).join('');
    } catch (err) {
        body.innerHTML = '<tr><td colspan="3" style="text-align:center; color:var(--danger);">Failed to load revenue.</td></tr>';
    }
}

async function downloadRevenueList() {
    const year = document.getElementById('revenueYearFilter').value;
    const month = document.getElementById('revenueMonthFilter').value;

    try {
        const res = await fetch(`/api/admin/payments?status=paid&year=${year}&month=${month}&limit=all`);
        const data = await res.json();
        const rows = data.data || [];

        if (rows.length === 0) {
            showToast('No revenue recorded for this month.', 'warning');
            return;
        }

        let csvContent = "data:text/csv;charset=utf-8,Member Name,Fees,Plan\n";
        rows.forEach(r => {
            csvContent += `"${r.first_name} ${r.last_name}","${r.amount}","${r.plan_name || 'No Plan'}"\n`;
        });

        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `revenue-${year}-${month}.csv`);
        document.body.appendChild(link);
        link.click();
        link.remove();
    } catch (err) {
        showToast('Failed to download revenue', 'error');
    }
}

// Settings fetch
async function fetchGymSettings() {
    try {
        const res = await fetch('/api/admin/settings');
        gymSettings = await res.json();

        const codeInput = document.getElementById('settingsGymCode');
        const nameInput = document.getElementById('settingsGymName');
        const phoneInput = document.getElementById('settingsGymPhone');
        const addressInput = document.getElementById('settingsGymAddress');
        const tokenInput = document.getElementById('settingsQRToken');
        const emailInput = document.getElementById('settingsGymEmail');
        const gstInput = document.getElementById('settingsGymGST');
        const footerInput = document.getElementById('settingsReceiptFooter');

        if (codeInput) codeInput.value = gymSettings.gym_code || '';
        if (nameInput) nameInput.value = gymSettings.gym_name || '';
        if (phoneInput) phoneInput.value = gymSettings.gym_phone || '';
        if (addressInput) addressInput.value = gymSettings.gym_address || '';
        if (tokenInput) tokenInput.value = gymSettings.qr_token || '';
        if (emailInput) emailInput.value = gymSettings.gym_email || '';
        if (gstInput) gstInput.value = gymSettings.gst_number || '';
        if (footerInput) footerInput.value = gymSettings.receipt_footer || '';
        
        const logoUrl = gymSettings.gym_logo || gymSettings.gym_image_url || '';
        updateGymLogoPreviewUI(logoUrl);
        renderGymBranding(logoUrl, gymSettings.gym_name);
        renderDashboardGymImage(logoUrl);
        drawSettingsQR();
    } catch (err) {
        console.error('Gym settings loading error', err);
    }
}

let currentSelectedOwnerPhoto = null; // null = unchanged, "" = removed, base64 = new

function handleOwnerPhotoSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
        showToast('Unsupported format. Please upload PNG, JPG, or WEBP image.', 'error');
        event.target.value = '';
        return;
    }
    if (file.size > 2 * 1024 * 1024) {
        showToast('File size exceeds 2MB limit. Please choose a smaller image.', 'error');
        event.target.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = function(e) {
        currentSelectedOwnerPhoto = e.target.result;
        updateOwnerPhotoPreviewUI(currentSelectedOwnerPhoto);
    };
    reader.readAsDataURL(file);
}

function removeOwnerPhoto() {
    currentSelectedOwnerPhoto = "";
    const fileInput = document.getElementById('ownerPhotoFileInput');
    if (fileInput) fileInput.value = '';
    updateOwnerPhotoPreviewUI("");
}

function updateOwnerPhotoPreviewUI(photoSrc) {
    const previewImg = document.getElementById('ownerPhotoPreview');
    const fallbackSpan = document.getElementById('ownerPhotoFallback');
    const removeBtn = document.getElementById('btnRemoveOwnerPhoto');

    if (photoSrc) {
        previewImg.src = photoSrc;
        previewImg.style.display = 'block';
        fallbackSpan.style.display = 'none';
        if (removeBtn) removeBtn.style.display = 'inline-block';
    } else {
        previewImg.src = '';
        previewImg.style.display = 'none';
        fallbackSpan.style.display = 'block';
        if (removeBtn) removeBtn.style.display = 'none';
    }
}

window.handleOwnerPhotoSelect = handleOwnerPhotoSelect;
window.removeOwnerPhoto = removeOwnerPhoto;

let currentSelectedGymLogo = null; // null = unchanged, "" = removed, base64/url = new

function handleGymLogoSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
        showToast('Unsupported format. Please upload PNG, JPG, or WEBP image.', 'error');
        event.target.value = '';
        return;
    }
    if (file.size > 2 * 1024 * 1024) {
        showToast('File size exceeds 2MB limit. Please choose a smaller image.', 'error');
        event.target.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = function(e) {
        currentSelectedGymLogo = e.target.result;
        updateGymLogoPreviewUI(currentSelectedGymLogo);
    };
    reader.readAsDataURL(file);
}

function removeGymLogo() {
    currentSelectedGymLogo = "";
    const fileInput = document.getElementById('gymLogoFileInput');
    if (fileInput) fileInput.value = '';
    updateGymLogoPreviewUI("");
}

function updateGymLogoPreviewUI(logoSrc) {
    const previewImg = document.getElementById('gymLogoPreview');
    const fallbackSpan = document.getElementById('gymLogoFallback');
    const removeBtn = document.getElementById('btnRemoveGymLogo');

    if (logoSrc) {
        previewImg.src = logoSrc;
        previewImg.style.display = 'block';
        fallbackSpan.style.display = 'none';
        if (removeBtn) removeBtn.style.display = 'inline-block';
    } else {
        previewImg.src = '';
        previewImg.style.display = 'none';
        fallbackSpan.style.display = 'block';
        if (removeBtn) removeBtn.style.display = 'none';
    }
}

function renderGymBranding(logoUrl, gymName) {
    const sidebarLogoEl = document.querySelector('.brand-logo-fitzone');
    if (sidebarLogoEl) {
        if (logoUrl) {
            sidebarLogoEl.innerHTML = `<img src="${logoUrl}" style="width:100%; height:100%; object-fit:cover; border-radius: 8px;" alt="Gym Logo">`;
        } else {
            sidebarLogoEl.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>`;
        }
    }
    const brandNameEl = document.querySelector('.brand-title-fitzone .brand-main');
    if (brandNameEl) brandNameEl.innerText = gymName || 'GymOS';
    const headerNameEl = document.getElementById('headerGymName');
    if (headerNameEl) headerNameEl.innerText = gymName || 'GymOS';

    // Dynamic browser tab title
    document.title = `GymOS Admin • ${gymName || 'GymOS'}`;

    // Mini branding element next to logo
    const miniBrandEl = document.getElementById('mobileBrandText');
    if (miniBrandEl) miniBrandEl.innerText = `${gymName || 'GymOS'} Admin`;

    // Footer copy branding
    const footerEl = document.querySelector('.dashboard-copy-footer');
    if (footerEl) footerEl.innerHTML = `&copy; 2026 ${gymName || 'GymOS'}. All rights reserved. Powered by GymOS.`;
}

function copyGymCode() {
    const codeInput = document.getElementById('settingsGymCode');
    if (!codeInput.value) {
        showToast('No Gym ID set yet', 'error');
        return;
    }
    navigator.clipboard.writeText(codeInput.value).then(() => {
        showToast('Gym ID copied to clipboard.');
    }).catch(() => {
        showToast('Could not copy automatically - select and copy manually.', 'error');
    });
}

function copyQRToken() {
    const tokenInput = document.getElementById('settingsQRToken');
    if (!tokenInput || !tokenInput.value) {
        showToast('No QR Token available', 'error');
        return;
    }
    navigator.clipboard.writeText(tokenInput.value).then(() => {
        showToast('Universal QR Token copied to clipboard.');
    }).catch(() => {
        showToast('Could not copy automatically - copy manually.', 'error');
    });
}

async function regenerateQRToken() {
    const confirmed = await showConfirmDialog({
        title: 'Regenerate QR Token',
        message: 'Regenerating will invalidate all existing QR codes. Members will need to refresh scan codes. Are you sure you want to generate a new QR token?',
        confirmText: 'Regenerate Token',
        type: 'danger'
    });
    if (!confirmed) return;

    try {
        const res = await fetch('/api/admin/settings/regenerate-qr-token', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast('New QR Token generated successfully.');
            const tokenInput = document.getElementById('settingsQRToken');
            if (tokenInput) tokenInput.value = data.qr_token;
            gymSettings.qr_token = data.qr_token;
            drawSettingsQR();
            drawGymQR();
        } else {
            showToast(data.error || 'Failed to regenerate token', 'error');
        }
    } catch (err) {
        showToast('Failed to regenerate QR token.', 'error');
    }
}

function updateTimeBasedGreeting() {
    const timeEl = document.getElementById('greetingTimePrefix');
    if (!timeEl) return;
    const hour = new Date().getHours();
    let prefix = 'Good Morning';
    if (hour >= 12 && hour < 17) {
        prefix = 'Good Afternoon';
    } else if (hour >= 17 || hour < 5) {
        prefix = 'Good Evening';
    }
    timeEl.innerText = prefix;
}

function renderDashboardGymImage(imageUrl) {
    const imgEl = document.getElementById('dashboardGymImage');
    const fallbackEl = document.getElementById('dashboardGymLogoFallback');
    if (!imgEl) return;
    if (imageUrl) {
        imgEl.src = imageUrl;
        imgEl.style.display = 'block';
        if (fallbackEl) fallbackEl.style.display = 'none';
    } else {
        imgEl.style.display = 'none';
        if (fallbackEl) fallbackEl.style.display = 'inline-block';
    }
}

function fillDemoOwnerCredentials() {
    const emailInput = document.getElementById('loginEmail');
    const pwdInput = document.getElementById('loginPassword');
    const errBox = document.getElementById('loginError');
    if (emailInput) emailInput.value = 'owner@gymos.com';
    if (pwdInput) pwdInput.value = 'password123';
    if (errBox) errBox.style.display = 'none';
    showToast('Demo owner credentials populated', 'info');
}

// Setup handlers
function setupFormHandlers() {
    // Restore saved email if remember-me was used
    const savedEmail = localStorage.getItem('gymos_saved_email');
    const emailInput = document.getElementById('loginEmail');
    const rememberCheckbox = document.getElementById('rememberEmailCheckbox');
    if (savedEmail && emailInput) {
        emailInput.value = savedEmail;
        if (rememberCheckbox) rememberCheckbox.checked = true;
    }

    // Login
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('loginEmail').value.trim();
        const password = document.getElementById('loginPassword').value;
        const rememberMe = document.getElementById('rememberEmailCheckbox')?.checked;
        const submitBtn = document.getElementById('loginSubmitBtn');
        const origBtnText = submitBtn ? submitBtn.innerText : 'Sign In';

        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerText = 'Signing In…';
        }

        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });
            const data = await res.json();

            if (data.success) {
                if (data.user.role !== 'owner') {
                    loginError.innerText = 'Logins here restricted to Gym Owners.';
                    loginError.style.display = 'block';
                    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = origBtnText; }
                    return;
                }

                if (rememberMe) {
                    localStorage.setItem('gymos_saved_email', email);
                } else {
                    localStorage.removeItem('gymos_saved_email');
                }
                localStorage.setItem('gymos_owner_auth', 'true');

                loginOverlay.style.display = 'none';
                appLayout.style.display = 'flex';
                showToast('Login successful', 'success');
                checkUserSession();
            } else {
                loginError.innerText = data.error || 'Authentication failed';
                loginError.style.display = 'block';
            }
        } catch (err) {
            loginError.innerText = 'Unable to connect to server. If using HTTPS, accept the browser security prompt or check server status.';
            loginError.style.display = 'block';
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerText = origBtnText;
            }
        }
    });

    // Forgot Password
    const forgotPasswordForm = document.getElementById('forgotPasswordForm');
    if (forgotPasswordForm) {
        forgotPasswordForm.addEventListener('submit', submitForgotPassword);
    }

    // Profile Trigger / Logout
    const profileCard = document.querySelector('.owner-profile-card');
    if (profileCard) {
        profileCard.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            triggerOwnerLogout(e);
        });
    }

    // Settings Update
    document.getElementById('settingsForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const logoPayload = currentSelectedGymLogo !== null ? currentSelectedGymLogo : (gymSettings.gym_logo || gymSettings.gym_image_url || '');
        const data = {
            gym_code: document.getElementById('settingsGymCode').value,
            gym_name: document.getElementById('settingsGymName').value,
            gym_phone: document.getElementById('settingsGymPhone').value,
            gym_address: document.getElementById('settingsGymAddress').value,
            qr_token: document.getElementById('settingsQRToken').value,
            gym_email: document.getElementById('settingsGymEmail').value,
            gst_number: document.getElementById('settingsGymGST').value,
            receipt_footer: document.getElementById('settingsReceiptFooter').value,
            gym_logo: logoPayload,
            gym_image_url: logoPayload
        };

        try {
            const res = await fetch('/api/admin/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            const resData = await res.json();
            if (resData.success) {
                showToast('Configuration updated');
                currentSelectedGymLogo = null;
                fetchGymSettings();
            } else {
                showToast(resData.error, 'error');
            }
        } catch (err) {
            showToast('Network error updating settings', 'error');
        }
    });
    // Owner Profile Update
    const ownerProfileForm = document.getElementById('ownerProfileForm');
    if (ownerProfileForm) {
        ownerProfileForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = document.getElementById('btnUpdateOwnerProfile');
            const originalText = btn.innerHTML;
            
            // Loading state
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-small"></span> Updating...';

            const first_name = document.getElementById('settingsOwnerFirstName').value.trim();
            const last_name = document.getElementById('settingsOwnerLastName').value.trim();
            const photoPayload = currentSelectedOwnerPhoto; // null = unchanged, "" = removed, base64 = new

            const payload = { first_name, last_name };
            if (photoPayload !== null) {
                payload.profile_photo = photoPayload;
            }

            try {
                const res = await fetch('/api/admin/owner-profile', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                
                if (!res.ok) {
                    const errorText = await res.text();
                    let errMsg = `Server returned ${res.status}`;
                    try {
                        const parsed = JSON.parse(errorText);
                        errMsg = parsed.error || errMsg;
                    } catch (_) {}
                    throw new Error(errMsg);
                }

                const resData = await res.json();
                if (resData.success) {
                    showToast('Owner Profile updated successfully', 'success');
                    currentSelectedOwnerPhoto = null;
                    
                    // Real-time synchronization WITHOUT refresh:
                    // 1. Sidebar Name
                    const nameEl = document.getElementById('profileOwnerName');
                    if (nameEl) nameEl.innerText = resData.updated_owner_name;

                    // 2. Sidebar Image
                    const avatarDiv = document.getElementById('profileOwnerAvatar');
                    if (avatarDiv) {
                        if (resData.updated_image_url) {
                            avatarDiv.innerHTML = `<img src="${resData.updated_image_url}" style="width:100%; height:100%; object-fit:cover; border-radius:50%;" alt="Avatar">`;
                        } else {
                            const initials = ((first_name ? first_name[0] : '') + (last_name ? last_name[0] : '')).toUpperCase() || 'OW';
                            avatarDiv.innerText = initials;
                            avatarDiv.innerHTML = initials;
                        }
                    }

                    // 3. Dashboard greeting
                    const greetingUser = document.getElementById('greetingUser');
                    if (greetingUser) greetingUser.innerText = first_name;

                    // 4. Update photo input preview state
                    const profilePreview = document.getElementById('ownerPhotoPreview');
                    const profileFallback = document.getElementById('ownerPhotoFallback');
                    const profileRemoveBtn = document.getElementById('btnRemoveOwnerPhoto');
                    if (profilePreview && profileFallback) {
                        if (resData.updated_image_url) {
                            profilePreview.src = resData.updated_image_url;
                            profilePreview.style.display = 'block';
                            profileFallback.style.display = 'none';
                            if (profileRemoveBtn) profileRemoveBtn.style.display = 'inline-block';
                        } else {
                            profilePreview.src = '';
                            profilePreview.style.display = 'none';
                            profileFallback.style.display = 'block';
                            if (profileRemoveBtn) profileRemoveBtn.style.display = 'none';
                        }
                    }
                } else {
                    showToast(resData.error || 'Failed to update profile', 'error');
                }
            } catch (err) {
                showToast(err.message || 'Server unavailable', 'error');
            } finally {
                btn.disabled = false;
                btn.innerHTML = originalText;
            }
        });
    }

    // Add Member: show/hide plan options based on plan selection
    document.getElementById('mPlanSelect').addEventListener('change', (e) => {
        document.getElementById('mPlanOptionsSection').style.display = e.target.value ? 'block' : 'none';
    });
    document.getElementById('mCustomPlanToggle').addEventListener('change', (e) => {
        document.getElementById('mCustomPlanDates').style.display = e.target.checked ? 'grid' : 'none';
    });

    // Add Member
    document.getElementById('addMemberForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const planId = document.getElementById('mPlanSelect').value;
        const isCustomPlan = document.getElementById('mCustomPlanToggle').checked;
        const data = {
            first_name: document.getElementById('mFirstName').value,
            last_name: document.getElementById('mLastName').value,
            email: document.getElementById('mEmail').value,
            phone: document.getElementById('mPhone').value,
            emergency_contact_name: document.getElementById('mEmergencyName').value,
            emergency_contact_number: document.getElementById('mEmergencyNumber').value,
            password: document.getElementById('mPassword').value,
            plan_id: planId,
            record_payment: document.getElementById('mRecordPayment').checked
        };
        if (isCustomPlan) {
            const customStart = document.getElementById('mCustomStartDate').value;
            const customEnd = document.getElementById('mCustomEndDate').value;
            if (customStart) data.start_date = customStart;
            if (customEnd) data.end_date = customEnd;
        }

        try {
            const res = await fetch('/api/admin/members', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            const resData = await res.json();
            if (!resData.success) {
                showToast(resData.error, 'error');
                return;
            }

            closeModal('addMemberModal');
            document.getElementById('addMemberForm').reset();
            showToast('Member created and plan assigned successfully.');
            fetchMembers();
            fetchDashboardStats();
        } catch (err) {
            showToast('Create request failed', 'error');
        }
    });

    // Edit member
    document.getElementById('editMemberForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('editMemberId').value;
        const data = {
            first_name: document.getElementById('emFirstName').value,
            last_name: document.getElementById('emLastName').value,
            email: document.getElementById('emEmail').value,
            phone: document.getElementById('emPhone').value,
            emergency_contact_name: document.getElementById('emEmergencyName').value,
            emergency_contact_number: document.getElementById('emEmergencyNumber').value,
            status: editMemberCurrentStatus,
            password: document.getElementById('emPassword').value || undefined,
            fee_pending: document.getElementById('emFeePending').value === 'true'
        };

        try {
            const res = await fetch(`/api/admin/members/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            const resData = await res.json();
            if (resData.success) {
                closeModal('editMemberModal');
                showToast('Member updated successfully.');
                fetchMembers();
                fetchDashboardStats();
            } else {
                showToast(resData.error, 'error');
            }
        } catch (err) {
            showToast('Update request failed', 'error');
        }
    });

    // Assign plan
    document.getElementById('assignPlanForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const memberId = document.getElementById('assignMemberId').value;
        const data = {
            plan_id: document.getElementById('assignPlanSelect').value,
            start_date: document.getElementById('assignStartDate').value,
            record_payment: document.getElementById('assignRecordPayment').checked
        };

        try {
            const res = await fetch(`/api/admin/members/${memberId}/assign-plan`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            const resData = await res.json();
            if (resData.success) {
                closeModal('assignPlanModal');
                showToast('Plan assigned successfully.');
                fetchMembers();
                fetchDashboardStats();
            } else {
                showToast(resData.error, 'error');
            }
        } catch (err) {
            showToast('Plan assignment error', 'error');
        }
    });

    // Record Payment
    document.getElementById('recordPaymentForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const paymentId = document.getElementById('recordPaymentSelect').value;

        try {
            const res = await fetch('/api/admin/payments/record', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ payment_id: paymentId })
            });
            const resData = await res.json();
            if (resData.success) {
                closeModal('recordPaymentModal');
                showToast('Payment marked as PAID.');
                fetchPayments();
                fetchDashboardStats();
                if (currentTab === 'reminders') populateRemindersTab();
            } else {
                showToast(resData.error, 'error');
            }
        } catch (err) {
            showToast('Record payment error', 'error');
        }
    });

    // Save plan
    document.getElementById('addPlanForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const editId = document.getElementById('editPlanId').value;
        const url = editId ? `/api/admin/plans/${editId}` : '/api/admin/plans';
        const method = editId ? 'PUT' : 'POST';

        const data = {
            name: document.getElementById('pName').value,
            price: document.getElementById('pPrice').value,
            duration_months: document.getElementById('pDuration').value,
            benefits: document.getElementById('pBenefits').value
        };

        try {
            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            const resData = await res.json();
            if (resData.success) {
                closeModal('addPlanModal');
                document.getElementById('addPlanForm').reset();
                document.getElementById('editPlanId').value = '';
                document.getElementById('planModalTitle').innerText = 'Create Membership Plan';
                showToast('Membership plan saved.');
                fetchPlans();
                fetchDashboardStats();
            } else {
                showToast(resData.error, 'error');
            }
        } catch (err) {
            showToast('Plan save failed', 'error');
        }
    });
}

async function logoutOwner(event) {
    return triggerOwnerLogout(event);
}

// Inline toggle suspend
async function toggleSuspendMember(id, currentStatus) {
    closeAllDotsMenus();
    const target = (currentStatus === 'suspended' || currentStatus === 'pending') ? 'active' : 'suspended';
    const confirmMsg = target === 'suspended' ? 'Are you sure you want to suspend this member?' : (currentStatus === 'pending' ? 'Approve and activate this member?' : 'Reactivate this member account?');
    const confirmed = await showConfirmDialog({
        title: target === 'suspended' ? 'Suspend Member' : 'Activate Member',
        message: confirmMsg,
        confirmText: target === 'suspended' ? 'Suspend' : 'Activate',
        type: target === 'suspended' ? 'warning' : 'info'
    });
    if (!confirmed) return;

    try {
        const detailRes = await fetch(`/api/admin/members/${id}`);
        const details = await detailRes.json();
        const m = details.member;
        m.status = target;

        const res = await fetch(`/api/admin/members/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(m)
        });
        const resData = await res.json();
        if (resData.success) {
            showToast(`Member profile set to ${target}.`);
            fetchMembers();
            fetchDashboardStats();
        } else {
            showToast(resData.error || 'Failed modifying member status', 'error');
        }
    } catch (err) {
        showToast('Failed to modify status', 'error');
    }
}

async function deleteMember(id) {
    closeAllDotsMenus();
    const confirmed = await showConfirmDialog({
        title: 'Delete Member',
        message: 'Are you sure you want to permanently delete this member? All attendance logs and payment records will be removed.',
        confirmText: 'Delete Permanently',
        type: 'danger'
    });
    if (!confirmed) return;

    try {
        const res = await fetch(`/api/admin/members/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            showToast('Member profile permanently deleted.');
            fetchMembers();
            fetchDashboardStats();
        } else {
            showToast(data.error || 'Failed deleting member profile', 'error');
        }
    } catch (err) {
        showToast('Failed deleting member profile', 'error');
    }
}

async function deletePlan(id) {
    const confirmed = await showConfirmDialog({
        title: 'Delete Plan',
        message: 'Are you sure you want to delete this membership plan tier?',
        confirmText: 'Delete Plan',
        type: 'danger'
    });
    if (!confirmed) return;

    try {
        const res = await fetch(`/api/admin/plans/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            showToast('Subscription plan tier deleted.');
            fetchPlans();
            fetchDashboardStats();
        } else {
            showToast(data.error || 'Failed deleting; plan is assigned to active members.', 'error');
        }
    } catch (err) {
        showToast('Network error deleting plan', 'error');
    }
}

function drawGymQR() {
    const token = gymSettings.qr_token || 'gymos-token-xyz-123';
    const txtEl = document.getElementById('qrTokenDisplayTxt');
    if (txtEl) txtEl.innerText = `Token: ${token}`;

    const container = document.getElementById('gymQRCodeContainer');
    if (container && typeof QRCode !== 'undefined') {
        container.innerHTML = '';
        new QRCode(container, {
            text: token,
            width: 180,
            height: 180,
            colorDark: '#0f172a',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.M
        });
    }
}

// Settings Subtab Switching
function switchSettingsSubtab(subtabKey) {
    const subtabs = ['profile', 'qr', 'branding', 'owner'];
    subtabs.forEach(tab => {
        const tabCap = tab.charAt(0).toUpperCase() + tab.slice(1);
        const btn = document.getElementById(`subtabBtn${tabCap}`);
        const pane = document.getElementById(`settingsPane${tabCap}`);
        if (btn) {
            if (tab === subtabKey) btn.classList.add('active');
            else btn.classList.remove('active');
        }
        if (pane) {
            if (tab === subtabKey) pane.classList.add('active');
            else pane.classList.remove('active');
        }
    });

    if (subtabKey === 'qr') {
        setTimeout(drawSettingsQR, 50);
    }
}
window.switchSettingsSubtab = switchSettingsSubtab;

function drawSettingsQR() {
    const token = gymSettings.qr_token || 'gymos-token-xyz-123';
    const badge = document.getElementById('settingsQRTokenBadge');
    if (badge) badge.innerText = `Token: ${token}`;

    const container = document.getElementById('settingsQRCodeContainer');
    if (container && typeof QRCode !== 'undefined') {
        container.innerHTML = '';
        new QRCode(container, {
            text: token,
            width: 128,
            height: 128,
            colorDark: '#0f172a',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.M
        });
    }
}

function downloadGymQRCode() {
    // Check Settings QR container first, then modal container
    let container = document.getElementById('settingsQRCodeContainer');
    let img = container ? container.querySelector('img') : null;
    let canvas = container ? container.querySelector('canvas') : null;

    if (!img && !canvas) {
        container = document.getElementById('gymQRCodeContainer');
        if (container) {
            if (!container.querySelector('img') && !container.querySelector('canvas')) {
                drawGymQR();
            }
            img = container.querySelector('img');
            canvas = container.querySelector('canvas');
        }
    }

    if (!img && !canvas) {
        drawSettingsQR();
        container = document.getElementById('settingsQRCodeContainer');
        if (container) {
            img = container.querySelector('img');
            canvas = container.querySelector('canvas');
        }
    }

    const dataUrl = img ? img.src : (canvas ? canvas.toDataURL('image/png') : null);

    if (!dataUrl) {
        showToast('QR code is not ready yet, please wait a moment.', 'warning');
        return;
    }

    const gymSlug = (gymSettings.gym_name || 'gym').toLowerCase().replace(/[^a-z0-9]/g, '-');
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = `${gymSlug}-entrance-qr.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    showToast('Gym Entrance QR Code downloaded successfully.', 'success');
}

function triggerAttendanceExport() {
    const dateStr = document.getElementById('attendanceDateFilter').value || 'all';

    let csvContent = "data:text/csv;charset=utf-8,Member,Phone,Check-In Logs,Verification State,Feedback\n";
    const rows = document.querySelectorAll('#attendanceTableBody tr');

    if (rows.length === 1 && rows[0].innerText.includes('No check-in')) {
        showToast("Empty logs. Add check-ins to export logs.", "warning");
        return;
    }
    showToast(`Downloading check-in logs for: [${dateStr}]`, "info");

    rows.forEach(tr => {
        const cols = tr.querySelectorAll('td');
        if (cols.length >= 5) {
            const name = cols[0].innerText;
            const phone = cols[1].innerText;
            const time = cols[2].innerText;
            const status = cols[3].innerText;
            const feedback = cols[4].innerText;
            csvContent += `"${name}","${phone}","${time}","${status}","${feedback}"\n`;
        }
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `gymos_attendance_${dateStr}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function generateMockReceipt(id, name, plan, amount, date, receipt_number, payment_method) {
    const win = window.open("", "Receipt " + id, "width=400,height=550");
    const d = new Date(date).toLocaleString();
    const receiptId = receipt_number || `RCPT-PAY-${new Date(date).toISOString().slice(0, 10).replace(/-/g, '')}-${String(id).padStart(6, '0')}`;
    
    const gymName = gymSettings.gym_name || 'GymOS';
    const gymPhone = gymSettings.gym_phone || '';
    const gymAddress = gymSettings.gym_address || '';
    const gymEmail = gymSettings.gym_email || '';
    const gstNo = gymSettings.gst_number || '';
    const customFooter = gymSettings.receipt_footer || `Thank you for choosing ${gymName}.<br>We appreciate your trust and wish you success on your fitness journey.<br>Powered by GymOS`;

    win.document.write(`
    <html>
    <head>
      <title>Payment Receipt</title>
      <style>
        body { font-family: monospace; padding: 24px; color: #333; line-height: 1.4; }
        .center { text-align: center; }
        .divider { border-bottom: 2px dashed #999; margin: 16px 0; }
        .row { display: flex; justify-content: space-between; }
        .bold { font-weight: bold; }
        .logo { font-size: 24px; font-weight: bold; margin-bottom: 4px; }
      </style>
    </head>
    <body>
      <div class="center">
        <div class="logo">${gymName}</div>
        <div>${gymAddress}</div>
        ${gymPhone ? `<div>Phone: ${gymPhone}</div>` : ''}
        ${gymEmail ? `<div>Email: ${gymEmail}</div>` : ''}
        ${gstNo ? `<div>GST No: ${gstNo}</div>` : ''}
      </div>
      <div class="divider"></div>
      <div class="center bold">RECEIPT FOR PAYMENT</div>
      <div style="margin-top: 10px;">Receipt ID: ${receiptId}</div>
      <div>Date: ${d}</div>
      <div>Method: ${(payment_method || 'online').toUpperCase()}</div>
      <div class="divider"></div>
      <div class="row"><span class="bold">Member:</span> <span>${name}</span></div>
      <div class="row"><span class="bold">Description:</span> <span>${plan} Plan</span></div>
      <div class="row"><span class="bold">Tax:</span> <span>₹0.00</span></div>
      <div class="divider"></div>
      <div class="row bold" style="font-size:16px;"><span>Total Paid:</span> <span>${formatINRCurrency(amount)}</span></div>
      <div class="divider"></div>
      <div class="center bold" style="font-size: 11px; line-height: 1.4;">
        ${customFooter}
      </div>
      <script>window.print();</script>
    </body>
    </html>
  `);
    win.document.close();
}

/* ================= PREMIUM TABLE HELPER FUNCTIONS ================= */

function getRandomColorForChar(char) {
    const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#14b8a6', '#6366f1'];
    const idx = char.charCodeAt(0) % colors.length;
    return colors[idx] || '#64748b';
}

function avatarHtmlWithFallback(photo, initialsHtml, size) {
    return MemberAvatar.html({ profile_photo: photo }, { size: size || 36 });
}

function resetMemberPageAndFetch() {
    memberPage = 1;
    selectedMembers.clear();
    updateSelectedCountAndOverlay('membersTable');
    fetchMembers();
}

function resetAttendancePageAndFetch() {
    attendancePage = 1;
    selectedAttendance.clear();
    updateSelectedCountAndOverlay('attendanceTable');
    fetchAttendance();
}

function resetPaymentPageAndFetch() {
    paymentPage = 1;
    selectedPayments.clear();
    updateSelectedCountAndOverlay('paymentsTable');
    fetchPayments();
}

function toggleSortMembers(col) {
    if (memberSortBy === col) {
        memberSortOrder = memberSortOrder === 'asc' ? 'desc' : 'asc';
    } else {
        memberSortBy = col;
        memberSortOrder = 'asc';
    }

    const headers = document.querySelectorAll('#membersTable th');
    headers.forEach(th => th.classList.remove('sort-asc', 'sort-desc'));

    fetchMembers();
}

function toggleSortAttendance(col) {
    if (attendanceSortBy === col) {
        attendanceSortOrder = attendanceSortOrder === 'asc' ? 'desc' : 'asc';
    } else {
        attendanceSortBy = col;
        attendanceSortOrder = 'desc';
    }
    fetchAttendance();
}

function toggleSortPayments(col) {
    if (paymentSortBy === col) {
        paymentSortOrder = paymentSortOrder === 'asc' ? 'desc' : 'asc';
    } else {
        paymentSortBy = col;
        paymentSortOrder = 'desc';
    }
    fetchPayments();
}

function renderPaginationControls(containerId, currentPage, totalPages, onPageChange) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    if (totalPages <= 1) return;

    // Previous Button
    const prevBtn = document.createElement('button');
    prevBtn.className = 'pagination-btn';
    prevBtn.innerHTML = '‹';
    prevBtn.disabled = currentPage === 1;
    prevBtn.onclick = () => onPageChange(currentPage - 1);
    container.appendChild(prevBtn);

    // Page Numbers
    const startPage = Math.max(1, currentPage - 2);
    const endPage = Math.min(totalPages, currentPage + 2);

    if (startPage > 1) {
        const firstBtn = document.createElement('button');
        firstBtn.className = 'pagination-btn';
        firstBtn.innerText = '1';
        firstBtn.onclick = () => onPageChange(1);
        container.appendChild(firstBtn);

        if (startPage > 2) {
            const dots = document.createElement('span');
            dots.innerText = '...';
            dots.style.margin = '0 4px';
            container.appendChild(dots);
        }
    }

    for (let i = startPage; i <= endPage; i++) {
        const btn = document.createElement('button');
        btn.className = `pagination-btn ${i === currentPage ? 'active' : ''}`;
        btn.innerText = i;
        btn.onclick = () => onPageChange(i);
        container.appendChild(btn);
    }

    if (endPage < totalPages) {
        if (endPage < totalPages - 1) {
            const dots = document.createElement('span');
            dots.innerText = '...';
            dots.style.margin = '0 4px';
            container.appendChild(dots);
        }

        const lastBtn = document.createElement('button');
        lastBtn.className = 'pagination-btn';
        lastBtn.innerText = totalPages;
        lastBtn.onclick = () => onPageChange(totalPages);
        container.appendChild(lastBtn);
    }

    // Next Button
    const nextBtn = document.createElement('button');
    nextBtn.className = 'pagination-btn';
    nextBtn.innerHTML = '›';
    nextBtn.disabled = currentPage === totalPages;
    nextBtn.onclick = () => onPageChange(currentPage + 1);
    container.appendChild(nextBtn);
}

function toggleRowSelection(tableId, id, checkboxEl) {
    const row = document.getElementById(tableId === 'membersTable' ? `member-row-${id}` : (tableId === 'attendanceTable' ? `attendance-row-${id}` : `payment-row-${id}`));
    const selectedSet = tableId === 'membersTable' ? selectedMembers : (tableId === 'attendanceTable' ? selectedAttendance : selectedPayments);

    if (checkboxEl.checked) {
        selectedSet.add(id);
        if (row) row.classList.add('selected');
    } else {
        selectedSet.delete(id);
        if (row) row.classList.remove('selected');
    }

    updateSelectedCountAndOverlay(tableId);
    updateSelectAllCheckboxState(tableId);
}

function toggleAllRowCheckboxes(tableId, selectAllCheckbox) {
    const tbody = document.getElementById(tableId === 'membersTable' ? 'membersTableBody' : (tableId === 'attendanceTable' ? 'attendanceTableBody' : 'paymentsTableBody'));
    const checkboxes = tbody.querySelectorAll('.row-checkbox');
    const selectedSet = tableId === 'membersTable' ? selectedMembers : (tableId === 'attendanceTable' ? selectedAttendance : selectedPayments);

    checkboxes.forEach(cb => {
        const id = parseInt(cb.dataset.id);
        cb.checked = selectAllCheckbox.checked;
        const row = document.getElementById(tableId === 'membersTable' ? `member-row-${id}` : (tableId === 'attendanceTable' ? `attendance-row-${id}` : `payment-row-${id}`));

        if (selectAllCheckbox.checked) {
            selectedSet.add(id);
            if (row) row.classList.add('selected');
        } else {
            selectedSet.delete(id);
            if (row) row.classList.remove('selected');
        }
    });

    updateSelectedCountAndOverlay(tableId);
}

function updateSelectedCountAndOverlay(tableId) {
    const selectedSet = tableId === 'membersTable' ? selectedMembers : (tableId === 'attendanceTable' ? selectedAttendance : selectedPayments);
    const count = selectedSet.size;
    const overlay = document.getElementById('bulkActionsBar');
    const countVal = document.getElementById('bulkSelectedVal');

    if (count > 0 && currentTab === (tableId === 'membersTable' ? 'members' : (tableId === 'attendanceTable' ? 'attendance' : 'payments'))) {
        countVal.innerText = count;
        overlay.classList.add('active');
    } else {
        overlay.classList.remove('active');
    }
}

function updateSelectAllCheckboxState(tableId) {
    const selectAllCb = document.getElementById(tableId === 'membersTable' ? 'selectAllMembers' : (tableId === 'attendanceTable' ? 'selectAllAttendance' : 'selectAllPayments'));
    if (!selectAllCb) return;

    const tbody = document.getElementById(tableId === 'membersTable' ? 'membersTableBody' : (tableId === 'attendanceTable' ? 'attendanceTableBody' : 'paymentsTableBody'));
    const checkboxes = tbody.querySelectorAll('.row-checkbox');

    if (checkboxes.length === 0) {
        selectAllCb.checked = false;
        return;
    }

    let allChecked = true;
    checkboxes.forEach(cb => {
        if (!cb.checked) allChecked = false;
    });

    selectAllCb.checked = allChecked;
}

function clearAllSelections() {
    selectedMembers.clear();
    selectedAttendance.clear();
    selectedPayments.clear();

    const checkboxes = document.querySelectorAll('.table-checkbox');
    checkboxes.forEach(cb => cb.checked = false);

    const rows = document.querySelectorAll('.premium-table tr');
    rows.forEach(r => r.classList.remove('selected'));

    const overlay = document.getElementById('bulkActionsBar');
    if (overlay) overlay.classList.remove('active');
}

function toggleVisDropdown(menuId) {
    const menus = document.querySelectorAll('.vis-dropdown-menu');
    menus.forEach(m => {
        if (m.id !== menuId) m.classList.remove('active');
    });

    const target = document.getElementById(menuId);
    if (target) target.classList.toggle('active');
}

function toggleTableColumn(tableId, colClassName) {
    const cells = document.querySelectorAll(`#${tableId} .${colClassName}`);
    cells.forEach(c => c.classList.toggle('hidden-col'));

    const visState = localStorage.getItem(`vis_${tableId}`) ? JSON.parse(localStorage.getItem(`vis_${tableId}`)) : {};
    const isHidden = cells.length > 0 && cells[0].classList.contains('hidden-col');
    visState[colClassName] = !isHidden;
    localStorage.setItem(`vis_${tableId}`, JSON.stringify(visState));
}

function applySavedColumnVisibility(tableId) {
    const visState = localStorage.getItem(`vis_${tableId}`) ? JSON.parse(localStorage.getItem(`vis_${tableId}`)) : null;
    if (!visState) return;

    Object.keys(visState).forEach(colClassName => {
        const isVisible = visState[colClassName];
        const cells = document.querySelectorAll(`#${tableId} .${colClassName}`);

        cells.forEach(c => {
            if (isVisible) {
                c.classList.remove('hidden-col');
            } else {
                c.classList.add('hidden-col');
            }
        });

        const menuId = tableId === 'membersTable' ? 'memberVisMenu' : (tableId === 'attendanceTable' ? 'attendanceVisMenu' : 'paymentVisMenu');
        const menu = document.getElementById(menuId);
        if (menu) {
            const cb = menu.querySelector(`input[onchange*="${colClassName}"]`);
            if (cb) cb.checked = isVisible;
        }
    });
}

// Table wrappers scroll horizontally (overflow-x: auto), which clips any
// absolutely-positioned dropdown nested inside them. To keep the menu fully
// visible we portal it to <body> as a fixed-position overlay while open,
// positioned from the toggle button's on-screen coordinates.
function closeAllDotsMenus() {
    document.querySelectorAll('.dots-dropdown-menu.active').forEach(m => {
        m.classList.remove('active');
        m.style.position = '';
        m.style.top = '';
        m.style.left = '';
        m.style.right = '';
        m.style.margin = '';
    });
}

// Removes any dropdown menus left behind in <body> from a previous render of
// a table (e.g. if the table refreshed while a menu was open). Call this
// before rebuilding a table that contains .dots-dropdown-menu elements, so
// stale, duplicate-id menus never pile up.
function cleanupPortaledDotsMenus() {
    document.querySelectorAll('body > .dots-dropdown-menu').forEach(m => m.remove());
}

function toggleDotsMenu(menuId, event) {
    event.stopPropagation();
    const target = document.getElementById(menuId);
    if (!target) return;

    const wasActive = target.classList.contains('active');
    closeAllDotsMenus();
    if (wasActive) return;

    const btn = event.currentTarget;
    const rect = btn.getBoundingClientRect();
    document.body.appendChild(target);
    target.classList.add('active');
    target.style.position = 'fixed';
    target.style.margin = '0';
    target.style.right = 'auto';
    target.style.top = `${rect.bottom + 4}px`;

    const menuWidth = target.offsetWidth || 160;
    let left = rect.right - menuWidth;
    if (left < 8) left = 8;
    const maxLeft = window.innerWidth - menuWidth - 8;
    if (left > maxLeft) left = maxLeft;
    target.style.left = `${left}px`;
}

document.addEventListener('click', (event) => {
    if (!event.target.closest('.dots-dropdown') && !event.target.closest('.dots-dropdown-menu')) {
        closeAllDotsMenus();
    }

    if (!event.target.closest('.vis-dropdown-relative')) {
        const visMenus = document.querySelectorAll('.vis-dropdown-menu');
        visMenus.forEach(m => m.classList.remove('active'));
    }
});

async function triggerBulkExport() {
    let mode = '';
    let selectedSet = null;
    if (currentTab === 'members') { mode = 'members'; selectedSet = selectedMembers; }
    else if (currentTab === 'attendance') { mode = 'attendance'; selectedSet = selectedAttendance; }
    else if (currentTab === 'payments') { mode = 'payments'; selectedSet = selectedPayments; }

    if (!selectedSet || selectedSet.size === 0) return;

    showToast(`Exporting ${selectedSet.size} selected ${mode} rows as CSV.`, 'info');

    let csvContent = "data:text/csv;charset=utf-8,";
    if (mode === 'members') {
        csvContent += "ID,Name,Email,Phone,Joined Date,Status,Plan,Last Checkin\n";
        selectedSet.forEach(id => {
            const row = document.getElementById(`member-row-${id}`);
            if (row) {
                const name = row.querySelector('.member-fullname-bold').innerText;
                const email = row.querySelector('.member-email-dim').innerText;
                const idVal = row.querySelector('.member-id-monospace').innerText;
                const phone = row.querySelector('.col-phone').innerText;
                const joined = row.querySelector('.col-joined').innerText;
                const status = row.querySelector('.col-status').innerText;
                const plan = row.querySelector('.col-plan div').innerText;
                const checkin = row.querySelector('.col-last-in').innerText;
                csvContent += `"${idVal}","${name}","${email}","${phone}","${joined}","${status}","${plan}","${checkin}"\n`;
            }
        });
    } else if (mode === 'attendance') {
        csvContent += "Name,Phone,Check-In Time,Check-Out Time,Workout Duration\n";
        selectedSet.forEach(id => {
            const row = document.getElementById(`attendance-row-${id}`);
            if (row) {
                const cols = row.querySelectorAll('td');
                const name = cols[1].innerText;
                const phone = cols[2].innerText;
                const checkin = cols[3].innerText;
                const checkout = cols[4].innerText;
                const duration = cols[5].innerText;
                csvContent += `"${name}","${phone}","${checkin}","${checkout}","${duration}"\n`;
            }
        });
    } else if (mode === 'payments') {
        csvContent += "Receipt ID,Member,Amount,Status,Payment Date\n";
        selectedSet.forEach(id => {
            const row = document.getElementById(`payment-row-${id}`);
            if (row) {
                const receipt = row.querySelector('.col-receipt').innerText;
                const name = row.querySelectorAll('td')[2].innerText;
                const amount = row.querySelector('.col-amount').innerText;
                const status = row.querySelector('.col-status').innerText;
                const date = row.querySelector('.col-date').innerText;
                csvContent += `"${receipt}","${name}","${amount}","${status}","${date}"\n`;
            }
        });
    }

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `gymos_${mode}_export_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

async function triggerBulkSuspend() {
    if (currentTab !== 'members') {
        showToast("Bulk Suspend check is only supported for Members list.", "warning");
        return;
    }
    if (selectedMembers.size === 0) return;

    const confirmed = await showConfirmDialog({
        title: 'Bulk Status Update',
        message: `Are you sure you want to toggle user suspension states for ${selectedMembers.size} selected members?`,
        confirmText: 'Toggle Status',
        type: 'warning'
    });
    if (!confirmed) return;

    let successCount = 0;
    for (const id of selectedMembers) {
        try {
            const detailRes = await fetch(`/api/admin/members/${id}`);
            const details = await detailRes.json();
            const m = details.member;
            m.status = m.status === 'suspended' ? 'active' : 'suspended';

            const res = await fetch(`/api/admin/members/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(m)
            });
            const data = await res.json();
            if (data.success) successCount++;
        } catch (e) {
            console.error("Error bulk toggling member ", id, e);
        }
    }

    showToast(`Successfully updated statuses for ${successCount} member records.`);
    clearAllSelections();
    fetchMembers();
    fetchDashboardStats();
}

async function triggerBulkDelete() {
    let mode = '';
    let selectedSet = null;
    let endpoint = '';
    if (currentTab === 'members') { mode = 'members'; selectedSet = selectedMembers; endpoint = '/api/admin/members/'; }
    else if (currentTab === 'attendance') { mode = 'attendance'; selectedSet = selectedAttendance; }
    else if (currentTab === 'payments') { mode = 'payments'; selectedSet = selectedPayments; }

    if (!selectedSet || selectedSet.size === 0) return;

    if (mode !== 'members') {
        showToast("Delete operations are only supported for entire Member accounts.", "warning");
        return;
    }

    const confirmed = await showConfirmDialog({
        title: 'Permanent Member Deletion',
        message: `CRITICAL WARNING: Are you sure you want to permanently DELETE ${selectedSet.size} members and clear all their check-in logs and payments?`,
        confirmText: 'Delete Members',
        type: 'danger'
    });
    if (!confirmed) return;

    let deletedCount = 0;
    for (const id of selectedSet) {
        try {
            const res = await fetch(`${endpoint}${id}`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) deletedCount++;
        } catch (e) {
            console.error("Failed bulk delete item ", id, e);
        }
    }

    showToast(`Permanently deleted ${deletedCount} member profiles.`);
    clearAllSelections();
    fetchMembers();
    fetchDashboardStats();
}

function exportMembersCSV() {
    if (selectedMembers.size > 0) {
        triggerBulkExport();
        return;
    }

    showToast("Downloading current page of Members directory as CSV.", "info");
    let csvContent = "data:text/csv;charset=utf-8,ID,Name,Email,Phone,Joined Date,Status,Plan,Last Checkin\n";
    const rows = document.querySelectorAll('#membersTableBody tr');

    rows.forEach(tr => {
        if (tr.querySelector('.member-fullname-bold')) {
            const name = tr.querySelector('.member-fullname-bold').innerText;
            const email = tr.querySelector('.member-email-dim').innerText;
            const idVal = tr.querySelector('.member-id-monospace').innerText;
            const phone = tr.querySelector('.col-phone').innerText;
            const joined = tr.querySelector('.col-joined').innerText;
            const status = tr.querySelector('.col-status').innerText;
            const plan = tr.querySelector('.col-plan div').innerText;
            const checkin = tr.querySelector('.col-last-in').innerText;
            csvContent += `"${idVal}","${name}","${email}","${phone}","${joined}","${status}","${plan}","${checkin}"\n`;
        }
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `gymos_members_page_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function exportAttendanceCSV() {
    if (selectedAttendance.size > 0) {
        triggerBulkExport();
        return;
    }

    const dateStr = document.getElementById('attendanceDateFilter').value || 'all';
    showToast(`Downloading check-in logs for: [${dateStr}]`, "info");

    let csvContent = "data:text/csv;charset=utf-8,Member,Phone,Check-In Time,Check-Out Time,Workout Duration\n";
    const rows = document.querySelectorAll('#attendanceTableBody tr');

    rows.forEach(tr => {
        const cols = tr.querySelectorAll('td');
        if (cols.length >= 6) {
            const name = cols[1].innerText;
            const phone = cols[2].innerText;
            const checkin = cols[3].innerText;
            const checkout = cols[4].innerText;
            const duration = cols[5].innerText;
            csvContent += `"${name}","${phone}","${checkin}","${checkout}","${duration}"\n`;
        }
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `gymos_attendance_${dateStr}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function exportPaymentsCSV() {
    if (selectedPayments.size > 0) {
        triggerBulkExport();
        return;
    }

    showToast("Downloading current page of Billings records as CSV.", "info");
    let csvContent = "data:text/csv;charset=utf-8,Receipt ID,Member,Amount,Status,Payment Date\n";
    const rows = document.querySelectorAll('#paymentsTableBody tr');

    rows.forEach(tr => {
        if (tr.querySelector('.col-receipt')) {
            const receipt = tr.querySelector('.col-receipt').innerText;
            const name = tr.querySelectorAll('td')[2].innerText;
            const amount = tr.querySelector('.col-amount').innerText;
            const status = tr.querySelector('.col-status').innerText;
            const date = tr.querySelector('.col-date').innerText;
            csvContent += `"${receipt}","${name}","${amount}","${status}","${date}"\n`;
        }
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `gymos_payments_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Custom Admin Leaderboard, Manual Attendance & Payment Approvals JS
async function fetchAdminLeaderboard() {
    const listContainer = document.getElementById('adminLeaderboardList');
    if (!listContainer) return;
    listContainer.innerHTML = '';
    
    try {
        const res = await fetch('/api/leaderboard');
        const data = await res.json();
        
        if (data.length === 0) {
            listContainer.innerHTML = '<p style="text-align: center; color: var(--text-tertiary); font-size: 13px; padding: 12px 0;">No leaderboard data yet.</p>';
            return;
        }
        
        data.forEach((user, idx) => {
            const item = document.createElement('div');
            item.className = 'recent-joiner-item';
            item.style.justifyContent = 'space-between';
            item.style.padding = '8px';
            item.style.borderRadius = 'var(--radius-sm)';
            if (idx === 0) {
                item.style.backgroundColor = 'rgba(234, 179, 8, 0.05)';
                item.style.border = '1px solid rgba(234, 179, 8, 0.2)';
            }
            
            const rankColors = ['#eab308', '#94a3b8', '#d97706'];
            const rankBadge = idx < 3 
                ? `<span style="display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:50%; background:${rankColors[idx]}20; color:${rankColors[idx]}; font-size:11px; font-weight:800; border:1px solid ${rankColors[idx]}60;">${idx + 1}</span>`
                : `<span style="font-weight:700; color:var(--text-tertiary); margin-right: 6px; font-size:12px;">#${idx + 1}</span>`;

            item.innerHTML = `
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span>${rankBadge}</span>
                    ${MemberAvatar.html(user, { size: 36 })}
                    <div class="joiner-details">
                        <span class="joiner-name">${user.first_name} ${user.last_name}</span>
                    </div>
                </div>
                <div style="text-align: right;">
                    <span style="font-size: 12px; font-weight: 700; color: var(--accent);">${user.checkin_count} check-ins</span>
                </div>
            `;
            listContainer.appendChild(item);
        });
    } catch (err) {
        console.error('Fetch admin leaderboard failed', err);
        listContainer.innerHTML = '<p style="text-align: center; color: var(--danger-dark); font-size: 12px;">Failed to load rankings.</p>';
    }
}

async function adminApprovePayment(id) {
    const confirmed = await showConfirmDialog({
        title: 'Approve Payment',
        message: 'Are you sure you want to approve this payment request?',
        confirmText: 'Approve Payment',
        type: 'info'
    });
    if (!confirmed) return;
    try {
        const res = await fetch(`/api/admin/payments/${id}/approve`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast('Payment request approved successfully!');
            fetchPayments();
            fetchDashboardStats();
        } else {
            showToast(data.error || 'Failed to approve payment.', 'error');
        }
    } catch (err) {
        console.error('Approve payment error', err);
        showToast('Network error, please try again.', 'error');
    }
}

function setRejectExample(text) {
    document.getElementById('rejectReason').value = text;
}

function adminRejectPayment(id) {
    closeAllDotsMenus();
    document.getElementById('rejectPaymentId').value = id;
    document.getElementById('rejectReason').value = '';
    openModal('rejectPaymentModal');
}

async function submitRejectPayment(event) {
    event.preventDefault();
    const id = document.getElementById('rejectPaymentId').value;
    const reason = document.getElementById('rejectReason').value.trim();

    if (!reason) {
        showToast('Please enter a rejection reason.', 'error');
        return;
    }

    try {
        const res = await fetch(`/api/admin/payments/${id}/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rejection_reason: reason })
        });
        const data = await res.json();
        if (data.success) {
            showToast('Payment request rejected.');
            closeModal('rejectPaymentModal');
            fetchPayments();
            fetchDashboardStats();
        } else {
            showToast(data.error || 'Failed to reject payment.', 'error');
        }
    } catch (err) {
        console.error('Reject payment error', err);
        showToast('Network error, please try again.', 'error');
    }
}

function openReviewPaymentModal(p) {
    document.getElementById('reviewPaymentId').value = p.id;
    document.getElementById('reviewMemberName').textContent = `${p.first_name} ${p.last_name || ''}`;
    document.getElementById('reviewMemberId').textContent = p.membership_number || '—';
    document.getElementById('reviewPlanName').textContent = p.plan_name || 'Membership Renewal';
    document.getElementById('reviewAmount').textContent = formatINRCurrency(p.amount);
    document.getElementById('reviewPaymentDate').textContent = p.payment_date || '—';
    document.getElementById('reviewPaymentMethod').textContent = p.payment_method ? p.payment_method.toUpperCase() : '—';
    document.getElementById('reviewRefId').textContent = p.transaction_reference || '—';
    document.getElementById('reviewReceiptNo').textContent = p.receipt_number || 'PENDING';
    document.getElementById('reviewSubmittedTime').textContent = p.created_at || '—';

    // Status Badge
    const badgeEl = document.getElementById('reviewStatusBadge');
    badgeEl.textContent = p.status || '—';
    badgeEl.className = 'badge';
    if (p.status === 'Approved') {
        badgeEl.classList.add('badge-active');
    } else if (p.status === 'Pending Approval') {
        badgeEl.classList.add('badge-pending-approval');
    } else if (p.status === 'Rejected') {
        badgeEl.classList.add('badge-expired');
    } else {
        badgeEl.classList.add('badge-suspended');
    }

    // Rejection Reason Feedback Section
    const remarksSec = document.getElementById('reviewRemarksSection');
    const remarksTxt = document.getElementById('reviewAdminRemarks');
    if (p.status === 'Rejected' && p.rejection_reason) {
        remarksSec.style.display = 'block';
        remarksTxt.textContent = p.rejection_reason;
    } else {
        remarksSec.style.display = 'none';
        remarksTxt.textContent = '';
    }

    const container = document.getElementById('reviewReceiptContainer');
    container.innerHTML = '';

    if (p.receipt_file_url && p.receipt_file_url !== '—') {
        if (p.receipt_file_type === 'application/pdf') {
            container.innerHTML = `<iframe src="${p.receipt_file_url}" style="width: 100%; height: 320px; border: none; border-radius: var(--radius-sm);"></iframe>`;
        } else {
            container.innerHTML = `<img src="${p.receipt_file_url}" style="max-width: 100%; max-height: 320px; object-fit: contain; cursor: zoom-in;" onclick="window.open('${p.receipt_file_url}', '_blank')">`;
        }
    } else {
        container.innerHTML = '<span style="color: var(--text-tertiary); font-size: 13px;">Receipt proof not available.</span>';
    }

    // Toggle download button
    const downloadBtn = document.getElementById('reviewDownloadBtn');
    if (downloadBtn) {
        if (p.receipt_file_url && p.receipt_file_url !== '—') {
            downloadBtn.style.display = 'inline-flex';
            downloadBtn.href = p.receipt_file_url;
            downloadBtn.download = `Receipt-${p.receipt_number || p.id}.${p.receipt_file_type === 'application/pdf' ? 'pdf' : 'png'}`;
        } else {
            downloadBtn.style.display = 'none';
        }
    }

    // Toggle Action Buttons based on status
    const approveBtn = document.querySelector('#reviewPaymentModal .btn-primary[onclick="triggerReviewApprove()"]');
    const rejectBtn = document.querySelector('#reviewPaymentModal .btn-primary[onclick="triggerReviewReject()"]');
    if (p.status === 'Pending Approval') {
        if (approveBtn) approveBtn.style.display = 'inline-block';
        if (rejectBtn) rejectBtn.style.display = 'inline-block';
    } else {
        if (approveBtn) approveBtn.style.display = 'none';
        if (rejectBtn) rejectBtn.style.display = 'none';
    }

    openModal('reviewPaymentModal');
}

function triggerReviewApprove() {
    const id = document.getElementById('reviewPaymentId').value;
    closeModal('reviewPaymentModal');
    adminApprovePayment(parseInt(id));
}

function triggerReviewReject() {
    const id = document.getElementById('reviewPaymentId').value;
    closeModal('reviewPaymentModal');
    adminRejectPayment(parseInt(id));
}

async function adminManualCheckIn(id) {
    closeAllDotsMenus();
    try {
        const res = await fetch(`/api/admin/members/${id}/check-in`, { method: 'POST' });
        const data = await res.json();
        if (res.ok || data.success) {
            showToast('Manual check-in completed successfully!');
            fetchMembers();
            fetchDashboardStats();
            if (typeof fetchAttendanceTable === 'function') fetchAttendanceTable();
        } else {
            showToast(data.error || 'This member is already checked in.', 'error');
        }
    } catch (err) {
        console.error('Manual check-in error', err);
        showToast('Network error, please try again.', 'error');
    }
}

async function adminManualCheckOut(id) {
    closeAllDotsMenus();
    try {
        const res = await fetch(`/api/admin/members/${id}/check-out`, { method: 'POST' });
        const data = await res.json();
        if (res.ok || data.success) {
            showToast(`Manual check-out logged! Duration: ${data.duration}`);
            fetchMembers();
            fetchDashboardStats();
            if (typeof fetchAttendanceTable === 'function') fetchAttendanceTable();
        } else {
            showToast(data.error || 'This member is not currently checked in.', 'error');
        }
    } catch (err) {
        console.error('Manual check-out error', err);
        showToast('Network error, please try again.', 'error');
    }
}

// ================= PENDING APPROVALS WORKFLOW CLIENT CODE =================

let allPendingApprovals = [];

async function fetchPendingApprovals() {
    const container = document.getElementById('pendingApprovalsContainer');
    const emptyState = document.getElementById('pendingApprovalsEmptyState');
    
    try {
        const res = await fetch('/api/admin/pending-approvals');
        allPendingApprovals = await res.json();
        
        renderPendingApprovals(allPendingApprovals);
    } catch (err) {
        console.error('Fetch pending approvals error:', err);
        showToast('Failed to fetch pending approvals.', 'error');
    }
}

function renderPendingApprovals(list) {
    const container = document.getElementById('pendingApprovalsContainer');
    const emptyState = document.getElementById('pendingApprovalsEmptyState');
    const subheading = document.getElementById('pendingApprovalsSubheading');
    
    container.innerHTML = '';
    
    subheading.innerText = `${list.length} registration${list.length === 1 ? '' : 's'} waiting for owner review`;
    
    if (list.length === 0) {
        container.style.display = 'none';
        emptyState.style.display = 'flex';
        return;
    }
    
    container.style.display = 'grid';
    emptyState.style.display = 'none';
    
    list.forEach(m => {
        const card = document.createElement('div');
        card.className = 'card';
        card.style.display = 'flex';
        card.style.flexDirection = 'column';
        card.style.justifyContent = 'space-between';
        card.style.padding = '24px';
        card.style.borderRadius = '16px';
        card.style.border = '1px solid var(--border-color)';
        card.style.backgroundColor = 'var(--bg-card)';
        card.style.boxShadow = 'var(--shadow-premium)';
        
        const avatarHtml = MemberAvatar.html(m, { size: 52 });
            
        const regDate = m.joined_at ? new Date(m.joined_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'N/A';
        
        card.innerHTML = `
            <div style="display: flex; align-items: flex-start; gap: 16px; margin-bottom: 20px;">
                ${avatarHtml}
                <div style="flex: 1;">
                    <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
                        <h4 style="font-size: 16px; font-weight: 700; color: var(--text-primary); margin: 0;">${m.first_name} ${m.last_name}</h4>
                        <span class="badge" style="background-color: var(--danger-light); color: var(--danger-dark); padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 700;">Pending</span>
                    </div>
                    <p style="font-size: 13px; color: var(--text-secondary); margin: 6px 0 0 0; display: flex; align-items: center; gap: 6px;">
                        <svg style="width: 14px; height: 14px; transform: translateY(2px);" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21.8 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
                        </svg>
                        <span style="margin-left: 2px;">${m.email}</span>
                    </p>
                    <p style="font-size: 13px; color: var(--text-secondary); margin: 4px 0 0 0; display: flex; align-items: center; gap: 6px;">
                        <svg style="width: 14px; height: 14px; transform: translateY(2px);" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.94.725l.548 2.2a1 1 0 01-.321.988l-1.305.98a10.582 10.582 0 004.872 4.872l.98-1.305a1 1 0 01.988-.321l2.2.548a1 1 0 01.725.94V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/>
                        </svg>
                        <span style="margin-left: 2px;">${m.phone}</span>
                    </p>
                    <p style="font-size: 12px; color: var(--text-tertiary); margin: 8px 0 0 0;">Registered: ${regDate}</p>
                </div>
            </div>
            <div style="display: flex; gap: 12px; border-top: 1px solid var(--border-color); padding-top: 16px;">
                <button class="btn btn-primary" style="flex: 1; padding: 8px 16px; font-size: 13px; font-weight: 600; display: flex; justify-content: center; align-items: center; gap: 6px; background-color: var(--success); border-color: var(--success); color: white;" onclick="approvePendingMember(${m.id})">
                    <svg style="width: 16px; height: 16px;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
                    </svg>
                    <span>Approve</span>
                </button>
                <button class="btn btn-secondary" style="flex: 1; padding: 8px 16px; font-size: 13px; font-weight: 600; display: flex; justify-content: center; align-items: center; gap: 6px; border-color: var(--danger); color: var(--danger); background: transparent;" onclick="rejectPendingMember(${m.id})">
                    <svg style="width: 16px; height: 16px;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
                    </svg>
                    <span>Reject</span>
                </button>
            </div>
        `;
        container.appendChild(card);
    });
}

function filterPendingApprovals() {
    const q = document.getElementById('pendingSearch').value.toLowerCase().trim();
    if (!q) {
        renderPendingApprovals(allPendingApprovals);
        return;
    }
    
    const filtered = allPendingApprovals.filter(m => {
        const name = `${m.first_name} ${m.last_name}`.toLowerCase();
        return name.includes(q) || m.email.toLowerCase().includes(q) || m.phone.includes(q);
    });
    
    renderPendingApprovals(filtered);
}

async function approvePendingMember(id) {
    try {
        const res = await fetch(`/api/admin/pending-approvals/${id}/approve`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast('Member approved successfully!', 'success');
            fetchPendingApprovals();
            fetchDashboardStats();
        } else {
            showToast(data.error || 'Failed to approve member.', 'error');
        }
    } catch (err) {
        console.error('Approve member error:', err);
        showToast('Network error, please try again.', 'error');
    }
}

async function rejectPendingMember(id) {
    const confirmed = await showConfirmDialog({
        title: 'Reject Member Registration',
        message: 'Are you sure you want to reject this member request?',
        confirmText: 'Reject Request',
        type: 'danger'
    });
    if (!confirmed) return;
    
    try {
        const res = await fetch(`/api/admin/pending-approvals/${id}/reject`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast('Member registration rejected.', 'info');
            fetchPendingApprovals();
            fetchDashboardStats();
        } else {
            showToast(data.error || 'Failed to reject member.', 'error');
        }
    } catch (err) {
        console.error('Reject member error:', err);
        showToast('Network error, please try again.', 'error');
    }
}

/* ================= OWNER NOTIFICATION MODULE ================= */

// OWNER NOTIFICATIONS FUNCTIONALITY
let ownerNotificationsList = [];
let notifHistoryFilterType = 'all'; // all, unread, read

function toggleNotificationPopover(event) {
    if (event) event.stopPropagation();
    const panel = document.getElementById('notificationBellPopover');
    if (!panel) return;

    const isActive = panel.classList.contains('active');
    if (isActive) {
        closeNotificationPopover();
    } else {
        // Re-render latest notifications
        renderOwnerNotificationsPopover();
        
        panel.style.display = 'flex';
        panel.offsetHeight;
        panel.classList.add('active');
    }
}

function closeNotificationPopover() {
    const panel = document.getElementById('notificationBellPopover');
    if (!panel) return;
    panel.classList.remove('active');
    setTimeout(() => {
        if (!panel.classList.contains('active')) {
            panel.style.display = 'none';
        }
    }, 250);
}

function initializeOwnerNotifications() {
    const local = localStorage.getItem('gymos_owner_notifications');
    if (local) {
        ownerNotificationsList = JSON.parse(local);
    } else {
        // Mock default data from request prompt
        ownerNotificationsList = [
            {
                id: 1,
                type: 'welcome',
                title: 'New Member Registered',
                message: 'Rahul Kumar submitted a registration request.',
                time: '2 mins ago',
                read: false,
                timestamp: new Date(Date.now() - 2 * 60000).toISOString()
            },
            {
                id: 2,
                type: 'payment',
                title: 'Payment Received',
                message: 'Kiran Patel paid ₹2,000.',
                time: '15 mins ago',
                read: false,
                timestamp: new Date(Date.now() - 15 * 60000).toISOString()
            },
            {
                id: 3,
                type: 'expiry',
                title: 'Membership Expiring',
                message: "Anjali Mehta's membership expires tomorrow.",
                time: '1 hour ago',
                read: false,
                timestamp: new Date(Date.now() - 60 * 60000).toISOString()
            },
            {
                id: 4,
                type: 'checkin',
                title: 'Member Checked In',
                message: 'Rahul Verma checked in.',
                time: '2 hours ago',
                read: false,
                timestamp: new Date(Date.now() - 120 * 60000).toISOString()
            },
            {
                id: 5,
                type: 'pending',
                title: 'Pending Approval',
                message: '1 member is waiting for approval.',
                time: '3 hours ago',
                read: false,
                timestamp: new Date(Date.now() - 180 * 60000).toISOString()
            }
        ];
        saveNotificationsToLocalStorage();
    }
    updateNotificationBadge();
}

function saveNotificationsToLocalStorage() {
    localStorage.setItem('gymos_owner_notifications', JSON.stringify(ownerNotificationsList));
}

function updateNotificationBadge() {
    const unreadCount = ownerNotificationsList.filter(n => !n.read).length;
    ['ownerBellBadge', 'mobileBellBadge'].forEach(id => {
        const badge = document.getElementById(id);
        if (!badge) return;
        if (unreadCount > 0) {
            badge.innerText = unreadCount;
            badge.style.display = 'inline-block';
        } else {
            badge.style.display = 'none';
        }
    });
}

function renderOwnerNotificationsPopover() {
    const container = document.getElementById('notifPopoverList');
    if (!container) return;

    container.innerHTML = '';
    
    // Sort descending by timestamp
    const sorted = [...ownerNotificationsList].sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
    const latest5 = sorted.slice(0, 5);

    if (latest5.length === 0) {
        container.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--text-tertiary); font-size: 13px;">No notifications.</div>';
        return;
    }

    latest5.forEach(n => {
        const item = document.createElement('div');
        item.className = `notif-popover-item ${n.read ? '' : 'unread'}`;
        item.onclick = () => {
            markNotificationRead(n.id);
            renderOwnerNotificationsPopover();
        };

        const itemIconSvg = getNotificationIconSvg(n.type);
        const bg = getNotificationIconBg(n.type);

        item.innerHTML = `
            <div class="notif-item-icon-wrapper" style="background-color: ${bg};">${itemIconSvg}</div>
            <div class="notif-item-info">
                <div class="notif-item-title-row">
                    <span class="notif-item-title">${n.title}</span>
                    <span class="notif-item-time">${n.time}</span>
                </div>
                <div class="notif-item-desc">${n.message}</div>
            </div>
            ${n.read ? '' : '<div class="notif-unread-dot"></div>'}
        `;
        container.appendChild(item);
    });
}

function getNotificationIconSvg(type) {
    if (type === 'welcome') {
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`;
    } else if (type === 'payment') {
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"></rect><line x1="1" y1="10" x2="23" y2="10"></line></svg>`;
    } else if (type === 'expiry') {
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;
    } else if (type === 'checkin') {
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><polyline points="17 11 19 13 23 9"></polyline></svg>`;
    } else if (type === 'pending') {
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0ea5e9" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>`;
    }
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#eab308" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>`;
}

function getNotificationIconBg(type) {
    if (type === 'welcome') return 'rgba(34, 197, 94, 0.1)';
    if (type === 'payment') return 'rgba(59, 130, 246, 0.1)';
    if (type === 'expiry') return 'rgba(239, 68, 68, 0.1)';
    if (type === 'checkin') return 'rgba(168, 85, 247, 0.1)';
    if (type === 'pending') return 'rgba(14, 165, 233, 0.1)';
    return 'rgba(234, 179, 8, 0.1)';
}

function viewAllNotifications(event) {
    if (event) event.preventDefault();
    closeNotificationPopover();
    showTab('notifications');
}

// Notification History Page filter selection
function setNotifHistoryFilter(type) {
    notifHistoryFilterType = type;
    
    // Toggle active state
    document.getElementById('notifFilterAll').style.backgroundColor = type === 'all' ? 'var(--accent)' : 'transparent';
    document.getElementById('notifFilterAll').style.borderColor = type === 'all' ? 'var(--accent)' : 'var(--border-color)';
    document.getElementById('notifFilterAll').style.color = type === 'all' ? 'white' : 'var(--text-primary)';
    
    document.getElementById('notifFilterUnread').style.backgroundColor = type === 'unread' ? 'var(--accent)' : 'transparent';
    document.getElementById('notifFilterUnread').style.borderColor = type === 'unread' ? 'var(--accent)' : 'var(--border-color)';
    document.getElementById('notifFilterUnread').style.color = type === 'unread' ? 'white' : 'var(--text-primary)';
    
    document.getElementById('notifFilterRead').style.backgroundColor = type === 'read' ? 'var(--accent)' : 'transparent';
    document.getElementById('notifFilterRead').style.borderColor = type === 'read' ? 'var(--accent)' : 'var(--border-color)';
    document.getElementById('notifFilterRead').style.color = type === 'read' ? 'white' : 'var(--text-primary)';

    filterNotificationHistory();
}

function filterNotificationHistory() {
    const listContainer = document.getElementById('notificationHistoryList');
    if (!listContainer) return;

    listContainer.innerHTML = '';
    const searchQuery = document.getElementById('notifSearchInput').value.toLowerCase().trim();

    let filtered = [...ownerNotificationsList].sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Filter by search query
    if (searchQuery) {
        filtered = filtered.filter(n => 
            n.title.toLowerCase().includes(searchQuery) || 
            n.message.toLowerCase().includes(searchQuery)
        );
    }

    // Filter by tab type selection
    if (notifHistoryFilterType === 'unread') {
        filtered = filtered.filter(n => !n.read);
    } else if (notifHistoryFilterType === 'read') {
        filtered = filtered.filter(n => n.read);
    }

    if (filtered.length === 0) {
        listContainer.innerHTML = '<div style="padding: 40px; text-align: center; color: var(--text-tertiary); font-size: 14px;">No notifications found matching criteria.</div>';
        return;
    }

    filtered.forEach(n => {
        const card = document.createElement('div');
        card.className = `notif-history-card ${n.read ? '' : 'unread'}`;

        const itemIconSvg = getNotificationIconSvg(n.type);
        const bg = getNotificationIconBg(n.type);

        card.innerHTML = `
            <div class="notif-history-left">
                <div class="notif-item-icon-wrapper" style="background-color: ${bg}; width: 40px; height: 40px;">${itemIconSvg}</div>
                <div class="notif-history-details">
                    <div class="notif-history-title-row">
                        <span class="notif-history-title">${n.title}</span>
                        ${n.read ? '' : '<span class="notif-history-badge-unread">Unread</span>'}
                        <span class="notif-history-time">&bull; ${n.time}</span>
                    </div>
                    <div class="notif-history-desc">${n.message}</div>
                </div>
            </div>
            <div class="notif-history-actions">
                ${n.read ? '' : `
                    <button class="notif-action-icon-btn" onclick="markNotificationRead(${n.id})" title="Mark as Read">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    </button>
                `}
                <button class="notif-action-icon-btn delete" onclick="deleteNotification(${n.id})" title="Delete Notification">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                </button>
            </div>
        `;
        listContainer.appendChild(card);
    });
}

function markNotificationRead(id) {
    const notif = ownerNotificationsList.find(n => n.id === id);
    if (notif) {
        notif.read = true;
        saveNotificationsToLocalStorage();
        updateNotificationBadge();
        filterNotificationHistory();
    }
}

function markAllNotificationsAsRead() {
    ownerNotificationsList.forEach(n => n.read = true);
    saveNotificationsToLocalStorage();
    updateNotificationBadge();
    filterNotificationHistory();
    showToast('All notifications marked as read', 'info');
}

function deleteNotification(id) {
    ownerNotificationsList = ownerNotificationsList.filter(n => n.id !== id);
    saveNotificationsToLocalStorage();
    updateNotificationBadge();
    filterNotificationHistory();
    showToast('Notification deleted', 'info');
}

async function clearAllNotifications() {
    const confirmed = await showConfirmDialog({
        title: 'Clear Notification History',
        message: 'Are you sure you want to clear your entire notification history?',
        confirmText: 'Clear All',
        type: 'danger'
    });
    if (!confirmed) return;
    
    ownerNotificationsList = [];
    saveNotificationsToLocalStorage();
    updateNotificationBadge();
    filterNotificationHistory();
    showToast('All notifications cleared', 'info');
}

function togglePasswordVisibility() {
    const pwdInput = document.getElementById('loginPassword');
    const eyeIcon = document.getElementById('passwordEyeIcon');
    if (!pwdInput || !eyeIcon) return;

    if (pwdInput.type === 'password') {
        pwdInput.type = 'text';
        eyeIcon.innerHTML = `
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
            <line x1="1" y1="1" x2="23" y2="23"></line>
        `;
    } else {
        pwdInput.type = 'password';
        eyeIcon.innerHTML = `
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
        `;
    }
}

// Sidebar toggle collapse
function toggleSidebarCollapse() {
    const sidebar = document.getElementById('adminSidebar');
    const button = document.getElementById('sidebarCollapseBtn');
    if (!sidebar) return;

    const isCollapsed = sidebar.classList.toggle('collapsed');
    localStorage.setItem('gymos_sidebar_collapsed', isCollapsed ? 'true' : 'false');
    
    if (button) {
        button.title = isCollapsed ? 'Expand Sidebar' : 'Collapse Sidebar';
    }
}

// Restore sidebar state on load
function restoreSidebarState() {
    const sidebar = document.getElementById('adminSidebar');
    const button = document.getElementById('sidebarCollapseBtn');
    if (!sidebar) return;
    
    const isCollapsed = localStorage.getItem('gymos_sidebar_collapsed') === 'true';
    if (isCollapsed) {
        sidebar.classList.add('collapsed');
        if (button) button.title = 'Expand Sidebar';
    } else {
        sidebar.classList.remove('collapsed');
        if (button) button.title = 'Collapse Sidebar';
    }
}

// Initialize on DOM ready
if (typeof initializeOwnerNotifications === 'function') {
    document.addEventListener('DOMContentLoaded', () => {
        restoreSidebarState();
    });
}

// Owner Logout Action
async function triggerOwnerLogout(event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    
    const confirmed = await showConfirmDialog({
        title: 'Confirm Logout',
        message: 'Are you sure you want to log out of the owner admin portal?',
        confirmText: 'Log Out',
        type: 'warning'
    });
    if (!confirmed) return;

    try {
        const res = await fetch('/api/auth/logout', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            // Reset state
            localStorage.removeItem('gymos_owner_notifications');
            localStorage.removeItem('gymos_owner_auth');
            // Redirect
            loginOverlay.style.display = 'flex';
            appLayout.style.display = 'none';
            showToast('Logged out successfully', 'info');
        } else {
            showToast('Logout failed. Please try again.', 'error');
        }
    } catch (err) {
        console.error('Logout error:', err);
        localStorage.removeItem('gymos_owner_auth');
        // Force redirect to login anyway if network error
        loginOverlay.style.display = 'flex';
        appLayout.style.display = 'none';
    }
}

// ================= WIN BACK CRM FUNCTIONS =================

let winBackCurrentPage = 1;
let winBackTotalPages = 1;
let selectedWinBackMemberIds = new Set();
let winBackMembersList = [];
let activeWinBackMember = null;

const WIN_BACK_TEMPLATES = {
    1: "Hello {name},\n\nWe missed you at {gym_name}! We noticed it's been {days} days since your last visit. We'd love to see you back on track. Keep up the consistency!\n\nBest regards,\n- {gym_name}",
    2: "Hello {name},\n\nYour fitness journey matters to us. We noticed you haven't visited {gym_name} in the last {days} days. Is everything okay? Let us know if you need help resuming your routine or modifying your active \"{plan}\" plan.\n\nBest regards,\n- {gym_name}",
    3: "Hello {name},\n\nIt's been {days} days since we last saw you at {gym_name}. We miss your energy! We want to help you get back on track. Pop by this week!\n\nBest regards,\n- {gym_name}",
    4: "Hello {name},\n\nThis is a friendly reminder from {gym_name}. Your active \"{plan}\" plan is expiring on {expiry_date}. Please renew soon to continue uninterrupted access!\n\nThank you,\n- {gym_name}",
    5: "Hello {name},\n\nYour membership at {gym_name} has expired. We would love to have you back! You can check our latest plans or renew your membership to continue your fitness journey.\n\nBest regards,\n- {gym_name}",
    6: "Hello {name},\n\nThis is a reminder from {gym_name}. You have a pending fee/dues payment. Please complete the payment soon to ensure smooth access to the gym.\n\nThank you,\n- {gym_name}",
    7: "Hello {name},\n\nWe want you back at {gym_name}! Here is a special comeback offer: Renew your active plan \"{plan}\" this week and get an extra 10% discount on your membership!\n\nBest regards,\n- {gym_name}"
};

async function fetchWinBackAnalytics() {
    try {
        const res = await fetch('/api/admin/win-back/analytics');
        const data = await res.json();
        
        document.getElementById('winbackTotalCount').innerText = data.total_win_back;
        document.getElementById('winbackFollowupCount').innerText = data.inactive_15_30;
        document.getElementById('winbackHighRiskCount').innerText = data.inactive_30_60;
        document.getElementById('winbackAlmostLostCount').innerText = data.inactive_60_plus;
        document.getElementById('winbackRecoveredMonth').innerText = data.recovered_this_month;
        document.getElementById('winbackRecoveryRate').innerText = `${data.recovery_rate}%`;
    } catch (err) {
        console.error('Failed to fetch win back analytics', err);
    }
}

async function fetchWinBackMembers() {
    const search = document.getElementById('winbackSearchInput').value;
    const days = document.getElementById('winbackDaysFilter').value;
    const startDate = document.getElementById('winbackStartDate').value;
    const endDate = document.getElementById('winbackEndDate').value;
    const limit = 25;
    
    let url = `/api/admin/win-back/members?page=${winBackCurrentPage}&limit=${limit}&search=${encodeURIComponent(search)}&days=${days}`;
    if (startDate && endDate) {
        url += `&start_date=${startDate}&end_date=${endDate}`;
    }
    
    try {
        const res = await fetch(url);
        const data = await res.json();
        
        winBackMembersList = data.data;
        winBackTotalPages = Math.ceil(data.total / limit) || 1;
        
        renderWinBackTable(winBackMembersList);
        
        document.getElementById('winbackTotalInfo').innerText = `Showing ${winBackMembersList.length} of ${data.total} members`;
        document.getElementById('winbackPrevPageBtn').disabled = winBackCurrentPage <= 1;
        document.getElementById('winbackNextPageBtn').disabled = winBackCurrentPage >= winBackTotalPages;
        
        // Reset selection on fetch
        selectedWinBackMemberIds.clear();
        updateWinBackBulkToolbar();
    } catch (err) {
        console.error('Failed to fetch win back members', err);
        showToast('Error loading win-back members list', 'error');
    }
}

function renderWinBackTable(members) {
    const tbody = document.getElementById('winbackTableBody');
    tbody.innerHTML = '';
    
    if (members.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding: 24px; color: var(--text-tertiary);">No win back members found.</td></tr>`;
        return;
    }
    
    members.forEach(m => {
        const tr = document.createElement('tr');
        
        // Determine status tag
        let statusTag = '';
        if (m.days_inactive <= 20) {
            statusTag = `<span class="status-tag status-tag-followup">Needs Follow-up</span>`;
        } else if (m.days_inactive <= 30) {
            statusTag = `<span class="status-tag status-tag-highrisk">High Risk</span>`;
        } else {
            statusTag = `<span class="status-tag status-tag-lost">Almost Lost</span>`;
        }
        
        // Last interaction info
        let interactionInfo = '<span style="font-size: 11px; color: var(--text-tertiary);">Never contacted</span>';
        if (m.last_interaction_type) {
            const timeStr = m.last_interaction_time ? new Date(m.last_interaction_time).toLocaleDateString() : '';
            const typeLabel = m.last_interaction_type.toUpperCase();
            interactionInfo = `<div style="font-size: 11px; color: var(--text-secondary);"><strong>${typeLabel}</strong>: ${timeStr}</div>`;
            if (m.last_follow_up_date) {
                interactionInfo += `<div style="font-size: 10px; color: var(--warning);">Follow-up: ${new Date(m.last_follow_up_date).toLocaleDateString()}</div>`;
            }
        }
        
        const lastVisitDate = m.last_visit ? new Date(m.last_visit).toLocaleDateString() : 'Never';
        const expiryDate = m.expiry_date ? new Date(m.expiry_date).toLocaleDateString() : 'No Plan';
        const isChecked = selectedWinBackMemberIds.has(m.id) ? 'checked' : '';
        
        tr.innerHTML = `
            <td style="text-align: center;"><input type="checkbox" class="winback-row-checkbox" data-id="${m.id}" ${isChecked} onclick="handleWinBackRowSelect(this, ${m.id})"></td>
            <td>
                <div style="display:flex; align-items:center; gap: 10px;">
                    ${MemberAvatar.html(m, { size: 36 })}
                    <div>
                        <div style="font-weight: 700; color: var(--text-primary); font-size:13.5px;">${m.first_name} ${m.last_name}</div>
                        <div style="font-size: 11px; color: var(--text-tertiary);">${m.membership_number || ''} &bull; ${m.phone}</div>
                        ${interactionInfo}
                    </div>
                </div>
            </td>
            <td><span style="font-size:13px; font-weight:600;">${m.plan_name || 'No Active Plan'}</span></td>
            <td style="font-size:13px;">${lastVisitDate}</td>
            <td><strong style="color: var(--danger-dark); font-size: 14px;">${m.days_inactive} days</strong></td>
            <td style="font-size:13px;">${expiryDate}</td>
            <td>${statusTag}</td>
            <td style="text-align: right;">
                <div style="display: flex; gap: 6px; justify-content: flex-end; align-items: center;">
                    <a href="tel:${m.phone}" class="btn btn-secondary" onclick="logInteraction(${m.id}, 'call')" title="Call Member" style="padding: 6px 10px;">
                        <svg style="width: 14px; height: 14px;" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.94.725l.548 2.2a1 1 0 01-.321.988l-1.305.98a10.582 10.582 0 004.872 4.872l.98-1.305a1 1 0 01.988-.321l2.2.548a1 1 0 01.725.94V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                        </svg>
                    </a>
                    <button class="btn btn-secondary" onclick="openWinBackWhatsappModal(${m.id})" title="Send WhatsApp Message" style="padding: 6px 10px; color: #22c55e;">
                        <svg style="width: 14px; height: 14px;" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                        </svg>
                    </button>
                    <button class="btn btn-secondary" onclick="openWinBackFollowUpModal(${m.id})" title="Schedule Follow-up" style="padding: 6px 10px; color: var(--warning);">
                        <svg style="width: 14px; height: 14px;" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                    </button>
                    <button class="btn btn-secondary" onclick="logInteraction(${m.id}, 'contacted')" style="font-size: 11px; padding: 6px 10px;">Mark Contacted</button>
                </div>
            </td>
        `;
        
        tbody.appendChild(tr);
    });
}

function handleWinBackRowSelect(checkbox, id) {
    if (checkbox.checked) {
        selectedWinBackMemberIds.add(id);
    } else {
        selectedWinBackMemberIds.delete(id);
    }
    
    // Update master header checkboxes
    const allCheckboxes = document.querySelectorAll('.winback-row-checkbox');
    const checkedCheckboxes = document.querySelectorAll('.winback-row-checkbox:checked');
    const masterMaster = document.getElementById('winbackSelectAllMaster');
    const masterHeader = document.getElementById('winbackSelectAllHeader');
    
    if (masterMaster) masterMaster.checked = allCheckboxes.length > 0 && allCheckboxes.length === checkedCheckboxes.length;
    if (masterHeader) masterHeader.checked = allCheckboxes.length > 0 && allCheckboxes.length === checkedCheckboxes.length;
    
    updateWinBackBulkToolbar();
}

function toggleWinBackAllRows(masterCheckbox) {
    const isChecked = masterCheckbox.checked;
    
    // Set checked state of master controls
    const masterMaster = document.getElementById('winbackSelectAllMaster');
    const masterHeader = document.getElementById('winbackSelectAllHeader');
    if (masterMaster) masterMaster.checked = isChecked;
    if (masterHeader) masterHeader.checked = isChecked;
    
    const checkboxes = document.querySelectorAll('.winback-row-checkbox');
    checkboxes.forEach(cb => {
        cb.checked = isChecked;
        const id = parseInt(cb.getAttribute('data-id'));
        if (isChecked) {
            selectedWinBackMemberIds.add(id);
        } else {
            selectedWinBackMemberIds.delete(id);
        }
    });
    
    updateWinBackBulkToolbar();
}

function updateWinBackBulkToolbar() {
    const toolbar = document.getElementById('winbackBulkToolbar');
    const countText = document.getElementById('winbackBulkCountText');
    const size = selectedWinBackMemberIds.size;
    
    if (size > 0) {
        toolbar.style.display = 'flex';
        countText.innerText = `${size} member${size === 1 ? '' : 's'} selected`;
    } else {
        toolbar.style.display = 'none';
        
        const masterMaster = document.getElementById('winbackSelectAllMaster');
        const masterHeader = document.getElementById('winbackSelectAllHeader');
        if (masterMaster) masterMaster.checked = false;
        if (masterHeader) masterHeader.checked = false;
    }
}

function clearWinBackDateRange() {
    document.getElementById('winbackStartDate').value = '';
    document.getElementById('winbackEndDate').value = '';
    fetchWinBackMembers();
}

function changeWinBackPage(delta) {
    const newPage = winBackCurrentPage + delta;
    if (newPage >= 1 && newPage <= winBackTotalPages) {
        winBackCurrentPage = newPage;
        fetchWinBackMembers();
    }
}

async function logInteraction(memberId, type, notes = '', followUpDate = null) {
    try {
        const res = await fetch('/api/admin/win-back/interaction', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                member_id: memberId,
                interaction_type: type,
                notes: notes,
                follow_up_date: followUpDate
            })
        });
        const data = await res.json();
        if (data.success) {
            showToast(`Interaction logged: ${type.toUpperCase()}`, 'success');
            fetchWinBackMembers();
        } else {
            showToast('Failed to log interaction', 'error');
        }
    } catch (err) {
        console.error(err);
        showToast('Network error logging interaction', 'error');
    }
}

async function triggerBulkInteractionModal(type) {
    if (selectedWinBackMemberIds.size === 0) return;
    
    const count = selectedWinBackMemberIds.size;
    if (type === 'whatsapp') {
        const confirmed = await showConfirmDialog({
            title: 'Bulk WhatsApp Note',
            message: `This will log a WhatsApp follow-up interaction for all ${count} selected members. Proceed?`,
            confirmText: 'Log Follow-ups',
            type: 'info'
        });
        if (!confirmed) return;
        
        await executeWinBackBulkAction('whatsapp', 'Bulk WhatsApp campaign initiated');
    } else {
        const confirmed = await showConfirmDialog({
            title: 'Mark Members Contacted',
            message: `This will mark all ${count} selected members as contacted/followed up. Proceed?`,
            confirmText: 'Mark Contacted',
            type: 'info'
        });
        if (!confirmed) return;
        
        await executeWinBackBulkAction('contacted', 'Bulk follow-up contact recorded');
    }
}

async function executeWinBackBulkAction(type, notes) {
    try {
        const idsArray = Array.from(selectedWinBackMemberIds);
        const res = await fetch('/api/admin/win-back/bulk-action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                member_ids: idsArray,
                interaction_type: type,
                notes: notes
            })
        });
        const data = await res.json();
        if (data.success) {
            showToast(`Recorded bulk interaction for ${idsArray.length} members`, 'success');
            selectedWinBackMemberIds.clear();
            fetchWinBackMembers();
            fetchWinBackAnalytics();
        } else {
            showToast('Failed to record bulk action', 'error');
        }
    } catch (err) {
        console.error(err);
        showToast('Error executing bulk action', 'error');
    }
}

function openWinBackWhatsappModal(memberId) {
    activeWinBackMember = winBackMembersList.find(m => m.id === memberId);
    if (!activeWinBackMember) return;
    
    document.getElementById('winBackWhatsappTemplateSelect').value = '1';
    updateWinBackWhatsappPreview();
    openModal('winBackWhatsappModal');
}

function updateWinBackWhatsappPreview() {
    if (!activeWinBackMember) return;
    
    const templateId = document.getElementById('winBackWhatsappTemplateSelect').value;
    const template = WIN_BACK_TEMPLATES[templateId];
    
    // Resolve dynamic values
    const gymName = gymSettings ? gymSettings.gym_name : "our Gym";
    const name = `${activeWinBackMember.first_name} ${activeWinBackMember.last_name}`;
    const days = activeWinBackMember.days_inactive;
    const plan = activeWinBackMember.plan_name || "N/A";
    const expiry = activeWinBackMember.expiry_date ? new Date(activeWinBackMember.expiry_date).toLocaleDateString() : "N/A";
    
    const resolved = WhatsAppUtility.generateWhatsAppMessage(template, {
        name: name,
        gym_name: gymName,
        days: days,
        plan: plan,
        expiry_date: expiry
    });
        
    document.getElementById('winBackWhatsappPreviewTxt').value = resolved;
}

async function triggerSendWinBackWhatsapp() {
    if (!activeWinBackMember) return;
    
    const message = document.getElementById('winBackWhatsappPreviewTxt').value;
    const phone = activeWinBackMember.phone;
    
    // Log WhatsApp interaction in database
    await logInteraction(activeWinBackMember.id, 'whatsapp', `WhatsApp message sent: Template ${document.getElementById('winBackWhatsappTemplateSelect').value}`);
    
    closeModal('winBackWhatsappModal');
    
    // Send WhatsApp via utility
    WhatsAppUtility.openWhatsApp(phone, message);
}

function openWinBackFollowUpModal(memberId) {
    activeWinBackMember = winBackMembersList.find(m => m.id === memberId);
    if (!activeWinBackMember) return;
    
    document.getElementById('winBackFollowUpMemberId').value = memberId;
    document.getElementById('winBackFollowUpDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('winBackFollowUpNotes').value = '';
    
    openModal('winBackFollowUpModal');
}

async function submitWinBackFollowUp(event) {
    event.preventDefault();
    const id = parseInt(document.getElementById('winBackFollowUpMemberId').value);
    const date = document.getElementById('winBackFollowUpDate').value;
    const notes = document.getElementById('winBackFollowUpNotes').value;
    
    closeModal('winBackFollowUpModal');
    await logInteraction(id, 'follow_up', notes, date);
}

function exportWinBackCSV() {
    if (winBackMembersList.length === 0) {
        showToast('No data to export', 'warning');
        return;
    }
    
    let csv = 'Membership Number,Name,Phone,Plan,Last Visit,Days Inactive,Expiry Date\n';
    winBackMembersList.forEach(m => {
        const lastVisit = m.last_visit ? new Date(m.last_visit).toLocaleDateString() : 'Never';
        const expiry = m.expiry_date ? new Date(m.expiry_date).toLocaleDateString() : 'No Plan';
        csv += `"${m.membership_number || ''}","${m.first_name} ${m.last_name}","${m.phone}","${m.plan_name || 'No Active Plan'}","${lastVisit}","${m.days_inactive}","${expiry}"\n`;
    });
    
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `win_back_members_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function printWinBackList() {
    if (winBackMembersList.length === 0) {
        showToast('No data to print', 'warning');
        return;
    }
    
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
    printWindow.close();
}

// ================= REVENUE ANALYTICS FUNCTIONS =================

let analyticsOverviewData = null;
let trendChartInstance = null;
let planChartInstance = null;
let currentTrendGrouping = 'month';

async function fetchRevenueAnalyticsOverview() {
    try {
        const res = await fetch('/api/admin/analytics/overview');
        const data = await res.json();
        analyticsOverviewData = data;

        // Data Integrity Validation empty state
        if (!data || (data.lifetime_revenue === 0 && data.avg_monthly_revenue === 0)) {
            document.getElementById('revenue-analyticsTab').innerHTML = `
                <div class="module-page-header">
                    <h2>Revenue Analytics & Business Insights</h2>
                    <p>Overview of gym financial health, month-over-month performance comparison, and automated recommendations.</p>
                </div>
                <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; padding: 60px 20px; border: 1px dashed var(--border-color); border-radius: var(--radius-md); text-align:center; background-color: var(--bg-card); margin-top: 24px;">
                    <svg style="width: 48px; height: 48px; color: var(--text-tertiary); margin-bottom: 16px;" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                    </svg>
                    <h3 style="font-weight:700; color:var(--text-primary); margin-bottom:8px;">No Financial Data Available Yet</h3>
                    <p style="color:var(--text-secondary); max-width:400px; font-size:13.5px; line-height:1.5; margin:0 0 20px 0;">Record member payments or assign plans to populate revenue analytics, comparison metrics, and business intelligence insights.</p>
                    <button class="btn btn-primary" onclick="showTab('payments')">Record a Payment</button>
                </div>
            `;
            return;
        }

        // 1. Bind KPI Cards
        document.getElementById('analyticsLifetimeRev').innerText = formatINRCurrency(data.lifetime_revenue);
        document.getElementById('analyticsThisMonthRev').innerText = formatINRCurrency(data.this_month_revenue);
        document.getElementById('analyticsLastMonthRev').innerText = formatINRCurrency(data.last_month_revenue);
        
        const growthEl = document.getElementById('analyticsGrowthVal');
        growthEl.innerText = `${data.growth_rate >= 0 ? '+' : ''}${data.growth_rate}%`;
        growthEl.style.color = data.growth_rate >= 0 ? '#10b981' : '#ef4444';

        document.getElementById('analyticsAvgMonthly').innerText = formatINRCurrency(data.avg_monthly_revenue);
        document.getElementById('analyticsARPU').innerText = formatINRCurrency(data.arpu);
        document.getElementById('analyticsCollectionRate').innerText = `${data.collection_rate}%`;
        document.getElementById('analyticsOutstandingDues').innerText = formatINRCurrency(data.outstanding_dues);

        // 2. Bind Insights Feed
        const feed = document.getElementById('analyticsInsightsFeed');
        feed.innerHTML = '';
        if (data.insights.length === 0) {
            feed.innerHTML = '<div style="font-size:13px; color:var(--text-tertiary); text-align:center; padding:16px;">No new business insights at this time.</div>';
        } else {
            data.insights.forEach(ins => {
                let badgeColor = 'var(--text-secondary)';
                if (ins.type === 'success') badgeColor = '#10b981';
                if (ins.type === 'warning') badgeColor = '#ef4444';
                if (ins.type === 'info') badgeColor = '#3b82f6';

                const div = document.createElement('div');
                div.style.cssText = 'padding: 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-color); background-color: var(--bg-card); display:flex; gap:10px;';
                div.innerHTML = `
                    <div style="width:8px; height:8px; border-radius:50%; background-color:${badgeColor}; margin-top:6px; flex-shrink:0;"></div>
                    <div>
                        <strong style="font-size:13px; display:block; color:var(--text-primary);">${ins.title}</strong>
                        <span style="font-size:12px; color:var(--text-secondary); line-height:1.4;">${ins.text}</span>
                    </div>
                `;
                feed.appendChild(div);
            });
        }

        // 3. Bind AI Recommendations Action Cards
        const recContainer = document.getElementById('analyticsRecommendationsContainer');
        recContainer.innerHTML = '';
        if (data.recommendations.length === 0) {
            recContainer.innerHTML = '<div style="font-size:13px; color:var(--text-tertiary); text-align:center; grid-column:span 2; padding:16px;">No actionable recommendations.</div>';
        } else {
            data.recommendations.forEach(rec => {
                const card = document.createElement('div');
                card.className = 'winback-stat-card';
                card.style.cssText = 'background-color: var(--bg-raised); justify-content:space-between; border-left: 3px solid var(--accent);';
                card.innerHTML = `
                    <div>
                        <strong style="font-size:13.5px; color:var(--text-primary); display:block; margin-bottom:4px;">${rec.title}</strong>
                        <p style="font-size:11.5px; color:var(--text-secondary); margin:0 0 10px 0; line-height:1.4;">${rec.text}</p>
                    </div>
                    <button class="btn btn-primary btn-sm" onclick="showTab('${rec.tab}')" style="width:100%; font-size:11.5px; font-weight:600; padding:6px;">${rec.button_text}</button>
                `;
                recContainer.appendChild(card);
            });
        }

        // 4. Bind Payment Methods Analytics
        const paymentList = document.getElementById('analyticsPaymentMethodsSplit');
        paymentList.innerHTML = '';
        if (data.payment_methods.length === 0) {
            paymentList.innerHTML = '<div style="font-size:13px; color:var(--text-tertiary); text-align:center; padding:16px;">No payment records.</div>';
        } else {
            data.payment_methods.forEach(pm => {
                const div = document.createElement('div');
                div.innerHTML = `
                    <div style="display:flex; justify-content:space-between; font-size:12.5px; margin-bottom:4px;">
                        <span style="text-transform:uppercase; font-weight:600;">${pm.method}</span>
                        <span>${pm.percentage}% (${formatINRCurrency(pm.revenue)})</span>
                    </div>
                    <div style="height:6px; background-color:var(--border-color); border-radius:3px; overflow:hidden;">
                        <div style="width:${pm.percentage}%; height:100%; background-color:var(--accent); border-radius:3px;"></div>
                    </div>
                `;
                paymentList.appendChild(div);
            });
        }

        // 5. Bind Top Performing Months
        const topMonths = document.getElementById('analyticsTopMonthsList');
        topMonths.innerHTML = '';
        data.top_months.forEach((tm, i) => {
            const dateObj = new Date(tm.month + '-02'); // Add day to construct valid date
            const label = dateObj.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
            const div = document.createElement('div');
            div.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:10px; border-radius:var(--radius-sm); border:1px solid var(--border-color); font-size:13px;';
            div.innerHTML = `
                <div style="display:flex; align-items:center; gap:8px;">
                    <span style="font-weight:800; color:var(--gold); font-size:15px;">#${i + 1}</span>
                    <span>${label}</span>
                </div>
                <strong style="color:var(--text-primary);">${formatINRCurrency(tm.revenue)}</strong>
            `;
            topMonths.appendChild(div);
        });

        // 6. Populate Comparison Dropdowns (Last 12 Months)
        const compSelect1 = document.getElementById('compareMonth1');
        const compSelect2 = document.getElementById('compareMonth2');
        compSelect1.innerHTML = '';
        compSelect2.innerHTML = '';
        
        data.monthly_trend.forEach((t, i) => {
            const dateObj = new Date(t.month + '-02');
            const label = dateObj.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
            
            const opt1 = document.createElement('option');
            opt1.value = t.month;
            opt1.innerText = label;
            compSelect1.appendChild(opt1);

            const opt2 = document.createElement('option');
            opt2.value = t.month;
            opt2.innerText = label;
            compSelect2.appendChild(opt2);
        });
        
        // Auto-select latest two months
        if (data.monthly_trend.length >= 2) {
            compSelect1.value = data.monthly_trend[data.monthly_trend.length - 2].month;
            compSelect2.value = data.monthly_trend[data.monthly_trend.length - 1].month;
        } else if (data.monthly_trend.length > 0) {
            compSelect1.value = data.monthly_trend[0].month;
            compSelect2.value = data.monthly_trend[0].month;
        }

        // 7. Render Charts
        renderTrendChart();
        renderPlanPieChart();
        fetchComparisonData();

    } catch (err) {
        console.error(err);
        showToast('Error loading revenue analytics overview', 'error');
    }
}

function renderTrendChart() {
    const canvas = document.getElementById('analyticsTrendLineChart');
    if (!canvas || !analyticsOverviewData) return;

    if (trendChartInstance) trendChartInstance.destroy();

    let chartData = [...analyticsOverviewData.monthly_trend];
    
    // Perform grouping if required
    if (currentTrendGrouping === 'quarter') {
        const quarters = {};
        chartData.forEach(d => {
            const yr = d.month.substring(0, 4);
            const m = parseInt(d.month.substring(5, 7));
            const q = Math.ceil(m / 3);
            const key = `${yr}-Q${q}`;
            quarters[key] = (quarters[key] || 0) + d.revenue;
        });
        chartData = Object.keys(quarters).map(k => ({ month: k, revenue: quarters[k] }));
    } else if (currentTrendGrouping === 'year') {
        const years = {};
        chartData.forEach(d => {
            const yr = d.month.substring(0, 4);
            years[yr] = (years[yr] || 0) + d.revenue;
        });
        chartData = Object.keys(years).map(k => ({ month: k, revenue: years[k] }));
    }

    const labels = chartData.map(d => {
        if (d.month.includes('-Q')) return d.month;
        if (d.month.length === 4) return d.month;
        const dateObj = new Date(d.month + '-02');
        return dateObj.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    });
    const dataPoints = chartData.map(d => d.revenue);

    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 220);
    gradient.addColorStop(0, 'rgba(212, 163, 89, 0.25)'); // matching dashboard gold tint
    gradient.addColorStop(1, 'rgba(212, 163, 89, 0.0)');

    trendChartInstance = new Chart(canvas, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Revenue Trend',
                data: dataPoints,
                borderColor: 'var(--gold)',
                borderWidth: 3,
                pointBackgroundColor: '#ffffff',
                pointBorderColor: 'var(--gold)',
                pointBorderWidth: 2,
                pointRadius: 5,
                backgroundColor: gradient,
                fill: true,
                tension: 0.25
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function(c) { return ' ' + formatINRCurrency(c.raw); }
                    }
                }
            },
            scales: {
                y: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: {
                        callback: function(val) { return '₹' + parseInt(val).toLocaleString('en-IN'); },
                        font: { family: 'Outfit, sans-serif', size: 10 }
                    }
                },
                x: {
                    grid: { display: false },
                    ticks: { font: { family: 'Outfit, sans-serif', size: 10 } }
                }
            }
        }
    });
}

function renderPlanPieChart() {
    const canvas = document.getElementById('analyticsPlanPieChart');
    if (!canvas || !analyticsOverviewData) return;

    if (planChartInstance) planChartInstance.destroy();

    const chartData = analyticsOverviewData.plan_breakdown;
    const labels = chartData.map(d => d.plan_name);
    const dataPoints = chartData.map(d => d.revenue);

    planChartInstance = new Chart(canvas, {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                data: dataPoints,
                backgroundColor: [
                    '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#6b7280'
                ],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { boxWidth: 10, font: { size: 9, family: 'Outfit, sans-serif' } }
                }
            }
        }
    });
}

async function fetchComparisonData() {
    const m1 = document.getElementById('compareMonth1').value;
    const m2 = document.getElementById('compareMonth2').value;
    
    if (!m1 || !m2) return;
    
    try {
        const res = await fetch(`/api/admin/analytics/compare?month1=${m1}&month2=${m2}`);
        const data = await res.json();
        
        // Populate Comparison Metrics
        const comp = data.comparison;
        const diffRev = document.getElementById('compRevDiff');
        const growRev = document.getElementById('compRevGrowth');
        
        diffRev.innerText = `${comp.revenue_diff >= 0 ? '+' : ''}${formatINRCurrency(comp.revenue_diff)}`;
        growRev.innerText = `${comp.revenue_pct >= 0 ? '↑' : '↓'} ${Math.abs(comp.revenue_pct)}%`;
        growRev.style.color = comp.revenue_pct >= 0 ? '#10b981' : '#ef4444';

        // New Members
        document.getElementById('compValM1_new').innerText = data.m1.new_members;
        document.getElementById('compValM2_new').innerText = data.m2.new_members;
        const diffNew = document.getElementById('compDiff_new');
        diffNew.innerText = `${comp.new_members_diff >= 0 ? '+' : ''}${comp.new_members_diff} compared`;
        diffNew.style.color = comp.new_members_diff >= 0 ? '#10b981' : '#ef4444';

        // Renewals
        document.getElementById('compValM1_renew').innerText = data.m1.renewals;
        document.getElementById('compValM2_renew').innerText = data.m2.renewals;
        const diffRen = document.getElementById('compDiff_renew');
        diffRen.innerText = `${comp.renewals_diff >= 0 ? '+' : ''}${comp.renewals_diff} compared`;
        diffRen.style.color = comp.renewals_diff >= 0 ? '#10b981' : '#ef4444';

        // Collection Rates
        document.getElementById('compValM1_col').innerText = `${formatINRCurrency(data.m1.collected)} (${data.m1.recovery_rate}%)`;
        document.getElementById('compValM2_col').innerText = `${formatINRCurrency(data.m2.collected)} (${data.m2.recovery_rate}%)`;
        const diffCol = document.getElementById('compDiff_col');
        const colDelta = Math.round((data.m2.recovery_rate - data.m1.recovery_rate) * 10) / 10;
        diffCol.innerText = `${colDelta >= 0 ? '+' : ''}${colDelta}% collection rate`;
        diffCol.style.color = colDelta >= 0 ? '#10b981' : '#ef4444';

        // Attendance
        document.getElementById('compValM1_att').innerText = data.m1.attendance;
        document.getElementById('compValM2_att').innerText = data.m2.attendance;
        document.getElementById('compDiff_att').innerText = `Peak: ${data.m1.peak_day} vs ${data.m2.peak_day}`;

        // Win Backs
        document.getElementById('compValM1_wb').innerText = data.m1.win_backs;
        document.getElementById('compValM2_wb').innerText = data.m2.win_backs;
        const diffWb = document.getElementById('compDiff_wb');
        diffWb.innerText = `${comp.win_backs_diff >= 0 ? '+' : ''}${comp.win_backs_diff} recovered`;
        diffWb.style.color = comp.win_backs_diff >= 0 ? '#10b981' : '#ef4444';

    } catch (err) {
        console.error(err);
        showToast('Error loading analytics comparison dataset', 'error');
    }
}

function toggleTrendGrouping(grouping) {
    currentTrendGrouping = grouping;
    
    document.getElementById('btnTrendMonth').classList.remove('active');
    document.getElementById('btnTrendQuarter').classList.remove('active');
    document.getElementById('btnTrendYear').classList.remove('active');
    
    const activeBtn = document.getElementById(`btnTrend${grouping.charAt(0).toUpperCase() + grouping.slice(1)}`);
    if (activeBtn) activeBtn.classList.add('active');
    
    renderTrendChart();
}

function exportAnalytics(format) {
    if (!analyticsOverviewData) {
        showToast('No analytics dataset loaded', 'warning');
        return;
    }

    if (format === 'csv' || format === 'excel') {
        let csv = 'Month,Revenue\n';
        analyticsOverviewData.monthly_trend.forEach(d => {
            csv += `"${d.month}","${d.revenue}"\n`;
        });

        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.setAttribute('href', url);
        link.setAttribute('download', `revenue_trend_${new Date().toISOString().split('T')[0]}.${format === 'csv' ? 'csv' : 'xls'}`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    } else if (format === 'pdf') {
        const printWindow = window.open('', '_blank');
        printWindow.document.write(`
            <html>
            <head>
                <title>Revenue Analytics Summary Report</title>
                <style>
                    body { font-family: -apple-system, sans-serif; padding: 30px; color:#111; }
                    h1 { margin-bottom: 5px; }
                    .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-top:20px; }
                    .card { border:1px solid #ddd; padding: 15px; border-radius:6px; }
                    .label { font-size:11px; text-transform:uppercase; color:#666; font-weight:600; }
                    .val { font-size: 20px; font-weight:bold; margin-top:5px; }
                    table { width: 100%; border-collapse: collapse; margin-top: 30px; }
                    th, td { border: 1px solid #ddd; padding: 10px; text-align: left; }
                    th { background-color: #f3f4f6; }
                </style>
            </head>
            <body>
                <h1>Revenue Analytics Summary</h1>
                <p>Generated on: ${new Date().toLocaleString()}</p>
                <div class="stats-grid">
                    <div class="card">
                        <div class="label">Lifetime Revenue</div>
                        <div class="val">${formatINRCurrency(analyticsOverviewData.lifetime_revenue)}</div>
                    </div>
                    <div class="card">
                        <div class="label">This Month</div>
                        <div class="val">${formatINRCurrency(analyticsOverviewData.this_month_revenue)}</div>
                    </div>
                    <div class="card">
                        <div class="label">Monthly Average</div>
                        <div class="val">${formatINRCurrency(analyticsOverviewData.avg_monthly_revenue)}</div>
                    </div>
                    <div class="card">
                        <div class="label">Outstanding Dues</div>
                        <div class="val">${formatINRCurrency(analyticsOverviewData.outstanding_dues)}</div>
                    </div>
                </div>
                <table>
                    <thead>
                        <tr>
                            <th>Month</th>
                            <th>Revenue Collected</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${analyticsOverviewData.monthly_trend.map(d => `
                            <tr>
                                <td>${d.month}</td>
                                <td>${formatINRCurrency(d.revenue)}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </body>
            </html>
        `);
        printWindow.document.close();
        printWindow.focus();
        printWindow.print();
        printWindow.close();
    }
}



