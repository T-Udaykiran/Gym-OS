let activeMemberData = {};
let memberDataReady = false;

// Single source of truth for the logged-in member. This is the ONLY function
// allowed to assign to activeMemberData. It merges additively (patch fields
// win, everything else is preserved) so no caller can accidentally erase
// fields it doesn't know about - unlike a whitelist rebuild, which silently
// drops any key it doesn't enumerate.
function setMemberData(patch) {
    if (!patch || typeof patch !== 'object') return activeMemberData;
    const merged = Object.assign({}, activeMemberData, patch);
    if ('member_id' in patch || 'id' in patch) {
        merged.member_id = patch.member_id || patch.id || activeMemberData.member_id || null;
    }
    if ('dob' in patch) {
        const iso = (typeof MemberDatePicker !== 'undefined' && MemberDatePicker.formatIso)
            ? MemberDatePicker.formatIso(patch.dob)
            : (patch.dob || '');
        merged.dob = iso || patch.dob || '';
    }
    activeMemberData = merged;
    return activeMemberData;
}
let currentMobileTab = 'home';
let previousMobileTab = 'home';
let previousProfileSubScreen = null;
let previousActivitySubScreen = null;
let memberNotifications = [];

const ROOT_MOBILE_TABS = new Set(['home', 'activity', 'leaders', 'profile']);

function setBottomNavigationVisible(visible) {
    const tabbar = document.querySelector('.app-tabbar');
    if (tabbar) tabbar.classList.toggle('is-hidden', !visible);
    const header = document.querySelector('.app-header');
    if (header) header.style.display = visible ? 'flex' : 'none';
}

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
    updatePwaInstallMenuItem();

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
function updateAppHeader(tabName) {
    const mainHeader = document.getElementById('memberAppHeader');
    const isRootTab = ROOT_MOBILE_TABS.has(tabName);
    
    if (mainHeader) {
        mainHeader.style.display = isRootTab ? 'flex' : 'none';
    }

    if (!isRootTab) return;

    const headerLeft = document.getElementById('headerLeftArea');
    const headerRight = document.getElementById('headerRightArea');
    if (!headerLeft || !headerRight) return;

    const firstName = (activeMemberData && activeMemberData.first_name) ? activeMemberData.first_name : 'User';

    const bellDot = document.getElementById('notifBadgeCount');
    const isBadgeVisible = bellDot ? (bellDot.style.display !== 'none') : false;

    const renderNotifBell = () => `
        <div class="notif-bell" style="background-color: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; position: relative; cursor: pointer;" onclick="openNotificationsScreen()" aria-label="Open notifications" role="button" tabindex="0">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="var(--text-primary)" stroke-width="2.5">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
                <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
            </svg>
            <div id="notifBadgeCount" class="notif-badge-dot" style="background-color: #ef4444; width: 8px; height: 8px; border-radius: 50%; position: absolute; top: 0; right: 0; display: ${isBadgeVisible ? 'block' : 'none'};"></div>
        </div>
    `;

    if (tabName === 'home') {
        headerLeft.innerHTML = `<p style="font-size: 15px; font-weight: 600; color: rgba(255,255,255,0.85); margin: 0; display: flex; align-items: center;">Hi, <span id="homeMemberFirstName">${firstName}</span>! 👋</p>`;
        headerRight.innerHTML = renderNotifBell();
    } else if (tabName === 'activity') {
        headerLeft.innerHTML = `<h2 style="font-size: 18px; font-weight: 800; color: #fff; margin: 0;">Activity</h2>`;
        headerRight.innerHTML = renderNotifBell();
    } else if (tabName === 'leaders') {
        headerLeft.innerHTML = `<h2 style="font-size: 18px; font-weight: 800; color: #fff; margin: 0;">Leaderboard</h2>`;
        headerRight.innerHTML = renderNotifBell();
    } else if (tabName === 'profile') {
        headerLeft.innerHTML = `<h2 style="font-size: 18px; font-weight: 800; color: #fff; margin: 0;">Account</h2>`;
        headerRight.innerHTML = renderNotifBell();
    }
}

function switchMobileNav(tabName) {
    if (tabName === 'scan') {
        const hasActivePlan = activeMemberData && !!activeMemberData.membership;
        if (!hasActivePlan) {
            showMobileToast('Please activate a plan before workout.', 'warning');
            openPlanPurchaseDrawer();
            return;
        }
    }

    if (currentMobileTab === 'scan' && tabName !== 'scan') stopCameraScanner();
    
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));

    const btnIdx = { home: 0, activity: 1, leaders: 2, profile: 3 };
    let targetTab = tabName;
    
    // Highlight the activity tab if we are on the attendance history page
    let activeBtnTab = tabName;
    if (tabName === 'attendanceHistory') {
        activeBtnTab = 'activity';
    }
    
    currentMobileTab = targetTab;
    setBottomNavigationVisible(ROOT_MOBILE_TABS.has(targetTab));
    updateAppHeader(targetTab);

    const btns = document.querySelectorAll('.tab-btn');
    if (btns[btnIdx[activeBtnTab]]) {
        btns[btnIdx[activeBtnTab]].classList.add('active');
    }

    document.querySelectorAll('.mobile-screen').forEach(screen => screen.classList.remove('active'));
    const targetScreen = document.getElementById(`${targetTab}Screen`);
    if (targetScreen) targetScreen.classList.add('active');

    // Refresh page fields
    if (targetTab === 'home') {
        fetchDashboardData();
        syncAttendanceState();
    }
    if (targetTab === 'scan') {
        syncAttendanceState();
        resetScannerView();
    }
    if (targetTab === 'activity') {
        syncAttendanceState();
        fetchActivityData();
        hideActivitySubScreen();
    }
    if (targetTab === 'attendanceHistory') {
        renderHistorySubScreen();
        fetchActivityData();
    }
    if (targetTab === 'leaders') {
        fetchActivityData();
        setTimeout(() => {
            renderLeaderboardSubScreen();
        }, 100);
    }
    if (targetTab === 'payments') { renderBillingBills(); fetchAndRenderPlans(); }
    if (targetTab === 'profile') populateProfileFields();

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
                if (memberDetails && !memberDetails.preferences_completed) {
                    memberAuthWrapper.style.display = 'flex';
                    memberAppWrapper.style.display = 'none';
                    showPersonalizeView();
                } else {
                    memberAuthWrapper.style.display = 'none';
                    memberAppWrapper.style.display = 'flex';
                    fetchDashboardData();
                }
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

function setDashboardLoading(loading) {
    const elements = [
        document.getElementById('homeMemberFirstName'),
        document.getElementById('homeStreakDaysText'),
        document.getElementById('homeWeeklyVisitsCount'),
        document.getElementById('homeMonthlyVisitsCount'),
        document.getElementById('homeTimeSpentText')
    ];
    elements.forEach(el => {
        if (!el) return;
        if (loading) {
            el.classList.add('skeleton-loader');
        } else {
            el.classList.remove('skeleton-loader');
        }
    });
}

// Load stats from server
async function fetchDashboardData() {
    setDashboardLoading(true);
    try {
        // These three endpoints are independent of each other - fire them
        // together instead of chaining awaits, so their latencies overlap
        // instead of stacking on top of one another during startup.
        const [res, actRes, meRes] = await Promise.all([
            fetch('/api/member/dashboard'),
            fetch('/api/member/activity').catch(err => { console.error('Fetch workout hours failed', err); return null; }),
            fetch('/api/auth/me')
        ]);

        if (res.status === 403) {
            const errData = await res.json();
            alert(errData.error || 'Your account is suspended.');
            logoutMemberApp();
            return;
        }

        const data = await res.json();
        setMemberData(data);
        syncAttendanceState();

        // Fill home fields
        if (document.getElementById('homeMemberFirstName')) {
            document.getElementById('homeMemberFirstName').innerText = activeMemberData.first_name || 'User';
        }
        if (document.getElementById('homeStreakDaysText')) {
            document.getElementById('homeStreakDaysText').innerText = data.streak || '0';
        }
        if (document.getElementById('homeStreakDaysLabel')) {
            document.getElementById('homeStreakDaysLabel').innerText = data.streak === 1 ? 'Day' : 'Days';
        }

        // Attendance stats
        if (document.getElementById('homeWeeklyVisitsCount')) {
            document.getElementById('homeWeeklyVisitsCount').innerText = data.weekly_count || '0';
        }
        if (document.getElementById('homeMonthlyVisitsCount')) {
            document.getElementById('homeMonthlyVisitsCount').innerText = data.monthly_count || '0';
        }

        // Activity total workout hours (already fetched above, in parallel)
        try {
            if (actRes) {
                const actData = await actRes.json();
                if (document.getElementById('homeTimeSpentText')) {
                    const hrs = actData.total_workout_hours || 0;
                    document.getElementById('homeTimeSpentText').innerText = `${hrs}hrs`;
                }
            }
        } catch (e) {
            console.error('Fetch workout hours failed', e);
        }

        // Render dynamic checkboxes for week checkins
        updateHomeStreakDaysGrid(data.attendance_history || []);

        // Membership ID and expiry (already fetched above, in parallel)
        const meData = await meRes.json();
        if (meData.user) {
            const meObj = Object.assign({ email: meData.user.email }, meData.user.member_details || {});
            setMemberData(meObj);

            // Format & set membership ID
            if (document.getElementById('homeMembershipId')) {
                const rawId = activeMemberData.member_id;
                document.getElementById('homeMembershipId').innerText = formatMembershipId(rawId);
            }
        }

        // Set Expiry & status
        if (document.getElementById('homeExpiryDate')) {
            const expDate = data.membership ? data.membership.end_date : 'No Plan';
            document.getElementById('homeExpiryDate').innerText = formatExpiryDate(expDate);
        }
        let hasActivePlan = !!data.membership;
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
        
        const buyBtn = document.getElementById('homeBuyPlanBtn');
        if (buyBtn) {
            buyBtn.style.display = hasActivePlan ? 'none' : 'block';
        }

        // Notification indicator dot
        const bellDot = document.getElementById('notifBadgeCount');
        const unreadNotifs = (data.notifications || []).filter(n => n.read_status === 0);
        if (bellDot) {
            if (unreadNotifs.length > 0) {
                bellDot.style.display = 'block';
            } else {
                bellDot.style.display = 'none';
            }
        }

        memberNotifications = data.notifications || [];
        renderNotificationsScreen();

        // Fetch Leaderboard
        fetchLeaderboard();

        memberDataReady = true;

        // Reactively populate edit profile form with loaded member state
        populateProfileFields();

    } catch (err) {
        console.error('Fetch dashboard stats failed', err);
    } finally {
        setDashboardLoading(false);
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
        container.innerHTML = '<p style="text-align: center; color: var(--text-tertiary); padding: 40px 0; font-size: 13px;">No payment history available.</p>';
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
        }) : (invoice.due_date || 'Date unavailable');

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
    if (invoice.receipt_file_url) {
        const link = document.createElement('a');
        link.href = invoice.receipt_file_url;
        const extension = invoice.receipt_file_type === 'application/pdf' ? 'pdf' : 'png';
        link.download = `GymOS-Receipt-${invoice.receipt_number || invoice.id}.${extension}`;
        link.click();
        showMobileToast('Receipt document downloaded.', 'success');
        return;
    }
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
      <div class="row"><span class="bold">Paid Value:</span> <span>₹${invoice.amount.toFixed(2)}</span></div>
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

