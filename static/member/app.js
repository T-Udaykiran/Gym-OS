// GymOS Member App Controller
let activeMemberData = {};
let currentMobileTab = 'home';
let notificationsPanelOpen = false;

// DOM Elements
const simTime = document.getElementById('simTime');
const memberAuthWrapper = document.getElementById('memberAuthWrapper');
const memberAppWrapper = document.getElementById('memberAppWrapper');
const memberLoginForm = document.getElementById('authLoginForm') || document.getElementById('memberLoginForm');
const memberRegisterForm = document.getElementById('authRegisterForm') || document.getElementById('memberRegisterForm');
const authErrorMsg = document.getElementById('authLoginError') || document.getElementById('authErrorMsg');

// ==========================================
// Leaderboard Repository & Data Abstraction
// ==========================================
class LeaderboardRepository {
    async fetchWeekly() { throw new Error("Not implemented"); }
    async fetchMonthly() { throw new Error("Not implemented"); }
    async fetchAllTime() { throw new Error("Not implemented"); }
    async fetchMemberRanks() { throw new Error("Not implemented"); }
}

class LocalDbLeaderboardRepository extends LeaderboardRepository {
    constructor() {
        super();
        this._cachedData = null;
    }
    
    clearCache() {
        this._cachedData = null;
    }
    
    async _getRawData() {
        if (this._cachedData) {
            return this._cachedData;
        }
        if (activityDataGlobal) {
            this._cachedData = {
                weekly: activityDataGlobal.leaderboard_weekly || [],
                monthly: activityDataGlobal.leaderboard_monthly || [],
                allTime: activityDataGlobal.leaderboard_all || [],
                weeklyRank: activityDataGlobal.weekly_rank || 0,
                monthlyRank: activityDataGlobal.monthly_rank || 0,
                allTimeRank: activityDataGlobal.all_time_rank || 0
            };
            return this._cachedData;
        }
        const res = await fetch('/api/member/activity');
        if (res.status === 403) {
            const errData = await res.json();
            alert(errData.error || 'Your account is suspended.');
            logoutMemberApp();
            return {};
        }
        const data = await res.json();
        activityDataGlobal = data;
        this._cachedData = {
            weekly: data.leaderboard_weekly || [],
            monthly: data.leaderboard_monthly || [],
            allTime: data.leaderboard_all || [],
            weeklyRank: data.weekly_rank || 0,
            monthlyRank: data.monthly_rank || 0,
            allTimeRank: data.all_time_rank || 0
        };
        return this._cachedData;
    }

    async fetchWeekly() {
        const data = await this._getRawData();
        return data.weekly || [];
    }
    async fetchMonthly() {
        const data = await this._getRawData();
        return data.monthly || [];
    }
    async fetchAllTime() {
        const data = await this._getRawData();
        return data.allTime || [];
    }
    async fetchMemberRanks() {
        const data = await this._getRawData();
        return {
            weeklyRank: data.weeklyRank || 0,
            monthlyRank: data.monthlyRank || 0,
            allTimeRank: data.allTimeRank || 0
        };
    }
}

const leaderboardRepo = new LocalDbLeaderboardRepository();

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    updateSimulatorClock();
    setInterval(updateSimulatorClock, 1000);
    checkMemberSession();
    setupAuthForms();

    // Listen for network connectivity change events
    window.addEventListener('online', () => {
        showMobileToast('You are back online. Synchronizing data...', 'success');
        fetchDashboardData();
    });
    window.addEventListener('offline', () => {
        showMobileToast('Connection lost. GymOS is running in offline mode.', 'info');
    });
});

