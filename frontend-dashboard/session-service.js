/**
 * AI Therapy Platform - Session and WebSocket Handler
 */
const API_BASE = window.location.origin;

class SessionService {
    constructor() {
        this.socket = null;
        this.sessionId = null;
        
        // Force isolated state if using an invite link, to avoid token clash with the therapist's tab
        const urlParams = new URLSearchParams(window.location.search);
        this.isGuestFlow = urlParams.get("role") === "patient" || urlParams.get("sid") || urlParams.get("join");

        const sessionToken = sessionStorage.getItem('access_token');

        if (this.isGuestFlow) {
             this.token = sessionToken;
        } else {
             this.token = localStorage.getItem('access_token');
        }
    }

    async bootstrap() {
        const response = await fetch(`${API_BASE}/api/dashboard/bootstrap`, {
            headers: { 'Authorization': `Bearer ${this.token}` }
        });
        
        if (!response.ok) {
            if (response.status === 401) {
                // Should try refresh logic if available
                await this.refreshToken();
                return this.bootstrap();
            }
            throw new Error('Bootstrap failed');
        }

        return await response.json();
    }

    async createSession() {
        const response = await fetch(`${API_BASE}/api/session/create`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${this.token}` }
        });

        if (!response.ok) throw new Error('Session creation failed');
        const data = await response.json();
        this.sessionId = data.session_id;
        return data.session_id;
    }

    async joinSession(sid) {
        const response = await fetch(`${API_BASE}/api/session/join?session_id=${sid}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${this.token}` }
        });

        if (!response.ok) throw new Error('Failed to join session');
        this.sessionId = sid;
        return await response.json();
    }

    connectWebSocket(handlers) {
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const wsUrl = `${protocol}://${window.location.host}/ws/chat`;
        
        this.socket = new WebSocket(wsUrl);

        this.socket.onopen = () => {
            console.log('WS Connected');
            this.socket.send(JSON.stringify({
                type: 'auth',
                token: this.token
            }));
        };

        this.socket.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (handlers[data.type]) handlers[data.type](data);
        };

        this.socket.onclose = () => {
            console.log('WS Disconnected');
            if (handlers.onClose) handlers.onClose();
        };

        this.socket.onerror = (err) => console.error('WS Error:', err);
    }

    sendMessage(msg) {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({
                ...msg,
                session_id: this.sessionId
            }));
        }
    }

    async refreshToken() {
        const urlParams = new URLSearchParams(window.location.search);
        const joinId = urlParams.get("sid") || urlParams.get("join");
        const isPatientInvite = urlParams.get("role") === "patient" || joinId;
        
        let refreshToken = isPatientInvite ? sessionStorage.getItem('refresh_token') : localStorage.getItem('refresh_token');

        console.log("Auth Refresh Check:", { isPatientInvite, hasToken: !!this.token, hasRefresh: !!refreshToken });

        // Auto-Guest Flow for Meeting Links
        if (isPatientInvite && (!this.token || !refreshToken)) {
            console.log("Attempting Auto-Guest Login...");
            try {
                const guestResp = await fetch(`${API_BASE}/api/auth/guest`); 
                if (guestResp.ok) {
                    const guestData = await guestResp.json();
                    this.token = guestData.access_token;
                    sessionStorage.setItem('access_token', guestData.access_token);
                    sessionStorage.setItem('refresh_token', guestData.refresh_token);
                    console.log("Guest Login Success");
                    return;
                }
            } catch (e) {
                console.error("Guest login failed", e);
            }
        }

        // If we have no refresh token and we're not a guest, we can't refresh
        if (!refreshToken) {
            this.showLoginOverlay();
            throw new Error('No refresh token available');
        }

        try {
            const resp = await fetch(`${API_BASE}/api/auth/refresh`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refresh_token: refreshToken })
            });

            if (!resp.ok) { 
                this.showLoginOverlay();
                throw new Error('Refresh failed');
            }

            const data = await resp.json();
            this.token = data.access_token;
            
            if (isPatientInvite) {
                sessionStorage.setItem('access_token', data.access_token);
                sessionStorage.setItem('refresh_token', data.refresh_token);
            } else {
                localStorage.setItem('access_token', data.access_token);
                localStorage.setItem('refresh_token', data.refresh_token);
            }
        } catch (err) {
            this.showLoginOverlay();
            throw err;
        }
    }

    showLoginOverlay() {
        window.location.href = '/register-login.html';
    }
}

window.sessionService = new SessionService();