// Master UI Orchestrator for Member Profile State
function syncMemberProfileState() {
    if (!activeMemberData) activeMemberData = {};
    const fullName = `${activeMemberData.first_name || ''} ${activeMemberData.last_name || ''}`.trim() || 'Member';

    // 1. Header & Home Labels
    if (document.getElementById('homeMemberFirstName')) {
        document.getElementById('homeMemberFirstName').innerText = activeMemberData.first_name || 'User';
    }
    if (document.getElementById('profileHomeName')) {
        document.getElementById('profileHomeName').innerText = fullName;
    }

    // 2. Avatar System Sync
    syncAllProfilePhotoElements();

    // 3. Edit Profile Inputs Sync
    if (document.getElementById('profFirst')) {
        document.getElementById('profFirst').value = fullName;
    }
    if (document.getElementById('profPhone')) {
        document.getElementById('profPhone').value = activeMemberData.phone || '';
    }
    if (document.getElementById('profEmail')) {
        document.getElementById('profEmail').value = activeMemberData.email || '';
    }
    const profDobInput = document.getElementById('profDob');
    if (profDobInput) {
        MemberDatePicker.setupDateInput(profDobInput);
        profDobInput.value = MemberDatePicker.formatIso(activeMemberData.dob);
    }
}

// Profile Fields Redesigned
function populateProfileFields() {
    // Hide all sub-screens and show home profile menu on tab change
    document.querySelectorAll('.profile-subscreen').forEach(el => el.classList.remove('active'));
    const homeView = document.getElementById('profileHomeView');
    if (homeView) homeView.style.display = 'block';

    syncMemberProfileState();

    // Set Streak, Time Spent, Rank stats dynamically
    const streak = activityDataGlobal ? (activityDataGlobal.streak || 0) : 0;
    const hoursFormatted = activityDataGlobal ? (activityDataGlobal.total_workout_formatted || (activityDataGlobal.total_workout_hours ? `${activityDataGlobal.total_workout_hours}h` : '0m')) : '0m';
    if (document.getElementById('profileHomeStreak')) {
        document.getElementById('profileHomeStreak').innerText = `${streak}d`;
    }
    if (document.getElementById('profileHomeTimeSpent')) {
        document.getElementById('profileHomeTimeSpent').innerText = hoursFormatted;
    }
    
    // Rank logic: use all_time_rank from backend activityDataGlobal to match Leaderboard screen 100%
    let rankText = '--';
    if (activityDataGlobal) {
        const rnk = activityDataGlobal.all_time_rank || activityDataGlobal.weekly_rank || 0;
        if (rnk > 0) rankText = `#${rnk}`;
    }
    if (document.getElementById('profileHomeRank')) {
        document.getElementById('profileHomeRank').innerText = rankText;
    }
}

// Notifications are a secondary screen, so the bottom tab bar is hidden while open.
function openNotificationsScreen() {
    previousMobileTab = currentMobileTab;
    previousProfileSubScreen = document.querySelector('.profile-subscreen.active')?.id || null;
    previousActivitySubScreen = document.querySelector('.activity-screen-sub.active')?.id || null;
    switchMobileNav('notifications');
    renderNotificationsScreen();
}

function closeNotificationsScreen() {
    switchMobileNav(previousMobileTab || 'home');
    if (previousProfileSubScreen) showProfileSubScreen(previousProfileSubScreen);
    if (previousActivitySubScreen) showActivitySubScreen(previousActivitySubScreen);
    previousProfileSubScreen = null;
    previousActivitySubScreen = null;
}

function renderNotificationsScreen() {
    const list = document.getElementById('notificationsList');
    if (!list) return;

    if (memberNotifications.length === 0) {
        list.innerHTML = `
            <div class="notifications-empty-state">
                <span aria-hidden="true">🔔</span>
                <h3>No notifications yet</h3>
                <p>Updates about your membership and activity will appear here.</p>
            </div>`;
        return;
    }

    list.innerHTML = memberNotifications.map(notification => {
        const timestamp = notification.created_at ? new Date(notification.created_at).toLocaleDateString() : '';
        const unreadClass = Number(notification.read_status) === 0 ? ' is-unread' : '';
        return `<article class="notification-item${unreadClass}">
            <p>${escapeHtml(notification.message || '')}</p>
            <time>${timestamp}</time>
        </article>`;
    }).join('');
}