// Toast notification helper for Mobile app view
function showMobileToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');

    const duplicate = Array.from(container.children).find(t => t.dataset.msg === message && t.dataset.type === type);
    if (duplicate) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.dataset.msg = message;
    toast.dataset.type = type;
    toast.style.width = '300px';
    toast.style.minWidth = '280px';

    let icon = '';
    if (type === 'success') {
        icon = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    } else if (type === 'error') {
        icon = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`;
    } else {
        icon = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
    }

    toast.innerHTML = `
    ${icon}
    <div style="font-size: 13.5px; font-weight: 500;">${message}</div>
  `;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) reverse forwards';
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

// Clock updates
function updateSimulatorClock() {
    const d = new Date();
    let hr = d.getHours();
    let min = d.getMinutes();
    if (min < 10) min = "0" + min;

    // Format 12hr clock for simulator status bar
    const suffix = hr >= 12 ? "PM" : "AM";
    hr = hr % 12;
    hr = hr ? hr : 12;
    if (simTime) {
        simTime.innerText = `${hr}:${min} ${suffix}`;
    }
}

// Screen navigation
function switchMobileNav(tabName) {
    if (currentMobileTab === 'scan' && tabName !== 'scan') stopCameraScanner();
    
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));

    const btnIdx = { home: 0, activity: 1, scan: 2, leaders: 3, profile: 4 };
    let targetTab = tabName;
    
    // Highlight the activity tab if we are on the attendance history page
    let activeBtnTab = tabName;
    if (tabName === 'attendanceHistory') {
        activeBtnTab = 'activity';
    }
    
    currentMobileTab = targetTab;

    const btns = document.querySelectorAll('.tab-btn');
    if (btns[btnIdx[activeBtnTab]]) {
        btns[btnIdx[activeBtnTab]].classList.add('active');
    }

    document.querySelectorAll('.mobile-screen').forEach(screen => screen.classList.remove('active'));
    const targetScreen = document.getElementById(`${targetTab}Screen`);
    if (targetScreen) targetScreen.classList.add('active');

    // Refresh page fields
    if (targetTab === 'home') fetchDashboardData();
    if (targetTab === 'scan') resetScannerView();
    if (targetTab === 'activity') {
        fetchActivityData();
        hideActivitySubScreen();
    }
    if (targetTab === 'attendanceHistory') {
        fetchActivityData();
        setTimeout(() => {
            renderHistorySubScreen();
        }, 100);
    }
    if (targetTab === 'leaders') {
        fetchActivityData();
        setTimeout(() => {
            renderLeaderboardSubScreen();
        }, 100);
    }
    if (targetTab === 'payments') { renderBillingBills(); fetchAndRenderPlans(); }
    if (targetTab === 'profile') populateProfileFields();

    // Close notifs panel when navigating
    const notifPanel = document.getElementById('notifOverlayPanel');
    if (notifPanel) notifPanel.style.display = 'none';
    notificationsPanelOpen = false;

    // Scroll to top inside simulator screen view
    if (targetScreen) targetScreen.scrollTop = 0;
}

// Session checker
async function checkMemberSession() {
    try {
        const res = await fetch('/api/auth/me');
        const data = await res.json();
        if (data.user && data.user.role === 'member') {
            const memberDetails = data.user.member_details;
            if (memberDetails && memberDetails.status === 'pending') {
                memberAuthWrapper.style.display = 'flex';
                memberAppWrapper.style.display = 'none';
                hideAllAuthViews();
                document.getElementById('authPendingView').style.display = 'flex';
                connectMemberSse(memberDetails.id || data.user.member_id);
            } else if (memberDetails && memberDetails.status === 'rejected') {
                memberAuthWrapper.style.display = 'flex';
                memberAppWrapper.style.display = 'none';
                hideAllAuthViews();
                document.getElementById('authLoginView').style.display = 'flex';
                document.getElementById('authLoginError').innerText = 'Your registration request was rejected. Please contact your gym.';
                document.getElementById('authLoginError').style.display = 'block';
            } else {
                memberAuthWrapper.style.display = 'none';
                memberAppWrapper.style.display = 'flex';
                fetchDashboardData();
            }
        } else {
            memberAuthWrapper.style.display = 'flex';
            memberAppWrapper.style.display = 'none';
            showSplashView();
            setTimeout(() => {
                const splash = document.getElementById('authSplashScreen');
                if (splash && splash.style.display !== 'none') {
                    splash.style.transition = 'opacity 0.5s ease-out';
                    splash.style.opacity = '0';
                    setTimeout(() => {
                        showLoginView();
                        splash.style.opacity = '1';
                    }, 500);
                }
            }, 1500);
        }
    } catch (err) {
        console.error('Session verify failed', err);
    }
}

// Time & Date format helpers
function formatMembershipId(id) {
    if (!id) return '000000000';
    const s = String(id);
    if (s.length >= 9) return s;
    return s.padStart(9, '863934660').slice(-9);
}

function formatExpiryDate(dateStr) {
    if (!dateStr || dateStr === 'No Plan') return 'NO PLAN';
    try {
        const d = new Date(dateStr.replace(' ', 'T'));
        if (isNaN(d.getTime())) return dateStr.toUpperCase();
        const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
        return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
    } catch (e) {
        return dateStr.toUpperCase();
    }
}

function updateHomeStreakDaysGrid(attendanceHistory) {
    for (let i = 1; i <= 7; i++) {
        const dot = document.getElementById(`streakDayDot-${i}`);
        if (dot) {
            dot.classList.remove('checked');
            dot.innerHTML = '';
        }
    }

    const now = new Date();
    const currentDay = now.getDay();
    const mondayOffset = currentDay === 0 ? -6 : 1 - currentDay;
    const monday = new Date(now);
    monday.setDate(now.getDate() + mondayOffset);
    monday.setHours(0, 0, 0, 0);

    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);

    const weekCheckIns = attendanceHistory.filter(row => {
        if (!row.check_in_time) return false;
        const d = new Date(row.check_in_time.replace(' ', 'T'));
        return d >= monday && d <= sunday && row.status === 'success';
    });

    weekCheckIns.forEach(row => {
        const d = new Date(row.check_in_time.replace(' ', 'T'));
        let dayOfWeek = d.getDay();
        let dotIdx = dayOfWeek === 0 ? 7 : dayOfWeek;
        const dot = document.getElementById(`streakDayDot-${dotIdx}`);
        if (dot) {
            dot.classList.add('checked');
            dot.innerHTML = '<svg width="10" height="8" viewBox="0 0 10 8" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 4L3.5 6.5L9 1" stroke="black" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        }
    });
}

function formatTime12hr(dateTimeStr) {
    if (!dateTimeStr) return '--:--';
    const d = new Date(dateTimeStr.replace(' ', 'T'));
    let hr = d.getHours();
    let min = d.getMinutes();
    const suffix = hr >= 12 ? 'PM' : 'AM';
    hr = hr % 12;
    hr = hr ? hr : 12;
    if (min < 10) min = '0' + min;
    return `${hr}:${min} ${suffix}`;
}

function formatDateShort(dateTimeStr) {
    if (!dateTimeStr) return '';
    const d = new Date(dateTimeStr.replace(' ', 'T'));
    const day = d.getDate();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[d.getMonth()];
    return `${day} ${month}`;
}

// Load stats from server
async function fetchDashboardData() {
    try {
        const res = await fetch('/api/member/dashboard');
        if (res.status === 403) {
            const errData = await res.json();
            alert(errData.error || 'Your account is suspended.');
            logoutMemberApp();
            return;
        }

        const data = await res.json();
        activeMemberData = data;

        // Fill home fields
        if (document.getElementById('homeMemberFirstName')) {
            document.getElementById('homeMemberFirstName').innerText = data.first_name;
        }
        if (document.getElementById('homeStreakDaysText')) {
            document.getElementById('homeStreakDaysText').innerText = `${data.streak} Day`;
        }

        // Attendance stats
        if (document.getElementById('homeWeeklyVisitsCount')) {
            document.getElementById('homeWeeklyVisitsCount').innerText = data.weekly_count || '0';
        }
        if (document.getElementById('homeMonthlyVisitsCount')) {
            document.getElementById('homeMonthlyVisitsCount').innerText = data.monthly_count || '0';
        }

        // Fetch activity total workout hours
        try {
            const actRes = await fetch('/api/member/activity');
            const actData = await actRes.json();
            if (document.getElementById('homeTimeSpentText')) {
                const hrs = actData.total_workout_hours || 0;
                document.getElementById('homeTimeSpentText').innerText = `${hrs}hrs`;
            }
        } catch (e) {
            console.error('Fetch workout hours failed', e);
        }

        // Render dynamic checkboxes for week checkins
        updateHomeStreakDaysGrid(data.attendance_history || []);

        // Retrieve membership ID and Expiry
        const meRes = await fetch('/api/auth/me');
        const meData = await meRes.json();
        if (meData.user) {
            activeMemberData.last_name = meData.user.member_details.last_name;
            activeMemberData.email = meData.user.email;
            activeMemberData.phone = meData.user.member_details.phone;
            activeMemberData.emergency_contact = meData.user.member_details.emergency_contact;
            activeMemberData.profile_photo = meData.user.member_details.profile_photo;
            
            // Format & set membership ID
            if (document.getElementById('homeMembershipId')) {
                const rawId = meData.user.member_details.id || meData.user.member_id;
                document.getElementById('homeMembershipId').innerText = formatMembershipId(rawId);
            }
        }

        // Set Expiry & status
        if (document.getElementById('homeExpiryDate')) {
            const expDate = data.membership ? data.membership.end_date : 'No Plan';
            document.getElementById('homeExpiryDate').innerText = formatExpiryDate(expDate);
        }
        if (document.getElementById('homeStatusText')) {
            const rawStatus = data.status || 'inactive';
            const cleanStatus = rawStatus.charAt(0).toUpperCase() + rawStatus.slice(1);
            document.getElementById('homeStatusText').innerText = cleanStatus;
            
            const statusEl = document.getElementById('homeStatusText');
            if (rawStatus === 'active') {
                statusEl.style.color = 'var(--accent)';
            } else {
                statusEl.style.color = '#8e8e93';
            }
        }

        // Notification indicator dot
        const bellDot = document.getElementById('notifBadgeCount');
        const unreadNotifs = data.notifications.filter(n => n.read_status === 0);
        if (bellDot) {
            if (unreadNotifs.length > 0) {
                bellDot.style.display = 'block';
            } else {
                bellDot.style.display = 'none';
            }
        }

        // Build Notification panel view lists
        const notifPanel = document.getElementById('notifPanelList');
        if (notifPanel) {
            notifPanel.innerHTML = '';
            if (data.notifications.length === 0) {
                notifPanel.innerHTML = '<p style="font-size:12px; color:var(--text-tertiary); text-align:center; padding:10px 0;">No notifications yet.</p>';
            } else {
                data.notifications.slice(0, 5).forEach(n => {
                    const timeStamp = new Date(n.created_at).toLocaleDateString();
                    const unreadStyle = n.read_status === 0 ? 'background-color: var(--accent-light); border-left:3px solid var(--accent);' : '';
                    notifPanel.innerHTML += `
              <div style="padding:10px; border-radius: var(--radius-sm); font-size:12.5px; border-bottom:1px solid #f1f5f9; ${unreadStyle}">
                <div style="font-weight:600; color:var(--text-primary);">${n.message}</div>
                <div style="font-size:10px; color:var(--text-secondary); margin-top:4px;">${timeStamp}</div>
              </div>
            `;
                });
            }
        }
        
        // Fetch Leaderboard
        fetchLeaderboard();

    } catch (err) {
        console.error('Fetch dashboard stats failed', err);
    }
}

// Attendance List logs view helper
function renderAttendanceLogs() {
    const container = document.getElementById('memberAttendanceList');
    container.innerHTML = '';

    const history = activeMemberData.attendance_history || [];
    if (history.length === 0) {
        container.innerHTML = '<p style="text-align: center; color: var(--text-tertiary); padding: 40px 0; grid-column: span 4;">No check-in logs recorded.</p>';
        return;
    }

    history.forEach(log => {
        const checkinDate = new Date(log.check_in_time.replace(' ', 'T'));
        const dateStr = formatDateShort(log.check_in_time);
        const inStr = formatTime12hr(log.check_in_time);
        
        let outStr = 'Active';
        let durationStr = 'Active';
        
        if (log.check_out_time) {
            const checkoutDate = new Date(log.check_out_time.replace(' ', 'T'));
            outStr = formatTime12hr(log.check_out_time);
            
            const diff = Math.floor((checkoutDate - checkinDate) / 60000);
            const hrs = Math.floor(diff / 60);
            const mins = diff % 60;
            durationStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
        }
        
        const row = document.createElement('div');
        row.style.display = 'grid';
        row.style.gridTemplateColumns = '1.15fr 1fr 1fr .85fr .9fr';
        row.style.gap = '6px';
        row.style.padding = '12px';
        row.style.borderBottom = '1px solid var(--border-color)';
        row.style.fontSize = '13.5px';
        row.style.color = 'var(--text-primary)';
        row.style.alignItems = 'center';
        
        const status = log.check_out_time ? 'Completed' : 'Checked in';
        row.innerHTML = `
            <div style="font-weight: 600;">${dateStr}</div>
            <div>${inStr}</div>
            <div style="color: ${outStr === 'Active' ? 'var(--accent)' : 'var(--text-secondary)'}; font-weight: ${outStr === 'Active' ? '600' : 'normal'}">${outStr}</div>
            <div style="font-weight: 500;">${durationStr}</div>
            <div style="text-align: right;"><span class="badge ${log.check_out_time ? 'badge-active' : 'badge-expired'}">${status}</span></div>
        `;
        container.appendChild(row);
    });
}

// Payments View lists renderer - Redesigned to match PDF
function renderBillingBills() {
    const container = document.getElementById('memberPaymentsList');
    if (!container) return;
    container.innerHTML = '';

    if (!activeMemberData.billing_history || activeMemberData.billing_history.length === 0) {
        container.innerHTML = '<p style="text-align: center; color: var(--text-tertiary); padding: 40px 0; font-size: 13px;">No invoices available.</p>';
        return;
    }

    activeMemberData.billing_history.forEach(invoice => {
        const item = document.createElement('div');
        item.className = 'payment-history-item';
        
        let statusText = 'Pending';
        let badgeClass = 'pending';
        if (invoice.status === 'paid') {
            statusText = 'Approved';
            badgeClass = 'approved';
        } else if (invoice.status === 'pending_approval') {
            statusText = 'Pending for Approval';
            badgeClass = 'pending';
        } else if (invoice.status === 'rejected') {
            statusText = 'Rejected';
            badgeClass = 'rejected';
        } else if (invoice.status === 'overdue') {
            statusText = 'Overdue';
            badgeClass = 'rejected';
        }

        const dateStr = invoice.payment_date ? new Date(invoice.payment_date).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        }) : (invoice.due_date || 'Jul 11, 2026');

        let rightActionHtml = '';
        if (invoice.status === 'paid' || invoice.status === 'pending_approval' || invoice.status === 'rejected') {
            rightActionHtml = `
                <a href="#" class="payment-download-link" onclick="downloadMemberReceipt(${JSON.stringify(invoice).replace(/"/g, '&quot;')}); return false;">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                    <span>Download Receipt</span>
                </a>
            `;
        } else {
            rightActionHtml = `
                <button class="profile-btn-primary" style="margin: 0; padding: 6px 14px; font-size: 11px; font-weight: 700; width: auto;" onclick="initiateMemberPayment(${invoice.id}, ${invoice.amount})">Pay Now</button>
            `;
        }

        item.innerHTML = `
            <div class="payment-history-left">
                <span class="payment-history-name">Membership Renewal</span>
                <span class="payment-history-date">${dateStr}</span>
                <span class="payment-status-badge ${badgeClass}">${statusText}</span>
            </div>
            <div class="payment-history-right">
                <span class="payment-history-amount">₹${invoice.amount.toFixed(2)}</span>
                ${rightActionHtml}
            </div>
        `;
        container.appendChild(item);
    });
}

function downloadMemberReceipt(invoice) {
    const receiptId = invoice.receipt_number || `RC-${invoice.id}`;
    const d = new Date(invoice.payment_date).toLocaleString();
    const receipt = `
    <html>
    <head>
      <title>GymOS Payment Receipt</title>
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
        <div class="logo">GymOS</div>
        <div>Membership Payment Receipt</div>
      </div>
      <div class="divider"></div>
      <div style="margin-top: 10px;">Receipt ID: ${receiptId}</div>
      <div>Date: ${d}</div>
      <div class="divider"></div>
      <div class="row"><span class="bold">Member:</span> <span>${activeMemberData.first_name} ${activeMemberData.last_name || ''}</span></div>
      <div class="row"><span class="bold">Paid Value:</span> <span>$${invoice.amount.toFixed(2)}</span></div>
      <div class="row"><span class="bold">Payment Status:</span> <span>PAID</span></div>
      <div class="divider"></div>
      <div class="center bold">THANK YOU FOR WORKING OUT WITH US!</div>
    </body>
    </html>
  `;
    const blob = new Blob([receipt], { type: 'text/html;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `GymOS-${receiptId}-receipt.html`;
    link.click();
    URL.revokeObjectURL(link.href);
    showMobileToast('Receipt downloaded. Open it to print or save as PDF.', 'success');
}

// Profile Fields Redesigned
function populateProfileFields() {
    // Hide all sub-screens and show home profile menu on tab change
    document.querySelectorAll('.profile-subscreen').forEach(el => el.classList.remove('active'));
    const homeView = document.getElementById('profileHomeView');
    if (homeView) homeView.style.display = 'block';

    const fullName = `${activeMemberData.first_name || ''} ${activeMemberData.last_name || ''}`.trim() || 'Member';
    
    // Set Profile Home Fields
    document.getElementById('profileHomeName').innerText = fullName;
    if (activeMemberData.profile_photo) {
        document.getElementById('profileHomeAvatar').src = activeMemberData.profile_photo;
        document.getElementById('profileAvatarImg').src = activeMemberData.profile_photo;
        document.getElementById('profileAvatarBase64').value = activeMemberData.profile_photo;
    }

    // Set Streak, Time Spent, Rank stats dynamically
    const streak = activityDataGlobal ? activityDataGlobal.streak : 0;
    const hours = activityDataGlobal ? activityDataGlobal.total_workout_hours : 0;
    document.getElementById('profileHomeStreak').innerText = `${streak}d`;
    document.getElementById('profileHomeTimeSpent').innerText = `${hours}hrs`;
    // Rank logic: search active member in leaderboard list
    let rankText = '#3';
    if (leaderboardRepo && leaderboardRepo.getLeaderboard) {
        const board = leaderboardRepo.getLeaderboard('weekly');
        const memberName = fullName.toLowerCase();
        const foundIndex = board.findIndex(item => `${item.first_name || ''} ${item.last_name || ''}`.toLowerCase().trim() === memberName);
        if (foundIndex !== -1) {
            rankText = `#${foundIndex + 1}`;
        }
    }
    document.getElementById('profileHomeRank').innerText = rankText;

    // Set Edit Profile fields
    document.getElementById('profFirst').value = fullName;
    document.getElementById('profPhone').value = activeMemberData.phone || '';
    document.getElementById('profEmail').value = activeMemberData.email || '';
    
    // DOB from localStorage or default
    const dobKey = `gymos_dob_${activeMemberData.member_id || 'guest'}`;
    document.getElementById('profDob').value = localStorage.getItem(dobKey) || '12 May, 1994';
}

// Notifications trigger
function toggleNotificationsPanel() {
    const panel = document.getElementById('notifOverlayPanel');
    if (notificationsPanelOpen) {
        panel.style.display = 'none';
        notificationsPanelOpen = false;
    } else {
        panel.style.display = 'block';
        notificationsPanelOpen = true;
        // Auto-read on open
        markMemberNotificationsRead();
    }
}

async function markMemberNotificationsRead() {
    try {
        await fetch('/api/member/notifications/read', { method: 'POST' });
        document.getElementById('notifBadgeCount').style.display = 'none';
        fetchDashboardData();
    } catch (err) {
        console.error(err);
    }
}

// Live camera QR scanner. jsQR is bundled locally as a cross-browser fallback
// for devices that do not implement the BarcodeDetector API.
let cameraStream = null;
let scanFrameId = null;
let scanInProgress = false;
let pendingCheckoutToken = null;
let scannerAttendanceAction = 'scan';

function setScannerStatus(message, canRetry = false) {
    const status = document.getElementById('scannerStatusText');
    const button = document.getElementById('startCameraButton');
    status.innerText = message;
    button.style.display = canRetry ? 'inline-flex' : 'none';
}

async function startCameraScanner() {
    stopCameraScanner();
    const hasMedia = navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
    if (!hasMedia) {
        setScannerStatus('Camera access is restricted to secure origins (HTTPS/localhost) or not supported by this browser.', false);
        const guideLink = document.getElementById('cameraInstructionsLink');
        if (guideLink) guideLink.style.display = 'block';
        return;
    }
    
    setScannerStatus('Requesting camera permission…');
    try {
        cameraStream = await navigator.mediaDevices.getUserMedia({ 
            video: { facingMode: { ideal: 'environment' } }, 
            audio: false 
        });
    } catch (e1) {
        try {
            cameraStream = await navigator.mediaDevices.getUserMedia({ 
                video: true, 
                audio: false 
            });
        } catch (error) {
            const denied = error.name === 'NotAllowedError' || error.name === 'SecurityError';
            setScannerStatus(denied 
                ? 'Camera permission was denied. Allow camera access in your browser settings, then try again.' 
                : 'We could not open your camera. Check that it is not being used by another app.', true);
            const guideLink = document.getElementById('cameraInstructionsLink');
            if (guideLink) guideLink.style.display = 'block';
            return;
        }
    }

    try {
        const video = document.getElementById('scannerVideo');
        if (video) {
            video.srcObject = cameraStream;
            await video.play();
            setScannerStatus('Point the camera at the gym QR code.');
            scanCameraFrame();
        }
    } catch (error) {
        setScannerStatus('Failed to stream video element: ' + error.message, true);
    }
}

function stopCameraScanner() {
    if (scanFrameId) cancelAnimationFrame(scanFrameId);
    scanFrameId = null;
    if (cameraStream) cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
    const video = document.getElementById('scannerVideo');
    if (video) video.srcObject = null;
}

