// GymOS Admin App Controller
let currentTab = 'dashboard';
let gymSettings = {};
let sseSource = null;
let revenueLineChart = null;
let attendanceDonutChart = null;

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
    document.getElementById('realTimeHeaderDate').innerText = dateStrLong;

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
        fetchRegisterPlans();
    } else if (modalId === 'recordPaymentModal') {
        fetchPendingPaymentsDropDown();
    } else if (modalId === 'gymQRModal') {
        drawGymQR();
    }
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('active');
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
                    <td style="text-align:right;"><button class="btn-comms-circle btn-comms-whatsapp" style="display:inline-flex;" onclick="triggerWhatsAppModal(${r.id})" title="Send WhatsApp reminder"><svg fill="currentColor" viewBox="0 0 24 24" width="14" height="14"><path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946C.06 5.348 5.397.01 12.008.01c3.202.001 6.212 1.246 8.477 3.514 2.266 2.268 3.507 5.28 3.505 8.484-.004 6.657-5.34 11.997-11.953 11.997-2.005-.001-3.973-.503-5.722-1.465L0 24zm6.59-4.846c1.6.95 3.188 1.449 4.825 1.451 5.436 0 9.86-4.37 9.864-9.799.002-2.63-1.023-5.101-2.885-6.965C16.59 1.977 14.113.953 11.5.953c-5.44 0-9.866 4.372-9.87 9.802 0 1.814.49 3.518 1.42 5.061l-.995 3.633 3.738-.971z"/></svg></button></td>
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
            alert('No pending dues to export.');
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

        document.getElementById('expiringSoonTotalInfo').innerText = `Total: ${rows.length} member${rows.length === 1 ? '' : 's'}`;

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
                    <td style="text-align:right;">${r.payment_id ? `<button class="btn-send-whatsapp-remind" onclick="triggerWhatsAppModal(${r.payment_id})">Alert</button>` : '—'}</td>
                </tr>
            `;
        }).join('');
    } catch (err) {
        body.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--danger);">Failed to load expiring memberships.</td></tr>';
    }
}

async function downloadExpiringSoonCSV() {
    try {
        const res = await fetch('/api/admin/dashboard/expiring-soon');
        const data = await res.json();
        const rows = data.data || [];

        if (rows.length === 0) {
            alert('No memberships expiring soon to export.');
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
    openModal('forgotPasswordModal');
}

function closeForgotPasswordFlow() {
    closeModal('forgotPasswordModal');
}

async function submitForgotPassword(event) {
    event.preventDefault();
    const errorBox = document.getElementById('forgotPasswordError');
    errorBox.style.display = 'none';

    const email = document.getElementById('fpEmail').value.trim();
    const phone = document.getElementById('fpPhone').value.trim();
    const new_password = document.getElementById('fpNewPassword').value;

    try {
        const res = await fetch('/api/auth/reset-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, phone, new_password })
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
    }
}

// Auth validation
async function checkUserSession() {
    try {
        const res = await fetch('/api/auth/me');
        const data = await res.json();
        if (data.user && data.user.role === 'owner') {
            loginOverlay.style.display = 'none';
            appLayout.style.display = 'flex';

            const ownerDisplayName = data.user.first_name ? `${data.user.first_name} ${data.user.last_name || ''}` : "Ramesh Kumar";
            const ownerFirstName = data.user.first_name || "Ramesh";

            document.getElementById('profileOwnerName').innerText = ownerDisplayName;
            document.getElementById('greetingUser').innerText = `${ownerFirstName} 👋`;

            const avatarDiv = document.querySelector('.owner-profile-card .owner-avatar');
            if (avatarDiv && data.user.first_name) {
                avatarDiv.innerText = (data.user.first_name[0] + (data.user.last_name ? data.user.last_name[0] : '')).toUpperCase();
            }

            startApp();
        } else {
            loginOverlay.style.display = 'flex';
            appLayout.style.display = 'none';
        }
    } catch (err) {
        console.error('Session validation error', err);
    }
}

function startApp() {
    fetchDashboardStats();
    fetchMembers();
    fetchAttendance();
    fetchPayments();
    fetchPlans();
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
    document.getElementById('statMonthlyRevenue').innerText = formatINRCurrency(stats.monthly_revenue);
    document.getElementById('statPendingPayments').innerText = stats.pending_payments;
    document.getElementById('statPendingAmountVal').innerText = `${formatINRCurrency(stats.pending_amount)} total`;
    document.getElementById('statExpiredCount').innerText = stats.expiring_members;

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
            const initials = (m.first_name[0] + (m.last_name ? m.last_name[0] : '')).toUpperCase();
            const div = document.createElement('div');
            div.className = 'recent-joiner-item';
            div.innerHTML = `
                <div class="member-avatar-mini" style="background-color: ${getRandomColorForChar(initials[0])}; color: white; border: none; font-weight: 700;">${initials}</div>
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
            alert('No attendance records for this month.');
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

            tr.innerHTML = `
                <td class="col-checkbox">
                    <input type="checkbox" class="table-checkbox row-checkbox" data-id="${m.id}" ${isChecked} onchange="toggleRowSelection('membersTable', ${m.id}, this)">
                </td>
                <td>
                    <div class="member-avatar-cell">
                        <div class="member-avatar-circle" style="background-color: ${getRandomColorForChar(initial)}">${initial}</div>
                        <div class="member-profile-desc">
                            <span class="member-fullname-bold">${m.first_name} ${m.last_name}</span>
                            <span class="member-email-dim">${m.email}</span>
                        </div>
                    </div>
                </td>
                <td class="col-id" data-label="Member ID"><span class="member-id-monospace">#${m.id}</span></td>
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
            tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-tertiary); padding: 40px 0;">No check-in activity matches.</td></tr>';
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

            const attendanceLabel = log.status === 'failed' ? 'Failed' : (log.attendance_state === 'completed' || log.check_out_time ? 'Completed' : 'Checked in');
            const stateBadge = log.status === 'failed' ? 'badge-suspended' : (attendanceLabel === 'Completed' ? 'badge-active' : 'badge-expired');
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
                <td class="col-verification" data-label="Status"><span class="badge ${stateBadge}">${attendanceLabel}</span></td>
                <td class="col-feedback" data-label="Access details" style="color: var(--text-secondary); font-size: 13.5px;">${log.error_msg || 'Access Approved'}</td>
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

// Payments Directory
async function fetchPayments() {
    const status = document.getElementById('paymentStatusFilter').value;
    const search = document.getElementById('paymentSearch').value;
    const pageSize = document.getElementById('paymentPageSize').value;
    paymentLimit = pageSize;
    const tbody = document.getElementById('paymentsTableBody');

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

            const badge = p.status === 'paid' ? 'badge-active' : (p.status === 'pending_approval' ? 'badge-pending-approval' : (p.status === 'overdue' ? 'badge-suspended' : 'badge-expired'));
            const isChecked = selectedPayments.has(p.id) ? 'checked' : '';

            let actionBtn = '';
            if (p.status === 'pending_approval') {
                actionBtn = `
                    <button class="dots-dropdown-item" style="color: var(--success-dark); font-weight: 600;" onclick="adminApprovePayment(${p.id})">Approve Payment</button>
                    <button class="dots-dropdown-item" style="color: var(--danger-dark);" onclick="adminRejectPayment(${p.id})">Reject Payment</button>
                `;
            } else if (p.status !== 'paid') {
                actionBtn = `
                    <button class="dots-dropdown-item" onclick="triggerManualPaymentForm(${p.id})">Record Pay</button>
                    <button class="dots-dropdown-item" style="color: var(--warning-dark);" onclick="triggerWhatsAppModal(${p.id})">WhatsApp Alert</button>
                `;
            } else {
                actionBtn = `<button class="dots-dropdown-item" style="color: var(--accent);" onclick="generateMockReceipt(${p.id}, '${p.first_name} ${p.last_name}', '${p.plan_name}', ${p.amount}, '${p.payment_date}')">Print Receipt</button>`;
            }

            const dateVal = p.status === 'paid' ? new Date(p.payment_date).toLocaleDateString() : `Due: ${p.due_date}`;

            tr.innerHTML = `
                <td class="col-checkbox">
                    <input type="checkbox" class="table-checkbox row-checkbox" data-id="${p.id}" ${isChecked} onchange="toggleRowSelection('paymentsTable', ${p.id}, this)">
                </td>
                <td class="col-receipt" data-label="Receipt" style="font-family: monospace; font-size:13px; font-weight:600;">${p.receipt_number || 'PENDING'}</td>
                <td style="font-weight: 500;">${p.first_name} ${p.last_name}</td>
                <td class="col-amount" data-label="Amount">${formatINRCurrency(p.amount)}</td>
                <td class="col-status" data-label="Status"><span class="badge ${badge}">${p.status}</span></td>
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
async function fetchRegisterPlans() {
    const select = document.getElementById('assignPlanSelect');
    try {
        const res = await fetch('/api/admin/plans');
        const plans = await res.json();
        select.innerHTML = '<option value="" disabled selected>Select Membership Plan Tier</option>';
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
    document.getElementById('assignMemberId').value = mbrId;
    document.getElementById('assignMemberName').innerText = name;
    openModal('assignPlanModal');
}

let editMemberCurrentStatus = 'active';

async function openEditMemberModal(mbrId) {
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
        document.getElementById('emEmergency').value = m.emergency_contact || '';
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

        // Convert the default currency sign in reminder message to Rupees (₹)
        let customMsg = data.message || '';
        customMsg = customMsg.replace(/\$/g, '₹');

        let customValUrl = data.whatsapp_url || '';
        customValUrl = customValUrl.replace(/\$/g, '₹');

        document.getElementById('whatsappPreviewTxt').innerText = customMsg;
        document.getElementById('whatsappTriggerLink').href = customValUrl;
        openModal('whatsappModal');
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
            alert('No revenue recorded for this month.');
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

        const nameInput = document.getElementById('settingsGymName');
        const phoneInput = document.getElementById('settingsGymPhone');
        const addressInput = document.getElementById('settingsGymAddress');
        const tokenInput = document.getElementById('settingsQRToken');
        const imageInput = document.getElementById('settingsGymImageUrl');

        if (nameInput) nameInput.value = gymSettings.gym_name || '';
        if (phoneInput) phoneInput.value = gymSettings.gym_phone || '';
        if (addressInput) addressInput.value = gymSettings.gym_address || '';
        if (tokenInput) tokenInput.value = gymSettings.qr_token || '';
        if (imageInput) imageInput.value = gymSettings.gym_image_url || '';

        document.getElementById('headerGymName').innerText = gymSettings.gym_name || 'GymOS';
        const brandNameEl = document.querySelector('.brand-title-fitzone .brand-main');
        if (brandNameEl) brandNameEl.innerText = gymSettings.gym_name || 'GymOS';

        renderDashboardGymImage(gymSettings.gym_image_url);
    } catch (err) {
        console.error('Gym settings loading error', err);
    }
}