async function markMemberNotificationsRead() {
    try {
        await fetch('/api/member/notifications/read', { method: 'POST' });
        memberNotifications = memberNotifications.map(notification => ({ ...notification, read_status: 1 }));
        renderNotificationsScreen();
        const badge = document.getElementById('notifBadgeCount');
        if (badge) badge.style.display = 'none';
    } catch (err) {
        console.error(err);
        showMobileToast('Unable to mark notifications as read.', 'error');
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

let activeAttendanceSession = null;
let liveWorkoutTimerInterval = null;

async function syncAttendanceState() {
    try {
        const res = await fetch('/api/member/attendance/active');
        if (res.ok) {
            const data = await res.json();
            activeAttendanceSession = data;
            renderAttendanceStateUI();
        }
    } catch (err) {
        console.error("Failed to sync active attendance state:", err);
    }
}

function renderAttendanceStateUI() {
    const viewfinder = document.getElementById('scannerViewfinder');
    const instructions = document.getElementById('scannerInstructionsBlock');
    const cameraState = document.getElementById('scannerCameraState');
    const successBox = document.getElementById('scannerSuccessAnimationBox');
    
    const checkinState = document.getElementById('checkinSuccessState');
    const checkoutState = document.getElementById('checkoutSuccessState');
    const completedState = document.getElementById('completedWarningState');

    if (!activeAttendanceSession || activeAttendanceSession.state === 'not_checked_in') {
        if (viewfinder) viewfinder.style.display = 'flex';
        if (instructions) instructions.style.display = 'flex';
        if (cameraState) cameraState.style.display = 'flex';
        if (successBox) successBox.style.display = 'none';
        
        if (checkinState) checkinState.style.display = 'none';
        if (checkoutState) checkoutState.style.display = 'none';
        if (completedState) completedState.style.display = 'none';
        
        stopLiveWorkoutTimer();
    } else if (activeAttendanceSession.state === 'checked_in') {
        stopCameraScanner();
        
        if (viewfinder) viewfinder.style.display = 'none';
        if (instructions) instructions.style.display = 'none';
        if (cameraState) cameraState.style.display = 'none';
        if (successBox) successBox.style.display = 'flex';
        
        if (checkinState) checkinState.style.display = 'block';
        if (checkoutState) checkoutState.style.display = 'none';
        if (completedState) completedState.style.display = 'none';
        
        const session = activeAttendanceSession.session;
        if (session && session.check_in_time) {
            const timeValEl = document.getElementById('checkinTimeVal');
            if (timeValEl) timeValEl.innerText = formatTime12hr(session.check_in_time);
            startLiveWorkoutTimer(session.check_in_time);
        }
    } else if (activeAttendanceSession.state === 'completed') {
        stopCameraScanner();
        stopLiveWorkoutTimer();
        
        if (viewfinder) viewfinder.style.display = 'none';
        if (instructions) instructions.style.display = 'none';
        if (cameraState) cameraState.style.display = 'none';
        if (successBox) successBox.style.display = 'flex';
        
        if (checkinState) checkinState.style.display = 'none';
        if (checkoutState) checkoutState.style.display = 'block';
        if (completedState) completedState.style.display = 'none';
        
        const session = activeAttendanceSession.session;
        if (session) {
            if (document.getElementById('checkoutDurationVal')) {
                document.getElementById('checkoutDurationVal').innerText = formatDurationLong(session.duration);
            }
            if (document.getElementById('successCheckinTime')) {
                document.getElementById('successCheckinTime').innerText = formatTime12hr(session.check_in_time);
            }
            if (document.getElementById('successCheckoutTime')) {
                document.getElementById('successCheckoutTime').innerText = formatTime12hr(session.check_out_time);
            }
        }
    }
}

function parseCheckInTimeMs(checkInTimeStr) {
    if (!checkInTimeStr) return Date.now();
    const iso = checkInTimeStr.replace(' ', 'T');
    const dt = new Date(iso);
    if (!isNaN(dt.getTime())) return dt.getTime();
    const fallback = new Date(checkInTimeStr);
    return !isNaN(fallback.getTime()) ? fallback.getTime() : Date.now();
}

function startLiveWorkoutTimer(checkInTimeStr) {
    stopLiveWorkoutTimer();
    const startTime = parseCheckInTimeMs(checkInTimeStr);
    
    function updateTimer() {
        const now = Date.now();
        const diffSec = Math.max(0, Math.floor((now - startTime) / 1000));
        
        const hrs = Math.floor(diffSec / 3600);
        const mins = Math.floor((diffSec % 3600) / 60);
        const secs = diffSec % 60;
        
        const pad = (n) => n.toString().padStart(2, '0');
        const timerEl = document.getElementById('liveWorkoutDurationTimer');
        if (timerEl) {
            timerEl.innerText = `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
        }
    }
    
    updateTimer();
    liveWorkoutTimerInterval = setInterval(updateTimer, 1000);
}

function stopLiveWorkoutTimer() {
    if (liveWorkoutTimerInterval) {
        clearInterval(liveWorkoutTimerInterval);
        liveWorkoutTimerInterval = null;
    }
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
        if (document.getElementById('scannerViewfinder').style.display !== 'none') {
            startCameraScanner();
        }
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
        if (data.completed_today || (res.status === 409 && data.completed_today)) {
            await syncAttendanceState();
            return;
        }

        if (res.status === 200 || res.status === 201 || data.success) {
            showMobileToast(data.type === 'checkout' ? 'Check-out complete!' : 'Check-in verified!', 'success');
            await syncAttendanceState();
            fetchDashboardData();
        } else {
            showMobileToast(data.error || 'Invalid code scanned', 'error');
            if (document.getElementById('scannerViewfinder').style.display !== 'none') {
                startCameraScanner();
            }
        }
    } catch (err) {
        showMobileToast('Scanner request failed. Please try again.', 'error');
        if (document.getElementById('scannerViewfinder').style.display !== 'none') {
            startCameraScanner();
        }
    } finally {
        scanInProgress = false;
    }
}

function resetScannerView() {
    if (activeAttendanceSession && activeAttendanceSession.state !== 'not_checked_in') {
        renderAttendanceStateUI();
        return;
    }
    const viewfinder = document.getElementById('scannerViewfinder');
    const instructions = document.getElementById('scannerInstructionsBlock');
    const cameraState = document.getElementById('scannerCameraState');
    const successBox = document.getElementById('scannerSuccessAnimationBox');

    if (viewfinder) viewfinder.style.display = 'flex';
    if (instructions) instructions.style.display = 'flex';
    if (cameraState) cameraState.style.display = 'flex';
    if (successBox) successBox.style.display = 'none';
    startCameraScanner();
}

function beginCheckoutScan() {
    promptCheckoutFromActiveState();
}

function finishAttendanceFlow() {
    scannerAttendanceAction = 'scan';
    stopCameraScanner();
    switchMobileNav('home');
}

function promptCheckoutFromActiveState() {
    document.getElementById('checkoutConfirmModal').style.display = 'flex';
}

function closeCheckoutConfirmation() {
    pendingCheckoutToken = null;
    document.getElementById('checkoutConfirmModal').style.display = 'none';
}

async function confirmCheckout() {
    document.getElementById('checkoutConfirmModal').style.display = 'none';
    try {
        const res = await fetch('/api/member/check-out', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showMobileToast('Check-out completed!', 'success');
            await syncAttendanceState();
            fetchDashboardData();
        } else {
            showMobileToast(data.error || 'Check-out failed.', 'error');
        }
    } catch (err) {
        showMobileToast('Check-out request failed. Please try again.', 'error');
    }
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

// Thin aliases onto the canonical shared avatar module (static/shared/member-avatar.js),
// kept so the ~15 existing call sites in this file don't need to change.
function getMemberInitials(firstName, lastName) {
    return MemberAvatar.getInitials(firstName, lastName);
}

function generateInitialsAvatarDataUrl(firstName, lastName, size = 100) {
    return MemberAvatar.generateInitialsDataUrl(firstName, lastName, size);
}

function getMemberAvatarSrc(userOrPhoto, firstName = '', lastName = '') {
    return MemberAvatar.resolveSrc(userOrPhoto, firstName, lastName);
}

function syncAllProfilePhotoElements() {
    const photo = activeMemberData.profile_photo || '';
    const fn = activeMemberData.first_name || '';
    const ln = activeMemberData.last_name || '';

    const homeAvatar = document.getElementById('profileHomeAvatar');
    if (homeAvatar && typeof homeAvatar.update === 'function') {
        homeAvatar.update({ src: photo, firstName: fn, lastName: ln });
    }

    const editAvatar = document.getElementById('profileEditAvatar');
    if (editAvatar && typeof editAvatar.update === 'function') {
        editAvatar.update({ src: photo, firstName: fn, lastName: ln });
    }

    const viewPhotoBtn = document.getElementById('viewPhotoOption');
    if (viewPhotoBtn) {
        viewPhotoBtn.style.display = MemberAvatar.hasRealPhoto(photo) ? 'block' : 'none';
    }

    if (typeof fetchLeaderboard === 'function') {
        fetchLeaderboard();
    }
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
        try {
            const res = await fetch('/api/member/profile', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    profile_photo: base64
                })
            });
            const resData = await res.json();
            if (res.ok && resData.success) {
                setMemberData({ profile_photo: base64 });
                syncMemberProfileState();
                showMobileToast('Profile photo updated successfully', 'success');
            } else if (res.status === 401 || res.status === 403) {
                showMobileToast('Authentication expired. Please log in again.', 'error');
            } else {
                showMobileToast(resData.error || 'Upload failed. Please try again.', 'error');
            }
        } catch (err) {
            console.error(err);
            showMobileToast('Network unavailable. Check your connection and try again.', 'error');
        } finally {
            if (spinner) spinner.style.display = 'none';
            event.target.value = '';
        }
    };
    reader.onerror = () => {
        showMobileToast('Unsupported image type. Please choose a different photo.', 'error');
        if (spinner) spinner.style.display = 'none';
        event.target.value = '';
    };
    reader.readAsDataURL(file);
}

async function removeProfilePhoto() {
    closePhotoOptionsSheet();
    const spinner = document.getElementById('profilePhotoLoading');
    if (spinner) spinner.style.display = 'flex';

    try {
        const res = await fetch('/api/member/profile', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                profile_photo: ''
            })
        });
        const resData = await res.json();
        if (res.ok && resData.success) {
            setMemberData({ profile_photo: '' });
            syncMemberProfileState();
            showMobileToast('Profile photo removed.', 'success');
        } else if (res.status === 401 || res.status === 403) {
            showMobileToast('Authentication expired. Please log in again.', 'error');
        } else {
            showMobileToast(resData.error || 'Unable to remove profile photo. Please try again.', 'error');
        }
    } catch (err) {
        console.error(err);
        showMobileToast('Network unavailable. Check your connection and try again.', 'error');
    } finally {
        if (spinner) spinner.style.display = 'none';
    }
}

// Canonical DOB helpers - one date picker (modalDobPicker) is reused by both the
// onboarding "Personalize" step and Edit Profile. Storage format is always ISO
// "YYYY-MM-DD"; "12 May 1994" is display-only.
function formatDobIso(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function formatDobDisplay(date) {
    return `${date.getDate()} ${DOB_MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`;
}

// Accepts canonical ISO ("1994-05-12") or legacy display text ("12 May 1994")
// so DOBs saved before this format was enforced still parse correctly.
function parseStoredDob(value) {
    if (!value) return null;
    const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (isoMatch) {
        const d = new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
        return isNaN(d) ? null : d;
    }
    const parsed = new Date(value);
    return isNaN(parsed) ? null : parsed;
}

function validateDobDate(date) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (date > today) {
        return { valid: false, message: 'Date of birth cannot be in the future.' };
    }
    const ageYears = (today - date) / (365.25 * 24 * 60 * 60 * 1000);
    if (ageYears < 10) {
        return { valid: false, message: 'Member must be at least 10 years old.' };
    }
    if (ageYears > 120) {
        return { valid: false, message: 'Please enter a valid date of birth.' };
    }
    return { valid: true, message: '' };
}

// Auth screen control
let tempRegisterData = null;
let verifyTimerInterval = null;
let selectedDobDate = new Date(2000, 8, 15);
let onboardingDobIso = null;
let currentHeightFt = 5;
let currentHeightIn = 6;
let currentWeightVal = 70;

let isDobSelected = false;
let isSexSelected = false;
let isHeightSelected = false;
let isWeightSelected = false;

function validatePersonalForm() {
    const btn = document.getElementById('onboardingContinueBtn');
    if (!btn) return;
    if (isDobSelected && isSexSelected && isHeightSelected && isWeightSelected) {
        btn.disabled = false;
        btn.style.opacity = '1';
        btn.style.cursor = 'pointer';
    } else {
        btn.disabled = true;
        btn.style.opacity = '0.5';
        btn.style.cursor = 'not-allowed';
    }
}

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

function showForgotPasswordView() {
    hideAllAuthViews();
    document.getElementById('authForgotPasswordForm').reset();
    document.getElementById('authForgotPasswordError').style.display = 'none';
    document.getElementById('authForgotPasswordView').style.display = 'flex';
}

async function submitMemberForgotPassword() {
    const errorBox = document.getElementById('authForgotPasswordError');
    errorBox.style.display = 'none';

    const email = document.getElementById('fpMemberEmail').value.trim();
    const phone = document.getElementById('fpMemberPhone').value.trim();
    const new_password = document.getElementById('fpMemberNewPassword').value;

    try {
        const res = await fetch('/api/auth/reset-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, phone, new_password })
        });
        const data = await res.json();

        if (data.success) {
            showLoginView();
            document.getElementById('authEmailInput').value = email;
            showMobileToast('Password reset. Please sign in with your new password.', 'success');
        } else {
            errorBox.innerText = data.error || 'Password reset failed';
            errorBox.style.display = 'block';
        }
    } catch (err) {
        errorBox.innerText = 'Network error. Please try again.';
        errorBox.style.display = 'block';
    }
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
    const views = ['authSplashScreen', 'authLoginView', 'authRegisterView', 'authForgotPasswordView', 'authVerifyView', 'authPendingOTPView', 'authPendingView', 'authPersonalizeView'];
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
        if (data.type === 'GYM_SETTINGS_UPDATED') {
            if (data.payload && data.payload.gym_logo !== undefined) {
                updateMemberAppGymLogo(data.payload.gym_logo);
            }
        }
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

function updateMemberAppGymLogo(logoUrl) {}

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
    const check = validateDobDate(selectedDobDate);
    if (!check.valid) {
        showMobileToast(check.message, 'error');
        return;
    }

    const iso = formatDobIso(selectedDobDate);
    const display = formatDobDisplay(selectedDobDate);

    document.getElementById('personalDobVal').innerText = display;
    onboardingDobIso = iso;
    isDobSelected = true;
    validatePersonalForm();
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
    isSexSelected = true;
    validatePersonalForm();
    closeGenderDropdown();
}

// Profile Photo View/Update Sheet
function openPhotoOptionsSheet() {
    const photo = activeMemberData.profile_photo || '';
    const viewOption = document.getElementById('viewPhotoOption');
    if (viewOption) {
        viewOption.style.display = MemberAvatar.hasRealPhoto(photo) ? 'block' : 'none';
    }
    document.getElementById('photoOptionsSheet').style.display = 'flex';
}

function closePhotoOptionsSheet() {
    document.getElementById('photoOptionsSheet').style.display = 'none';
}

function viewProfilePhotoFull() {
    closePhotoOptionsSheet();
    const photo = activeMemberData.profile_photo || '';
    if (!MemberAvatar.hasRealPhoto(photo)) {
        showMobileToast('No profile photo to view.', 'info');
        return;
    }
    document.getElementById('photoViewerImg').src = photo;
    document.getElementById('photoViewerModal').style.display = 'flex';
}

function closePhotoViewer() {
    document.getElementById('photoViewerModal').style.display = 'none';
}

function triggerProfilePhotoUpdate() {
    closePhotoOptionsSheet();
    document.getElementById('profilePhotoInput').click();
}

// Height Modal
function openHeightPickerDialog() {
    document.getElementById('modalHeightPicker').style.display = 'flex';
    document.getElementById('heightFtPickerVal').innerText = currentHeightFt;
    document.getElementById('heightInPickerVal').innerText = currentHeightIn;
}

function closeHeightPicker() {
    document.getElementById('modalHeightPicker').style.display = 'none';
}

function adjustHeightFt(delta) {
    currentHeightFt += delta;
    if (currentHeightFt < 3) currentHeightFt = 3;
    if (currentHeightFt > 8) currentHeightFt = 8;
    document.getElementById('heightFtPickerVal').innerText = currentHeightFt;
}

function adjustHeightIn(delta) {
    currentHeightIn += delta;
    if (currentHeightIn < 0) {
        currentHeightIn = 11;
    } else if (currentHeightIn > 11) {
        currentHeightIn = 0;
    }
    document.getElementById('heightInPickerVal').innerText = currentHeightIn;
}

function confirmHeightPicker() {
    document.getElementById('personalHeightVal').innerText = `${currentHeightFt}'${currentHeightIn}"`;
    isHeightSelected = true;
    validatePersonalForm();
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
    document.getElementById('personalWeightVal').innerText = `${currentWeightVal} kg`;
    isWeightSelected = true;
    validatePersonalForm();
    closeWeightPicker();
}

async function submitPersonalizedDataAndComplete() {
    const dob = onboardingDobIso;
    const gender = document.getElementById('personalGenderVal').innerText;
    
    const weightValStr = document.getElementById('personalWeightVal').innerText;
    const heightValStr = document.getElementById('personalHeightVal').innerText;
    
    if (!isDobSelected || !isSexSelected || !isHeightSelected || !isWeightSelected) {
        showMobileToast('Please fill all mandatory fields.', 'error');
        return;
    }
    
    const weight = parseFloat(weightValStr);
    
    // Parse height and convert to cm for internal backward compatibility
    let height = null;
    if (heightValStr.includes("'")) {
        const parts = heightValStr.replace('"', '').split("'");
        const ft = parseInt(parts[0]);
        const inches = parseInt(parts[1]);
        height = (ft * 12 + inches) * 2.54;
    }
    
    try {
        const res = await fetch('/api/member/preferences', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dob, gender, height, weight })
        });
        const resData = await res.json();
        if (resData.success) {
            showMobileToast('Profile personalized successfully!', 'success');
            setMemberData({ preferences_completed: true });
            proceedToMemberApp();
        } else {
            showMobileToast(resData.error || 'Failed to save preferences.', 'error');
        }
    } catch (err) {
        console.error(err);
        showMobileToast('Network error saving preferences.', 'error');
    }
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
                    setMemberData({ member_id: data.user.member_id, preferences_completed: data.user.preferences_completed });
                    
                    if (!data.user.preferences_completed) {
                        showPersonalizeView();
                        showMobileToast('Welcome! Please complete your fitness preferences.', 'info');
                    } else {
                        memberAuthWrapper.style.display = 'none';
                        memberAppWrapper.style.display = 'flex';
                        showMobileToast('Welcome back!', 'success');
                        fetchDashboardData();
                    }
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
                errBanner.innerText = 'Unable to connect to server. Ensure you accept the self-signed certificate if using HTTPS, or check server connection.';
                errBanner.style.display = 'block';
            }
        });
    }

    const regForm = document.getElementById('authRegisterForm');
    if (regForm) {
        regForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const gymId = document.getElementById('regGymIdInput').value;
            if (!gymId) {
                showMobileToast('Please search for and select your gym first.', 'error');
                return;
            }

            const fullName = document.getElementById('regFullNameInput').value.trim();
            const nameParts = fullName.split(' ');
            const first_name = nameParts[0] || '';
            const last_name = nameParts.slice(1).join(' ') || '';

            tempRegisterData = {
                gym_id: parseInt(gymId, 10),
                first_name: first_name,
                last_name: last_name,
                email: document.getElementById('regEmailInput').value.trim(),
                phone: document.getElementById('regPhoneInput').value.trim(),
                emergency_contact_name: document.getElementById('regEmergencyNameInput').value.trim(),
                emergency_contact_number: document.getElementById('regEmergencyNumberInput').value.trim(),
                password: document.getElementById('regPasswordInput').value.trim()
            };

            showVerifyView();
        });
    }

}