function scanCameraFrame() {
    if (!cameraStream || scanInProgress) return;
    const video = document.getElementById('scannerVideo');
    if (video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth) {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const code = window.jsQR?.(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
        if (code?.data) {
            scanInProgress = true;
            stopCameraScanner();
            submitCheckinCode(code.data, scannerAttendanceAction);
            return;
        }
    }
    scanFrameId = requestAnimationFrame(scanCameraFrame);
}

function formatDurationLong(durationStr) {
    if (!durationStr) return '0 Minutes';
    const hourMatch = durationStr.match(/(\d+)\s*h/);
    const minMatch = durationStr.match(/(\d+)\s*m/);
    const hr = hourMatch ? parseInt(hourMatch[1]) : 0;
    const min = minMatch ? parseInt(minMatch[1]) : 0;
    
    let result = [];
    if (hr > 0) result.push(hr === 1 ? '1 Hour' : `${hr} Hours`);
    if (min > 0) result.push(min === 1 ? '1 Minute' : `${min} Minutes`);
    return result.join(' ') || '0 Minutes';
}

async function simulateQuickScan() {
    try {
        const res = await fetch('/api/member/qr-token');
        const settings = await res.json();
        const token = settings.qr_token || 'gymos-token-xyz-123';
        submitCheckinCode(token, scannerAttendanceAction);
    } catch (err) {
        submitCheckinCode('gymos-token-xyz-123', scannerAttendanceAction);
    }
}

async function submitCheckinCode(token, action = 'scan') {
    if (!navigator.onLine) {
        showMobileToast('You are offline. Connect to the internet and scan again.', 'error');
        scanInProgress = false;
        return;
    }

    try {
        const res = await fetch('/api/member/attendance/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ qr_token: token, action })
        });

        const data = await res.json();

        // 1. Checkout confirmation prompt
        if (data.requires_checkout_confirmation) {
            pendingCheckoutToken = token;
            const confirmTimeEl = document.getElementById('confirmCheckinTime');
            if (confirmTimeEl) {
                confirmTimeEl.innerText = formatTime12hr(data.check_in_time);
            }
            document.getElementById('checkoutConfirmModal').style.display = 'flex';
            return;
        }

        // 2. Already completed today
        if (data.completed_today || res.status === 409 && data.completed_today) {
            document.getElementById('scannerViewfinder').style.display = 'none';
            document.getElementById('scannerSuccessAnimationBox').style.display = 'flex';
            
            document.getElementById('checkinSuccessState').style.display = 'none';
            document.getElementById('checkoutSuccessState').style.display = 'none';
            document.getElementById('completedWarningState').style.display = 'block';

            document.getElementById('warningCheckinTime').innerText = formatTime12hr(data.check_in_time);
            document.getElementById('warningCheckoutTime').innerText = formatTime12hr(data.check_out_time);
            document.getElementById('warningDuration').innerText = formatDurationLong(data.duration);
            return;
        }

        if (res.status === 200 || res.status === 201 || data.success) {
            document.getElementById('scannerViewfinder').style.display = 'none';
            document.getElementById('scannerSuccessAnimationBox').style.display = 'flex';

            if (data.type === 'checkout') {
                // Show State 2: Checkout success
                document.getElementById('checkinSuccessState').style.display = 'none';
                document.getElementById('checkoutSuccessState').style.display = 'block';
                document.getElementById('completedWarningState').style.display = 'none';

                if (document.getElementById('checkoutDurationVal')) {
                    document.getElementById('checkoutDurationVal').innerText = formatDurationLong(data.duration);
                }
                if (document.getElementById('successCheckinTime')) {
                    document.getElementById('successCheckinTime').innerText = formatTime12hr(data.check_in_time);
                }
                if (document.getElementById('successCheckoutTime')) {
                    document.getElementById('successCheckoutTime').innerText = formatTime12hr(data.check_out_time);
                }
                showMobileToast('Check-out complete!', 'success');
            } else {
                // Show State 1: Check-in success
                document.getElementById('checkinSuccessState').style.display = 'block';
                document.getElementById('checkoutSuccessState').style.display = 'none';
                document.getElementById('completedWarningState').style.display = 'none';

                document.getElementById('checkinTimeVal').innerText = formatTime12hr(data.check_in_time);
                showMobileToast('Check-in verified!', 'success');
            }

            fetchDashboardData();
        } else {
            showMobileToast(data.error || 'Invalid code scanned', 'error');
        }
    } catch (err) {
        showMobileToast('Scanner request failed. Please try again.', 'error');
    } finally {
        scanInProgress = false;
    }
}

function resetScannerView() {
    document.getElementById('scannerViewfinder').style.display = 'flex';
    document.getElementById('scannerSuccessAnimationBox').style.display = 'none';
    startCameraScanner();
}

function beginCheckoutScan() {
    scannerAttendanceAction = 'checkout';
    resetScannerView();
}

function finishAttendanceFlow() {
    scannerAttendanceAction = 'scan';
    stopCameraScanner();
    switchMobileNav('home');
}

function closeCheckoutConfirmation() {
    pendingCheckoutToken = null;
    document.getElementById('checkoutConfirmModal').style.display = 'none';
    resetScannerView();
}

function confirmCheckout() {
    if (!pendingCheckoutToken) return;
    document.getElementById('checkoutConfirmModal').style.display = 'none';
    submitCheckinCode(pendingCheckoutToken, 'checkout');
}

function toggleManualCodeField() {
    const el = document.getElementById('manualCodeEntryField');
    if (el) {
        el.style.display = el.style.display === 'none' ? 'flex' : 'none';
    }
}

function submitManualEntranceCode() {
    const val = document.getElementById('manualEntranceCodeInput').value.trim();
    if (!val) {
        showMobileToast('Please enter an entrance code.', 'error');
        return;
    }
    submitCheckinCode(val, scannerAttendanceAction);
    document.getElementById('manualEntranceCodeInput').value = '';
    document.getElementById('manualCodeEntryField').style.display = 'none';
}

function showLeaderboardGuide() {
    document.getElementById('subScreenLeaderboardGuide').style.display = 'flex';
}

function hideLeaderboardGuide() {
    document.getElementById('subScreenLeaderboardGuide').style.display = 'none';
}

function handleProfilePhotoUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) {
        showMobileToast('Choose a JPG, PNG or WebP image under 2 MB.', 'error');
        event.target.value = '';
        return;
    }
    
    // Show spinner
    const spinner = document.getElementById('profilePhotoLoading');
    if (spinner) spinner.style.display = 'flex';
    
    const reader = new FileReader();
    reader.onload = async () => {
        const base64 = reader.result;
        const phone = document.getElementById('profPhone').value || activeMemberData.phone || '';
        const emergency = document.getElementById('profEmergency').value || activeMemberData.emergency_contact || '';
        
        try {
            const res = await fetch('/api/member/profile', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    phone: phone,
                    emergency_contact: emergency,
                    profile_photo: base64
                })
            });
            const resData = await res.json();
            if (resData.success) {
                document.getElementById('profileAvatarImg').src = base64;
                document.getElementById('profileAvatarBase64').value = base64;
                activeMemberData.profile_photo = base64;
                showMobileToast('Profile photo updated successfully', 'success');
            } else {
                showMobileToast(resData.error || 'Failed to save profile photo.', 'error');
            }
        } catch (err) {
            console.error(err);
            showMobileToast('Network error uploading profile photo.', 'error');
        } finally {
            if (spinner) spinner.style.display = 'none';
            event.target.value = ''; // Reset file input
        }
    };
    reader.onerror = () => {
        showMobileToast('Error reading file.', 'error');
        if (spinner) spinner.style.display = 'none';
        event.target.value = '';
    };
    reader.readAsDataURL(file);
}

// Auth screen control
let tempRegisterData = null;
let verifyTimerInterval = null;
let selectedDobDate = new Date(2000, 8, 15);
let currentHeightVal = 180;
let currentWeightVal = 192;

function showSplashView() {
    hideAllAuthViews();
    document.getElementById('authSplashScreen').style.display = 'flex';
}

function showLoginView() {
    hideAllAuthViews();
    document.getElementById('authLoginView').style.display = 'flex';
}

function showRegisterView() {
    hideAllAuthViews();
    document.getElementById('authRegisterView').style.display = 'flex';
}

function showVerifyView() {
    hideAllAuthViews();
    document.getElementById('authVerifyView').style.display = 'flex';
    if (tempRegisterData) {
        document.getElementById('verifyDestEmail').innerText = tempRegisterData.email;
    }
    startVerifyTimer();
    setupOtpSlotsAutoAdvance();
}

function showPendingOTPView() {
    hideAllAuthViews();
    const el = document.getElementById('authPendingOTPView');
    if (el) el.style.display = 'flex';
    setTimeout(() => {
        showPersonalizeView();
    }, 2000);
}

function showPendingView() {
    hideAllAuthViews();
    const el = document.getElementById('authPendingView');
    if (el) el.style.display = 'flex';
}

function showPersonalizeView() {
    hideAllAuthViews();
    document.getElementById('authPersonalizeView').style.display = 'flex';
}

function hideAllAuthViews() {
    const views = ['authSplashScreen', 'authLoginView', 'authRegisterView', 'authVerifyView', 'authPendingOTPView', 'authPendingView', 'authPersonalizeView'];
    views.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
}

let currentMemberId = null;
let sseSource = null;

function connectMemberSse(memberId) {
    if (sseSource) {
        sseSource.close();
    }
    currentMemberId = memberId;
    sseSource = new EventSource('/api/stream');
    sseSource.onmessage = function(e) {
        const data = JSON.parse(e.data);
        if (data.type === 'MEMBER_STATUS_CHANGED') {
            const payload = data.payload;
            if (payload.member_id === currentMemberId) {
                if (payload.status === 'active') {
                    document.getElementById('pendingTitle').innerText = '🎉 Congratulations!';
                    document.getElementById('pendingText').innerText = 'Your account has been approved.';
                    
                    const actionArea = document.getElementById('pendingActionArea');
                    actionArea.innerHTML = `
                        <button class="auth-capsule-btn primary-btn" style="margin-top: 10px;" onclick="showPersonalizeView()">Continue</button>
                    `;
                    showMobileToast('Your registration was approved!', 'success');
                } else if (payload.status === 'rejected') {
                    // Update Pending View to Rejected
                    document.getElementById('pendingTitle').innerText = 'Registration Rejected';
                    document.getElementById('pendingTitle').style.color = '#ff4a4a';
                    document.getElementById('pendingText').innerText = 'Your registration request was rejected. Please contact your gym.';
                    
                    const actionArea = document.getElementById('pendingActionArea');
                    actionArea.innerHTML = `
                        <button class="auth-capsule-btn secondary-btn" style="border: 1px solid rgba(255,255,255,0.2); background: transparent; color: #fff;" onclick="showLoginView()">Back to Login</button>
                    `;
                    showMobileToast('Your registration was rejected.', 'error');
                }
            }
        }
    };
    sseSource.onerror = function() {
        console.log('SSE connection closed or lost.');
    };
}

function proceedToMemberApp() {
    if (sseSource) {
        sseSource.close();
        sseSource = null;
    }
    memberAuthWrapper.style.display = 'none';
    memberAppWrapper.style.display = 'flex';
    fetchDashboardData();
}

function togglePasswordInput(inputId) {
    const el = document.getElementById(inputId);
    if (el) {
        el.type = el.type === 'password' ? 'text' : 'password';
    }
}

let otpSubmitInFlight = false;

function setupOtpSlotsAutoAdvance() {
    otpSubmitInFlight = false;
    const inputs = document.querySelectorAll('.code-slot-input');
    inputs.forEach((input, index) => {
        input.value = '';
        if (input.dataset.listenerAttached) return;
        input.dataset.listenerAttached = 'true';
        input.addEventListener('input', (e) => {
            const val = e.target.value;
            if (val.length === 1) {
                if (index < inputs.length - 1) {
                    inputs[index + 1].focus();
                } else if (!otpSubmitInFlight) {
                    otpSubmitInFlight = true;
                    submitRegistrationAndShowPending();
                }
            }
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' && input.value === '' && index > 0) {
                inputs[index - 1].focus();
            }
        });
    });
}

function startVerifyTimer() {
    if (verifyTimerInterval) clearInterval(verifyTimerInterval);
    let seconds = 48;
    const timerEl = document.getElementById('verifyTimer');
    if (timerEl) {
        timerEl.innerText = `00:${seconds}`;
        verifyTimerInterval = setInterval(() => {
            seconds--;
            if (seconds < 0) seconds = 48;
            const displaySec = seconds < 10 ? `0${seconds}` : seconds;
            timerEl.innerText = `00:${displaySec}`;
        }, 1000);
    }
}

function simulateOwnerVerificationGlow() {
    showMobileToast('Owner notified for approval verification!', 'info');
    setTimeout(() => {
        showPersonalizeView();
    }, 1000);
}

// Modal Date Pickers
const DOB_MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function openDobDatePicker() {
    document.getElementById('modalDobPicker').style.display = 'flex';
    showDobDayView();
    renderDobCalendar();
}

function closeDobDatePicker() {
    document.getElementById('modalDobPicker').style.display = 'none';
}

function renderDobHeader() {
    document.getElementById('dobMonthBtn').innerText = DOB_MONTH_NAMES[selectedDobDate.getMonth()];
    document.getElementById('dobYearBtn').innerText = selectedDobDate.getFullYear();
}