function renderDashboardGymImage(imageUrl) {
    const el = document.getElementById('dashboardGymImage');
    if (!el) return;
    if (imageUrl) {
        el.src = imageUrl;
        el.style.display = 'block';
    } else {
        el.style.display = 'none';
    }
}

// Setup handlers
function setupFormHandlers() {
    // Login
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('loginEmail').value;
        const password = document.getElementById('loginPassword').value;

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
                    return;
                }
                loginOverlay.style.display = 'none';
                appLayout.style.display = 'flex';
                showToast('Login successful', 'success');
                checkUserSession();
            } else {
                loginError.innerText = data.error || 'Authentication failed';
                loginError.style.display = 'block';
            }
        } catch (err) {
            loginError.innerText = 'Failed request: server offline';
            loginError.style.display = 'block';
        }
    });

    // Forgot Password
    const forgotPasswordForm = document.getElementById('forgotPasswordForm');
    if (forgotPasswordForm) {
        forgotPasswordForm.addEventListener('submit', submitForgotPassword);
    }

    // Profile Trigger / Logout
    document.querySelector('.owner-profile-card').addEventListener('contextmenu', async (e) => {
        e.preventDefault();
        if (confirm("End Owner Session?")) {
            logoutOwner();
        }
    });

    // Add logout hook to profile click just in case
    document.querySelector('.owner-profile-card').addEventListener('click', () => {
        // Toggle logout overlay or double click to logout
        showToast("Right-click profile card to Logout.");
    });

    // Settings Update
    document.getElementById('settingsForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = {
            gym_name: document.getElementById('settingsGymName').value,
            gym_phone: document.getElementById('settingsGymPhone').value,
            gym_address: document.getElementById('settingsGymAddress').value,
            qr_token: document.getElementById('settingsQRToken').value,
            gym_image_url: document.getElementById('settingsGymImageUrl').value
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
                fetchGymSettings();
            } else {
                showToast(resData.error, 'error');
            }
        } catch (err) {
            showToast('Network error updating settings', 'error');
        }
    });

    // Add Member
    document.getElementById('addMemberForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = {
            first_name: document.getElementById('mFirstName').value,
            last_name: document.getElementById('mLastName').value,
            email: document.getElementById('mEmail').value,
            phone: document.getElementById('mPhone').value,
            emergency_contact: document.getElementById('mEmergency').value,
            password: document.getElementById('mPassword').value || undefined
        };

        try {
            const res = await fetch('/api/admin/members', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            const resData = await res.json();
            if (resData.success) {
                closeModal('addMemberModal');
                document.getElementById('addMemberForm').reset();
                showToast('Member created successfully.');
                fetchMembers();
                fetchDashboardStats();
            } else {
                showToast(resData.error, 'error');
            }
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
            emergency_contact: document.getElementById('emEmergency').value,
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

async function logoutOwner() {
    try {
        await fetch('/api/auth/logout', { method: 'POST' });
        if (sseSource) sseSource.close();
        loginOverlay.style.display = 'flex';
        appLayout.style.display = 'none';
        showToast('Logout completed.');
    } catch (err) {
        console.error(err);
    }
}

// Inline toggle suspend
async function toggleSuspendMember(id, currentStatus) {
    const target = (currentStatus === 'suspended' || currentStatus === 'pending') ? 'active' : 'suspended';
    const actionLabel = currentStatus === 'pending' ? 'approve' : (currentStatus === 'suspended' ? 'activate' : 'suspend');
    if (!confirm(`Are you sure you want to ${actionLabel} this member?`)) return;

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
            showToast(resData.error, 'error');
        }
    } catch (err) {
        showToast('Failed to modify status', 'error');
    }
}