// Gym search/select for registration
let gymSearchDebounceTimer = null;

function handleGymSearchInput() {
    document.getElementById('regGymIdInput').value = '';
    const q = document.getElementById('regGymSearchInput').value.trim();
    const dropdown = document.getElementById('regGymResultsDropdown');

    clearTimeout(gymSearchDebounceTimer);
    if (q.length < 2) {
        dropdown.style.display = 'none';
        return;
    }

    gymSearchDebounceTimer = setTimeout(async () => {
        try {
            const res = await fetch(`/api/gyms/search?q=${encodeURIComponent(q)}`);
            const gyms = await res.json();

            if (gyms.length === 0) {
                dropdown.innerHTML = '<div style="padding: 12px 16px; font-size: 13px; color: rgba(255,255,255,0.5);">No gyms found.</div>';
            } else {
                dropdown.innerHTML = gyms.map(g => `
                    <div class="gym-search-result-item" style="padding: 10px 16px; font-size: 13.5px; color: #fff; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,0.08);"
                         onclick="selectGym(${g.id}, '${g.name.replace(/'/g, "\\'")}', '${g.gym_code}')">
                        <div style="font-weight:600;">${g.name}</div>
                        <div style="font-size:11.5px; color: rgba(255,255,255,0.5);">${g.gym_code}</div>
                    </div>
                `).join('');
            }
            dropdown.style.display = 'block';
        } catch (err) {
            dropdown.style.display = 'none';
        }
    }, 300);
}

function selectGym(id, name, code) {
    document.getElementById('regGymIdInput').value = id;
    document.getElementById('regGymSearchInput').value = `${name} (${code})`;
    document.getElementById('regGymResultsDropdown').style.display = 'none';
}

async function logoutMemberApp() {
    try {
        await fetch('/api/auth/logout', { method: 'POST' });
        activeMemberData = {};
        memberDataReady = false;
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

function updatePwaInstallMenuItem() {
    const menuItem = document.getElementById('pwaInstallMenuItem');
    const menuLabel = document.getElementById('pwaInstallMenuLabel');
    const menuArrow = document.getElementById('pwaInstallMenuArrow');
    if (!menuItem || !menuLabel) return;

    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    
    if (isStandalone) {
        menuLabel.innerText = 'GymOS Installed';
        menuLabel.style.color = 'rgba(255,255,255,0.4)';
        menuItem.style.opacity = '0.6';
        menuItem.style.cursor = 'default';
        if (menuArrow) menuArrow.style.display = 'none';
    } else {
        menuLabel.innerText = 'Install GymOS';
        menuLabel.style.color = '';
        menuItem.style.opacity = '';
        menuItem.style.cursor = '';
        if (menuArrow) menuArrow.style.display = 'block';
    }
}

function triggerPwaInstallFromMenu() {
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    if (isStandalone) {
        showMobileToast('GymOS is already installed on this device.', 'info');
        return;
    }

    if (!deferredPrompt) {
        showMobileToast('GymOS is already installed on this device. (Or PWA installation is not supported by this browser.)', 'info');
        return;
    }

    triggerAppInstall();
}

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
    updatePwaInstallMenuItem();
});