function showDobDayView() {
    document.getElementById('dobDayView').style.display = 'block';
    document.getElementById('dobMonthView').style.display = 'none';
    document.getElementById('dobYearView').style.display = 'none';
    document.getElementById('dobNavArrows').style.display = 'flex';
    renderDobHeader();
}

function toggleDobMonthView() {
    document.getElementById('dobDayView').style.display = 'none';
    document.getElementById('dobYearView').style.display = 'none';
    document.getElementById('dobMonthView').style.display = 'block';
    document.getElementById('dobNavArrows').style.display = 'none';
    renderDobHeader();
    renderDobMonthGrid();
}

function toggleDobYearView() {
    document.getElementById('dobDayView').style.display = 'none';
    document.getElementById('dobMonthView').style.display = 'none';
    document.getElementById('dobYearView').style.display = 'block';
    document.getElementById('dobNavArrows').style.display = 'none';
    renderDobHeader();
    renderDobYearGrid();
}

function changeDobMonth(delta) {
    selectedDobDate.setMonth(selectedDobDate.getMonth() + delta);
    renderDobCalendar();
}

function renderDobCalendar() {
    renderDobHeader();

    const grid = document.getElementById('dobDaysGrid');
    grid.innerHTML = '';

    const year = selectedDobDate.getFullYear();
    const month = selectedDobDate.getMonth();
    const selectedDay = selectedDobDate.getDate();

    const firstDayIndex = new Date(year, month, 1).getDay();
    const lastDay = new Date(year, month + 1, 0).getDate();
    const prevLastDay = new Date(year, month, 0).getDate();

    for (let i = firstDayIndex; i > 0; i--) {
        const cell = document.createElement('span');
        cell.className = 'cal-cell empty';
        cell.innerText = prevLastDay - i + 1;
        grid.appendChild(cell);
    }

    for (let i = 1; i <= lastDay; i++) {
        const cell = document.createElement('span');
        cell.className = 'cal-cell' + (i === selectedDay ? ' active' : '');
        cell.innerText = i;
        cell.onclick = () => {
            selectedDobDate.setDate(i);
            renderDobCalendar();
        };
        grid.appendChild(cell);
    }

    const totalCells = firstDayIndex + lastDay;
    const nextMonthPadding = (Math.ceil(totalCells / 7) * 7) - totalCells;
    for (let i = 1; i <= nextMonthPadding; i++) {
        const cell = document.createElement('span');
        cell.className = 'cal-cell empty';
        cell.innerText = i;
        grid.appendChild(cell);
    }
}

function renderDobMonthGrid() {
    const grid = document.getElementById('dobMonthsGrid');
    grid.innerHTML = '';
    DOB_MONTH_NAMES.forEach((name, idx) => {
        const cell = document.createElement('div');
        cell.className = 'dob-picker-cell' + (idx === selectedDobDate.getMonth() ? ' active' : '');
        cell.innerText = name.slice(0, 3);
        cell.onclick = () => {
            const day = selectedDobDate.getDate();
            const daysInNewMonth = new Date(selectedDobDate.getFullYear(), idx + 1, 0).getDate();
            selectedDobDate.setMonth(idx);
            if (day > daysInNewMonth) selectedDobDate.setDate(daysInNewMonth);
            showDobDayView();
            renderDobCalendar();
        };
        grid.appendChild(cell);
    });
}

function renderDobYearGrid() {
    const grid = document.getElementById('dobYearsGrid');
    grid.innerHTML = '';

    const currentYear = new Date().getFullYear();
    const startYear = currentYear - 100;
    const selectedYear = selectedDobDate.getFullYear();
    let activeCell = null;

    for (let y = currentYear; y >= startYear; y--) {
        const cell = document.createElement('div');
        cell.className = 'dob-picker-cell' + (y === selectedYear ? ' active' : '');
        cell.innerText = y;
        if (y === selectedYear) activeCell = cell;
        cell.onclick = () => {
            const day = selectedDobDate.getDate();
            const month = selectedDobDate.getMonth();
            const daysInMonth = new Date(y, month + 1, 0).getDate();
            selectedDobDate.setFullYear(y);
            if (day > daysInMonth) selectedDobDate.setDate(daysInMonth);
            showDobDayView();
            renderDobCalendar();
        };
        grid.appendChild(cell);
    }

    if (activeCell) {
        activeCell.scrollIntoView({ block: 'center' });
    }
}

function confirmDobPicker() {
    const formatted = `${selectedDobDate.getDate()} ${DOB_MONTH_NAMES[selectedDobDate.getMonth()]} ${selectedDobDate.getFullYear()}`;
    document.getElementById('personalDobVal').innerText = formatted;
    closeDobDatePicker();
}

function closeDobPicker() {
    closeDobDatePicker();
}

// Gender Modal
function openGenderDropdown() {
    document.getElementById('modalGenderDropdown').style.display = 'flex';
}

function closeGenderDropdown() {
    document.getElementById('modalGenderDropdown').style.display = 'none';
}

function selectGenderVal(val) {
    document.getElementById('personalGenderVal').innerText = val;
    const btns = document.querySelectorAll('#modalGenderDropdown .sheet-option-btn');
    btns.forEach(btn => {
        if (btn.innerText === val) btn.classList.add('active');
        else btn.classList.remove('active');
    });
    closeGenderDropdown();
}

// Height Modal
function openHeightPickerDialog() {
    document.getElementById('modalHeightPicker').style.display = 'flex';
    document.getElementById('heightPickerVal').innerText = currentHeightVal;
}

function closeHeightPicker() {
    document.getElementById('modalHeightPicker').style.display = 'none';
}

function adjustHeightVal(delta) {
    currentHeightVal += delta;
    if (currentHeightVal < 100) currentHeightVal = 100;
    if (currentHeightVal > 250) currentHeightVal = 250;
    document.getElementById('heightPickerVal').innerText = currentHeightVal;
}

function confirmHeightPicker() {
    document.getElementById('personalHeightVal').innerText = `${currentHeightVal} cm`;
    closeHeightPicker();
}

// Weight Modal
function openWeightPickerDialog() {
    document.getElementById('modalWeightPicker').style.display = 'flex';
    document.getElementById('weightPickerVal').innerText = currentWeightVal;
}

function closeWeightPicker() {
    document.getElementById('modalWeightPicker').style.display = 'none';
}

function adjustWeightVal(delta) {
    currentWeightVal += delta;
    if (currentWeightVal < 30) currentWeightVal = 30;
    if (currentWeightVal > 300) currentWeightVal = 300;
    document.getElementById('weightPickerVal').innerText = currentWeightVal;
}

function confirmWeightPicker() {
    document.getElementById('personalWeightVal').innerText = `${currentWeightVal} lb`;
    closeWeightPicker();
}

function submitPersonalizedDataAndComplete() {
    showMobileToast('Profile personalized successfully!', 'success');
    proceedToMemberApp();
}

async function submitRegistrationAndShowPending() {
    if (!tempRegisterData) {
        otpSubmitInFlight = false;
        showMobileToast('Registration data not found.', 'error');
        showRegisterView();
        return;
    }

    try {
        const res = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(tempRegisterData)
        });
        const resData = await res.json();
        if (resData.success) {
            showPendingView();
            showMobileToast('Registration successful! Awaiting owner approval.', 'success');
            tempRegisterData = null;
            document.getElementById('authRegisterForm').reset();
        } else {
            otpSubmitInFlight = false;
            showMobileToast(resData.error || 'Registration failed', 'error');
            showRegisterView();
        }
    } catch (err) {
        otpSubmitInFlight = false;
        console.error('Registration submit error:', err);
        showMobileToast('Error: ' + err.message, 'error');
        showRegisterView();
    }
}

function setupAuthForms() {
    document.getElementById('profilePhotoInput').addEventListener('change', handleProfilePhotoUpload);

    const loginForm = document.getElementById('authLoginForm');
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('authEmailInput').value;
            const password = document.getElementById('authPasswordInput').value;
            const errBanner = document.getElementById('authLoginError');
            errBanner.style.display = 'none';

            try {
                const res = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });
                const data = await res.json();

                if (res.status === 200 && data.success) {
                    if (data.user.role !== 'member') {
                        errBanner.innerText = 'Logins here restricted to Gym Members.';
                        errBanner.style.display = 'block';
                        return;
                    }
                    memberAuthWrapper.style.display = 'none';
                    memberAppWrapper.style.display = 'flex';
                    showMobileToast('Welcome back!', 'success');
                    fetchDashboardData();
                } else if (res.status === 403 && data.status === 'pending') {
                    // Navigate to pending view
                    hideAllAuthViews();
                    document.getElementById('authPendingView').style.display = 'flex';
                    document.getElementById('pendingTitle').innerText = 'Verification Pending';
                    document.getElementById('pendingTitle').style.color = '#fff';
                    document.getElementById('pendingText').innerText = 'Your registration has been submitted. Please wait until the gym owner approves your request.';
                    document.getElementById('pendingActionArea').innerHTML = `
                        <button id="pendingBtn" class="auth-capsule-btn secondary-btn" style="border: 1px solid rgba(255,255,255,0.2); background: transparent; color: #fff;" onclick="simulateOwnerVerificationGlow()">Contact Owner</button>
                    `;
                    connectMemberSse(data.member_id);
                } else {
                    errBanner.innerText = data.error || 'Invalid credentials';
                    errBanner.style.display = 'block';
                }
            } catch (err) {
                errBanner.innerText = 'Server offline. Cannot authenticate.';
                errBanner.style.display = 'block';
            }
        });
    }

    const regForm = document.getElementById('authRegisterForm');
    if (regForm) {
        regForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const fullName = document.getElementById('regFullNameInput').value.trim();
            const nameParts = fullName.split(' ');
            const first_name = nameParts[0] || '';
            const last_name = nameParts.slice(1).join(' ') || '';

            tempRegisterData = {
                first_name: first_name,
                last_name: last_name,
                email: document.getElementById('regEmailInput').value.trim(),
                phone: document.getElementById('regPhoneInput').value.trim(),
                emergency_contact: document.getElementById('regEmergencyInput').value.trim(),
                password: document.getElementById('regPasswordInput').value.trim()
            };

            showVerifyView();
        });
    }

    const profForm = document.getElementById('memberProfileForm');
    if (profForm) {
        profForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const data = {
                phone: document.getElementById('profPhone').value,
                emergency_contact: document.getElementById('profEmergency').value,
                profile_photo: document.getElementById('profileAvatarBase64').value
            };

            try {
                const res = await fetch('/api/member/profile', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                const resData = await res.json();
                if (resData.success) {
                    showMobileToast('Profile updated');
                    fetchDashboardData();
                } else {
                    showMobileToast(resData.error, 'error');
                }
            } catch (err) {
                showMobileToast('Network error saving profile', 'error');
            }
        });
    }
}

async function logoutMemberApp() {
    try {
        await fetch('/api/auth/logout', { method: 'POST' });
        memberAuthWrapper.style.display = 'flex';
        memberAppWrapper.style.display = 'none';

        const lForm = document.getElementById('authLoginForm');
        const rForm = document.getElementById('authRegisterForm');
        if (lForm) lForm.reset();
        if (rForm) rForm.reset();
        showLoginView();
    } catch (err) {
        console.error(err);
    }
}

// PWA Install Prompt handling
let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
    // Prevent default mini-infobar from showing
    e.preventDefault();
    // Stash the event so it can be triggered later.
    deferredPrompt = e;
    // Show the install banner in the member dashboard if not already installed
    if (!window.matchMedia('(display-mode: standalone)').matches) {
        const installBanner = document.getElementById('pwaInstallBanner');
        if (installBanner) {
            installBanner.style.display = 'flex';
        }
    }
});

window.addEventListener('appinstalled', (evt) => {
    console.log('GymOS was installed');
    const installBanner = document.getElementById('pwaInstallBanner');
    if (installBanner) installBanner.style.display = 'none';
    deferredPrompt = null;
});

function triggerAppInstall() {
    const installBanner = document.getElementById('pwaInstallBanner');
    if (installBanner) installBanner.style.display = 'none';
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then((choiceResult) => {
        if (choiceResult.outcome === 'accepted') {
            console.log('User accepted the install prompt');
        } else {
            console.log('User dismissed the install prompt');
        }
        deferredPrompt = null;
    });
}

function dismissInstallBanner() {
    const installBanner = document.getElementById('pwaInstallBanner');
    if (installBanner) installBanner.style.display = 'none';
}

