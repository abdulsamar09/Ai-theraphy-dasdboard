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
            
            const sidebarMinutesEl = document.getElementById('sidebarCreditVal');
            if (sidebarMinutesEl) {
                sidebarMinutesEl.textContent = wallet_status.minutes_remaining.toFixed(1);
            }

            if (window.dashboard) {
                window.dashboard.remainingCredits = wallet_status.minutes_remaining;
                
                // Set Fixed Room ID for therapists to share/join easily
                if (user_profile.fixed_room_id) {
                    const isTherapist = user_profile.role === 'therapist';
                    
                    if (isTherapist) {
                        const sidEl = document.getElementById('currentSessionId');
                        if (sidEl) sidEl.value = user_profile.fixed_room_id;
                        
                        const supEl = document.getElementById('supervisionRoomId');
                        if (supEl) supEl.value = user_profile.fixed_room_id;
                        
                        window.dashboard.sessionId = user_profile.fixed_room_id;
                    } else {
                        // For patients/guests, only use fixed_room_id if we don't already have one from the URL
                        if (!window.dashboard.sessionId) {
                            window.dashboard.sessionId = user_profile.fixed_room_id;
                        }
                    }
                }
                
                window.dashboard.updateCreditsUI();
            }
            minutesEl.style.color = (wallet_status.minutes_remaining < 20 && wallet_status.free_session_used) ? 'var(--color-danger)' : 'var(--color-accent)';
        }

        // Start Session Control
        if (startSessionBtn) {
            if (wallet_status.free_session_used === false) {
                startSessionBtn.textContent = 'START FREE SESSION (20 MINUTES)';
            } else if (!session_eligibility.can_start) {
                startSessionBtn.disabled = false;
                startSessionBtn.style.opacity = '1';
                startSessionBtn.textContent = 'CLINICAL TRIAL COMPLETED. PLEASE PURCHASE MINUTES TO CONTINUE SESSIONS.';
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