window.addEventListener('appinstalled', (evt) => {
    console.log('GymOS was installed');
    const installBanner = document.getElementById('pwaInstallBanner');
    if (installBanner) installBanner.style.display = 'none';
    deferredPrompt = null;
    updatePwaInstallMenuItem();
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
        updatePwaInstallMenuItem();
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
            
            item.innerHTML = `
                <div style="display: flex; align-items: center; gap: 10px;">
                    ${rankBadge}
                    ${MemberAvatar.html(user, { size: 32 })}
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

let selectedReceiptFile = null;

function triggerFileInput() {
    document.getElementById('paymentScreenshotInput').click();
}

function handleFileSelection(e) {
    const file = e.target.files[0];
    if (!file) return;

    // Validate size (1 MB max)
    if (file.size > 1024 * 1024) {
        showMobileToast('File size exceeds the 1 MB limit.', 'error');
        e.target.value = '';
        return;
    }

    // Validate file type (JPG, PNG, PDF)
    const allowedTypes = ['image/jpeg', 'image/png', 'application/pdf'];
    if (!allowedTypes.includes(file.type)) {
        showMobileToast('Only JPG, PNG, and PDF receipt formats are supported.', 'error');
        e.target.value = '';
        return;
    }

    selectedReceiptFile = file;
    document.getElementById('progressFileName').innerText = file.name;
    document.getElementById('fileUploadTitle').innerText = file.name;
    document.getElementById('fileUploadDottedZone').style.display = 'none';
    document.getElementById('fileUploadProgressCard').style.display = 'flex';
}

async function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = error => reject(error);
        reader.readAsDataURL(file);
    });
}

function initiateMemberPayment(paymentId, amount) {
    document.getElementById('modalPaymentId').value = paymentId;
    document.getElementById('modalPlanId').value = '';
    document.getElementById('modalPaymentAmount').innerText = `₹${amount.toFixed(2)}`;
    document.getElementById('modalPaymentRef').value = '';
    
    // Set default date to today
    document.getElementById('modalPaymentDate').value = new Date().toISOString().split('T')[0];
    
    // Reset file state
    selectedReceiptFile = null;
    document.getElementById('paymentScreenshotInput').value = '';
    document.getElementById('fileUploadDottedZone').style.display = 'block';
    document.getElementById('fileUploadTitle').innerText = 'Choose Receipt File...';
    document.getElementById('fileUploadProgressCard').style.display = 'none';
    document.getElementById('progressFillBar').style.width = '0%';
    
    document.getElementById('memberPaymentModal').style.display = 'flex';
}

function initiatePlanPurchase(planId, price) {
    document.getElementById('modalPaymentId').value = '';
    document.getElementById('modalPlanId').value = planId;
    document.getElementById('modalPaymentAmount').innerText = `₹${price.toFixed(2)}`;
    document.getElementById('modalPaymentRef').value = '';
    
    // Set default date to today
    document.getElementById('modalPaymentDate').value = new Date().toISOString().split('T')[0];
    
    // Reset file state
    selectedReceiptFile = null;
    document.getElementById('paymentScreenshotInput').value = '';
    document.getElementById('fileUploadDottedZone').style.display = 'block';
    document.getElementById('fileUploadTitle').innerText = 'Choose Receipt File...';
    document.getElementById('fileUploadProgressCard').style.display = 'none';
    document.getElementById('progressFillBar').style.width = '0%';
    
    document.getElementById('memberPaymentModal').style.display = 'flex';
}

function closePaymentModal() {
    document.getElementById('memberPaymentModal').style.display = 'none';
}

async function submitPaymentRequest(event) {
    event.preventDefault();
    const paymentId = document.getElementById('modalPaymentId').value;
    const planId = document.getElementById('modalPlanId').value;
    const method = document.getElementById('modalPaymentMethod').value;
    const date = document.getElementById('modalPaymentDate').value;
    const ref = document.getElementById('modalPaymentRef').value.trim();
    
    if (!selectedReceiptFile) {
        showMobileToast('Please select and upload payment proof receipt.', 'error');
        return;
    }

    const submitBtn = document.getElementById('uploadPaymentSubmitBtn');
    submitBtn.disabled = true;

    // Simulate upload progress
    const progressCard = document.getElementById('fileUploadProgressCard');
    const fillBar = document.getElementById('progressFillBar');
    progressCard.style.display = 'flex';
    
    let progress = 0;
    const progressInterval = setInterval(() => {
        progress += 10;
        fillBar.style.width = `${progress}%`;
        if (progress >= 100) {
            clearInterval(progressInterval);
            completePaymentSubmission();
        }
    }, 50);

    async function completePaymentSubmission() {
        try {
            const base64Data = await readFileAsBase64(selectedReceiptFile);
            const fileType = selectedReceiptFile.type;

            let res;
            const payload = {
                transaction_reference: ref,
                payment_method: method,
                payment_date: date,
                receipt_file_url: base64Data,
                receipt_file_type: fileType
            };

            if (paymentId) {
                res = await fetch(`/api/member/payments/${paymentId}/pay`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
            } else if (planId) {
                payload.plan_id = parseInt(planId);
                res = await fetch('/api/member/purchase-plan', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
            }

            const data = await res.json();
            if (res.status === 200 || data.success) {
                showMobileToast('Payment request submitted to Owner!', 'success');
                closePaymentModal();
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
        } finally {
            submitBtn.disabled = false;
        }
    }
}

// ================= PREMIUM ACTIVITY MODULE CONTROLLER LOGIC =================

let activityDataGlobal = null;
let currentLeaderboardPeriod = 'weekly';
let calendarCurrentDate = new Date();
let selectedTimelineLog = null;

async function fetchActivityData() {
    // Set loading state if no data exists yet
    if (!activityDataGlobal) {
        renderHistorySubScreen();
    }
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
        if (!res.ok || !data || !Array.isArray(data.logs)) {
            activityDataGlobal = { error: true };
            renderHistorySubScreen();
            showMobileToast((data && data.error) || 'Failed to load activity logs.', 'error');
            return;
        }

        activityDataGlobal = data;
        populateActivityDashboard(data);
        renderHistorySubScreen();
        if (currentMobileTab === 'leaders') {
            renderLeaderboardSubScreen();
        }
    } catch (err) {
        console.error('Fetch activity data failed', err);
        activityDataGlobal = { error: true };
        renderHistorySubScreen();
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
    const logs = (activityDataGlobal && activityDataGlobal.logs) || [];
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
        if (!data.logs || data.logs.length === 0) {
            emptyState.style.display = 'flex';
            content.style.display = 'none';
        } else {
            emptyState.style.display = 'none';
            content.style.display = 'flex';
        }
    }
}

function showActivitySubScreen(screenId) {
    setBottomNavigationVisible(false);
    
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
    setBottomNavigationVisible(true);
}

// Full "Monday, 21 July 2026" date label used only on the Attendance History cards.
function formatAttendanceDateFull(dateTimeStr) {
    const d = new Date(dateTimeStr.replace(' ', 'T'));
    const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return `${daysOfWeek[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

// "1 hr 13 min" duration label used only on the Attendance History cards.
function formatAttendanceDuration(checkInStr, checkOutStr) {
    const start = new Date(checkInStr.replace(' ', 'T'));
    const end = new Date(checkOutStr.replace(' ', 'T'));
    const totalMinutes = Math.max(0, Math.floor((end - start) / 60000));
    const hrs = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    if (hrs > 0 && mins > 0) return `${hrs} hr ${mins} min`;
    if (hrs > 0) return `${hrs} hr`;
    return `${mins} min`;
}

function renderHistorySubScreen() {
    const container = document.getElementById('subHistoryListContainer');
    const loadingState = document.getElementById('subHistoryLoadingState');
    const emptyState = document.getElementById('subHistoryEmptyState');
    const errorState = document.getElementById('subHistoryErrorState');

    if (!container) return;
    container.innerHTML = '';
    if (loadingState) loadingState.style.display = 'none';
    if (emptyState) emptyState.style.display = 'none';
    if (errorState) errorState.style.display = 'none';

    if (!activityDataGlobal) {
        if (loadingState) loadingState.style.display = 'block';
        return;
    }

    if (activityDataGlobal.error) {
        if (errorState) errorState.style.display = 'block';
        return;
    }

    const logs = Array.isArray(activityDataGlobal.logs) ? [...activityDataGlobal.logs] : [];
    logs.sort((a, b) => new Date(b.check_in_time.replace(' ', 'T')) - new Date(a.check_in_time.replace(' ', 'T')));

    if (logs.length === 0) {
        if (emptyState) emptyState.style.display = 'flex';
        return;
    }

    logs.forEach(log => {
        const dateLabel = formatAttendanceDateFull(log.check_in_time);
        const inStr = formatTime12hr(log.check_in_time);
        const outStr = log.check_out_time ? formatTime12hr(log.check_out_time) : '--:--';
        const durationStr = log.check_out_time ? formatAttendanceDuration(log.check_in_time, log.check_out_time) : '--';

        const card = document.createElement('div');
        card.style.background = '#1c1c1e';
        card.style.border = '1px solid rgba(255,255,255,0.05)';
        card.style.borderRadius = '14px';
        card.style.padding = '14px 16px';
        card.style.textAlign = 'left';

        card.innerHTML = `
            <h4 style="font-size: 13.5px; font-weight: 800; color: #fff; margin: 0 0 12px 0;">${dateLabel}</h4>
            <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                <div style="flex: 1;">
                    <span style="font-size: 10px; color: rgba(255,255,255,0.4); text-transform: uppercase; font-weight: 600;">Check In</span>
                    <p style="font-size: 14px; font-weight: 800; color: #fff; margin: 4px 0 0 0;">${inStr}</p>
                </div>
                <div style="flex: 1;">
                    <span style="font-size: 10px; color: rgba(255,255,255,0.4); text-transform: uppercase; font-weight: 600;">Check Out</span>
                    <p style="font-size: 14px; font-weight: 800; color: #fff; margin: 4px 0 0 0;">${outStr}</p>
                </div>
                <div style="flex: 1; text-align: right;">
                    <span style="font-size: 10px; color: rgba(255,255,255,0.4); text-transform: uppercase; font-weight: 600;">Duration</span>
                    <p style="font-size: 14px; font-weight: 800; color: #fff; margin: 4px 0 0 0;">${durationStr}</p>
                </div>
            </div>
        `;
        container.appendChild(card);
    });
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

    // This wrapper starts hidden (display:none) so nothing flashes before
    // data is ready; reveal it now that we're about to populate it.
    const mainContent = document.getElementById('leaderboardMainContent');
    if (mainContent) mainContent.style.display = 'flex';
    
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
    
    const emptyState = document.getElementById('leaderboardEmptyState');
    if (leaderboard.length === 0) {
        if (mainContent) mainContent.style.display = 'none';
        if (emptyState) emptyState.style.display = 'flex';
        return;
    } else {
        if (mainContent) mainContent.style.display = 'flex';
        if (emptyState) emptyState.style.display = 'none';
    }

    // Populate Rank 1
    const r1 = leaderboard.find(u => u.rank === 1);
    const p1 = document.getElementById('podiumRank1');
    if (r1) {
        if (p1) p1.style.visibility = 'visible';
        document.getElementById('podiumRank1Name').innerText = `${r1.first_name} ${r1.last_name}`;
        document.getElementById('podiumRank1Count').innerText = `${r1.checkin_count || r1.points || 0} CHECK-INS`;
        const p1Img = document.getElementById('podiumRank1Img');
        MemberAvatar.applyFallback(p1Img, r1);
        p1Img.src = getMemberAvatarSrc(r1);
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
        const p2Img = document.getElementById('podiumRank2Img');
        MemberAvatar.applyFallback(p2Img, r2);
        p2Img.src = getMemberAvatarSrc(r2);
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
        const p3Img = document.getElementById('podiumRank3Img');
        MemberAvatar.applyFallback(p3Img, r3);
        p3Img.src = getMemberAvatarSrc(r3);
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
                ${MemberAvatar.html(user, { size: 38 })}
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
    const logs = (activityDataGlobal && activityDataGlobal.logs) || [];
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
    setBottomNavigationVisible(false);
    const homeView = document.getElementById('profileHomeView');
    if (homeView) homeView.style.display = 'none';

    document.querySelectorAll('.profile-subscreen').forEach(el => {
        el.classList.remove('active');
    });

    const subScreen = document.getElementById(screenId);
    if (subScreen) {
        subScreen.classList.add('active');
    }

    if (screenId === 'profileEditSubScreen') {
        syncMemberProfileState();
    } else if (screenId === 'profileEmergencySubScreen') {
        renderEmergencyContacts();
    } else if (screenId === 'profileStatsSubScreen') {
        renderStatsSubScreen();
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
    setBottomNavigationVisible(true);
    
    populateProfileFields();
}

async function saveProfileChangesRedesigned(e) {
    if (e && e.preventDefault) e.preventDefault();

    if (!memberDataReady || !activeMemberData.member_id) {
        showMobileToast('Still loading your profile - please try again in a moment.', 'info');
        return;
    }

    const rawName = (document.getElementById('profFirst') && document.getElementById('profFirst').value.trim());
    const fullName = rawName || `${activeMemberData.first_name || ''} ${activeMemberData.last_name || ''}`.trim();
    
    const phoneInput = document.getElementById('profPhone');
    const phone = (phoneInput && phoneInput.value.trim()) || activeMemberData.phone || '';

    const profDobInput = document.getElementById('profDob');
    const dobRaw = (profDobInput && profDobInput.value.trim());
    const dobIso = (dobRaw ? MemberDatePicker.formatIso(dobRaw) : '') || activeMemberData.dob || '';

    const submitButton = document.getElementById('profileSaveButton');

    // DOB Validation
    const dobCheck = MemberDatePicker.validateDob(dobIso, true);
    if (!dobCheck.valid) {
        showMobileToast(dobCheck.message, 'error');
        if (submitButton) {
            submitButton.disabled = false;
            submitButton.textContent = 'Save Changes';
        }
        return;
    }

    // Split name
    const parts = fullName.split(' ');
    const first = parts[0] || activeMemberData.first_name || '';
    const last = parts.slice(1).join(' ') || activeMemberData.last_name || '';

    if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = 'Saving...';
    }

    // Call API
    try {
        const res = await fetch('/api/member/profile', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                phone: phone,
                first_name: first,
                last_name: last,
                dob: dobIso
            })
        });
        const resData = await res.json();
        if (res.ok && resData.success) {
            setMemberData({ first_name: first, last_name: last, phone: phone, dob: dobIso });
            syncMemberProfileState();
            showMobileToast('Profile updated successfully!', 'success');
            hideProfileSubScreen('profileEditSubScreen');
        } else if (res.status === 401 || res.status === 403) {
            showMobileToast('Your session has expired. Please log in again.', 'error');
        } else {
            showMobileToast(resData.error || 'Unable to save changes. Please try again.', 'error');
        }
    } catch (err) {
        showMobileToast('Network unavailable. Check your connection and try again.', 'error');
    } finally {
        if (submitButton) {
            submitButton.disabled = false;
            submitButton.textContent = 'Save Changes';
        }
    }
}

// Emergency Contacts Management
// The backend stores a single primary emergency contact on the member record
// itself (emergency_contact_name/number/relation) - there is no separate
// contacts list, so this reads/writes activeMemberData directly.
function renderEmergencyContacts() {
    const container = document.getElementById('emergencyContactsList');
    if (!container) return;

    const name = activeMemberData.emergency_contact_name;
    const phone = activeMemberData.emergency_contact_number;
    if (!name || !phone) {
        container.innerHTML = '<p class="empty-state-message">No emergency contact added.</p>';
        return;
    }
    container.innerHTML = `<div class="emergency-contact-card"><div class="emergency-contact-details">
        <h4>${escapeHtml(name)} <span class="emergency-contact-relation">${escapeHtml(activeMemberData.emergency_contact_relation || '')}</span></h4>
        <p>${escapeHtml(phone)}</p></div><div class="emergency-contact-actions">
        <button class="emergency-action-btn" onclick="editEmergencyContact()">Edit</button>
        <button class="emergency-action-btn delete" onclick="deleteEmergencyContact()">Delete</button>
    </div></div>`;
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
    const name = document.getElementById('emergencyName').value.trim();
    const relation = document.getElementById('emergencyRelation').value.trim();
    const phone = document.getElementById('emergencyPhone').value.trim();

    saveEmergencyContact({ name, relation, phone });
}

function editEmergencyContact() {
    document.getElementById('emergencyContactId').value = 'primary';
    document.getElementById('emergencyName').value = activeMemberData.emergency_contact_name || '';
    document.getElementById('emergencyRelation').value = activeMemberData.emergency_contact_relation || '';
    document.getElementById('emergencyPhone').value = activeMemberData.emergency_contact_number || '';
    document.getElementById('emergencyModalTitle').innerText = 'Edit Emergency Contact';
    document.getElementById('emergencyContactModal').style.display = 'flex';
}

function deleteEmergencyContact() {
    if (window.confirm('Remove this emergency contact?')) saveEmergencyContact({ name: '', relation: '', phone: '' });
}

async function saveEmergencyContact(contact) {
    if (!memberDataReady || !activeMemberData.member_id) {
        showMobileToast('Still loading your profile - please try again in a moment.', 'info');
        return;
    }

    const legacy = contact.name ? `${contact.name} (${contact.relation}) / ${contact.phone}` : '';
    try {
        // Only the emergency-contact fields are sent - this must never touch
        // name/phone/dob/photo, which belong to the Edit Profile and Photo flows.
        const res = await fetch('/api/member/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            phone: activeMemberData.phone, emergency_contact: legacy, emergency_contact_name: contact.name,
            emergency_contact_number: contact.phone, emergency_contact_relation: contact.relation
        }) });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Unable to save contact');
        setMemberData({ emergency_contact: legacy, emergency_contact_name: contact.name, emergency_contact_number: contact.phone, emergency_contact_relation: contact.relation });
        closeEmergencyContactModal();
        renderEmergencyContacts();
        showMobileToast(contact.name ? 'Emergency contact saved.' : 'Emergency contact removed.', 'success');
    } catch (error) {
        console.error(error);
        showMobileToast('Something went wrong. Please try again.', 'error');
    }
}