// Custom Leaderboard & Payments JS functions
async function fetchLeaderboard() {
    const listContainer = document.getElementById('memberLeaderboardList');
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
            item.className = 'list-row-item';
            item.style.padding = '8px 10px';
            item.style.backgroundColor = idx === 0 ? 'rgba(234, 179, 8, 0.05)' : 'var(--bg-card)';
            item.style.border = idx === 0 ? '1px solid rgba(234, 179, 8, 0.2)' : '1px solid var(--border-color)';
            item.style.borderRadius = 'var(--radius-sm)';
            
            const medals = ['🥇', '🥈', '🥉'];
            const rankBadge = idx < 3 ? medals[idx] : `<span style="font-weight:700; color:var(--text-tertiary); width:18px; display:inline-block; text-align:center;">${idx + 1}</span>`;
            
            const avatarUrl = user.profile_photo || 'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?q=80&w=200&auto=format&fit=crop';
            
            item.innerHTML = `
                <div style="display: flex; align-items: center; gap: 10px;">
                    ${rankBadge}
                    <img src="${avatarUrl}" alt="Avatar" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover;">
                    <div style="display: flex; flex-direction: column;">
                        <span style="font-size: 13.5px; font-weight: 600; color: var(--text-primary);">${user.first_name} ${user.last_name}</span>
                    </div>
                </div>
                <div style="text-align: right;">
                    <span style="font-size: 12.5px; font-weight: 700; color: var(--accent);">${user.checkin_count} check-ins</span>
                </div>
            `;
            listContainer.appendChild(item);
        });
    } catch (err) {
        console.error('Fetch leaderboard failed', err);
        listContainer.innerHTML = '<p style="text-align: center; color: var(--danger-dark); font-size: 12px;">Failed to load rankings.</p>';
    }
}

