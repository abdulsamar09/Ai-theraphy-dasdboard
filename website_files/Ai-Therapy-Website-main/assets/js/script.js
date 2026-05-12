'use strict';





/**
 * add event listener on multiple elements
 */

const addEventOnElements = function (elements, eventType, callback) {
  for (let i = 0, len = elements.length; i < len; i++) {
    elements[i].addEventListener(eventType, callback);
  }
}



/**
 * PRELOADER
 * 
 * preloader will be visible until document load
 */

const preloader = document.querySelector("[data-preloader]");

const removePreloader = function () {
  if (preloader) {
    preloader.classList.add("loaded");
    document.body.classList.add("loaded");
  }
}

if (preloader) {
  window.addEventListener("load", removePreloader);

  // Fallback: Remove preloader after 5 seconds even if 'load' event hasn't fired
  // This prevents the page from being stuck if an external resource fails to load.
  setTimeout(removePreloader, 5000);
}



/**
 * MOBILE NAVBAR
 * 
 * show the mobile navbar when click menu button
 * and hidden after click menu close button or overlay
 */

const navbar = document.querySelector("[data-navbar]");
const navTogglers = document.querySelectorAll("[data-nav-toggler]");
const overlay = document.querySelector("[data-overlay]");

const toggleNav = function () {
  navbar.classList.toggle("active");
  overlay.classList.toggle("active");
  document.body.classList.toggle("nav-active");
}

addEventOnElements(navTogglers, "click", toggleNav);



/**
 * HEADER & BACK TOP BTN
 * 
 * active header & back top btn when window scroll down to 100px
 */

const header = document.querySelector("[data-header]");
const backTopBtn = document.querySelector("[data-back-top-btn]");

const activeElementOnScroll = function () {
  if (window.scrollY > 100) {
    header.classList.add("active");
    backTopBtn.classList.add("active");
  } else {
    header.classList.remove("active");
    backTopBtn.classList.remove("active");
  }
}

window.addEventListener("scroll", activeElementOnScroll);



/**
 * SCROLL REVEAL
 */

const revealElements = document.querySelectorAll("[data-reveal]");

const revealElementOnScroll = function () {
  for (let i = 0, len = revealElements.length; i < len; i++) {
    if (revealElements[i].getBoundingClientRect().top < window.innerHeight / 1.15) {
      revealElements[i].classList.add("revealed");
    } else {
      revealElements[i].classList.remove("revealed");
    }
  }
}

window.addEventListener("scroll", revealElementOnScroll);

window.addEventListener("load", revealElementOnScroll);

/**
 * USER USAGE & BALANCE SYNC
 */
const handleLogout = function() {
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
  sessionStorage.removeItem('access_token');
  sessionStorage.removeItem('refresh_token');
  window.location.reload();
}