async function deleteMember(id) {
    if (!confirm('Are you sure you want to permanently delete this member?')) return;

    try {
        const res = await fetch(`/api/admin/members/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            showToast('Member profile purged.');
            fetchMembers();
            fetchDashboardStats();
        } else {
            showToast(data.error, 'error');
        }
    } catch (err) {
        showToast('Failed deleting member profile', 'error');
    }
}

async function deletePlan(id) {
    if (!confirm('Delete this plan tier?')) return;

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
    document.getElementById('qrTokenDisplayTxt').innerText = `Token: ${token}`;

    const container = document.getElementById('gymQRCodeContainer');
    container.innerHTML = '';
    if (typeof QRCode !== 'undefined') {
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

function downloadGymQRCode() {
    const container = document.getElementById('gymQRCodeContainer');
    const img = container.querySelector('img');
    const canvas = container.querySelector('canvas');
    const dataUrl = img ? img.src : (canvas ? canvas.toDataURL('image/png') : null);

    if (!dataUrl) {
        showToast('QR code is not ready yet', 'error');
        return;
    }

    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = 'gym-entrance-qr.png';
    document.body.appendChild(link);
    link.click();
    link.remove();
}

function triggerAttendanceExport() {
    const dateStr = document.getElementById('attendanceDateFilter').value || 'all';
    alert(`CSV Report Generated. Downloading check-in logs for: [${dateStr}]`);

    let csvContent = "data:text/csv;charset=utf-8,Member,Phone,Check-In Logs,Verification State,Feedback\n";
    const rows = document.querySelectorAll('#attendanceTableBody tr');

    if (rows.length === 1 && rows[0].innerText.includes('No check-in')) {
        alert("Empty logs. Add check-ins to export logs.");
        return;
    }

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

function generateMockReceipt(id, name, plan, amount, date) {
    const win = window.open("", "Receipt " + id, "width=400,height=550");
    const d = new Date(date).toLocaleString();
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
        <div class="logo">FitZone Gym</div>
        <div>${gymSettings.gym_name || 'FitZone Gym'}</div>
        <div>${gymSettings.gym_address || ''}</div>
        <div>Tel: ${gymSettings.gym_phone || ''}</div>
      </div>
      <div class="divider"></div>
      <div class="center bold">RECEIPT FOR PAYMENT</div>
      <div style="margin-top: 10px;">ID: RC-${id}-${Math.floor(Date.now() / 1000)}</div>
      <div>Date: ${d}</div>
      <div class="divider"></div>
      <div class="row"><span class="bold">Member:</span> <span>${name}</span></div>
      <div class="row"><span class="bold">Description:</span> <span>${plan} Plan</span></div>
      <div class="row"><span class="bold">Tax:</span> <span>₹0.00</span></div>
      <div class="divider"></div>
      <div class="row bold" style="font-size:16px;"><span>Total Paid:</span> <span>${formatINRCurrency(amount)}</span></div>
      <div class="divider"></div>
      <div class="center bold">THANK YOU FOR YOUR PATRONAGE!</div>
      <div class="center" style="font-size: 11px; margin-top: 24px; color: #777;">GymOS Integration Engine.</div>
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

    alert(`Exporting ${selectedSet.size} selected ${mode} rows as CSV.`);

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
        csvContent += "Name,Phone,Check-In Time,Check-Out Time,Workout Duration,Verification State,Feedback\n";
        selectedSet.forEach(id => {
            const row = document.getElementById(`attendance-row-${id}`);
            if (row) {
                const cols = row.querySelectorAll('td');
                const name = cols[1].innerText;
                const phone = cols[2].innerText;
                const checkin = cols[3].innerText;
                const checkout = cols[4].innerText;
                const duration = cols[5].innerText;
                const status = cols[6].innerText;
                const feedback = cols[7].innerText;
                csvContent += `"${name}","${phone}","${checkin}","${checkout}","${duration}","${status}","${feedback}"\n`;
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
        alert("Bulk Suspend check is only supported for Members list.");
        return;
    }
    if (selectedMembers.size === 0) return;

    if (!confirm(`Are you sure you want to toggle user suspension states for ${selectedMembers.size} selected members?`)) return;

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
        alert("Delete operations are only supported for entire Member accounts.");
        return;
    }

    if (!confirm(`CRITICAL WARNING: Are you sure you want to permanently DELETE ${selectedSet.size} members and clear all their checkin logs and payments?`)) return;

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

    alert("Downloading current page of Members directory as CSV.");
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
    alert(`CSV Report Generated. Downloading check-in logs for: [${dateStr}]`);

    let csvContent = "data:text/csv;charset=utf-8,Member,Phone,Check-In Time,Check-Out Time,Workout Duration,Verification State,Feedback\n";
    const rows = document.querySelectorAll('#attendanceTableBody tr');

    rows.forEach(tr => {
        const cols = tr.querySelectorAll('td');
        if (cols.length >= 8) {
            const name = cols[1].innerText;
            const phone = cols[2].innerText;
            const checkin = cols[3].innerText;
            const checkout = cols[4].innerText;
            const duration = cols[5].innerText;
            const status = cols[6].innerText;
            const feedback = cols[7].innerText;
            csvContent += `"${name}","${phone}","${checkin}","${checkout}","${duration}","${status}","${feedback}"\n`;
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

    alert("Downloading current page of Billings records as CSV.");
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
            
            const initials = (user.first_name[0] + (user.last_name ? user.last_name[0] : '')).toUpperCase();
            const medals = ['🥇', '🥈', '🥉'];
            const rankBadge = idx < 3 ? medals[idx] : `<span style="font-weight:700; color:var(--text-tertiary); margin-right: 6px;">#${idx + 1}</span>`;
            
            item.innerHTML = `
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="font-size: 14px;">${rankBadge}</span>
                    <div class="member-avatar-mini">${initials}</div>
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
    if (!confirm('Approve this payment request?')) return;
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

async function adminRejectPayment(id) {
    if (!confirm('Reject this payment request?')) return;
    try {
        const res = await fetch(`/api/admin/payments/${id}/reject`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast('Payment request rejected.');
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

async function adminManualCheckIn(id) {
    try {
        const res = await fetch(`/api/admin/members/${id}/check-in`, { method: 'POST' });
        const data = await res.json();
        if (res.status === 200 || data.success) {
            showToast('Manual check-in completed successfully!');
            fetchMembers();
            fetchDashboardStats();
        } else {
            showToast(data.error || 'Check-in failed.', 'error');
        }
    } catch (err) {
        console.error('Manual check-in error', err);
        showToast('Network error, please try again.', 'error');
    }
}

async function adminManualCheckOut(id) {
    try {
        const res = await fetch(`/api/admin/members/${id}/check-out`, { method: 'POST' });
        const data = await res.json();
        if (res.status === 200 || data.success) {
            showToast(`Manual check-out logged! Duration: ${data.duration}`);
            fetchMembers();
            fetchDashboardStats();
        } else {
            showToast(data.error || 'Check-out failed.', 'error');
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
        
        const initials = ((m.first_name ? m.first_name[0] : '') + (m.last_name ? m.last_name[0] : '')).toUpperCase() || 'M';
        const avatarHtml = m.profile_photo 
            ? `<img src="${m.profile_photo}" style="width: 52px; height: 52px; border-radius: 50%; object-fit: cover;" />`
            : `<div style="width: 52px; height: 52px; border-radius: 50%; background-color: var(--accent-light); color: var(--accent); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 18px;">${initials}</div>`;
            
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
    const confirmed = confirm('Reject Request?\n\nAre you sure you want to reject this member request?');
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

        let icon = '🔔';
        let bg = 'rgba(234, 179, 8, 0.1)';
        if (n.type === 'welcome') { icon = '🟢'; bg = 'rgba(34, 197, 94, 0.1)'; }
        else if (n.type === 'payment') { icon = '💰'; bg = 'rgba(59, 130, 246, 0.1)'; }
        else if (n.type === 'expiry') { icon = '⚠️'; bg = 'rgba(239, 68, 68, 0.1)'; }
        else if (n.type === 'checkin') { icon = '🏃'; bg = 'rgba(168, 85, 247, 0.1)'; }
        else if (n.type === 'pending') { icon = '📩'; bg = 'rgba(14, 165, 233, 0.1)'; }

        item.innerHTML = `
            <div class="notif-item-icon-wrapper" style="background-color: ${bg};">${icon}</div>
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

        let icon = '🔔';
        let bg = 'rgba(234, 179, 8, 0.1)';
        if (n.type === 'welcome') { icon = '🟢'; bg = 'rgba(34, 197, 94, 0.1)'; }
        else if (n.type === 'payment') { icon = '💰'; bg = 'rgba(59, 130, 246, 0.1)'; }
        else if (n.type === 'expiry') { icon = '⚠️'; bg = 'rgba(239, 68, 68, 0.1)'; }
        else if (n.type === 'checkin') { icon = '🏃'; bg = 'rgba(168, 85, 247, 0.1)'; }
        else if (n.type === 'pending') { icon = '📩'; bg = 'rgba(14, 165, 233, 0.1)'; }

        card.innerHTML = `
            <div class="notif-history-left">
                <div class="notif-item-icon-wrapper" style="background-color: ${bg}; width: 40px; height: 40px; font-size: 18px;">${icon}</div>
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

function clearAllNotifications() {
    const confirmed = confirm('Delete All?\n\nAre you sure you want to clear your entire notification history?');
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
    
    const confirmed = confirm('Logout\n\nAre you sure you want to logout?');
    if (!confirmed) return;

    try {
        const res = await fetch('/api/auth/logout', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            // Reset state
            localStorage.removeItem('gymos_owner_notifications');
            // Redirect
            loginOverlay.style.display = 'flex';
            appLayout.style.display = 'none';
            showToast('Logged out successfully', 'info');
        } else {
            showToast('Logout failed. Please try again.', 'error');
        }
    } catch (err) {
        console.error('Logout error:', err);
        // Force redirect to login anyway if network error
        loginOverlay.style.display = 'flex';
        appLayout.style.display = 'none';
    }
}