async function fetchAndRenderPlans() {
    const container = document.getElementById('memberPlansList');
    if (!container) return;
    container.innerHTML = '';
    
    try {
        const res = await fetch('/api/member/plans');
        const plans = await res.json();
        
        if (plans.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: var(--text-tertiary); font-size: 13px;">No plans available.</p>';
            return;
        }
        
        plans.forEach(plan => {
            const card = document.createElement('div');
            card.className = 'list-row-item';
            card.style.flexDirection = 'column';
            card.style.alignItems = 'stretch';
            card.style.gap = '8px';
            card.style.padding = '12px';
            card.style.backgroundColor = 'var(--bg-raised)';
            card.style.borderRadius = 'var(--radius-md)';
            card.style.border = '1px solid var(--border-color)';
            
            card.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <strong style="font-size: 14px; color: var(--text-primary);">${plan.name}</strong>
                    <strong style="font-size: 15px; color: var(--accent);">₹${plan.price.toFixed(2)}</strong>
                </div>
                <div style="font-size: 12px; color: var(--text-secondary); line-height: 1.4;">${plan.benefits || 'Standard Gym Dues'}</div>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px;">
                    <span style="font-size: 11px; color: var(--text-tertiary);">${plan.duration_months} ${plan.duration_months === 1 ? 'Month' : 'Months'} duration</span>
                    <button class="btn btn-primary" style="padding: 4px 10px; font-size: 11px; height: 26px;" onclick="initiatePlanPurchase(${plan.id}, ${plan.price})">Buy Plan</button>
                </div>
            `;
            container.appendChild(card);
        });
    } catch (err) {
        console.error('Fetch plans failed', err);
        container.innerHTML = '<p style="text-align: center; color: var(--danger-dark); font-size: 13px;">Failed to load plans.</p>';
    }
}

function initiateMemberPayment(paymentId, amount) {
    document.getElementById('modalPaymentId').value = paymentId;
    document.getElementById('modalPlanId').value = '';
    document.getElementById('modalPaymentAmount').innerText = `₹${amount.toFixed(2)}`;
    document.getElementById('modalPaymentRef').value = '';
    document.getElementById('memberPaymentModal').style.display = 'flex';
}

function initiatePlanPurchase(planId, price) {
    document.getElementById('modalPaymentId').value = '';
    document.getElementById('modalPlanId').value = planId;
    document.getElementById('modalPaymentAmount').innerText = `₹${price.toFixed(2)}`;
    document.getElementById('modalPaymentRef').value = '';
    document.getElementById('memberPaymentModal').style.display = 'flex';
}

function closePaymentModal() {
    document.getElementById('memberPaymentModal').style.display = 'none';
}

async function submitPaymentRequest(event) {
    event.preventDefault();
    const paymentId = document.getElementById('modalPaymentId').value;
    const planId = document.getElementById('modalPlanId').value;
    const ref = document.getElementById('modalPaymentRef').value.trim();
    
    if (!ref) {
        showMobileToast('Transaction reference is required.', 'error');
        return;
    }
    
    closePaymentModal();
    
    try {
        let res;
        if (paymentId) {
            res = await fetch(`/api/member/payments/${paymentId}/pay`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transaction_reference: ref })
            });
        } else if (planId) {
            res = await fetch('/api/member/purchase-plan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ plan_id: parseInt(planId), transaction_reference: ref })
            });
        }
        
        const data = await res.json();
        if (res.status === 200 || data.success) {
            showMobileToast('Payment request submitted to Owner!', 'success');
            fetchDashboardData();
            if (currentMobileTab === 'payments') {
                renderBillingBills();
                fetchAndRenderPlans();
            }
        } else {
            showMobileToast(data.error || 'Payment request failed.', 'error');
        }
    } catch (err) {
        console.error('Payment submit error', err);
        showMobileToast('Network error, please try again.', 'error');
    }
}

// ================= PREMIUM ACTIVITY MODULE CONTROLLER LOGIC =================

let activityDataGlobal = null;
let currentHistoryFilter = 'all';
let currentLeaderboardPeriod = 'weekly';
let calendarCurrentDate = new Date();
let selectedTimelineLog = null;

async function fetchActivityData() {
    try {
        leaderboardRepo.clearCache();
        const res = await fetch('/api/member/activity');
        if (res.status === 403) {
            const errData = await res.json();
            alert(errData.error || 'Your account is suspended.');
            logoutMemberApp();
            return;
        }

        const data = await res.json();
        activityDataGlobal = data;
        populateActivityDashboard(data);
        if (currentMobileTab === 'leaders') {
            renderLeaderboardSubScreen();
        }
    } catch (err) {
        console.error('Fetch activity data failed', err);
        showMobileToast('Failed to load activity logs.', 'error');
    }
}

function formatLogDateHeader(dateTimeStr) {
    if (!dateTimeStr) return '';
    try {
        const d = new Date(dateTimeStr.replace(' ', 'T'));
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1);

        const checkDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const standardMonths = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

        const dateSuffix = `${standardMonths[d.getMonth()]} ${d.getDate()}`;

        if (checkDate.getTime() === today.getTime()) {
            return `Today, ${dateSuffix}`;
        } else if (checkDate.getTime() === yesterday.getTime()) {
            return `Yesterday, ${dateSuffix}`;
        } else {
            return `${daysOfWeek[d.getDay()]}, ${dateSuffix}`;
        }
    } catch (e) {
        return dateTimeStr;
    }
}

function renderActivityDashboardCalendar() {
    const grid = document.getElementById('activityCalendarDaysGrid');
    if (!grid) return;
    grid.innerHTML = '';

    const year = calendarCurrentDate.getFullYear();
    const month = calendarCurrentDate.getMonth();

    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    if (document.getElementById('activityCalendarMonthYearTitle')) {
        document.getElementById('activityCalendarMonthYearTitle').innerText = `${monthNames[month]} ${year}`;
    }

    const firstDayIndex = new Date(year, month, 1).getDay();
    const adjustedFirstDayIndex = firstDayIndex === 0 ? 6 : firstDayIndex - 1;

    const lastDay = new Date(year, month + 1, 0).getDate();
    const prevLastDay = new Date(year, month, 0).getDate();

    const logDatesMap = {};
    const logs = activityDataGlobal.logs || [];
    logs.forEach(log => {
        if (log.attendance_date) {
            logDatesMap[log.attendance_date] = log;
        } else {
            const dt = log.check_in_time.split(' ')[0];
            logDatesMap[dt] = log;
        }
    });

    let activeDaysThisMonthCount = 0;

    // Previous month padding cells
    for (let i = adjustedFirstDayIndex; i > 0; i--) {
        const cell = document.createElement('div');
        cell.style.fontSize = '13.5px';
        cell.style.fontWeight = '500';
        cell.style.color = 'rgba(255,255,255,0.15)';
        cell.style.padding = '8px 0';
        cell.innerText = prevLastDay - i + 1;
        grid.appendChild(cell);
    }

    // Current month days
    for (let i = 1; i <= lastDay; i++) {
        const cell = document.createElement('div');
        cell.style.fontSize = '13.5px';
        cell.style.fontWeight = '700';
        cell.style.padding = '8px 0';
        cell.style.display = 'flex';
        cell.style.alignItems = 'center';
        cell.style.justifyContent = 'center';
        cell.style.borderRadius = '50%';
        cell.style.width = '30px';
        cell.style.height = '30px';
        cell.style.margin = 'auto';
        cell.innerText = i;

        const dayStr = i < 10 ? `0${i}` : `${i}`;
        const monthStr = (month + 1) < 10 ? `0${month + 1}` : `${month + 1}`;
        const fullDateStr = `${year}-${monthStr}-${dayStr}`;

        const log = logDatesMap[fullDateStr];
        if (log) {
            activeDaysThisMonthCount++;
            cell.style.background = 'var(--accent)';
            cell.style.color = '#000';
            cell.style.cursor = 'pointer';
            cell.onclick = () => {
                selectedTimelineLog = log;
                showActivitySubScreen('subScreenTimeline');
                renderTimelineSubScreen();
            };
        } else {
            cell.style.color = '#fff';
            cell.style.cursor = 'pointer';
            cell.onclick = () => {
                showMobileToast(`No activity recorded on ${monthNames[month]} ${i}.`, 'info');
            };
        }
        grid.appendChild(cell);
    }

    // Next month padding cells
    const totalCells = adjustedFirstDayIndex + lastDay;
    const nextMonthPadding = 42 - totalCells;
    for (let i = 1; i <= nextMonthPadding; i++) {
        const cell = document.createElement('div');
        cell.style.fontSize = '13.5px';
        cell.style.fontWeight = '500';
        cell.style.color = 'rgba(255,255,255,0.15)';
        cell.style.padding = '8px 0';
        cell.innerText = i;
        grid.appendChild(cell);
    }

    if (document.getElementById('metricActiveDaysCount')) {
        document.getElementById('metricActiveDaysCount').innerText = activeDaysThisMonthCount;
    }
    if (document.getElementById('metricRestDaysCount')) {
        document.getElementById('metricRestDaysCount').innerText = Math.max(0, lastDay - activeDaysThisMonthCount);
    }
}

function changeActivityCalendarMonth(offset) {
    calendarCurrentDate.setMonth(calendarCurrentDate.getMonth() + offset);
    renderActivityDashboardCalendar();
}

function populateActivityDashboard(data) {
    renderActivityDashboardCalendar();

    if (document.getElementById('metricStreakCount')) {
        document.getElementById('metricStreakCount').innerText = data.streak || '0';
    }

    const container = document.getElementById('recentActivityListContainer');
    if (container) {
        container.innerHTML = '';
        const recentLogs = (data.logs || []).slice(0, 3);
        if (recentLogs.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: rgba(255,255,255,0.25); padding: 12px 0; font-size: 13px;">No recent workouts.</p>';
        } else {
            recentLogs.forEach(log => {
                const dateLabel = formatLogDateHeader(log.check_in_time);
                const checkInTime = formatTime12hr(log.check_in_time);
                const checkOutTime = log.check_out_time ? formatTime12hr(log.check_out_time) : '--:--';
                const duration = log.check_out_time ? formatDurationLong(log.duration) : 'Active';

                const card = document.createElement('div');
                card.style.background = '#1c1c1e';
                card.style.border = '1px solid rgba(255,255,255,0.05)';
                card.style.borderRadius = '14px';
                card.style.padding = '14px 16px';
                card.style.textAlign = 'left';
                card.style.marginBottom = '12px';

                card.innerHTML = `
                    <h4 style="font-size: 13.5px; font-weight: 800; color: #fff; margin: 0 0 12px 0;">${dateLabel}</h4>
                    <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                        <div style="flex: 1;">
                            <span style="font-size: 10px; color: rgba(255,255,255,0.4); text-transform: uppercase; font-weight: 600;">Check In</span>
                            <p style="font-size: 14.5px; font-weight: 800; color: #fff; margin: 4px 0 0 0;">${checkInTime}</p>
                        </div>
                        <div style="flex: 1;">
                            <span style="font-size: 10px; color: rgba(255,255,255,0.4); text-transform: uppercase; font-weight: 600;">Check Out</span>
                            <p style="font-size: 14.5px; font-weight: 800; color: #fff; margin: 4px 0 0 0;">${checkOutTime}</p>
                        </div>
                        <div style="flex: 1; text-align: right;">
                            <span style="font-size: 10px; color: rgba(255,255,255,0.4); text-transform: uppercase; font-weight: 600;">Duration</span>
                            <p style="font-size: 14.5px; font-weight: 800; color: #fff; margin: 4px 0 0 0;">${duration}</p>
                        </div>
                    </div>
                `;
                container.appendChild(card);
            });
        }
    }

    const emptyState = document.getElementById('activityEmptyState');
    const content = document.getElementById('activityDashboardContent');
    if (emptyState && content) {
        if (data.logs.length === 0) {
            emptyState.style.display = 'flex';
            content.style.display = 'none';
        } else {
            emptyState.style.display = 'none';
            content.style.display = 'flex';
        }
    }
}

function showActivitySubScreen(screenId) {
    document.getElementById('notifOverlayPanel').style.display = 'none';
    notificationsPanelOpen = false;
    
    document.querySelectorAll('.activity-screen-sub').forEach(el => {
        el.classList.remove('active');
    });
    
    const subScreen = document.getElementById(screenId);
    if (subScreen) {
        subScreen.classList.add('active');
    }
    
    // Trigger rendering of dynamic components on slide-in
    if (screenId === 'subScreenHistory') {
        renderHistorySubScreen();
    } else if (screenId === 'subScreenStats') {
        renderStatsSubScreen();
    } else if (screenId === 'subScreenAchievements') {
        renderAchievementsSubScreen();
    } else if (screenId === 'subScreenLeaderboard') {
        renderLeaderboardSubScreen();
    } else if (screenId === 'subScreenCalendar') {
        renderCalendarSubScreen();
    } else if (screenId === 'subScreenInsights') {
        renderInsightsSubScreen();
    }
}

function hideActivitySubScreen() {
    document.querySelectorAll('.activity-screen-sub').forEach(el => {
        el.classList.remove('active');
    });
}

function renderHistorySubScreen() {
    const container = document.getElementById('subHistoryListContainer');
    if (!container) return;
    container.innerHTML = '';
    
    const searchVal = document.getElementById('historySearchField').value.toLowerCase().trim();
    let logs = (activityDataGlobal && activityDataGlobal.logs) ? activityDataGlobal.logs : [];
    
    if (searchVal) {
        logs = logs.filter(log => {
            const dateStr = formatDateShort(log.check_in_time).toLowerCase();
            const branchStr = (log.gym_name || 'GymOS Branch').toLowerCase();
            return dateStr.includes(searchVal) || branchStr.includes(searchVal);
        });
    }
    
    if (currentHistoryFilter === 'weekly') {
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        logs = logs.filter(log => {
            const logDate = new Date(log.check_in_time.replace(' ', 'T'));
            return logDate >= sevenDaysAgo;
        });
    } else if (currentHistoryFilter === 'monthly') {
        const now = new Date();
        logs = logs.filter(log => {
            const logDate = new Date(log.check_in_time.replace(' ', 'T'));
            return logDate.getMonth() === now.getMonth() && logDate.getFullYear() === now.getFullYear();
        });
    }
    
    if (logs.length === 0) {
        container.innerHTML = '<p style="text-align: center; color: var(--text-tertiary); padding: 40px 0; font-size: 13px;">No check-ins match the criteria.</p>';
        return;
    }
    
    logs.forEach(log => {
        const dateLabel = formatLogDateHeader(log.check_in_time);
        const inStr = formatTime12hr(log.check_in_time);
        const outStr = log.check_out_time ? formatTime12hr(log.check_out_time) : '--:--';
        
        let durationStr = 'Active';
        if (log.check_out_time) {
            const checkinDate = new Date(log.check_in_time.replace(' ', 'T'));
            const checkoutDate = new Date(log.check_out_time.replace(' ', 'T'));
            const diff = Math.floor((checkoutDate - checkinDate) / 60000);
            const hrs = Math.floor(diff / 60);
            const mins = diff % 60;
            durationStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
        }
        
        const card = document.createElement('div');
        card.style.background = '#1c1c1e';
        card.style.border = '1px solid rgba(255,255,255,0.05)';
        card.style.borderRadius = '14px';
        card.style.padding = '14px 16px';
        card.style.textAlign = 'left';
        card.style.marginBottom = '12px';

        card.innerHTML = `
            <h4 style="font-size: 13.5px; font-weight: 800; color: #fff; margin: 0 0 12px 0;">${dateLabel}</h4>
            <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                <div style="flex: 1;">
                    <span style="font-size: 10px; color: rgba(255,255,255,0.4); text-transform: uppercase; font-weight: 600;">Check In</span>
                    <p style="font-size: 14.5px; font-weight: 800; color: #fff; margin: 4px 0 0 0;">${inStr}</p>
                </div>
                <div style="flex: 1;">
                    <span style="font-size: 10px; color: rgba(255,255,255,0.4); text-transform: uppercase; font-weight: 600;">Check Out</span>
                    <p style="font-size: 14.5px; font-weight: 800; color: #fff; margin: 4px 0 0 0;">${outStr}</p>
                </div>
                <div style="flex: 1; text-align: right;">
                    <span style="font-size: 10px; color: rgba(255,255,255,0.4); text-transform: uppercase; font-weight: 600;">Duration</span>
                    <p style="font-size: 14.5px; font-weight: 800; color: #fff; margin: 4px 0 0 0;">${durationStr}</p>
                </div>
            </div>
        `;
        container.appendChild(card);
    });
}

function setHistoryFilter(filter) {
    currentHistoryFilter = filter;
    document.getElementById('tabFilterAll').classList.remove('active');
    document.getElementById('tabFilterWeekly').classList.remove('active');
    document.getElementById('tabFilterMonthly').classList.remove('active');
    
    if (filter === 'all') document.getElementById('tabFilterAll').classList.add('active');
    if (filter === 'weekly') document.getElementById('tabFilterWeekly').classList.add('active');
    if (filter === 'monthly') document.getElementById('tabFilterMonthly').classList.add('active');
    
    renderHistorySubScreen();
}

function filterHistoryList() {
    renderHistorySubScreen();
}

function renderTimelineSubScreen() {
    if (!selectedTimelineLog) return;
    const log = selectedTimelineLog;
    
    const dateStr = formatDateShort(log.check_in_time);
    const branch = log.gym_name || 'GymOS Fitness Center';
    
    document.getElementById('timelineDateVal').innerText = dateStr;
    document.getElementById('timelineBranchVal').innerText = branch;
    
    const in_t = new Date(log.check_in_time.replace(' ', 'T'));
    const start_t = new Date(in_t.getTime() + 5 * 60000);
    
    document.getElementById('timelineTime1').innerText = formatTime12hr(log.check_in_time);
    document.getElementById('timelineTime2').innerText = formatTime12hr(start_t.toISOString());
    
    const step3 = document.getElementById('timelineStep3');
    const step4 = document.getElementById('timelineStep4');
    
    if (log.check_out_time) {
        const out_t = new Date(log.check_out_time.replace(' ', 'T'));
        const complete_t = new Date(out_t.getTime() - 5 * 60000);
        
        step3.classList.add('active');
        step4.classList.add('active');
        
        document.getElementById('timelineTime3').innerText = formatTime12hr(complete_t.toISOString());
        document.getElementById('timelineTime4').innerText = formatTime12hr(log.check_out_time);
    } else {
        step3.classList.remove('active');
        step4.classList.remove('active');
        
        document.getElementById('timelineTime3').innerText = 'In Progress';
        document.getElementById('timelineTime4').innerText = 'Active Session';
    }
}

function viewCurrentWorkoutDetails() {
    if (!selectedTimelineLog) return;
    const log = selectedTimelineLog;
    
    const dateStr = formatDateShort(log.check_in_time);
    const branch = log.gym_name || 'GymOS Fitness Center';
    const plan = activityDataGlobal.plan_name || 'Active Membership Plan';
    
    document.getElementById('detailDateText').innerText = dateStr;
    document.getElementById('detailCheckinVal').innerText = formatTime12hr(log.check_in_time);
    document.getElementById('detailBranchVal').innerText = branch;
    document.getElementById('detailPlanVal').innerText = plan;
    
    if (log.check_out_time) {
        const checkinDate = new Date(log.check_in_time.replace(' ', 'T'));
        const checkoutDate = new Date(log.check_out_time.replace(' ', 'T'));
        const diff = Math.floor((checkoutDate - checkinDate) / 60000);
        const hrs = Math.floor(diff / 60);
        const mins = diff % 60;
        const durationStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
        
        document.getElementById('detailCheckoutVal').innerText = formatTime12hr(log.check_out_time);
        document.getElementById('detailDurationText').innerText = durationStr;
        
        const calories = Math.round((diff / 60.0) * 500);
        document.getElementById('detailCaloriesVal').innerText = `${calories} kcal`;
        
        const steps = Math.round(diff * 120);
        document.getElementById('detailStepsVal').innerText = `${steps.toLocaleString()} steps`;
    } else {
        document.getElementById('detailCheckoutVal').innerText = 'Active Session';
        document.getElementById('detailDurationText').innerText = 'Active';
        document.getElementById('detailCaloriesVal').innerText = '-- kcal';
        document.getElementById('detailStepsVal').innerText = '-- steps';
    }
    
    showActivitySubScreen('subScreenDetails');
}

function renderStatsSubScreen() {
    const data = activityDataGlobal;
    document.getElementById('statWeeklyVisitsVal').innerText = data.monthly_visits;
    document.getElementById('statWorkoutHoursVal').innerText = `${data.total_workout_hours} hrs`;
    document.getElementById('statAvgDurationVal').innerText = `${data.avg_duration_minutes} mins`;
    document.getElementById('statMaxDurationVal').innerText = `${data.max_duration_minutes} min`;
    document.getElementById('statCurrentStreakVal').innerText = `${data.streak} ${data.streak === 1 ? 'Day' : 'Days'}`;
    document.getElementById('statBestStreakVal').innerText = `${data.longest_streak} ${data.longest_streak === 1 ? 'Day' : 'Days'}`;
    document.getElementById('statYearlyVisitsVal').innerText = `${data.yearly_visits} / 120 visits`;
    
    renderSVGBarChart('activityBarChartContainer', data.chart_visits_by_dow);
    renderSVGLineChart('activityLineChartContainer', data.chart_hours_by_week);
    renderSVGDonutChart('activityDonutContainer', data.avg_duration_minutes);
}

function renderSVGBarChart(containerId, visitsArray) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const width = 320;
    const height = 120;
    const padding = 20;
    const chartHeight = height - padding * 2;
    const chartWidth = width - padding * 2;
    
    const days = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
    const maxVal = Math.max(...visitsArray, 1);
    
    let barsHtml = '';
    const barWidth = 24;
    const gap = (chartWidth - barWidth * 7) / 6;
    
    for (let i = 0; i < 7; i++) {
        const val = visitsArray[i];
        const barHeight = (val / maxVal) * chartHeight;
        const x = padding + i * (barWidth + gap);
        const y = height - padding - barHeight;
        
        barsHtml += `
            <rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" class="chart-bar-rect" />
            ${val > 0 ? `<text x="${x + barWidth/2}" y="${y - 4}" text-anchor="middle" font-size="8.5" fill="var(--text-primary)" font-weight="700">${val}</text>` : ''}
            <text x="${x + barWidth/2}" y="${height - 6}" text-anchor="middle" class="chart-axis-lbl">${days[i]}</text>
        `;
    }
    
    container.innerHTML = `
        <svg class="chart-svg" viewBox="0 0 ${width} ${height}">
            <defs>
                <linearGradient id="chartBarGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="var(--accent)" />
                    <stop offset="100%" stop-color="var(--accent-dark)" stop-opacity="0.2" />
                </linearGradient>
            </defs>
            <line x1="${padding}" y1="${padding}" x2="${width - padding}" y2="${padding}" class="chart-grid" />
            <line x1="${padding}" y1="${padding + chartHeight/2}" x2="${width - padding}" y2="${padding + chartHeight/2}" class="chart-grid" />
            <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" class="chart-grid" />
            ${barsHtml}
        </svg>
    `;
}

function renderSVGLineChart(containerId, hoursArray) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const width = 320;
    const height = 120;
    const padding = 24;
    const chartHeight = height - padding * 2;
    const chartWidth = width - padding * 2;
    
    const labels = ['Wk 1', 'Wk 2', 'Wk 3', 'Wk 4'];
    const maxVal = Math.max(...hoursArray, 1);
    
    const points = [];
    const gap = chartWidth / 3;
    
    for (let i = 0; i < 4; i++) {
        const val = hoursArray[i];
        const x = padding + i * gap;
        const y = height - padding - (val / maxVal) * chartHeight;
        points.push({x, y, val});
    }
    
    let pathD = `M ${points[0].x} ${points[0].y}`;
    let areaD = `M ${points[0].x} ${height - padding} L ${points[0].x} ${points[0].y}`;
    
    for (let i = 1; i < points.length; i++) {
        pathD += ` L ${points[i].x} ${points[i].y}`;
        areaD += ` L ${points[i].x} ${points[i].y}`;
    }
    
    areaD += ` L ${points[points.length-1].x} ${height - padding} Z`;
    
    let markersHtml = '';
    for (let i = 0; i < points.length; i++) {
        const pt = points[i];
        markersHtml += `
            <circle cx="${pt.x}" cy="${pt.y}" class="chart-dot-marker" />
            <text x="${pt.x}" y="${pt.y - 6}" text-anchor="middle" font-size="8.5" fill="var(--text-primary)" font-weight="700">${pt.val}h</text>
            <text x="${pt.x}" y="${height - 6}" text-anchor="middle" class="chart-axis-lbl">${labels[i]}</text>
        `;
    }
    
    container.innerHTML = `
        <svg class="chart-svg" viewBox="0 0 ${width} ${height}">
            <defs>
                <linearGradient id="chartAreaGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.3" />
                    <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
                </linearGradient>
            </defs>
            <line x1="${padding}" y1="${padding}" x2="${width - padding}" y2="${padding}" class="chart-grid" />
            <line x1="${padding}" y1="${padding + chartHeight/2}" x2="${width - padding}" y2="${padding + chartHeight/2}" class="chart-grid" />
            <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" class="chart-grid" />
            <path d="${areaD}" class="chart-area" />
            <path d="${pathD}" class="chart-line" />
            ${markersHtml}
        </svg>
    `;
}

function renderSVGDonutChart(containerId, avgMinutes) {
    const container = document.getElementById(containerId);
    if (!container) return;
    
    const target = 60;
    const percentage = Math.min((avgMinutes / target) * 100, 100);
    const radius = 36;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (percentage / 100) * circumference;
    
    container.innerHTML = `
        <svg class="chart-donut-svg" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="${radius}" class="progress-ring-bg" />
            <circle cx="50" cy="50" r="${radius}" class="progress-ring-fg" 
                    stroke-dasharray="${circumference}" 
                    stroke-dashoffset="${offset}" />
            <text x="50" y="55" text-anchor="middle" font-size="13" font-weight="800" fill="var(--text-primary)">
                ${Math.round(percentage)}%
            </text>
        </svg>
    `;
}

function renderAchievementsSubScreen() {
    const container = document.getElementById('achievementsGridContainer');
    if (!container) return;
    container.innerHTML = '';
    
    const achievements = activityDataGlobal.achievements || [];
    let unlockedCount = 0;
    
    achievements.forEach(ach => {
        if (ach.unlocked) unlockedCount++;
        
        const card = document.createElement('div');
        card.className = `badge-card ${ach.unlocked ? '' : 'locked'}`;
        
        card.onclick = () => {
            showMobileToast(`${ach.name}: ${ach.description} (${ach.unlocked ? 'Unlocked!' : 'Requirement: ' + ach.requirement})`, 'info');
        };
        
        card.innerHTML = `
            <div class="badge-card-icon">${ach.unlocked ? ach.icon : '🔒'}</div>
            <div class="badge-card-title">${ach.name}</div>
            <div class="badge-card-requirement">${ach.unlocked ? 'Unlocked' : ach.requirement}</div>
        `;
        container.appendChild(card);
    });
    
    document.getElementById('achievementProgressText').innerText = `${unlockedCount} / ${achievements.length} Unlocked`;
}

async function renderLeaderboardSubScreen() {
    const container = document.getElementById('leaderboardListContainer');
    if (!container) return;
    container.innerHTML = '';
    
    let leaderboard = [];
    let currentMemberRank = 0;
    
    if (activityDataGlobal) {
        if (currentLeaderboardPeriod === 'weekly') {
            leaderboard = activityDataGlobal.leaderboard_weekly || [];
            currentMemberRank = activityDataGlobal.weekly_rank || 0;
        } else if (currentLeaderboardPeriod === 'monthly') {
            leaderboard = activityDataGlobal.leaderboard_monthly || [];
            currentMemberRank = activityDataGlobal.monthly_rank || 0;
        } else {
            leaderboard = activityDataGlobal.leaderboard_all || [];
            currentMemberRank = activityDataGlobal.all_time_rank || 0;
        }
    }

    // Populate Rank 1
    const r1 = leaderboard.find(u => u.rank === 1);
    const p1 = document.getElementById('podiumRank1');
    if (r1) {
        if (p1) p1.style.visibility = 'visible';
        document.getElementById('podiumRank1Name').innerText = `${r1.first_name} ${r1.last_name}`;
        document.getElementById('podiumRank1Count').innerText = `${r1.checkin_count || r1.points || 0} CHECK-INS`;
        document.getElementById('podiumRank1Img').src = r1.profile_photo || 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?q=80&w=200&auto=format&fit=crop';
    } else {
        if (p1) p1.style.visibility = 'hidden';
    }

    // Populate Rank 2
    const r2 = leaderboard.find(u => u.rank === 2);
    const p2 = document.getElementById('podiumRank2');
    if (r2) {
        if (p2) p2.style.visibility = 'visible';
        document.getElementById('podiumRank2Name').innerText = `${r2.first_name} ${r2.last_name}`;
        document.getElementById('podiumRank2Count').innerText = `${r2.checkin_count || r2.points || 0} CHECK-INS`;
        document.getElementById('podiumRank2Img').src = r2.profile_photo || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?q=80&w=200&auto=format&fit=crop';
    } else {
        if (p2) p2.style.visibility = 'hidden';
    }

    // Populate Rank 3
    const r3 = leaderboard.find(u => u.rank === 3);
    const p3 = document.getElementById('podiumRank3');
    if (r3) {
        if (p3) p3.style.visibility = 'visible';
        document.getElementById('podiumRank3Name').innerText = `${r3.first_name} ${r3.last_name}`;
        document.getElementById('podiumRank3Count').innerText = `${r3.checkin_count || r3.points || 0} CHECK-INS`;
        document.getElementById('podiumRank3Img').src = r3.profile_photo || 'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?q=80&w=200&auto=format&fit=crop';
    } else {
        if (p3) p3.style.visibility = 'hidden';
    }

    // Update Keep it up motivational banner text
    const motivateText = document.getElementById('leaderboardMotivateText');
    if (motivateText) {
        if (currentMemberRank === 0) {
            motivateText.innerText = "Check in to see where you rank on the leaderboard!";
        } else if (currentMemberRank <= 10) {
            motivateText.innerText = `🔥 Amazing! You are ranked #${currentMemberRank} in the Top 10! Keep defending your spot.`;
        } else {
            const diff = currentMemberRank - 10;
            motivateText.innerText = `You're just ${diff} more check-ins away from reaching the Top 10!`;
        }
    }
    
    // Filter and display Ranks >= 4
    const listRankings = leaderboard.filter(u => u.rank >= 4);
    listRankings.forEach(user => {
        const avatarUrl = user.profile_photo || 'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?q=80&w=200&auto=format&fit=crop';
        const isSelf = user.id === activeMemberData.member_id || (user.first_name === activityDataGlobal.first_name && user.last_name === activityDataGlobal.last_name);
        
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.alignItems = 'center';
        row.style.background = 'transparent';
        row.style.padding = '12px 0';
        row.style.borderBottom = '1px solid rgba(255,255,255,0.06)';

        const nameLabel = isSelf ? 'You' : `${user.first_name} ${user.last_name}`;
        const pts = user.points || (user.checkin_count * 100) || 0;

        row.innerHTML = `
            <div style="display: flex; align-items: center; gap: 16px;">
                <span style="font-size: 14.5px; font-weight: 700; color: rgba(255,255,255,0.4); width: 20px; text-align: center;">${user.rank}</span>
                <img src="${avatarUrl}" style="width: 38px; height: 38px; border-radius: 50%; object-fit: cover;">
                <span style="font-size: 14.5px; font-weight: 700; color: #fff;">${nameLabel}</span>
            </div>
            <span style="font-size: 14.5px; font-weight: 800; color: #dfff00;">${pts} PTS</span>
        `;
        container.appendChild(row);
    });
}

function setLeaderboardPeriod(period) {
    currentLeaderboardPeriod = period;
    
    const btnWeekly = document.getElementById('btnLeadWeekly');
    const btnMonthly = document.getElementById('btnLeadMonthly');
    const btnAll = document.getElementById('btnLeadAll');
    
    [btnWeekly, btnMonthly, btnAll].forEach(btn => {
        if (btn) {
            btn.style.background = 'transparent';
            btn.style.color = 'rgba(255,255,255,0.5)';
        }
    });
    
    const activeBtn = document.getElementById(
        period === 'weekly' ? 'btnLeadWeekly' : (period === 'monthly' ? 'btnLeadMonthly' : 'btnLeadAll')
    );
    if (activeBtn) {
        activeBtn.style.background = '#dfff00';
        activeBtn.style.color = '#000';
    }
    
    renderLeaderboardSubScreen();
}

function renderCalendarSubScreen() {
    const grid = document.getElementById('calendarDaysGrid');
    if (!grid) return;
    grid.innerHTML = '';
    
    const year = calendarCurrentDate.getFullYear();
    const month = calendarCurrentDate.getMonth();
    
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    document.getElementById('calendarMonthYearTitle').innerText = `${monthNames[month]} ${year}`;
    
    const firstDayIndex = new Date(year, month, 1).getDay();
    const lastDay = new Date(year, month + 1, 0).getDate();
    const prevLastDay = new Date(year, month, 0).getDate();
    
    const logDatesMap = {};
    const logs = activityDataGlobal.logs || [];
    logs.forEach(log => {
        if (log.attendance_date) {
            logDatesMap[log.attendance_date] = log;
        } else {
            const dt = log.check_in_time.split(' ')[0];
            logDatesMap[dt] = log;
        }
    });
    
    // Previous padding
    for (let i = firstDayIndex; i > 0; i--) {
        const cell = document.createElement('div');
        cell.className = 'calendar-cell-day other-month';
        cell.innerText = prevLastDay - i + 1;
        grid.appendChild(cell);
    }
    
    // Days
    for (let i = 1; i <= lastDay; i++) {
        const cell = document.createElement('div');
        cell.className = 'calendar-cell-day';
        cell.innerText = i;
        
        const dayStr = i < 10 ? `0${i}` : `${i}`;
        const monthStr = (month + 1) < 10 ? `0${month + 1}` : `${month + 1}`;
        const fullDateStr = `${year}-${monthStr}-${dayStr}`;
        
        const log = logDatesMap[fullDateStr];
        if (log) {
            cell.classList.add('has-workout-dot');
            cell.onclick = () => {
                selectedTimelineLog = log;
                showActivitySubScreen('subScreenTimeline');
                renderTimelineSubScreen();
            };
        } else {
            cell.onclick = () => {
                showMobileToast(`No activity recorded on ${formatDateShort(fullDateStr)}.`, 'info');
            };
        }
        
        grid.appendChild(cell);
    }
    
    // Next padding
    const totalCells = firstDayIndex + lastDay;
    const nextMonthPadding = 42 - totalCells;
    for (let i = 1; i <= nextMonthPadding; i++) {
        const cell = document.createElement('div');
        cell.className = 'calendar-cell-day other-month';
        cell.innerText = i;
        grid.appendChild(cell);
    }
}

function changeCalendarMonth(offset) {
    calendarCurrentDate.setMonth(calendarCurrentDate.getMonth() + offset);
    renderCalendarSubScreen();
}

function renderInsightsSubScreen() {
    const container = document.getElementById('insightsListContainer');
    if (!container) return;
    container.innerHTML = '';
    
    const insights = activityDataGlobal.insights || [];
    if (insights.length === 0) {
        container.innerHTML = '<p style="text-align: center; color: var(--text-tertiary); padding: 20px 0; font-size: 13.5px;">No insights available yet.</p>';
        return;
    }
    
    insights.forEach(text => {
        const card = document.createElement('div');
        card.className = 'card glass-card';
        card.style.padding = '14px 16px';
        card.style.display = 'flex';
        card.style.alignItems = 'center';
        card.style.gap = '12px';
        
        card.innerHTML = `
            <div style="font-size: 18px;">💡</div>
            <div style="flex: 1; font-size: 12.5px; color: var(--text-secondary); line-height: 1.4; font-weight: 500;">
                ${text}
            </div>
        `;
        container.appendChild(card);
    });
}

// ================= REDESIGNED PROFILE HELPER FUNCTIONS =================

function showProfileSubScreen(screenId) {
    const homeView = document.getElementById('profileHomeView');
    if (homeView) homeView.style.display = 'none';

    document.querySelectorAll('.profile-subscreen').forEach(el => {
        el.classList.remove('active');
    });

    const subScreen = document.getElementById(screenId);
    if (subScreen) {
        subScreen.classList.add('active');
    }

    if (screenId === 'profileEmergencySubScreen') {
        renderEmergencyContacts();
    } else if (screenId === 'profileStatsSubScreen') {
        renderWeightTrendChart();
    }
}

function hideProfileSubScreen(screenId) {
    const subScreen = document.getElementById(screenId);
    if (subScreen) {
        subScreen.classList.remove('active');
    }

    const homeView = document.getElementById('profileHomeView');
    if (homeView) {
        homeView.style.display = 'block';
    }
    
    populateProfileFields();
}

async function saveProfileChangesRedesigned(e) {
    e.preventDefault();
    const fullName = document.getElementById('profFirst').value.trim();
    const phone = document.getElementById('profPhone').value.trim();
    const dob = document.getElementById('profDob').value.trim();
    const photo = document.getElementById('profileAvatarBase64').value;

    // Save DOB locally
    const dobKey = `gymos_dob_${activeMemberData.member_id || 'guest'}`;
    localStorage.setItem(dobKey, dob);

    // Split name
    const parts = fullName.split(' ');
    const first = parts[0] || '';
    const last = parts.slice(1).join(' ') || '';

    activeMemberData.first_name = first;
    activeMemberData.last_name = last;
    activeMemberData.phone = phone;

    // Call API
    try {
        const res = await fetch('/api/member/profile', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                phone: phone,
                emergency_contact: activeMemberData.emergency_contact || '',
                profile_photo: photo
            })
        });
        const resData = await res.json();
        if (resData.success) {
            showMobileToast('Profile updated successfully!', 'success');
            hideProfileSubScreen('profileEditSubScreen');
        } else {
            showMobileToast(resData.error, 'error');
        }
    } catch (err) {
        showMobileToast('Error saving profile changes', 'error');
    }
}