const updateUserUsage = async function () {
  const token = localStorage.getItem('access_token');
  if (!token) return;

  try {
    const response = await fetch('/api/dashboard/bootstrap', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (response.ok) {
      const data = await response.json();
      const mins = data.wallet_status.minutes_remaining;
      const minsFixed = parseFloat(mins).toFixed(1);
      const userName = data.user_profile.full_name || "Clinician";
      const userEmail = data.user_profile.email || "";
      const userRole = data.user_profile.role || "Licensed Clinician";
      
      // 1. Update Header with Premium Profile Dropdown
      const authContainer = document.querySelector('.auth-buttons-container');
      
      // Smart Header Detection
      const headerStyles = window.getComputedStyle(header);
      const isWhiteBg = headerStyles.backgroundColor === 'rgb(255, 255, 255)' || 
                       headerStyles.backgroundColor === 'white' ||
                       window.location.pathname.includes('pricing.html');
      
      const textColor = isWhiteBg ? '#0f172a' : 'white';
      const triggerBg = isWhiteBg ? 'rgba(15, 23, 42, 0.05)' : 'rgba(255, 255, 255, 0.1)';
      const triggerBorder = isWhiteBg ? 'rgba(15, 23, 42, 0.1)' : 'rgba(255, 255, 255, 0.2)';

      if (authContainer) {
        authContainer.innerHTML = `
          <style>
            .profile-dropdown {
              position: relative;
              display: flex;
              align-items: center;
              gap: 12px;
            }
            .profile-trigger {
              display: flex;
              align-items: center;
              gap: 10px;
              background: ${triggerBg};
              padding: 5px 15px;
              border-radius: 50px;
              border: 1px solid ${triggerBorder};
              cursor: pointer;
              transition: all 0.3s ease;
            }
            .profile-trigger:hover {
              background: ${isWhiteBg ? 'rgba(15, 23, 42, 0.1)' : 'rgba(255, 255, 255, 0.2)'};
              border-color: var(--verdigris);
            }
            .avatar {
              width: 30px;
              height: 30px;
              background: var(--verdigris);
              border-radius: 50%;
              display: flex;
              align-items: center;
              justify-content: center;
              color: white;
              font-weight: bold;
              font-size: 14px;
              flex-shrink: 0;
            }
            .dropdown-content {
              position: absolute;
              top: calc(100% + 10px);
              right: 0;
              width: 280px;
              background: #0f172a;
              border: 1px solid rgba(255, 255, 255, 0.1);
              border-radius: 16px;
              box-shadow: 0 10px 40px rgba(0,0,0,0.5);
              padding: 20px;
              display: none;
              flex-direction: column;
              gap: 15px;
              z-index: 1000;
              backdrop-filter: blur(20px);
            }
            
            /* Responsive Dropdown for Mobile */
            @media (max-width: 575px) {
              .dropdown-content {
                right: -50px; /* Adjust to stay in viewport */
                width: 240px;
              }
              .profile-trigger span {
                display: none; /* Hide 'ACCOUNT' text on very small screens */
              }
            }

            /* Bridge the gap so hover isn't lost */
            .dropdown-content::before {
              content: '';
              position: absolute;
              top: -15px;
              left: 0;
              width: 100%;
              height: 15px;
            }
            .dropdown-content.show {
              display: flex;
            }
            
            /* Responsive Dropdown for Mobile */
            @media (max-width: 575px) {
              .dropdown-content {
                right: -20px; 
                width: 260px;
              }
              .profile-trigger span {
                display: none; 
              }
            }

            /* Bridge the gap so hover isn't lost on desktop */
            @media (min-width: 992px) {
              .dropdown-content::before {
                content: '';
                position: absolute;
                top: -15px;
                left: 0;
                width: 100%;
                height: 15px;
              }
              .profile-dropdown:hover .dropdown-content {
                display: flex;
              }
            }
            
            .info-group {
              display: flex;
              flex-direction: column;
              gap: 4px;
            }
            .info-label {
              font-size: 10px;
              text-transform: uppercase;
              letter-spacing: 1px;
              color: var(--verdigris);
              font-weight: bold;
            }
            .info-value {
              font-size: 14px;
              color: white;
              font-weight: 500;
              word-break: break-all;
            }
            .balance-card {
              background: rgba(22, 160, 133, 0.1);
              padding: 12px;
              border-radius: 10px;
              border: 1px solid rgba(22, 160, 133, 0.3);
              display: flex;
              justify-content: space-between;
              align-items: center;
              margin-bottom: 5px;
            }
            .btn-dashboard-nav {
              display: flex !important;
              width: 100%;
              justify-content: center;
              align-items: center;
              padding: 12px;
              font-size: 13px;
              font-weight: bold;
              text-align: center;
              background: var(--verdigris);
              color: white !important;
              border-radius: 8px;
              text-transform: uppercase;
              letter-spacing: 1px;
              transition: opacity 0.2s;
              margin-top: 5px;
            }
            .btn-dashboard-nav:hover { opacity: 0.9; }
            
            .logout-btn-red {
              margin-top: 5px;
              padding-top: 15px;
              border-top: 1px solid rgba(255, 255, 255, 0.1);
              display: flex;
              align-items: center;
              gap: 8px;
              color: #ff4d4d;
              font-size: 13px;
              font-weight: bold;
              cursor: pointer;
              transition: opacity 0.2s;
            }
            .logout-btn-red:hover { opacity: 0.8; }
          </style>

          <div class="profile-dropdown">
            <div class="profile-trigger" id="profileTrigger">
              <div class="avatar">${userName.charAt(0).toUpperCase()}</div>
              <span style="color: ${textColor}; font-size: 13px; font-weight: 500;">ACCOUNT</span>
              <ion-icon name="chevron-down-outline" style="color: ${textColor}; font-size: 12px;"></ion-icon>
            </div>
            
            <div class="dropdown-content" id="profileDropdown">
              <div class="info-group">
                <span class="info-label">Active Clinician</span>
                <span class="info-value" style="font-size: 16px;">${userName}</span>
              </div>
              
              <div class="info-group">
                <span class="info-label">Email Address</span>
                <span class="info-value" style="font-size: 12px; opacity: 0.7;">${userEmail}</span>
              </div>

              <div class="balance-card">
                <div class="info-group">
                  <span class="info-label" style="color: rgba(255,255,255,0.6);">Balance</span>
                  <span class="info-value" style="color: var(--verdigris); font-size: 18px;">${minsFixed} MIN</span>
                </div>
                <ion-icon name="time-outline" style="font-size: 24px; color: var(--verdigris); opacity: 0.5;"></ion-icon>
              </div>
              
              <a href="/dashboard/" class="btn-dashboard-nav">GO TO DASHBOARD</a>
              
              <div class="logout-btn-red" onclick="handleLogout()">
                <ion-icon name="log-out-outline" style="font-size: 18px;"></ion-icon>
                LOGOUT ACCOUNT
              </div>
            </div>
          </div>
        `;

        // Click to toggle logic
        const trigger = document.getElementById('profileTrigger');
        const dropdown = document.getElementById('profileDropdown');
        
        trigger.addEventListener('click', (e) => {
          e.stopPropagation();
          dropdown.classList.toggle('show');
        });

        document.addEventListener('click', () => {
          dropdown.classList.remove('show');
        });
        
        dropdown.addEventListener('click', (e) => {
          e.stopPropagation();
        });
      }
      
      // 2. Update Pricing Page Usage Card (if exists)
      const usageContainer = document.getElementById('pricing-usage-display');
      if (usageContainer) {
        usageContainer.style.display = 'block';
        usageContainer.innerHTML = `
          <div style="background: white; padding: 30px; border-radius: 12px; box-shadow: var(--shadow-1); text-align: center; margin-bottom: 40px; border: 2px solid var(--verdigris); margin-inline: 15px;">
            <h3 class="headline-sm" style="color: var(--midnight-green); margin-bottom: 10px;">Welcome back, ${userName}</h3>
            <div style="font-size: clamp(32px, 8vw, 48px); font-weight: bold; color: var(--verdigris); margin: 10px 0;">${minsFixed} <span style="font-size: 20px; color: var(--independece);">Minutes Remaining</span></div>
            <p style="color: var(--independece); font-size: 14px; max-width: 500px; margin: 0 auto;">Your clinician account is active and ready for AI-assisted sessions.</p>
            <div style="display: flex; gap: 15px; justify-content: center; margin-top: 25px; flex-wrap: wrap;">
              <a href="/dashboard/" class="btn" style="margin: 0; min-width: 160px; justify-content: center;">Open Dashboard</a>
              <button onclick="handleLogout()" class="btn" style="margin: 0; background: #ff4d4d; min-width: 160px; justify-content: center;">Logout Account</button>
            </div>
          </div>
        `;
      }
    }
  } catch (err) {
    console.error("Error fetching usage:", err);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  updateUserUsage();
  
  // ACTIVE NAV LINK
  const navLinks = document.querySelectorAll('.navbar-item .navbar-link');
  let currentPath = window.location.pathname.split('/').pop();
  if (currentPath === '' || currentPath === '/') currentPath = 'index.html';
  
  navLinks.forEach(link => {
    if (link.getAttribute('href') === currentPath) {
      link.style.backgroundColor = 'hsl(182, 100%, 35%)';
      link.style.borderRadius = '6px';
      link.style.setProperty('color', 'white', 'important');
      link.style.textAlign = 'center';
    }
  });
});