// Authoritative API-backed emergency contacts. These declarations replace the
// retired browser-local implementation above and always use the logged-in
// member's server-side session scope.
let emergencyContacts = [];

async function renderEmergencyContacts() {
    const container = document.getElementById('emergencyContactsList');
    if (!container) return;
    container.innerHTML = '<p class="empty-state-message">Loading emergency contacts…</p>';
    try {
        const res = await fetch('/api/member/emergency-contacts');
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Unable to load contacts');
        emergencyContacts = data.contacts || [];
        
        // Hide/disable Add button if 2 contacts exist, show limit message
        const addBtn = document.querySelector('#profileEmergencySubScreen .floating-add-btn');
        let limitMsg = document.getElementById('emergencyLimitMessage');
        if (!limitMsg) {
            limitMsg = document.createElement('p');
            limitMsg.id = 'emergencyLimitMessage';
            limitMsg.style.cssText = 'text-align: center; font-size: 13.5px; color: rgba(255,255,255,0.4); margin-top: 16px; font-weight: 500;';
            container.parentNode.appendChild(limitMsg);
        }

        if (emergencyContacts.length >= 2) {
            if (addBtn) addBtn.style.display = 'none';
            limitMsg.innerText = 'You can add a maximum of 2 emergency contacts.';
            limitMsg.style.display = 'block';
        } else {
            if (addBtn) addBtn.style.display = 'flex';
            limitMsg.style.display = 'none';
        }

        if (!emergencyContacts.length) {
            container.innerHTML = '<div class="notifications-empty-state"><span aria-hidden="true">☎</span><h3>No Emergency Contacts Added</h3><p>Add an emergency contact so the gym can reach someone if needed.</p></div>';
            return;
        }

        container.innerHTML = emergencyContacts.map(contact => {
            const isPrimary = contact.contact_type === 'primary';
            const title = isPrimary ? 'Primary Emergency Contact' : 'Secondary Emergency Contact';
            const relation = contact.relationship ? ` <span class="emergency-contact-relation" style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent); margin-left: 8px;">${escapeHtml(contact.relationship)}</span>` : '';
            return `<div class="emergency-contact-card" style="background: #1c1c1e; border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 16px; padding: 16px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center;">
                <div class="emergency-contact-details" style="text-align: left;">
                    <span style="font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: rgba(255, 255, 255, 0.4); display: block; margin-bottom: 4px;">${title}</span>
                    <h4 style="margin: 0 0 4px 0; font-size: 15px; color: #fff;">${escapeHtml(contact.name)}${relation}</h4>
                    <p style="margin: 0; font-size: 13px; color: rgba(255,255,255,0.6);">${escapeHtml(contact.phone)}</p>
                </div>
                <div class="emergency-contact-actions" style="display: flex; gap: 8px;">
                    <button class="emergency-action-btn" onclick="editEmergencyContact('${contact.id}')" style="background: rgba(255,255,255,0.05); border: none; border-radius: 50%; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; cursor: pointer; color: #fff;">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                    </button>
                    <button class="emergency-action-btn delete" onclick="deleteEmergencyContact('${contact.id}')" style="background: rgba(255,69,58,0.15); border: none; border-radius: 50%; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; cursor: pointer; color: #ff453a;">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                    </button>
                </div>
            </div>`;
        }).join('');
    } catch (error) {
        console.error(error);
        container.innerHTML = '<p class="empty-state-message">Something went wrong. Please try again.</p>';
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

async function saveEmergencyContactSubmit(event) {
    event.preventDefault();
    const contactId = document.getElementById('emergencyContactId').value;
    const payload = { name: document.getElementById('emergencyName').value.trim(), relationship: document.getElementById('emergencyRelation').value.trim(), phone: document.getElementById('emergencyPhone').value.trim() };
    const submitButton = event.currentTarget.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    submitButton.textContent = 'Saving...';
    try {
        const res = await fetch(contactId ? `/api/member/emergency-contacts/${contactId}` : '/api/member/emergency-contacts', { method: contactId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Unable to save contact');
        closeEmergencyContactModal();
        await renderEmergencyContacts();
        showMobileToast('Emergency contact saved.', 'success');
    } catch (error) {
        console.error(error);
        showMobileToast(error.message || 'Something went wrong. Please try again.', 'error');
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = 'Save';
    }
}

function editEmergencyContact(contactId) {
    const contact = emergencyContacts.find(item => String(item.id) === String(contactId));
    if (!contact) return;
    document.getElementById('emergencyContactId').value = contact.id;
    document.getElementById('emergencyName').value = contact.name;
    document.getElementById('emergencyRelation').value = contact.relationship || '';
    document.getElementById('emergencyPhone').value = contact.phone;
    document.getElementById('emergencyModalTitle').innerText = 'Edit Emergency Contact';
    document.getElementById('emergencyContactModal').style.display = 'flex';
}

async function deleteEmergencyContact(contactId) {
    if (contactId === 'primary') {
        const secondary = emergencyContacts.find(c => c.contact_type === 'secondary');
        if (secondary) {
            const promote = window.confirm(`The primary contact cannot be deleted directly. Do you want to promote your secondary contact ("${secondary.name}") to become the new primary contact?`);
            if (promote) {
                try {
                    // 1. Promote secondary contact details to primary contact
                    let res = await fetch('/api/member/emergency-contacts/primary', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            name: secondary.name,
                            phone: secondary.phone,
                            relationship: secondary.relationship
                        })
                    });
                    const d1 = await res.json();
                    if (!res.ok || !d1.success) throw new Error(d1.error || 'Failed to update primary contact');

                    // 2. Delete the secondary contact
                    res = await fetch(`/api/member/emergency-contacts/${secondary.id}`, { method: 'DELETE' });
                    const d2 = await res.json();
                    if (!res.ok || !d2.success) throw new Error(d2.error || 'Failed to remove secondary contact');

                    showMobileToast('Secondary contact promoted to Primary.', 'success');
                    await renderEmergencyContacts();
                } catch (error) {
                    console.error(error);
                    showMobileToast(error.message || 'Something went wrong. Please try again.', 'error');
                }
            }
        } else {
            alert('The primary contact is required and cannot be deleted. You can edit its details instead.');
        }
        return;
    }

    if (!window.confirm('Remove this emergency contact?')) return;
    try {
        const res = await fetch(`/api/member/emergency-contacts/${contactId}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Unable to remove contact');
        await renderEmergencyContacts();
        showMobileToast('Emergency contact removed.', 'success');
    } catch (error) {
        console.error(error);
        showMobileToast(error.message || 'Something went wrong. Please try again.', 'error');
    }
}

// Body Stats Management
let bodyStatsHistory = [];

async function fetchBodyStatsHistory() {
    try {
        const res = await fetch('/api/member/body-stats');
        const data = await res.json();
        if (data.success) {
            bodyStatsHistory = data.stats || [];
        }
    } catch (e) {
        console.error("Error fetching body stats:", e);
    }
}

function renderStatsSubScreen() {
    fetchBodyStatsHistory().then(() => {
        const weightValEl = document.getElementById('statWeightVal');
        const heightValEl = document.getElementById('statHeightVal');
        const bmiValEl = document.getElementById('statBmiVal');
        const bmiCatEl = document.getElementById('statBmiCategory');
        const goalWeightEl = document.getElementById('statGoalWeightVal');
        const progressTextEl = document.getElementById('progressStatsText');
        const progressRemEl = document.getElementById('progressRemainingText');
        const lastUpdatedValEl = document.getElementById('statsLastUpdatedVal');
        const emptyStateEl = document.getElementById('statsEmptyState');
        const trendCardEl = document.getElementById('weightTrendCard');
        const trendBadgeEl = document.getElementById('weightTrendDiffBadge');
        const trendDiffEl = document.getElementById('weightTrendDiffText');
        
        if (bodyStatsHistory.length === 0) {
            weightValEl.innerText = '--';
            heightValEl.innerText = '--';
            bmiValEl.innerText = '--';
            bmiCatEl.innerText = '--';
            goalWeightEl.innerText = '--';
            progressTextEl.innerText = 'Current: -- • Goal: --';
            progressRemEl.innerText = '--';
            lastUpdatedValEl.innerText = 'Updated --';
            if (emptyStateEl) emptyStateEl.style.display = 'flex';
            if (trendCardEl) trendCardEl.style.display = 'none';
            return;
        }

        const latest = bodyStatsHistory[bodyStatsHistory.length - 1];
        const weightKg = latest.weight;
        const heightCm = latest.height;
        const goalKg = latest.goal_weight;
        
        const heightM = heightCm / 100;
        const bmi = parseFloat((weightKg / (heightM * heightM)).toFixed(1));
        
        let category = 'Normal';
        if (bmi < 18.5) category = 'Underweight';
        else if (bmi < 25) category = 'Normal';
        else if (bmi < 30) category = 'Overweight';
        else category = 'Obese';
        
        const totalInches = heightCm / 2.54;
        const ft = Math.floor(totalInches / 12);
        const inches = Math.round(totalInches % 12);
        
        weightValEl.innerHTML = `${weightKg} <span style="font-size: 12px; font-weight: 500; opacity: 0.6;">kg</span>`;
        heightValEl.innerText = `${ft}'${inches}"`;
        bmiValEl.innerText = bmi;
        bmiCatEl.innerText = category;
        
        if (goalKg) {
            goalWeightEl.innerHTML = `${goalKg} <span style="font-size: 12px; font-weight: 500; opacity: 0.6;">kg</span>`;
            progressTextEl.innerHTML = `Current: ${weightKg} kg &bull; Goal: ${goalKg} kg`;
            const diff = weightKg - goalKg;
            if (diff <= 0) {
                progressRemEl.innerText = 'Goal Achieved 🎉';
            } else {
                progressRemEl.innerText = `${parseFloat(diff.toFixed(1))} kg to goal`;
            }
        } else {
            goalWeightEl.innerText = '--';
            progressTextEl.innerHTML = `Current: ${weightKg} kg &bull; Goal: Not Set`;
            progressRemEl.innerText = '--';
        }

        let updatedText = 'Updated --';
        if (latest.created_at) {
            const dateStr = latest.created_at.split(' ')[0];
            const recordDate = new Date(dateStr);
            const today = new Date();
            recordDate.setHours(0,0,0,0);
            today.setHours(0,0,0,0);
            const diffTime = today - recordDate;
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            if (diffDays === 0) {
                updatedText = 'Updated Today';
            } else if (diffDays === 1) {
                updatedText = 'Updated Yesterday';
            } else {
                updatedText = `Updated ${diffDays} days ago`;
            }
        }
        lastUpdatedValEl.innerText = updatedText;

        if (bodyStatsHistory.length < 2) {
            if (emptyStateEl) emptyStateEl.style.display = 'flex';
            if (trendCardEl) trendCardEl.style.display = 'none';
        } else {
            if (emptyStateEl) emptyStateEl.style.display = 'none';
            if (trendCardEl) trendCardEl.style.display = 'block';
            
            const prev = bodyStatsHistory[bodyStatsHistory.length - 2];
            const diff = latest.weight - prev.weight;
            if (diff < 0) {
                trendDiffEl.innerText = `↓ ${Math.abs(parseFloat(diff.toFixed(1)))} kg`;
                trendBadgeEl.style.color = '#10b981';
            } else if (diff > 0) {
                trendDiffEl.innerText = `↑ ${parseFloat(diff.toFixed(1))} kg`;
                trendBadgeEl.style.color = '#ef4444';
            } else {
                trendDiffEl.innerText = 'No change';
                trendBadgeEl.style.color = 'var(--text-tertiary)';
            }
            
            renderTrendChartSVG();
        }
    });
}

function renderTrendChartSVG() {
    const container = document.getElementById('weightTrendChartContainer');
    if (!container) return;
    container.innerHTML = '';
    
    const entries = bodyStatsHistory.slice(-6);
    const weights = entries.map(e => e.weight);
    const labels = entries.map(e => {
        if (!e.created_at) return '';
        const dateParts = e.created_at.split(' ')[0].split('-');
        const d = new Date(dateParts[0], dateParts[1] - 1, dateParts[2]);
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    });

    const width = 340;
    const height = 150;
    const padding = 25;
    const graphWidth = width - padding * 2;
    const graphHeight = height - padding * 2.5;

    const maxW = Math.max(...weights) + 1;
    const minW = Math.min(...weights) - 1;
    const range = maxW - minW || 1;

    let points = '';
    let circlesHtml = '';
    let labelsHtml = '';

    const stepX = graphWidth / Math.max(1, weights.length - 1);
    weights.forEach((w, idx) => {
        const x = padding + idx * stepX;
        const y = padding + graphHeight - ((w - minW) / range) * graphHeight;
        points += `${x},${y} `;
        
        circlesHtml += `<circle cx="${x}" cy="${y}" r="4.5" fill="#c7ff24" stroke="#0b0b0b" stroke-width="1.5" />`;
        labelsHtml += `<text x="${x}" y="${height - 4}" text-anchor="middle" font-size="8" fill="var(--text-tertiary)" font-weight="500">${labels[idx]}</text>`;
    });

    let polylineHtml = '';
    if (weights.length > 1) {
        polylineHtml = `<polyline points="${points.trim()}" fill="none" stroke="#c7ff24" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />`;
    }

    const svg = `
        <svg width="100%" height="100%" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="overflow: visible;">
            <line x1="${padding}" y1="${padding}" x2="${width - padding}" y2="${padding}" stroke="rgba(255,255,255,0.03)" stroke-width="1" />
            <line x1="${padding}" y1="${padding + graphHeight / 2}" x2="${width - padding}" y2="${padding + graphHeight / 2}" stroke="rgba(255,255,255,0.03)" stroke-width="1" />
            <line x1="${padding}" y1="${padding + graphHeight}" x2="${width - padding}" y2="${padding + graphHeight}" stroke="rgba(255,255,255,0.05)" stroke-width="1" />
            
            ${polylineHtml}
            ${circlesHtml}
            ${labelsHtml}
        </svg>
    `;
    container.innerHTML = svg;
}

function updateModalBmiRealtime() {
    const weight = parseFloat(document.getElementById('statsWeightInput').value) || 0;
    const ft = parseInt(document.getElementById('statsHeightFt').value) || 0;
    const inches = parseInt(document.getElementById('statsHeightIn').value) || 0;
    
    if (weight > 0 && (ft > 0 || inches > 0)) {
        const heightCm = ((ft * 12) + inches) * 2.54;
        const heightM = heightCm / 100;
        const bmi = (weight / (heightM * heightM)).toFixed(1);
        document.getElementById('modalBmiVal').innerText = bmi;
    } else {
        document.getElementById('modalBmiVal').innerText = '--';
    }
}

function openUpdateStatsModal() {
    const latest = bodyStatsHistory[bodyStatsHistory.length - 1];
    document.getElementById('statsWeightInput').value = latest ? latest.weight : '';
    const totalInches = latest ? latest.height / 2.54 : null;
    document.getElementById('statsHeightFt').value = totalInches ? Math.floor(totalInches / 12) : '';
    document.getElementById('statsHeightIn').value = totalInches ? Math.round(totalInches % 12) : '';
    document.getElementById('statsGoalWeightInput').value = latest?.goal_weight || '';
    
    const wInput = document.getElementById('statsWeightInput');
    const ftSelect = document.getElementById('statsHeightFt');
    const inSelect = document.getElementById('statsHeightIn');
    if (wInput && !wInput.dataset.bmiListener) {
        wInput.addEventListener('input', updateModalBmiRealtime);
        ftSelect.addEventListener('change', updateModalBmiRealtime);
        inSelect.addEventListener('change', updateModalBmiRealtime);
        wInput.dataset.bmiListener = 'true';
    }
    
    updateModalBmiRealtime();
    document.getElementById('updateStatsModal').style.display = 'flex';
}

function closeUpdateStatsModal() {
    document.getElementById('updateStatsModal').style.display = 'none';
}

async function saveStatsSubmit(e) {
    e.preventDefault();
    const weight = parseFloat(document.getElementById('statsWeightInput').value);
    const ft = parseInt(document.getElementById('statsHeightFt').value);
    const inches = parseInt(document.getElementById('statsHeightIn').value);
    const goalVal = document.getElementById('statsGoalWeightInput').value;
    const goal_weight = goalVal ? parseFloat(goalVal) : null;
    
    const heightCm = ((ft * 12) + inches) * 2.54;
    
    try {
        const res = await fetch('/api/member/body-stats', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ weight, height: heightCm, goal_weight })
        });
        const data = await res.json();
        if (data.success) {
            showMobileToast('Stats updated successfully', 'success');
            closeUpdateStatsModal();
            renderStatsSubScreen();
        } else {
            showMobileToast(data.error || 'Failed to update stats', 'error');
        }
    } catch (err) {
        showMobileToast('Server offline. Cannot update stats.', 'error');
    }
}