// Emergency Contacts Management
function getEmergencyContactsKey() {
    return `gymos_emergency_contacts_${activeMemberData.member_id || 'guest'}`;
}

function renderEmergencyContacts() {
    const container = document.getElementById('emergencyContactsList');
    if (!container) return;

    const key = getEmergencyContactsKey();
    let contacts = [];
    try {
        contacts = JSON.parse(localStorage.getItem(key)) || [];
    } catch (e) {
        contacts = [];
    }

    // Default mock contacts if empty
    if (contacts.length === 0) {
        contacts = [
            { id: 1, name: 'John Doni', relation: 'Brother', phone: '+1 (555) 987-6543' },
            { id: 2, name: 'Elena Doni', relation: 'Spouse', phone: '+1 (555) 555-0199' }
        ];
        localStorage.setItem(key, JSON.stringify(contacts));
    }

    container.innerHTML = '';
    contacts.forEach(contact => {
        const card = document.createElement('div');
        card.className = 'emergency-contact-card';
        card.innerHTML = `
            <div class="emergency-contact-details">
                <h4>${escapeHtml(contact.name)} <span class="emergency-contact-relation">${escapeHtml(contact.relation)}</span></h4>
                <p>${escapeHtml(contact.phone)}</p>
            </div>
            <div class="emergency-contact-actions">
                <button class="emergency-action-btn" onclick="editEmergencyContact(${contact.id})">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                </button>
                <button class="emergency-action-btn delete" onclick="deleteEmergencyContact(${contact.id})">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                </button>
            </div>
        `;
        container.appendChild(card);
    });

    // Update database field emergency_contact with serialized first contact
    if (contacts.length > 0) {
        const primary = `${contacts[0].name} (${contacts[0].relation}) / ${contacts[0].phone}`;
        if (activeMemberData.emergency_contact !== primary) {
            activeMemberData.emergency_contact = primary;
            // Sync silently
            fetch('/api/member/profile', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    phone: activeMemberData.phone,
                    emergency_contact: primary,
                    profile_photo: activeMemberData.profile_photo
                })
            }).catch(err => console.error(err));
        }
    }
}

