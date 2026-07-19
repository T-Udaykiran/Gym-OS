// GymOS Company Portal Controller

const loginOverlay = document.getElementById('loginOverlay');
const appLayout = document.getElementById('appLayout');
let companyPlansCache = [];

document.addEventListener('DOMContentLoaded', () => {
    checkSession();
    setupForms();
});

async function checkSession() {
    try {
        const res = await fetch('/api/company/auth/me');
        const data = await res.json();
        if (data.user) {
            startApp();
        } else {
            loginOverlay.style.display = 'flex';
            appLayout.style.display = 'none';
        }
    } catch (err) {
        console.error('Session check failed', err);
    }
}

function startApp() {
    loginOverlay.style.display = 'none';
    appLayout.style.display = 'flex';
    fetchGyms();
    fetchCompanyPlans();
}

async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    loginOverlay.style.display = 'flex';
    appLayout.style.display = 'none';
}

function showTab(tabName) {
    document.querySelectorAll('.company-tab-content').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.company-tab-btn').forEach(el => el.classList.remove('active'));
    document.getElementById(`${tabName}Tab`).style.display = 'block';
    document.querySelector(`.company-tab-btn[data-tab="${tabName}"]`).classList.add('active');
}

function openModal(modalId) {
    document.getElementById(modalId).classList.add('active');
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('active');
}

function formatINRCurrency(value) {
    return '₹' + parseFloat(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<div style="font-size: 14px; font-weight: 500;">${message}</div>`;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}

// ================= GYMS =================

async function fetchGyms() {
    const tbody = document.getElementById('gymsTableBody');
    try {
        const res = await fetch('/api/company/gyms');
        const gyms = await res.json();

        tbody.innerHTML = '';
        if (gyms.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding: 32px 0; color: var(--text-tertiary);">No gyms yet. Click Add Gym to create the first tenant.</td></tr>';
            return;
        }

        gyms.forEach(g => {
            const tr = document.createElement('tr');
            const badgeClass = g.subscription_status === 'active' ? 'badge-active' : 'badge-suspended';
            tr.innerHTML = `
                <td style="font-weight:600;">${g.name}</td>
                <td><code>${g.gym_code || '—'}</code></td>
                <td>${g.owner_email || '—'}</td>
                <td>${g.member_count}</td>
                <td><span class="badge ${badgeClass}">${g.subscription_status}</span></td>
                <td>${g.subscription_end_date || '—'}</td>
                <td><button class="btn btn-ghost" style="padding:6px 12px; font-size:13px;" onclick="openGymDetail(${g.id})">Manage</button></td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color: var(--danger);">Failed to load gyms.</td></tr>';
    }
}

async function openGymDetail(gymId) {
    try {
        const res = await fetch(`/api/company/gyms/${gymId}`);
        const data = await res.json();
        if (data.error) {
            showToast(data.error, 'error');
            return;
        }

        const g = data.gym;
        document.getElementById('gymDetailTitle').textContent = g.name;
        document.getElementById('markPaidGymId').value = gymId;
        document.getElementById('markPaidStartDate').value = new Date().toISOString().split('T')[0];
        document.getElementById('markPaidAmount').value = '';
        document.getElementById('markPaidNotes').value = '';

        const statusBadge = g.subscription_status === 'active' ? 'badge-active' : 'badge-suspended';
        document.getElementById('gymDetailInfo').innerHTML = `
            <div><strong>Gym ID:</strong> <code>${g.gym_code || '—'}</code></div>
            <div><strong>Owner:</strong> ${g.owner_email || '—'}</div>
            <div><strong>Phone:</strong> ${g.phone || '—'}</div>
            <div><strong>Address:</strong> ${g.address || '—'}</div>
            <div><strong>Members:</strong> ${data.member_count}</div>
            <div><strong>Subscription:</strong> <span class="badge ${statusBadge}">${g.subscription_status}</span> ${g.subscription_end_date ? `(expires ${g.subscription_end_date})` : ''}</div>
        `;

        const planSelect = document.getElementById('markPaidPlanSelect');
        planSelect.innerHTML = companyPlansCache.map(p =>
            `<option value="${p.id}">${p.name} (${formatINRCurrency(p.price)} - ${p.duration_months}m)</option>`
        ).join('');

        const histBody = document.getElementById('gymSubscriptionHistoryBody');
        if (data.subscription_history.length === 0) {
            histBody.innerHTML = '<tr><td colspan="4" style="text-align:center; color: var(--text-tertiary); padding: 16px 0;">No payments recorded yet.</td></tr>';
        } else {
            histBody.innerHTML = data.subscription_history.map(h => `
                <tr>
                    <td>${h.plan_name || '—'}</td>
                    <td>${h.start_date} &rarr; ${h.end_date}</td>
                    <td>${formatINRCurrency(h.amount_paid)}</td>
                    <td>${h.payment_date || '—'}</td>
                </tr>
            `).join('');
        }

        openModal('gymDetailModal');
    } catch (err) {
        showToast('Failed to load gym detail', 'error');
    }
}

