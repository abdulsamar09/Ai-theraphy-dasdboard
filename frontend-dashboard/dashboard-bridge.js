/**
 * AI Therapy Platform - Dashboard UI Bridge
 * Synchronizes backend state with frontend UI elements
 * Updated for redesigned dual-view dashboard
 */
async function initializeDashboard() {
    try {
        const bootstrapData = await sessionService.bootstrap();
        const { user_profile, wallet_status, session_eligibility } = bootstrapData;

        // Update Wallet UI — new design uses class-based selectors
        const minutesEls = document.querySelectorAll('.minutes-remaining-val');
        if (minutesEls.length > 0) {
            minutesEls.forEach(el => {
                el.textContent = wallet_status.minutes_remaining.toFixed(1);
            });
        }

        // Legacy support: old IDs from backup dashboard
        const creditValEl = document.getElementById('creditVal');
        if (creditValEl) {
            creditValEl.textContent = wallet_status.minutes_remaining.toFixed(1);
        }
        const sidebarCreditVal = document.getElementById('sidebarCreditVal');
        if (sidebarCreditVal) {
            sidebarCreditVal.textContent = wallet_status.minutes_remaining.toFixed(1);
        }

        if (window.dashboard) {
            window.dashboard.remainingCredits = wallet_status.minutes_remaining;
            
            // Set Fixed Room ID for therapists to share/join easily
            if (user_profile.fixed_room_id) {
                const isTherapist = user_profile.role === 'therapist';
                
                if (isTherapist) {
                    // New ID for clinician session display
                    const sidEl = document.getElementById('clinicianSessionIdDisplay');
                    if (sidEl) sidEl.value = user_profile.fixed_room_id;
                    
                    // Legacy IDs
                    const legacySidEl = document.getElementById('currentSessionId');
                    if (legacySidEl) legacySidEl.value = user_profile.fixed_room_id;
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

        // Session eligibility checks (recharge modal trigger)
        if (!session_eligibility.can_start && wallet_status.free_session_used) {
            // Could show recharge modal automatically, but we let the start button handle it
            console.log('Session start blocked: insufficient minutes or trial used.');
        }

        console.log('Dashboard Initialized for:', user_profile.full_name);
        return bootstrapData;
    } catch (err) {
        console.error('Initialization Error:', err);
        sessionService.showLoginOverlay();
    }
}

window.initializeDashboard = initializeDashboard;