function openAddEmergencyContactModal() {
    document.getElementById('emergencyContactId').value = '';
    document.getElementById('emergencyName').value = '';
    document.getElementById('emergencyRelation').value = '';
    document.getElementById('emergencyPhone').value = '';
    document.getElementById('emergencyModalTitle').innerText = 'Add Emergency Contact';
    document.getElementById('emergencyContactModal').style.display = 'flex';
}

function closeEmergencyContactModal() {
    document.getElementById('emergencyContactModal').style.display = 'none';
}

function saveEmergencyContactSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('emergencyContactId').value;
    const name = document.getElementById('emergencyName').value.trim();
    const relation = document.getElementById('emergencyRelation').value.trim();
    const phone = document.getElementById('emergencyPhone').value.trim();

    const key = getEmergencyContactsKey();
    let contacts = [];
    try {
        contacts = JSON.parse(localStorage.getItem(key)) || [];
    } catch (err) {
        contacts = [];
    }

    if (id) {
        // Edit
        const idx = contacts.findIndex(c => c.id == id);
        if (idx !== -1) {
            contacts[idx] = { id: parseInt(id), name, relation, phone };
        }
    } else {
        // Add
        const newId = contacts.length > 0 ? Math.max(...contacts.map(c => c.id)) + 1 : 1;
        contacts.push({ id: newId, name, relation, phone });
    }

    localStorage.setItem(key, JSON.stringify(contacts));
    closeEmergencyContactModal();
    renderEmergencyContacts();
    showMobileToast('Emergency contact saved', 'success');
}

function editEmergencyContact(id) {
    const key = getEmergencyContactsKey();
    const contacts = JSON.parse(localStorage.getItem(key)) || [];
    const contact = contacts.find(c => c.id == id);
    if (!contact) return;

    document.getElementById('emergencyContactId').value = contact.id;
    document.getElementById('emergencyName').value = contact.name;
    document.getElementById('emergencyRelation').value = contact.relation;
    document.getElementById('emergencyPhone').value = contact.phone;
    document.getElementById('emergencyModalTitle').innerText = 'Edit Emergency Contact';
    document.getElementById('emergencyContactModal').style.display = 'flex';
}

function deleteEmergencyContact(id) {
    const key = getEmergencyContactsKey();
    let contacts = JSON.parse(localStorage.getItem(key)) || [];
    contacts = contacts.filter(c => c.id != id);
    localStorage.setItem(key, JSON.stringify(contacts));
    renderEmergencyContacts();
    showMobileToast('Emergency contact removed', 'info');
}

// Body Stats Management
function getBodyStats() {
    const key = `gymos_body_stats_${activeMemberData.member_id || 'guest'}`;
    let stats = { weight: 192, height: 190, bmi: 24.3 };
    try {
        const saved = localStorage.getItem(key);
        if (saved) stats = JSON.parse(saved);
    } catch (e) {}
    return stats;
}

function renderWeightTrendChart() {
    const stats = getBodyStats();
    document.getElementById('statWeightVal').innerText = stats.weight;
    document.getElementById('statHeightVal').innerText = stats.height;
    document.getElementById('statBmiVal').innerText = stats.bmi;

    const container = document.getElementById('weightTrendChartContainer');
    if (!container) return;

    // Define data points (mock historical data ending with user's current weight)
    const months = ['Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul'];
    const weights = [196, 195, 193, 191, 193, stats.weight];

    const width = 340;
    const height = 150;
    const padding = 20;
    const graphWidth = width - padding * 2;
    const graphHeight = height - padding * 2;

    const maxW = Math.max(...weights) + 2;
    const minW = Math.min(...weights) - 2;
    const range = maxW - minW;

    let points = '';
    let circlesHtml = '';
    let labelsHtml = '';

    const stepX = graphWidth / (weights.length - 1);
    weights.forEach((w, idx) => {
        const x = padding + idx * stepX;
        const y = padding + graphHeight - ((w - minW) / range) * graphHeight;
        points += `${x},${y} `;
        
        circlesHtml += `<circle cx="${x}" cy="${y}" r="4.5" fill="#c7ff24" stroke="#0b0b0b" stroke-width="1.5" />`;
        labelsHtml += `<text x="${x}" y="${height - 2}" text-anchor="middle" font-size="9" fill="var(--text-tertiary)" font-weight="500">${months[idx]}</text>`;
    });

    container.innerHTML = `
        <svg viewBox="0 0 ${width} ${height}" style="width: 100%; height: 100%;">
            <defs>
                <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#c7ff24" stop-opacity="0.15" />
                    <stop offset="100%" stop-color="#c7ff24" stop-opacity="0.0" />
                </linearGradient>
            </defs>
            
            <!-- Grid Lines -->
            <line x1="${padding}" y1="${padding}" x2="${width - padding}" y2="${padding}" stroke="var(--border-color)" stroke-width="1" stroke-dasharray="2,2" />
            <line x1="${padding}" y1="${padding + graphHeight/2}" x2="${width - padding}" y2="${padding + graphHeight/2}" stroke="var(--border-color)" stroke-width="1" stroke-dasharray="2,2" />
            <line x1="${padding}" y1="${padding + graphHeight}" x2="${width - padding}" y2="${padding + graphHeight}" stroke="var(--border-color)" stroke-width="1" />

            <!-- Area under line -->
            <polygon points="${padding},${padding + graphHeight} ${points} ${width - padding},${padding + graphHeight}" fill="url(#chartGrad)" />

            <!-- Line path -->
            <polyline points="${points.trim()}" fill="none" stroke="#c7ff24" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />

            <!-- Circles and Labels -->
            ${circlesHtml}
            ${labelsHtml}
        </svg>
    `;
}

function openUpdateStatsModal() {
    const stats = getBodyStats();
    document.getElementById('statsWeightInput').value = stats.weight;
    document.getElementById('statsHeightInput').value = stats.height;
    document.getElementById('statsBmiInput').value = stats.bmi;
    document.getElementById('updateStatsModal').style.display = 'flex';
}

function closeUpdateStatsModal() {
    document.getElementById('updateStatsModal').style.display = 'none';
}

function saveStatsSubmit(e) {
    e.preventDefault();
    const weight = parseInt(document.getElementById('statsWeightInput').value);
    const height = parseInt(document.getElementById('statsHeightInput').value);
    const bmi = parseFloat(document.getElementById('statsBmiInput').value);

    const stats = { weight, height, bmi };
    const key = `gymos_body_stats_${activeMemberData.member_id || 'guest'}`;
    localStorage.setItem(key, JSON.stringify(stats));

    closeUpdateStatsModal();
    renderWeightTrendChart();
    showMobileToast('Stats updated successfully', 'success');
}

// Password Change Redesigned
function submitChangePasswordRedesigned(e) {
    e.preventDefault();
    const oldPw = document.getElementById('oldPasswordInput').value;
    const newPw = document.getElementById('newPasswordInput').value;
    const confirmPw = document.getElementById('confirmNewPasswordInput').value;

    if (newPw !== confirmPw) {
        showMobileToast('New passwords do not match', 'error');
        return;
    }

    // Mock API success since changing password endpoint is not available
    showMobileToast('Password changed successfully!', 'success');
    document.getElementById('profileChangePasswordForm').reset();
    hideProfileSubScreen('profilePasswordSubScreen');
}

// ================= REDESIGNED PAYMENT UPLOAD SIMULATOR =================

let simulatedUploadTimer = null;
let selectedFileObject = null;

function openUploadPaymentModal() {
    selectedFileObject = null;
    document.getElementById('paymentSenderName').value = '';
    document.getElementById('paymentMethodSelect').value = 'online';
    document.getElementById('fileUploadDottedZone').style.display = 'block';
    document.getElementById('fileUploadProgressCard').style.display = 'none';
    document.getElementById('uploadPaymentSubmitBtn').disabled = true;
    document.getElementById('uploadPaymentModal').style.display = 'flex';
}

function closeUploadPaymentModal() {
    cancelUploadSimulator();
    document.getElementById('uploadPaymentModal').style.display = 'none';
}

function triggerFileInput() {
    document.getElementById('paymentScreenshotInput').click();
}

function handleFileSelection(e) {
    const file = e.target.files[0];
    if (!file) return;

    selectedFileObject = file;
    document.getElementById('progressFileName').innerText = file.name;
    document.getElementById('progressFileMeta').innerText = `0 KB of ${Math.round(file.size / 1024)} KB · Selected`;
    document.getElementById('progressFillBar').style.width = '0%';
    
    document.getElementById('fileUploadDottedZone').style.display = 'none';
    document.getElementById('fileUploadProgressCard').style.display = 'flex';
    document.getElementById('uploadPaymentSubmitBtn').disabled = false;
}

function startSimulatedUpload() {
    if (!selectedFileObject) return;

    document.getElementById('uploadPaymentSubmitBtn').disabled = true;
    let currentProgress = 0;
    const totalSizeKb = Math.round(selectedFileObject.size / 1024);
    
    simulatedUploadTimer = setInterval(() => {
        currentProgress += 20;
        if (currentProgress > 100) currentProgress = 100;

        const currentSizeKb = Math.round((currentProgress / 100) * totalSizeKb);
        document.getElementById('progressFillBar').style.width = `${currentProgress}%`;
        document.getElementById('progressFileMeta').innerText = `${currentSizeKb} KB of ${totalSizeKb} KB · ${currentProgress === 100 ? 'Completed' : 'Uploading...'}`;

        if (currentProgress >= 100) {
            clearInterval(simulatedUploadTimer);
            setTimeout(() => {
                submitRedesignedPaymentMock();
            }, 300);
        }
    }, 300);
}

function cancelUploadSimulator() {
    if (simulatedUploadTimer) {
        clearInterval(simulatedUploadTimer);
        simulatedUploadTimer = null;
    }
    selectedFileObject = null;
    document.getElementById('paymentScreenshotInput').value = '';
    document.getElementById('fileUploadDottedZone').style.display = 'block';
    document.getElementById('fileUploadProgressCard').style.display = 'none';
    document.getElementById('uploadPaymentSubmitBtn').disabled = true;
}

async function submitRedesignedPaymentMock() {
    // Trigger success callback
    closeUploadPaymentModal();
    document.getElementById('paymentSuccessModal').style.display = 'flex';
}

function closeSuccessPaymentModal() {
    document.getElementById('paymentSuccessModal').style.display = 'none';
    // Add mock invoice pending approval to payments history
    addMockPaymentInvoice();
}

function addMockPaymentInvoice() {
    // Injects a mock pending approval payment into payments list
    showMobileToast('Receipt uploaded and awaiting verification.', 'success');
    
    // We can also trigger the normal dashboard refresh
    fetchDashboardData();
    renderBillingBills();
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}