async function submitMarkPaid() {
    const gymId = document.getElementById('markPaidGymId').value;
    const companyPlanId = document.getElementById('markPaidPlanSelect').value;
    const startDate = document.getElementById('markPaidStartDate').value;
    const amount = document.getElementById('markPaidAmount').value;
    const notes = document.getElementById('markPaidNotes').value;

    try {
        const res = await fetch(`/api/company/gyms/${gymId}/mark-paid`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                company_plan_id: companyPlanId,
                start_date: startDate || undefined,
                amount_paid: amount ? parseFloat(amount) : undefined,
                notes: notes || undefined
            })
        });
        const data = await res.json();
        if (data.success) {
            showToast(`Subscription activated through ${data.subscription_end_date}.`, 'success');
            closeModal('gymDetailModal');
            fetchGyms();
        } else {
            showToast(data.error, 'error');
        }
    } catch (err) {
        showToast('Failed to record payment', 'error');
    }
}

// ================= SUBSCRIPTION PLANS =================

async function fetchCompanyPlans() {
    const tbody = document.getElementById('companyPlansTableBody');
    try {
        const res = await fetch('/api/company/plans');
        const plans = await res.json();
        companyPlansCache = plans;

        tbody.innerHTML = '';
        if (plans.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding: 32px 0; color: var(--text-tertiary);">No subscription plans yet.</td></tr>';
            return;
        }

        plans.forEach(p => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="font-weight:600;">${p.name}</td>
                <td>${formatINRCurrency(p.price)}</td>
                <td>${p.duration_months} ${p.duration_months === 1 ? 'Month' : 'Months'}</td>
                <td>
                    <button class="btn btn-ghost" style="padding:6px 10px; font-size:13px;" onclick='openEditPlanModal(${JSON.stringify(p)})'>Edit</button>
                    <button class="btn btn-ghost" style="padding:6px 10px; font-size:13px; color: var(--danger-dark);" onclick="deleteCompanyPlan(${p.id})">Delete</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color: var(--danger);">Failed to load plans.</td></tr>';
    }
}

function openAddPlanModal() {
    document.getElementById('planModalTitle').textContent = 'Add Subscription Plan';
    document.getElementById('addPlanForm').reset();
    document.getElementById('editPlanId').value = '';
    openModal('addPlanModal');
}

function openEditPlanModal(plan) {
    document.getElementById('planModalTitle').textContent = 'Edit Subscription Plan';
    document.getElementById('editPlanId').value = plan.id;
    document.getElementById('planNameInput').value = plan.name;
    document.getElementById('planPriceInput').value = plan.price;
    document.getElementById('planDurationInput').value = plan.duration_months;
    openModal('addPlanModal');
}

async function deleteCompanyPlan(id) {
    if (!confirm('Delete this subscription plan?')) return;
    try {
        const res = await fetch(`/api/company/plans/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            showToast('Plan deleted.');
            fetchCompanyPlans();
        } else {
            showToast(data.error, 'error');
        }
    } catch (err) {
        showToast('Failed to delete plan', 'error');
    }
}

function setupForms() {
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('loginEmail').value;
        const password = document.getElementById('loginPassword').value;
        const errBanner = document.getElementById('loginError');
        errBanner.style.display = 'none';

        try {
            const res = await fetch('/api/company/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });
            const data = await res.json();
            if (data.success) {
                startApp();
            } else {
                errBanner.textContent = data.error || 'Invalid credentials';
                errBanner.style.display = 'block';
            }
        } catch (err) {
            errBanner.textContent = 'Server offline. Cannot authenticate.';
            errBanner.style.display = 'block';
        }
    });

    document.getElementById('addGymForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = {
            gym_name: document.getElementById('gymNameInput').value,
            gym_phone: document.getElementById('gymPhoneInput').value,
            gym_address: document.getElementById('gymAddressInput').value,
            owner_first_name: document.getElementById('ownerFirstNameInput').value,
            owner_email: document.getElementById('ownerEmailInput').value,
            owner_password: document.getElementById('ownerPasswordInput').value
        };
        try {
            const res = await fetch('/api/company/gyms', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            const resData = await res.json();
            if (resData.success) {
                closeModal('addGymModal');
                document.getElementById('addGymForm').reset();
                showToast(`Gym created. Gym ID: ${resData.gym_code}`, 'success');
                fetchGyms();
            } else {
                showToast(resData.error, 'error');
            }
        } catch (err) {
            showToast('Failed to create gym', 'error');
        }
    });

    document.getElementById('addPlanForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('editPlanId').value;
        const data = {
            name: document.getElementById('planNameInput').value,
            price: parseFloat(document.getElementById('planPriceInput').value),
            duration_months: parseInt(document.getElementById('planDurationInput').value, 10)
        };
        try {
            const res = await fetch(id ? `/api/company/plans/${id}` : '/api/company/plans', {
                method: id ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            const resData = await res.json();
            if (resData.success) {
                closeModal('addPlanModal');
                showToast(id ? 'Plan updated.' : 'Plan created.', 'success');
                fetchCompanyPlans();
            } else {
                showToast(resData.error, 'error');
            }
        } catch (err) {
            showToast('Failed to save plan', 'error');
        }
    });
}
