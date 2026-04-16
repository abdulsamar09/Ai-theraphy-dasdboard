/**
 * AI Therapy Platform - Auth Service
 * Handles Login, Signup, Refresh, and Token Storage
 */
const API_BASE = window.location.origin;

const AuthService = {
    async login(email, password) {
        const response = await fetch(`${API_BASE}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Login failed');
        }
        
        const data = await response.json();
        this.setTokens(data.access_token, data.refresh_token);
        return data;
    },

    async signup(email, password, full_name, role, license_data = null, state = null, username = null) {
        const response = await fetch(`${API_BASE}/auth/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, full_name, role, license_data, state, username })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Signup failed');
        }

        return await response.json();
    },

    async refresh() {
        const refreshToken = localStorage.getItem('refresh_token');
        if (!refreshToken) throw new Error('No refresh token available');

        const response = await fetch(`${API_BASE}/api/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: refreshToken })
        });

        if (!response.ok) {
            this.logout();
            throw new Error('Session expired');
        }

        const data = await response.json();
        this.setTokens(data.access_token, data.refresh_token);
        return data.access_token;
    },

    setTokens(access, refresh) {
        localStorage.setItem('access_token', access);
        localStorage.setItem('refresh_token', refresh);
    },

    getToken() {
        return localStorage.getItem('access_token');
    },

    logout() {
        localStorage.removeItem('access_token');
        localStorage.removeItem('refresh_token');
        window.location.href = '/';
    },

    async getStatus() {
        const token = this.getToken();
        if (!token) return null;

        const response = await fetch(`${API_BASE}/api/dashboard/bootstrap`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.status === 401) {
            const newToken = await this.refresh();
            return this.getStatus(); // Retry with new token
        }

        return await response.json();
    }
};

window.AuthService = AuthService;
