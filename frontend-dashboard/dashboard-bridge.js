/**
 * AI Therapy Platform - Dashboard UI Bridge
 * Synchronizes backend state with frontend UI elements
 */
async function initializeDashboard() {
    try {
        const bootstrapData = await sessionService.bootstrap();
        const { user_profile, wallet_status, session_eligibility } = bootstrapData;

        // UI Components - Aligned with index.html IDs
        const minutesEl = document.getElementById('creditVal');
        const startSessionBtn = document.getElementById('startTherapyBtn');
        const billingPill = document.getElementById('billingPill');

        // Update Wallet UI
        if (minutesEl) {
            minutesEl.textContent = wallet_status.minutes_remaining.toFixed(1);
            if (billingPill) billingPill.style.display = 'flex';
            if (wallet_status.minutes_remaining < 20 && wallet_status.free_session_used) {
                minutesEl.style.color = 'var(--color-danger)';
            }
        }

        // Start Session Control
        if (startSessionBtn) {
            if (wallet_status.free_session_used === false) {
                startSessionBtn.textContent = 'START FREE SESSION (20 MINUTES)';
            } else if (!session_eligibility.can_start) {
                startSessionBtn.disabled = false;
                startSessionBtn.style.opacity = '1';
                startSessionBtn.textContent = 'FREE SESSION COMPLETED. PLEASE PROCEED TO PAYMENTS TO CONTINUE';
                startSessionBtn.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const modal = document.getElementById('rechargeModal') || document.getElementById('paywallModal');
                    if (modal) modal.classList.add('active');
                };
            } else {
                startSessionBtn.textContent = 'START CLINICAL SESSION';
                startSessionBtn.disabled = false;
                startSessionBtn.style.opacity = '1';
            }
        }

        console.log('Dashboard Initialized for:', user_profile.full_name);
        return bootstrapData;
    } catch (err) {
        console.error('Initialization Error:', err);
    }
}

window.initializeDashboard = initializeDashboard;