// Password Change Redesigned
async function submitChangePasswordRedesigned(e) {
    e.preventDefault();
    const oldPw = document.getElementById('oldPasswordInput').value;
    const newPw = document.getElementById('newPasswordInput').value;
    const confirmPw = document.getElementById('confirmNewPasswordInput').value;

    if (newPw !== confirmPw) {
        showMobileToast('New passwords do not match', 'error');
        return;
    }

    const submitButton = e.currentTarget.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    submitButton.textContent = 'Saving...';
    try {
        const res = await fetch('/api/member/password', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current_password: oldPw, new_password: newPw }) });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Unable to change password');
        showMobileToast('Password changed successfully.', 'success');
        e.currentTarget.reset();
        hideProfileSubScreen('profilePasswordSubScreen');
    } catch (error) {
        console.error(error);
        showMobileToast(error.message || 'Something went wrong. Please try again.', 'error');
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = 'Save Changes';
    }
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// ================= PREMIUM BOTTOM DRAWER SHEET =================
function openPlanPurchaseDrawer() {
    const drawer = document.getElementById('planPurchaseDrawer');
    if (!drawer) return;
    drawer.style.display = 'flex';
    drawer.offsetHeight; // trigger reflow
    
    fetchAndRenderDrawerPlans();
    
    const card = drawer.querySelector('.bottom-sheet-card');
    if (card) {
        card.style.transform = 'translateY(0)';
    }
}

