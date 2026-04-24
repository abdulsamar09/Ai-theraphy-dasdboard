/**
 * AI Therapy Platform - Router Logic
 * Manages redirections based on user role and status
 */
async function handleAfterLogin() {
    try {
        const bootstrapData = await AuthService.getStatus();
        if (!bootstrapData) {
            window.location.href = '/';
            return;
        }

        const { role, approval_status } = bootstrapData.user_profile;
        console.log('Routing for Role:', role, 'Status:', approval_status);

        if (role === 'patient') {
            window.location.href = '/dashboard';
        } else if (role === 'therapist') {
            if (approval_status === 'pending') {
                alert('Account is pending approval. You will notify your email once approved.');
            } else if (approval_status === 'approved') {
                window.location.href = '/dashboard';
            } else {
                alert('Account not approved. Access Denied.');
                AuthService.logout();
            }
        }
    } catch (err) {
        console.error('Routing Error:', err);
        AuthService.logout();
    }
}

window.handleAfterLogin = handleAfterLogin;