function hidePlanPurchaseDrawer() {
    const drawer = document.getElementById('planPurchaseDrawer');
    if (!drawer) return;
    const card = drawer.querySelector('.bottom-sheet-card');
    if (card) {
        card.style.transform = 'translateY(100%)';
    }
    setTimeout(() => {
        drawer.style.display = 'none';
    }, 300);
}

function closePlanPurchaseDrawer(event) {
    if (event.target.id === 'planPurchaseDrawer') {
        hidePlanPurchaseDrawer();
    }
}

async function fetchAndRenderDrawerPlans() {
    const container = document.getElementById('drawerPlansList');
    if (!container) return;
    container.innerHTML = '<p style="text-align: center; color: var(--text-tertiary); font-size: 13px; padding: 20px;">Loading plans...</p>';
    
    try {
        const res = await fetch('/api/member/plans');
        const plans = await res.json();
        
        if (plans.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: var(--text-tertiary); font-size: 13px; padding: 20px;">No plans available.</p>';
            return;
        }
        
        container.innerHTML = '';
        plans.forEach(plan => {
            const card = document.createElement('div');
            card.style.padding = '16px';
            card.style.display = 'flex';
            card.style.flexDirection = 'column';
            card.style.gap = '8px';
            card.style.background = 'var(--bg-raised)';
            card.style.borderRadius = 'var(--radius-md)';
            card.style.border = '1px solid var(--border-color)';
            
            card.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <strong style="font-size: 14px; color: var(--text-primary);">${escapeHtml(plan.name)}</strong>
                    <strong style="font-size: 15px; color: var(--accent);">₹${plan.price.toFixed(2)}</strong>
                </div>
                <div style="font-size: 12px; color: var(--text-secondary); line-height: 1.4;">${escapeHtml(plan.benefits || 'Standard Gym Dues')}</div>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 6px;">
                    <span style="font-size: 11px; color: var(--text-tertiary);">${plan.duration_months} ${plan.duration_months === 1 ? 'Month' : 'Months'} duration</span>
                    <button class="btn btn-primary" style="padding: 6px 14px; font-size: 11px; min-height: unset; height: 30px;" onclick="buyPlanFromDrawer(${plan.id}, ${plan.price})">Buy Now</button>
                </div>
            `;
            container.appendChild(card);
        });
    } catch (e) {
        console.error(e);
        container.innerHTML = '<p style="text-align: center; color: var(--danger); font-size: 13px; padding: 20px;">Failed to load plans.</p>';
    }
}

function buyPlanFromDrawer(planId, price) {
    hidePlanPurchaseDrawer();
    initiatePlanPurchase(planId, price);
}
