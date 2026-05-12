/* 
  CLINICAL SESSION CONTROLLER v2
  Implementation: Shared Sessions, Monitoring Fan-out, Voice Config, Therapist Text
*/

const CONFIG = {
    BACKEND_BASE_URL: window.location.origin,
    WS_URL: window.location.origin.replace(/^http/, "ws") + "/ws/chat",
    ENDPOINTS: {
        HEALTH: "/health",
        LOGIN: "/api/auth/login",
        SIGNUP: "/api/auth/signup",
        ME: "/api/auth/me",
        BOOTSTRAP: "/api/dashboard/bootstrap",
        ACCOUNT_STATUS: "/api/account/status",
        PURCHASE: "/api/account/purchase-minutes",
        TTS: "/api/tts",
        STT: "/api/stt"
    }
};

const TEMPO_SPEED_MAP = { slow: 0.75, normal: 1.0, fast: 1.25 };

/**
 * Helper to stream chunks of audio into a single playback stream using MediaSource.
 */
class PatientAudioStreamer {
    constructor(audioElement) {
        this.audio = audioElement;
        this.mediaSource = null;
        this.sourceBuffer = null;
        this.queue = [];
        this.isActive = false;
        this.hasHeader = false;
    }

    start() {
        if (this.isActive) this.stop();
        this.mediaSource = new MediaSource();
        this.audio.src = URL.createObjectURL(this.mediaSource);
        this.mediaSource.addEventListener('sourceopen', () => {
            try {
                // Common WebM Opus format from MediaRecorder
                this.sourceBuffer = this.mediaSource.addSourceBuffer('audio/webm; codecs="opus"');
                this.sourceBuffer.addEventListener('updateend', () => this.processQueue());
            } catch (e) {
                console.error("MSE SourceBuffer error:", e);
            }
        });
        this.isActive = true;
        this.hasHeader = false;
        this.audio.play().catch(() => {});
        console.log("Audio streamer started");
    }

    push(arrayBuffer) {
        if (!this.isActive) this.start();
        this.queue.push(arrayBuffer);
        this.processQueue();
    }

    processQueue() {
        if (!this.sourceBuffer || this.sourceBuffer.updating || this.queue.length === 0) return;
        
        // MSE requires the first chunk (with headers) to be appended first.
        // If we join mid-stream, the first chunk might not have EBML headers and fail.
        try {
            const chunk = this.queue.shift();
            this.sourceBuffer.appendBuffer(chunk);
        } catch (e) {
            console.warn("MSE segment append failed (possibly missing header):", e);
            // If it fails, we might need a fresh MediaSource when the next stream starts
        }
    }

    stop() {
        this.isActive = false;
        this.queue = [];
        try {
            if (this.mediaSource && this.mediaSource.readyState === 'open') {
                this.mediaSource.endOfStream();
            }
        } catch (e) {}
    }
}

class TherapyDashboard {
    constructor() {
        console.log("TherapyDashboard v5 Initialized (Google Meet Style)");
        this.sessionActive = false;
        this.isPaused = false;
        this.timerSeconds = 0;
        this.timerInterval = null;

        this.user = null;
        this.socket = null;
        this.sessionId = null;
        this.patientOnline = false;
        this.isSupervising = false;
        this.remainingCredits = 0;

        this.mediaRecorder = null;
        this.audioChunks = [];
        this.activeChannel = null;

        // Voice state — single source of truth for all TTS calls and session_config
        this.voiceState = {
            gender: "female",
            tempo: "normal",
            pitch: "normal",
            speed: 1.0,
            pitchShift: 0.0
        };

        // Patient audio monitoring (therapist side)
        this.monitoringPatientAudio = false;
        this.audioStreamer = null; // initialized when needed 

        // 🎙️ Sentence-based TTS Queue (to reduce delay)
        this.ttsQueue = [];
        this.isTTSSpeaking = false;
        this.currentTextBuffer = "";

        // Audio Visualizer setup
        this.audioCtx = null;
        this.analyser = null;
        this.visData = new Uint8Array(20);
        this.visInterval = null;

        this.init();
    }

    async init() {
        this.cacheDOM();
        this.bindEvents();
        
        // Auto-rejoin if we have a saved session
        const savedSid = sessionStorage.getItem('active_session_id');
        const wasSupervising = sessionStorage.getItem('is_supervising') === 'true';
        if (savedSid && wasSupervising) {
            console.log("Auto-rejoining session:", savedSid);
            this.sessionId = savedSid;
            this.isSupervising = true;
            // We wait a bit for WS to connect
            setTimeout(() => {
                if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                    this.wsSend({ type: "join_supervision", target_session_id: savedSid });
                }
            }, 1000);
        }
        
        this.bindVoiceControls();
        this.checkURLParams();
    }

    checkURLParams() {
        const params = new URLSearchParams(window.location.search);
        let joinId = params.get("sid") || params.get("join") || sessionStorage.getItem('active_session_id');
        
        if (joinId) {
            console.log("Re-establishing session ID:", joinId);
            if (this.stageSessionInput) this.stageSessionInput.value = joinId.toUpperCase();
            this.sessionId = joinId.toUpperCase();
            
            // If we have a stored role or flag, restore it
            if (sessionStorage.getItem('is_supervising') === 'true') {
                this.isSupervising = true;
            }
        }
    }

    cacheDOM() {
        this.loginOverlay = document.getElementById("loginOverlay");
        this.loginBtn = document.getElementById("loginBtn");
        this.loginEmail = document.getElementById("loginEmail");
        this.logoutBtn = document.getElementById("logoutBtn");
        this.topLoginBtn = document.getElementById("topLoginBtn");
        this.profileBar = document.getElementById("userProfileBar");
        this.userAvatar = document.getElementById("userAvatar");
        this.billingPill = document.getElementById("billingPill");
        this.creditVal = document.getElementById("creditVal");

        this.sessionIdLabel = document.getElementById("sessionIdLabel");
        this.displaySessionId = document.getElementById("displaySessionId");
        this.patientIdBadge = document.getElementById("patientIdBadge");
        this.leftSidebar = document.getElementById("leftSidebar");
        this.modeTabs = document.getElementById("modeTabs");
        this.trainingJoinPanel = document.getElementById("trainingJoinPanel");
        this.targetSessionInput = document.getElementById("targetSessionInput");
        this.joinConfirmBtn = document.getElementById("joinConfirmBtn");
        this.clinicalInstructionsPanel = document.getElementById("clinicalInstructionsPanel");
        this.updateAiInstructionBtn = document.getElementById("updateAiInstructionBtn");

        this.startBtn = document.getElementById("startTherapyBtn");
        this.pauseBtn = document.getElementById("pauseSessionBtn");
        this.stopBtn = document.getElementById("stopSessionBtn");
        this.activeControls = document.getElementById("activeSessionControls");
        this.timerDisplay = document.getElementById("sessionTimer");
        this.aiStatus = document.getElementById("aiStatus");
        this.lockedStatusHint = document.getElementById("lockedStatusHint");

        this.aiTranscript = document.getElementById("aiTranscript");
        this.patientTranscript = document.getElementById("patientTranscript");
        this.audioWave = document.getElementById("audioWave");
        this.consultationLog = document.getElementById("consultationLog");

        // New elements
        this.therapistTextInput = document.getElementById("therapistTextInput");
        this.sendTherapistTextBtn = document.getElementById("sendTherapistTextBtn");
        this.monitorPatientAudioBtn = document.getElementById("monitorPatientAudioBtn");
        this.monitorStatusHint = document.getElementById("monitorStatusHint");
        this.patientAudioPlayer = document.getElementById("patientAudioPlayer");
        this.sharePatientLinkBtn = document.getElementById("sharePatientLinkBtn");

        // Stage Overlay elements (Therapist Join vs Patient Start)
        this.clinicalStartOverlay = document.getElementById("clinicalStartOverlay");
        this.stageJoinGroup = document.getElementById("stageJoinGroup");
        this.stageSessionInput = document.getElementById("stageSessionInput");
        this.stageJoinBtn = document.getElementById("stageJoinBtn");

        // Patient login fields
        this.patientLoginFields = document.getElementById("patientLoginFields");
        this.loginAge = document.getElementById("loginAge");
        this.loginGender = document.getElementById("loginGender");

        // Mobile Toggles
        this.mobileLeftToggle = document.getElementById("mobileLeftToggle");
        this.mobileRightToggle = document.getElementById("mobileRightToggle");
        this.mobileBackdrop = document.getElementById("mobileBackdrop");
        this.rightSidebar = document.querySelector(".sidebar-panel.right");

        // Step-by-step Onboarding
        this.finishIntakeBtn = document.getElementById("finishIntakeBtn");
        this.patientIntakeModal = document.getElementById("patientIntakeModal");
        this.patientSessionStartBtn = document.getElementById("patientSessionStartBtn");
    }

    bindEvents() {
        if (this.loginBtn) this.loginBtn.onclick = () => this.handleLogin();
        if (this.logoutBtn) {
            this.logoutBtn.onclick = () => {
                localStorage.removeItem('access_token');
                localStorage.removeItem('refresh_token');
                sessionStorage.removeItem('access_token');
                sessionStorage.removeItem('refresh_token');
                // CLEANUP: Reset intake status on full logout
                sessionStorage.removeItem('patient_intake_complete');
                sessionStorage.removeItem('pref_age');
                sessionStorage.removeItem('pref_gender');
                sessionStorage.removeItem('active_session_id');
                sessionStorage.removeItem('is_supervising');
                window.location.href = '/register-login.html';
            };
        }
        if (this.topLoginBtn) this.topLoginBtn.onclick = () => this.loginOverlay.classList.add("active");

        // Show patient fields when patient email is typed
        if (this.loginEmail) {
            this.loginEmail.oninput = () => {
                const val = this.loginEmail.value.toLowerCase().trim();
                const isPatient = val.includes("patient");
                if (this.patientLoginFields) {
                    this.patientLoginFields.style.display = isPatient ? "block" : "none";
                }
            };
        }

        if (this.startBtn) this.startBtn.onclick = () => this.startSession();
        if (this.pauseBtn) this.pauseBtn.onclick = () => this.togglePause();
        if (this.stopBtn) this.stopBtn.onclick = () => this.endSession();
        if (this.joinConfirmBtn) this.joinConfirmBtn.onclick = () => this.joinSupervision();

        // Auto-save session config when dropdowns change
        const trainingType = document.getElementById("trainingType");
        const therapyApproach = document.getElementById("therapyApproach");
        
        const saveConfig = () => {
            if (!this.sessionId) return;
            this.wsSend({
                type: "session_config",
                training_type: trainingType ? trainingType.value : "therapist_roleplaying_patient",
                approach: therapyApproach ? therapyApproach.value : "CBT"
            });
            this.toast("Session approach updated.");
        };

        if (trainingType) trainingType.onchange = saveConfig;
        if (therapyApproach) therapyApproach.onchange = saveConfig;

        const pMicStart = document.getElementById("startPatientBtn");
        if (pMicStart) pMicStart.onclick = () => this.startMic("patient");
        const pMicStop = document.getElementById("stopPatientBtn");
        if (pMicStop) pMicStop.onclick = () => this.stopMic();

        const tMicStart = document.getElementById("startTherapistBtn");
        if (tMicStart) tMicStart.onclick = () => this.startMic("whisper");
        const tMicStop = document.getElementById("stopTherapistBtn");
        if (tMicStop) tMicStop.onclick = () => this.stopMic();

        const wMicStart = document.getElementById("startWhisperBtn");
        if (wMicStart) wMicStart.onclick = () => this.startMic("whisper");
        const wMicStop = document.getElementById("stopWhisperBtn");
        if (wMicStop) wMicStop.onclick = () => this.stopMic();

        // Therapist Text — send on Ctrl+Enter or button click
        if (this.therapistTextInput) {
            this.therapistTextInput.onkeydown = (e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    this.sendTherapistInstruction();
                }
            };
        }
        if (this.sendTherapistTextBtn) {
            this.sendTherapistTextBtn.onclick = () => this.sendTherapistInstruction();
        }

        // Intake Finish (legacy removed)

        // Stage Join (Therapist)
        if (this.stageJoinBtn) this.stageJoinBtn.onclick = () => this.joinFromStage();
        if (this.stageSessionInput) {
            this.stageSessionInput.onkeydown = (e) => {
                if (e.key === "Enter") this.joinFromStage();
            };
        }

        if (this.monitorPatientAudioBtn) {
            this.monitorPatientAudioBtn.onclick = () => this.togglePatientAudioMonitor();
        }

        if (this.sharePatientLinkBtn) {
            this.sharePatientLinkBtn.onclick = () => {
                this.openInviteModal();
            };
        }

        // Mobile Toggles
        if (this.mobileLeftToggle) {
            this.mobileLeftToggle.onclick = () => this.toggleSidebar("left");
        }
        if (this.mobileRightToggle) {
            this.mobileRightToggle.onclick = () => this.toggleSidebar("right");
        }
        if (this.mobileBackdrop) {
            this.mobileBackdrop.onclick = () => this.closeAllSidebars();
        }
    }

    toggleSidebar(side) {
        if (side === "left") {
            this.leftSidebar.classList.toggle("mobile-active");
            if (this.rightSidebar) this.rightSidebar.classList.remove("mobile-active");
        } else {
            if (this.rightSidebar) this.rightSidebar.classList.toggle("mobile-active");
            this.leftSidebar.classList.remove("mobile-active");
        }
        
        const isActive = this.leftSidebar.classList.contains("mobile-active") || 
                        (this.rightSidebar && this.rightSidebar.classList.contains("mobile-active"));
        
        if (this.mobileBackdrop) {
            this.mobileBackdrop.classList.toggle("active", isActive);
        }
    }

    closeAllSidebars() {
        this.leftSidebar.classList.remove("mobile-active");
        if (this.rightSidebar) this.rightSidebar.classList.remove("mobile-active");
        if (this.mobileBackdrop) this.mobileBackdrop.classList.remove("active");
    }

    // ─── VOICE CONTROLS ──────────────────────────────────────────────────────

    bindVoiceControls() {
        this._bindSegmentGroup("genderSelect", (val) => {
            this.voiceState.gender = val;
            this.pushVoiceConfig();
        });
        this._bindSegmentGroup("tempoSelect", (val) => {
            this.voiceState.tempo = val;
            this.voiceState.speed = TEMPO_SPEED_MAP[val] ?? 1.0;
            this.pushVoiceConfig();
        });
        this._bindSegmentGroup("pitchSelect", (val) => {
            this.voiceState.pitch = val;
            this.pushVoiceConfig();
        });

        // Live tweaks
        const adjSlower = document.getElementById("adjSlower");
        const adjFaster = document.getElementById("adjFaster");
        const adjLower  = document.getElementById("adjLower");
        const adjHigher = document.getElementById("adjHigher");

        if (adjSlower) adjSlower.onclick = () => {
            this.voiceState.speed = Math.max(0.25, parseFloat((this.voiceState.speed - 0.1).toFixed(2)));
            this.toast(`Speed: ${this.voiceState.speed.toFixed(1)}x`);
            this.pushVoiceConfig();
        };
        if (adjFaster) adjFaster.onclick = () => {
            this.voiceState.speed = Math.min(4.0, parseFloat((this.voiceState.speed + 0.1).toFixed(2)));
            this.toast(`Speed: ${this.voiceState.speed.toFixed(1)}x`);
            this.pushVoiceConfig();
        };
        if (adjLower) adjLower.onclick = () => {
            this.voiceState.pitchShift = Math.max(-5, this.voiceState.pitchShift - 1);
            this.toast(`Pitch shift: ${this.voiceState.pitchShift}`);
            this.pushVoiceConfig();
        };
        if (adjHigher) adjHigher.onclick = () => {
            this.voiceState.pitchShift = Math.min(5, this.voiceState.pitchShift + 1);
            this.toast(`Pitch shift: ${this.voiceState.pitchShift}`);
            this.pushVoiceConfig();
        };
    }

    _bindSegmentGroup(containerId, onChange) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.querySelectorAll(".segment-btn").forEach(btn => {
            btn.onclick = () => {
                container.querySelectorAll(".segment-btn").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                onChange(btn.dataset.val);
            };
        });
    }

    // Send voice config to backend session (if session exists)
    pushVoiceConfig() {
        if (!this.sessionId) return;
        this.wsSend({
            type: "session_config",
            voice_gender: this.voiceState.gender,
            tempo: this.voiceState.tempo,
            pitch: this.voiceState.pitch,
            speed: this.voiceState.speed,
            pitch_shift: this.voiceState.pitchShift
        });
    }

    // ─── AUTH & ROLE UI ───────────────────────────────────────────────────────

    async handleLogin() {
        const email = this.loginEmail.value.trim();
        const password = document.getElementById("loginPassword")?.value || "password";
        const age = this.loginAge ? this.loginAge.value.trim() : "";
        const gender = this.loginGender ? this.loginGender.value : "";

        if (!email) { this.toast("Please enter your email."); return; }

        try {
            const res = await fetch(CONFIG.ENDPOINTS.LOGIN, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, password })
            });
            const data = await res.json();
            if (!res.ok) {
                this.toast("Login Failed: " + (data.detail || "Unknown error"));
                return;
            }

            const user = data.user;

            // Block unapproved therapists
            if (user.role === "therapist" && user.approval_status !== "approved") {
                this.toast("⏳ Your therapist account is pending admin approval.");
                return;
            }

            // Enrich with optional patient fields
            if (age) user.age = age;
            if (gender) user.gender = gender;

            this.user = user;
            this.userPassword = password; // store for WebSocket auth
            this.applyRoleUI();
            this.connectWS();
        } catch (err) {
            this.toast("Network error. Is the server running?");
            console.error("[LOGIN]", err);
        }
    }

    applyRoleUI() {
        if (!this.user) return; // Don't show overlay by default
        
        this.loginOverlay.classList.remove("active");
        this.profileBar.style.display = "flex";
        if (this.topLoginBtn) this.topLoginBtn.style.display = "none";
        this.userAvatar.innerText = this.user.name.split(" ").map(n => n[0]).join("");

        const isTherapist = this.user.role === "therapist";
        if (!isTherapist) this.patientOnline = true; // Patients are always "online" for themselves
        const intakeDone = sessionStorage.getItem('patient_intake_complete') === 'true';

        console.log(`[RoleUI] Role: ${this.user.role}, IntakeDone: ${intakeDone}`);

        // Role-gated elements
        document.querySelectorAll("[data-role]").forEach(el => {
            const role = el.dataset.role;
            const isVisible = (role === "therapist" && isTherapist) || (role === "patient" && !isTherapist);
            
            if (isVisible) {
                // Patient intake modal logic
                if (el.id === "patientIntakeModal") {
                    // Only show if patient and details are missing or "Pending"
                    const needsIntake = !isTherapist && (!this.user.age || !this.user.gender || this.user.age === 'Pending' || this.user.gender === 'Pending');
                    if (needsIntake) {
                        el.style.setProperty('display', 'flex', 'important');
                    } else {
                        el.style.setProperty('display', 'none', 'important');
                    }
                    return;
                }
                const needsFlex = ["therapistMics", "patientAudioMonitorRow", "stageJoinGroup"].includes(el.id);
                el.style.display = needsFlex ? "flex" : "block";
            } else {
                el.style.display = "none";
            }
        });

        // Patient start button is always shown for patients — therapist sets profile
        if (!isTherapist) {
            if (this.patientSessionStartBtn) {
                this.patientSessionStartBtn.style.setProperty('display', 'flex', 'important');
            }
            // Patient intake modal visibility is handled in the data-role loop above
        } else if (isTherapist) {
            // Force hide patient start button for therapists
            if (this.patientSessionStartBtn) {
                this.patientSessionStartBtn.style.setProperty('display', 'none', 'important');
            }
            // Ensure join group is visible if session is not active
            if (this.stageJoinGroup && !this.sessionActive) {
                this.stageJoinGroup.style.display = "flex";
            }
        }

        if (this.modeTabs) this.modeTabs.style.display = "none";
        if (this.trainingJoinPanel) this.trainingJoinPanel.style.display = "none";
        if (this.leftSidebar) this.leftSidebar.style.display = isTherapist ? "flex" : "none";

        // Billing — show minutes_remaining for all roles, but only allow purchase for therapists
        if (this.billingPill) {
            this.billingPill.style.display = "flex";
            
            if (isTherapist) {
                this.billingPill.style.cursor = "pointer";
                this.billingPill.title = "Add Minutes";
                this.billingPill.setAttribute('onclick', 'window.dashboard.buyMinutes()');
            } else {
                this.billingPill.style.cursor = "default";
                this.billingPill.title = "Session Minutes Remaining";
                this.billingPill.removeAttribute('onclick');
            }

            // Hide the "+" add icon for patients
            const addIcon = this.billingPill.querySelector('.add-credit-icon');
            if (addIcon) addIcon.style.display = isTherapist ? "inline" : "none";

            // Prioritize the live remainingCredits if already set by WebSocket, otherwise fallback to user profile
            if (this.remainingCredits === undefined || this.remainingCredits === null || this.remainingCredits === 0) {
                 this.remainingCredits = this.user.minutes_remaining ?? 0;
            }
            const mins = this.remainingCredits.toFixed(1);
            if (this.creditVal) this.creditVal.innerText = mins;
            const sidebarMins = document.getElementById('sidebarCreditVal');
            if (sidebarMins) sidebarMins.innerText = mins;
        }

        // Voice config panel — now handled by data-role loop (patient only)

        // Patient profile card (right sidebar)
        const patientInfoCard = document.getElementById("patientInfoCard");
        if (patientInfoCard && !isTherapist) {
            // Pick up URL params if present (from invite link)
            const urlParams = new URLSearchParams(window.location.search);
            const urlAge = urlParams.get('patient_age');
            const urlSex = urlParams.get('patient_sex');
            
            if (urlAge) this.user.age = urlAge;
            if (urlSex) this.user.gender = urlSex;

            patientInfoCard.style.display = "block";
            document.getElementById("infoCardName").innerText = this.user.name || "Guest Patient";
            document.getElementById("infoCardMeta").innerText =
                `Age: ${this.user.age || "--"} | Gender: ${this.user.gender || "--"}`;
            document.getElementById("infoCardRole").innerText = (this.user.role || "patient").toUpperCase();
        }

        // Therapist own profile card
        const therapistInfoCard = document.getElementById("supervisedPatientCard");
        if (therapistInfoCard && isTherapist) {
            therapistInfoCard.style.display = "block";
            document.getElementById("svdPatientName").innerText = this.user.name;
            document.getElementById("svdPatientMeta").innerText = "Role: Clinician";
            document.getElementById("svdPatientSession").innerText = "Enter Session ID to join a patient session";
            document.getElementById("svdSessionStatus").innerText = "Status: Awaiting Session Join";
            therapistInfoCard.style.background = "rgba(44, 132, 91, 0.08)";
            therapistInfoCard.style.borderColor = "rgba(44, 132, 91, 0.3)";
            const firstDiv = therapistInfoCard.querySelector("div");
            if (firstDiv) {
                firstDiv.innerText = "Signed In As";
                firstDiv.style.color = "var(--color-primary-light)";
            }
        }

        // Therapist mic row: ensure flex direction is column
        const therapistMics = document.getElementById("therapistMics");
        if (therapistMics && isTherapist) therapistMics.style.flexDirection = "column";

        // Show clinical instructions panel by default for therapists
        if (this.clinicalInstructionsPanel) {
            this.clinicalInstructionsPanel.style.display = isTherapist ? "block" : "none";
        }

        // Enable patient audio monitoring by default for therapist
        if (isTherapist) {
            this.monitoringPatientAudio = true;
            if (this.monitorPatientAudioBtn) {
                this.monitorPatientAudioBtn.style.borderColor = "var(--color-accent)";
                this.monitorPatientAudioBtn.style.color = "var(--color-accent)";
            }
            if (this.monitorStatusHint) {
                this.monitorStatusHint.innerText = "🔊 On — playing patient mic recordings";
            }
        }

        // Patient: pre-populate voice config defaults
        if (!isTherapist) {
            // defaults already set in voiceState; nothing extra needed
        }

        // --- BUTTON LABEL OVERRIDES (Therapist Only) ---
        if (isTherapist) {
            const pMicBtn = document.getElementById("startPatientBtn");
            if (pMicBtn) {
                const svg = pMicBtn.querySelector("svg");
                if (svg) pMicBtn.innerHTML = `${svg.outerHTML} THERAPIST TO DIRECT AI`;
            }

            const tMicBtn = document.getElementById("startTherapistBtn");
            if (tMicBtn) {
                const svg = tMicBtn.querySelector("svg");
                if (svg) tMicBtn.innerHTML = `${svg.outerHTML} MIC WHISPER — SPECIAL INSTRUCTIONS`;
            }
        }
    }

    // ─── WEBSOCKET ────────────────────────────────────────────────────────────

    connectWS() {
        this.socket = new WebSocket(CONFIG.WS_URL);
        this.socket.binaryType = "arraybuffer";
        this.socket.onopen = () => {
            // Send token-based auth message
            this.wsSend({
                type: "auth",
                token: window.sessionService.token
            });
            if (this.user.role === "patient") {
                this.wsSend({ type: "create_session", forced_id: this.sessionId });
            } else if (this.user.role === "therapist" && this.isSupervising && this.sessionId) {
                this.wsSend({ type: "join_supervision", target_session_id: this.sessionId });
            }
        };
        this.socket.onmessage = (e) => {
            if (e.data instanceof ArrayBuffer) {
                // Binary: patient audio blob received by therapist
                this.handlePatientAudioBlob(e.data);
            } else {
                this.handleWSMessage(JSON.parse(e.data));
            }
        };
        this.socket.onclose = (e) => {
            console.warn("[WS] Disconnected. Code:", e.code);
            if (e.code !== 4001) {
                // Reconnect unless closed due to auth failure
                setTimeout(() => this.connectWS(), 3000);
            }
        };
        this.socket.onerror = (err) => console.error("[WS] Error", err);
    }

    handleWSMessage(data) {
        switch (data.type) {
            case "session_created":
                this.sessionId = data.session_id;
                sessionStorage.setItem('active_session_id', this.sessionId);
                
                if (data.minutes_remaining !== undefined) {
                    this.remainingCredits = data.minutes_remaining;
                    this.updateCreditsUI();
                }

                if (this.sessionIdLabel) this.sessionIdLabel.innerText = this.sessionId;
                if (this.displaySessionId) this.displaySessionId.innerText = this.sessionId;
                if (this.patientIdBadge) this.patientIdBadge.style.display = "flex";
                // Send initial voice config to session
                this.pushVoiceConfig();
                // Send patient profile (age/gender) to session
                this.wsSend({
                    type: "session_config",
                    patient_age: this.user.age || "25",
                    patient_sex: this.user.gender || "Female",
                    voice_gender: this.voiceState.gender,
                    tempo: this.voiceState.tempo,
                    pitch: this.voiceState.pitch,
                    speed: this.voiceState.speed,
                    pitch_shift: this.voiceState.pitchShift
                });
                this.toast("Session Created: " + this.sessionId);
                break;

            case "session_sync":
                this.sessionId = data.session_id;
                sessionStorage.setItem('active_session_id', this.sessionId);
                if (this.sessionIdLabel) this.sessionIdLabel.innerText = this.sessionId;
                if (this.displaySessionId) this.displaySessionId.innerText = this.sessionId;
                if (data.elapsed_seconds !== undefined) this.timerSeconds = data.elapsed_seconds;
                if (this.patientIdBadge) this.patientIdBadge.style.display = "flex";
                if (this.clinicalStartOverlay) this.clinicalStartOverlay.style.display = "none";

                // Populate therapist supervised patient card
                const svdCard = document.getElementById("supervisedPatientCard");
                if (svdCard) {
                    svdCard.style.display = "block";
                    svdCard.style.background = "rgba(168,85,247,0.08)";
                    svdCard.style.borderColor = "rgba(168,85,247,0.3)";
                    const svdHeader = svdCard.querySelector("div");
                    if (svdHeader) { svdHeader.innerText = "SUPERVISED PATIENT"; svdHeader.style.color = "#a855f7"; }
                    document.getElementById("svdPatientName").innerText = data.patient_name || "Patient";
                    document.getElementById("svdPatientMeta").innerText = `Age: ${data.patient_age || "Pending"} | Sex: ${data.patient_sex || "Pending"}`;
                    document.getElementById("svdPatientSession").innerText = `Session: ${data.session_id}`;
                    document.getElementById("svdSessionStatus").innerText = `Status: ${data.session_active ? "🟢 Active" : "⚫ Inactive"} ${data.patient_online ? "(👤 Patient Online)" : "(🚫 Patient Offline)"}`;
                    this.patientOnline = data.patient_online;
                }

                // Sync voice config from session to UI
                if (data.voice_gender) this._setSegmentActive("genderSelect", data.voice_gender);
                if (data.tempo) { this._setSegmentActive("tempoSelect", data.tempo); this.voiceState.tempo = data.tempo; }
                if (data.pitch) { this._setSegmentActive("pitchSelect", data.pitch); this.voiceState.pitch = data.pitch; }
                if (data.speed) this.voiceState.speed = data.speed;
                if (data.voice_gender) this.voiceState.gender = data.voice_gender;
                if (data.minutes_remaining !== undefined) {
                    this.remainingCredits = data.minutes_remaining;
                    this.updateCreditsUI();
                }

                // Populate ageInput/sexInput in therapist sidebar
                if (document.getElementById("ageInput")) document.getElementById("ageInput").value = data.patient_age;
                if (document.getElementById("sexInput")) document.getElementById("sexInput").value = data.patient_sex;
                if (document.getElementById("customInstruction") && data.custom_instruction) {
                    document.getElementById("customInstruction").value = data.custom_instruction;
                }
                if (document.getElementById("therapyApproach") && data.approach) {
                    document.getElementById("therapyApproach").value = data.approach;
                }

                // Populate Transcript History
                if (data.transcript) {
                    data.transcript.forEach(msg => {
                        if (msg.role === "patient") this.patientTranscript.innerText = "Patient: " + msg.text;
                        else if (msg.role === "ai") this.aiTranscript.innerText = "AI: " + msg.text;
                    });
                }
                if (data.session_active) this.onSessionStarted();
                break;

            case "status":
                const msg = data.message;
                this.toast(msg);
                if (msg.includes("Started")) this.onSessionStarted();
                if (msg.includes("Ended")) this.onSessionEnded();
                if (msg.includes("Paused")) {
                    this.isPaused = true;
                    this.pauseBtn.innerText = "RESUME";
                    this.updateAIStatus("⏸ Session Paused", false);
                    const pStart = document.getElementById("startPatientBtn");
                    if (pStart) { pStart.disabled = true; pStart.style.opacity = "0.3"; }
                }
                if (msg.includes("Resumed")) {
                    this.isPaused = false;
                    this.pauseBtn.innerText = "PAUSE";
                    this.updateAIStatus("▶ Session Active", true);
                    const pStart = document.getElementById("startPatientBtn");
                    if (pStart) { pStart.disabled = false; pStart.style.opacity = "1"; }
                }
                if (msg.includes("Instruction Sent")) {
                    if (this.therapistTextInput) this.therapistTextInput.value = "";
                }
                break;

            case "monitor_patient_text":
                this.patientTranscript.innerText = "Patient: " + data.text;
                this.patientTranscript.classList.remove("opacity-50");
                if (this.consultationLog) {
                    const entry = document.createElement("div");
                    entry.style.cssText = "color: #94a3b8; border-left: 2px solid var(--color-primary); padding-left: 8px; margin-bottom: 6px; font-size: 13px;";
                    entry.innerText = `[PATIENT] ${data.text}`;
                    this.consultationLog.prepend(entry);
                }
                break;

            case "chunk":
                if (this.aiTranscript.innerText.includes("Ready")) this.aiTranscript.innerText = "AI: ";
                const chunk = data.text;
                this.aiTranscript.innerText += chunk;
                this.processTextForTTS(chunk); // New streaming logic
                break;

            case "monitor_ai_reply":
                if (this.aiTranscript.innerText.includes("Ready")) this.aiTranscript.innerText = "AI: ";
                this.aiTranscript.innerText += data.text;
                break;

            case "final":
                this.aiTranscript.innerText = "AI: " + data.text;
                // Add to log
                if (this.consultationLog) {
                    const entry = document.createElement("div");
                    entry.style.cssText = "color: #cbd5e1; border-left: 2px solid #cbd5e1; padding-left: 8px; margin-bottom: 6px; font-size: 13px; opacity: 0.8;";
                    entry.innerText = `[AI] ${data.text}`;
                    this.consultationLog.prepend(entry);
                }
                // Handle any remaining text in buffer
                this.processTextForTTS("", true); 
                break;

            case "credits":
                this.remainingCredits = data.remaining;
                this.updateCreditsUI();
                break;

            case "therapist_reply":
                // This is the therapist's own speech in the conference call.
                // It shows in the therapist's consultation log for reference.
                const tEntry = document.createElement("div");
                tEntry.style.cssText = "color: #a855f7; border-left: 2px solid #a855f7; padding-left: 8px; margin-bottom: 6px; font-size: 13px;";
                tEntry.innerText = "[THERAPIST SAYS] " + data.text;
                if (this.consultationLog) this.consultationLog.prepend(tEntry);
                break;

            case "error":
                this.toast("⚠ " + data.message);
                // If trial ends or balance is out, auto-show payment for therapist
                if (this.user && this.user.role === "therapist" && (data.message.toLowerCase().includes("trial ended") || data.message.toLowerCase().includes("purchase"))) {
                    setTimeout(() => this.buyMinutes(), 1500);
                }
                break;
        }
    }

    wsSend(payload) {
        if (this.socket && this.socket.readyState === 1) {
            this.socket.send(JSON.stringify({ ...payload, session_id: this.sessionId }));
        }
    }

    // ─── SESSION CONTROLS ─────────────────────────────────────────────────────

    startSession() { 
        // Priority: 1) URL invite params, 2) user object (set by invite modal), 3) defaults
        const urlParams = new URLSearchParams(window.location.search);
        const urlAge = urlParams.get('patient_age');
        const urlSex = urlParams.get('patient_sex');
        
        const patientAge = urlAge || this.user.age || '25';
        const patientSex = urlSex || this.user.gender || 'Female';
        
        // Store on user object for reference
        this.user.age = patientAge;
        this.user.gender = patientSex;

        const trainingType = document.getElementById("trainingType");
        const therapyApproach = document.getElementById("therapyApproach");
        const customInstruction = document.getElementById("customInstruction");
        
        this.wsSend({
            type: "session_config",
            patient_age: patientAge,
            patient_sex: patientSex,
            voice_gender: this.voiceState.gender,
            tempo: this.voiceState.tempo,
            pitch: this.voiceState.pitch,
            speed: this.voiceState.speed,
            pitch_shift: this.voiceState.pitchShift,
            ai_role: trainingType ? trainingType.value : "therapist_roleplaying_patient",
            approach: therapyApproach ? therapyApproach.value : "NLP",
            custom_instruction: customInstruction ? customInstruction.value : ""
        });

        this.wsSend({ type: "session_control", command: "START_THERAPY" }); 
    }
    togglePause() {
        this.isPaused = !this.isPaused;
        this.wsSend({ type: "session_control", command: this.isPaused ? "PAUSE" : "RESUME" });
        this.pauseBtn.innerText = this.isPaused ? "RESUME" : "PAUSE";
    }
    endSession() { this.wsSend({ type: "session_control", command: "STOP" }); }

    async buyMinutes() {
        if (this.user.role !== "therapist") {
            this.toast("Only clinicians can purchase minutes.");
            return;
        }

        const modal = document.getElementById("paymentModal");
        if (!modal) {
            if (!confirm("Add 100 Clinical Minutes for testing?")) return;
            this.executePurchase();
            return;
        }

        modal.style.display = "flex";

        // Cancel button
        const cancelBtn = document.getElementById("cancelPaymentBtn");
        if (cancelBtn) cancelBtn.onclick = () => modal.style.display = "none";

        // 'X' Close button
        const closeBtn = document.getElementById("closePaymentBtn");
        if (closeBtn) closeBtn.onclick = () => modal.style.display = "none";

        // Close on clicking outside the card
        modal.onclick = (e) => {
            if (e.target === modal) {
                modal.style.display = "none";
            }
        };

        // Clear any previously rendered PayPal buttons
        const container = document.getElementById("paypal-button-container");
        const loading   = document.getElementById("paypal-loading");
        const errorBox  = document.getElementById("paypal-error");
        if (container) container.innerHTML = "";
        if (errorBox)  { errorBox.style.display = "none"; errorBox.textContent = ""; }

        if (typeof paypal === "undefined") {
            if (loading) loading.textContent = "PayPal failed to load. Please refresh.";
            return;
        }
        if (loading) loading.style.display = "none";

        paypal.Buttons({
            style: {
                layout : "vertical",  // shows PayPal + Venmo stacked
                color  : "blue",
                shape  : "rect",
                label  : "pay"
            },

            // Create the $24 order on PayPal
            createOrder: (data, actions) => {
                return actions.order.create({
                    purchase_units: [{
                        amount: { value: "24.00", currency_code: "USD" },
                        description: "60 Clinical Minutes — Psychotherapy Now"
                    }]
                });
            },

            // Called when buyer completes payment
            onApprove: async (data, actions) => {
                try {
                    await actions.order.capture();
                    modal.style.display = "none";
                    await this.executePurchase(); // credits minutes on backend
                } catch (err) {
                    if (errorBox) {
                        errorBox.textContent = "Payment failed. Please try again.";
                        errorBox.style.display = "block";
                    }
                }
            },

            // Buyer clicked Cancel
            onCancel: () => {
                modal.style.display = "none";
                this.toast("Payment cancelled.");
            },

            // PayPal SDK error
            onError: (err) => {
                if (errorBox) {
                    errorBox.textContent = "PayPal error. Try again or contact support.";
                    errorBox.style.display = "block";
                }
            }
        }).render("#paypal-button-container");
    }

    async executePurchase() {
        try {
            const token = window.sessionService ? window.sessionService.token : localStorage.getItem('access_token');
            const res = await fetch(CONFIG.BACKEND_BASE_URL + '/api/account/purchase-minutes', {
                method: "POST",
                headers: { "Authorization": "Bearer " + token }
            });
            const data = await res.json();
            if (res.ok) {
                this.toast("Payment successful! Balance updated.");
                setTimeout(() => window.location.reload(), 1000);
            } else {
                this.toast("Purchase failed: " + (data.detail || "Error"));
            }
        } catch (err) {
            console.error(err);
            this.toast("Network error during purchase.");
        }
    }

    // ─── PATIENT INVITE MODAL ──────────────────────────────────────────────────

    openInviteModal() {
        const modal = document.getElementById('patientInviteModal');
        if (!modal) { 
            console.error('[InviteModal] Modal element not found!'); 
            return; 
        }

        // Generate link immediately
        this.generatePatientInviteLink();

        // Force display with important to override any conflicting rules
        modal.style.removeProperty('display');
        modal.style.setProperty('display', 'flex', 'important');
    }

    generatePatientInviteLink() {
        const linkBox = document.getElementById('generatedLinkBox');
        const copyBtn = document.getElementById('copyInviteLinkBtn');

        // Show UI by default now
        if (linkBox) linkBox.style.display = 'block';
        if (copyBtn) {
            copyBtn.style.opacity = '1';
            copyBtn.style.pointerEvents = 'auto';
        }

        // Build invite URL
        let roomId = this.stageSessionInput ? this.stageSessionInput.value.trim() : "";
        if (!roomId) roomId = this.sessionId;
        if (!roomId && this.user) roomId = this.user.fixed_room_id;
        if (!roomId) roomId = "ROOM-" + Math.floor(Math.random() * 10000);
        
        // Auto-fill supervision inputs
        if (this.stageSessionInput) this.stageSessionInput.value = roomId;
        if (this.targetSessionInput) this.targetSessionInput.value = roomId;

        const base = window.location.origin + window.location.pathname;
        let link = `${base}?role=patient&sid=${roomId}`;

        // Show the link box
        const linkInput = document.getElementById('generatedLinkInput');
        if (linkInput) linkInput.value = link;
    }

    copyGeneratedLink() {
        const linkInput = document.getElementById('generatedLinkInput');
        if (!linkInput || !linkInput.value) return;
        navigator.clipboard.writeText(linkInput.value).then(() => {
            this.toast('✅ Link copied successfully!');
            setTimeout(() => {
                const modal = document.getElementById('patientInviteModal');
                if (modal) modal.style.setProperty('display', 'none', 'important');
            }, 600);
        }).catch(() => {
            linkInput.select();
            document.execCommand('copy');
            this.toast('✅ Link copied!');
            setTimeout(() => {
                const modal = document.getElementById('patientInviteModal');
                if (modal) modal.style.setProperty('display', 'none', 'important');
            }, 600);
        });
    }

    joinSupervision() {
        const id = this.targetSessionInput.value.trim().toUpperCase();
        if (id) {
            this.isSupervising = true;
            this.sessionId = id;
            sessionStorage.setItem('active_session_id', id);
            sessionStorage.setItem('is_supervising', 'true');
            this.wsSend({ type: "join_supervision", target_session_id: id });
        }
    }

    submitIntake() {
        const age = document.getElementById('intakeAge').value;
        const sex = document.getElementById('intakeSex').value;
        
        if (!age || !sex) {
            this.toast("Please provide both age and gender.");
            return;
        }

        this.user.age = age;
        this.user.gender = sex;
        
        // Update session config on server
        this.wsSend({
            type: "session_config",
            patient_name: this.user.name,
            patient_age: age,
            patient_sex: sex
        });

        document.getElementById('patientIntakeModal').style.display = 'none';
        this.toast("Details saved. Starting session...");
        this.applyRoleUI(); // Refresh UI to show updated age/sex
        this.startSession();
    }

    onSessionStarted() {
        if (this.clinicalStartOverlay) this.clinicalStartOverlay.style.display = "none";
        if (this.sessionActive) return; // Already started
        this.sessionActive = true;
        this.activeControls.style.display = "flex";
        if (this.lockedStatusHint) this.lockedStatusHint.style.display = "none";
        this.startClock();
        
        // Re-enable and reset opacity for all session controls
        ["startPatientBtn", "stopPatientBtn", "startTherapistBtn", "stopTherapistBtn"].forEach(id => {
            const el = document.getElementById(id);
            if (el) { 
                el.disabled = false; 
                el.style.opacity = "1"; 
                el.style.pointerEvents = "auto";
            }
        });
        
        this.updateAIStatus("▶ Session Active", true);
        // Reset status color to clinical green
        if (this.aiStatus) this.aiStatus.style.color = "var(--color-primary-light)";
    }

    onSessionEnded() {
        this.sessionActive = false;
        sessionStorage.removeItem('active_session_id');
        sessionStorage.removeItem('is_supervising');
        clearInterval(this.timerInterval);
        this.updateAIStatus("Session Ended", false);
        this.aiStatus.style.color = "var(--color-danger)";
        this.activeControls.style.display = "none";
        ["startPatientBtn", "stopPatientBtn", "startTherapistBtn", "stopTherapistBtn"].forEach(id => {
            const el = document.getElementById(id);
            if (el) { el.disabled = true; el.style.opacity = "0.3"; }
        });
        
        // Show the start/join overlay and ensure it respects roles
        if (this.clinicalStartOverlay) {
            this.clinicalStartOverlay.style.display = "block";
            this.applyRoleUI();
        }
    }

    joinFromStage() {
        const id = this.stageSessionInput.value.trim().toUpperCase();
        if (id) {
            this.isSupervising = true;
            this.sessionId = id;
            sessionStorage.setItem('active_session_id', id);
            sessionStorage.setItem('is_supervising', 'true');
            this.wsSend({ type: "join_supervision", target_session_id: id });
        }
    }

    // ─── MICROPHONE ────────────────────────────────────────────────────────────

    async startMic(channel) {
        if (!this.sessionId && channel === "patient") return this.toast("No active session");
        
        try {
            // Resume Context (Browsers block it until user interaction)
            if (this.audioCtx && this.audioCtx.state === 'suspended') {
                await this.audioCtx.resume();
            }

            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            
            // Setup Visualizer
            this.setupVisualizer(stream);

            // Robust mimeType Selection
            const types = [
                'audio/webm; codecs=opus',
                'audio/webm',
                'audio/ogg; codecs=opus',
                'audio/mp4',
                ''
            ];
            let mimeType = '';
            for (const t of types) {
                if (t === '' || MediaRecorder.isTypeSupported(t)) {
                    mimeType = t;
                    break;
                }
            }
            console.log("Using recorder mimeType:", mimeType);

            this.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
            this.audioChunks = [];
            
            this.mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) {
                    this.audioChunks.push(e.data);
                    // Real-time relay to therapist
                    if (channel === "patient" && this.sessionId) {
                        this._relayPatientAudioToTherapist(e.data);
                    }
                }
            };

            this.mediaRecorder.onstop = async () => {
                this.stopVisualizer();
                const blob = new Blob(this.audioChunks, { type: this.mediaRecorder.mimeType || "audio/webm" });
                console.log(`Stop bit. Blob size: ${blob.size}`);
                
                if (blob.size < 1000) return console.warn("Audio too short.");

                this.toast("Processing...");
                
                const fd = new FormData();
                fd.append("file", blob);
                try {
                    const res = await fetch(CONFIG.ENDPOINTS.STT, { method: "POST", body: fd });
                    const data = await res.json();
                    if (data.text) {
                        const type =
                            channel === "patient" ? "user_message" :
                            channel === "therapist" ? "therapist_message" :
                            "whisper";
                        
                        this.wsSend({ type, text: data.text });

                        // Log voice whisper if applicable
                        if (type === "whisper" && this.consultationLog) {
                            const entry = document.createElement("div");
                            entry.style.cssText = "color: #a855f7; border-left: 2px solid #a855f7; padding-left: 8px; margin-bottom: 6px; font-size: 13px;";
                            entry.innerText = `[VOICE WHISPER] ${data.text}`;
                            this.consultationLog.prepend(entry);
                        }
                    }
                } catch (e) {
                    this.toast("Connection Error");
                }
                stream.getTracks().forEach(t => t.stop());
            };

            this.mediaRecorder.start(250);
            this.activeChannel = channel;
            this.updateMicUI(true, channel);

        } catch (err) {
            console.error("Mic error:", err);
            this.toast("Microphone error");
        }
    }

    // ─── STREAMING TTS LOGIC ──────────────────────────────────────────────────

    processTextForTTS(chunk, isFinal = false) {
        this.currentTextBuffer += chunk;

        // Split by punctuation for natural breaks
        // Matches periods, question marks, exclamation points followed by space or end of string
        const sentences = this.currentTextBuffer.split(/([.?!:;]\s+|[.?!:;]$|\n+)/);
        
        // We iterate and combine the split sentence with its delimiter
        let completeSentences = [];
        for (let i = 0; i < sentences.length - 1; i += 2) {
            const sentence = (sentences[i] + (sentences[i+1] || "")).trim();
            if (sentence.length > 3) {
                completeSentences.push(sentence);
            }
        }

        if (completeSentences.length > 0) {
            // Remaining text stays in buffer
            const lastFullIdx = this.currentTextBuffer.lastIndexOf(completeSentences[completeSentences.length - 1]);
            this.currentTextBuffer = this.currentTextBuffer.substring(lastFullIdx + completeSentences[completeSentences.length-1].length);

            completeSentences.forEach(s => this.addToTTSQueue(s));
        }

        if (isFinal && this.currentTextBuffer.trim().length > 0) {
            this.addToTTSQueue(this.currentTextBuffer.trim());
            this.currentTextBuffer = "";
        }
    }

    addToTTSQueue(text) {
        console.log("Adding to TTS Queue:", text);
        this.ttsQueue.push(text);
        if (!this.isTTSSpeaking) this.playNextInTTSQueue();
    }

    async playNextInTTSQueue() {
        if (this.ttsQueue.length === 0) {
            this.isTTSSpeaking = false;
            return;
        }

        this.isTTSSpeaking = true;
        const text = this.ttsQueue.shift();

        try {
            const payload = {
                text,
                voice_gender: this.voiceState.gender,
                tempo: this.voiceState.tempo,
                pitch: this.voiceState.pitch,
                speed: this.voiceState.speed
            };

            const res = await fetch(CONFIG.ENDPOINTS.TTS, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            if (!res.ok) throw new Error("TTS Failed");

            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);

            // Visualizer support for TTS
            if (this.audioWave) this.audioWave.style.opacity = "1";
            
            await new Promise((resolve) => {
                audio.onended = () => {
                    URL.revokeObjectURL(url);
                    resolve();
                };
                audio.onerror = resolve;
                audio.play().catch(resolve);
            });

            if (this.ttsQueue.length === 0) {
                 if (this.audioWave) this.audioWave.style.opacity = "0";
                 document.querySelector('.avatar-ring')?.classList.remove('vis-active');
            } else {
                 document.querySelector('.avatar-ring')?.classList.add('vis-active');
            }

        } catch (e) {
            console.error("Queue TTS error:", e);
        }

        // Delay slightly between sentences for natural flow
        setTimeout(() => this.playNextInTTSQueue(), 150);
    }

    stopMic() {
        if (this.mediaRecorder?.state === "recording") {
            this.mediaRecorder.stop();
            this.updateMicUI(false);
            this.activeChannel = null;
        }
    }

    updateMicUI(on, channel) {
        const icon = document.getElementById("micStateIcon");
        const label = document.getElementById("micStatusLabel");

        const pStart = document.getElementById("startPatientBtn");
        const pStop  = document.getElementById("stopPatientBtn");
        const tStart = document.getElementById("startTherapistBtn");
        const tStop  = document.getElementById("stopTherapistBtn");
        const wStart = document.getElementById("startWhisperBtn");
        const wStop  = document.getElementById("stopWhisperBtn");

        if (icon) {
            icon.style.background = on
                ? (channel === "patient" ? "var(--color-primary-light)" : "#a855f7")
                : "var(--color-danger)";
            icon.classList.toggle("active", on);
        }
        if (label) {
            let statusText = on ? `LISTENING: ${channel.toUpperCase()}` : "SYSTEM: NOT LISTENING";
            if (on && this.user && this.user.role === "therapist") {
                if (channel === "patient") statusText = "LISTENING: ROLEPLAY / TALK TO AI";
                if (channel === "whisper") statusText = "LISTENING: VOICE DIRECTIVE (WHISPER)";
            }
            label.innerText = statusText;
            label.style.color = on ? "var(--color-primary-light)" : "var(--text-muted)";
        }

        if (on) {
            if (pStart) pStart.disabled = true;
            if (tStart) tStart.disabled = true;
            if (wStart) wStart.disabled = true;
            if (channel === "patient" && pStop) pStop.disabled = false;
            if ((channel === "therapist" || channel === "whisper") && tStop) tStop.disabled = false;
            if (channel === "whisper" && wStop) wStop.disabled = false;
        } else {
            if (pStart) pStart.disabled = false;
            if (tStart) tStart.disabled = false;
            if (wStart) wStart.disabled = false;
            if (pStop) pStop.disabled = true;
            if (tStop) tStop.disabled = true;
            if (wStop) wStop.disabled = true;
        }
    }

    setupVisualizer(stream) {
        try {
            if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
            this.analyser = this.audioCtx.createAnalyser();
            const source = this.audioCtx.createMediaStreamSource(stream);
            source.connect(this.analyser);
            if (this.audioWave) this.audioWave.style.opacity = "1";
            document.querySelector('.avatar-ring')?.classList.add('vis-active');
            // Simple visualizer interval
            this.visInterval = setInterval(() => {
                if (this.analyser && this.audioWave) {
                    this.analyser.getByteFrequencyData(this.visData);
                    const avg = this.visData.reduce((a, b) => a + b) / this.visData.length;
                    this.audioWave.style.transform = `scaleY(${1 + avg / 128})`;
                }
            }, 60);
        } catch (e) { console.warn("Visualizer failed", e); }
    }

    stopVisualizer() {
        if (this.visInterval) clearInterval(this.visInterval);
        this.visInterval = null;
        if (this.audioWave) {
            this.audioWave.style.opacity = "0";
            this.audioWave.style.transform = "scaleY(1)";
        }
        document.querySelector('.avatar-ring')?.classList.remove('vis-active');
    }

    // ─── THERAPIST INSTRUCTIONS ───────────────────────────────────────────────

    sendTherapistInstruction() {
        const val = this.therapistTextInput?.value.trim();
        if (val) {
            this.wsSend({ type: "therapist_instruction", text: val });
            // Show confirmation in consultation log
            if (this.consultationLog) {
                const entry = document.createElement("div");
                entry.style.cssText = "color: #38bdf8; border-left: 2px solid #38bdf8; padding-left: 8px; margin-bottom: 6px; font-size: 13px;";
                entry.innerText = `[DIRECTIVE SENT] ${val}`;
                this.consultationLog.prepend(entry);
            }
            // textarea cleared on server ack (status "Instruction Sent")
        }
    }

    // ─── PATIENT AUDIO RELAY ──────────────────────────────────────────────────

    /**
     * Send patient audio blob to server as binary WebSocket frame.
     * Format: b"AUDIO:<session_id>\x00" + audio_data
     */
    _relayPatientAudioToTherapist(blob) {
        if (!this.socket || this.socket.readyState !== 1) return;
        const prefix = `AUDIO:${this.sessionId}\x00`;
        const encoder = new TextEncoder();
        const prefixBytes = encoder.encode(prefix);
        blob.arrayBuffer().then(audioBuffer => {
            const audioBytes = new Uint8Array(audioBuffer);
            const combined = new Uint8Array(prefixBytes.length + audioBytes.length);
            combined.set(prefixBytes, 0);
            combined.set(audioBytes, prefixBytes.length);
            this.socket.send(combined.buffer);
        }).catch(() => {});
    }

    /**
     * Therapist receives patient audio blob (as ArrayBuffer from WS binary frame).
     */
    handlePatientAudioBlob(arrayBuffer) {
        if (!this.monitoringPatientAudio) return;
        
        // Use real-time audio streamer
        if (!this.audioStreamer && this.patientAudioPlayer) {
            this.audioStreamer = new PatientAudioStreamer(this.patientAudioPlayer);
        }
        
        if (this.audioStreamer) {
            this.audioStreamer.push(arrayBuffer);
        }
    }

    togglePatientAudioMonitor() {
        this.monitoringPatientAudio = !this.monitoringPatientAudio;
        if (this.monitorPatientAudioBtn) {
            this.monitorPatientAudioBtn.style.borderColor = this.monitoringPatientAudio ? "var(--color-accent)" : "";
            this.monitorPatientAudioBtn.style.color = this.monitoringPatientAudio ? "var(--color-accent)" : "";
        }
        if (this.monitorStatusHint) {
            this.monitorStatusHint.innerText = this.monitoringPatientAudio
                ? "🔊 On — playing patient mic recordings"
                : "Off — click to hear patient mic recordings";
        }
        this.toast(this.monitoringPatientAudio ? "Patient audio monitoring ON" : "Patient audio monitoring OFF");
    }

    // ─── TTS ──────────────────────────────────────────────────────────────────

    async playTTS(text, voiceOverrides = {}) {
        const payload = {
            text,
            voice_gender: voiceOverrides.voice_gender ?? this.voiceState.gender,
            tempo:        voiceOverrides.tempo        ?? this.voiceState.tempo,
            pitch:        voiceOverrides.pitch        ?? this.voiceState.pitch,
            speed:        voiceOverrides.speed        ?? this.voiceState.speed,
            pitch_shift:  this.voiceState.pitchShift
        };
        try {
            const res = await fetch(CONFIG.ENDPOINTS.TTS, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            const blob = await res.blob();
            const audio = new Audio(URL.createObjectURL(blob));
            audio.play().catch(() => {});
            // Show audio wave animation
            if (this.audioWave) {
                this.audioWave.style.opacity = "1";
                audio.onended = () => { if (this.audioWave) this.audioWave.style.opacity = "0"; };
            }
        } catch (e) {
            this.toast("TTS error");
        }
    }

    // ─── CLOCK ────────────────────────────────────────────────────────────────

    updateCreditsUI() {
        const mins = Math.max(0, this.remainingCredits).toFixed(1);
        if (this.creditVal) this.creditVal.innerText = mins;
        const sidebarMins = document.getElementById('sidebarCreditVal');
        if (sidebarMins) sidebarMins.innerText = mins;
        
        // Visual warning if low
        if (this.remainingCredits < 5) {
            if (this.creditVal) this.creditVal.style.color = "var(--color-danger)";
            if (sidebarMins) sidebarMins.style.color = "var(--color-danger)";
        }
    }

    // ─── CLOCK ────────────────────────────────────────────────────────────────

    startClock() {
        if (this.timerInterval) clearInterval(this.timerInterval);
        this.timerInterval = setInterval(() => {
            // Therapist: Only run if patient is online. Patient: Always run if active.
            const shouldRun = this.user.role === 'therapist' ? this.patientOnline : true;
            if (this.isPaused || !shouldRun) return;
            this.timerSeconds++;
            
            // Live Minutes Update (Decrement by 1/60th of a minute every second)
            if (this.sessionActive) {
                this.remainingCredits -= (1 / 60);
                this.updateCreditsUI();
                
                // Auto-stop if out of time
                if (this.remainingCredits <= 0) {
                    this.toast("Session ended: Out of minutes.");
                    this.endSession();
                }
            }

            const m = String(Math.floor(this.timerSeconds / 60)).padStart(2, "0");
            const s = String(this.timerSeconds % 60).padStart(2, "0");
            this.timerDisplay.innerText = `${m}:${s}`;
        }, 1000);
    }

    // ─── HELPERS ──────────────────────────────────────────────────────────────

    _setSegmentActive(containerId, val) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.querySelectorAll(".segment-btn").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.val === val);
        });
    }

    updateAIStatus(text, isActive) {
        if (!this.aiStatus) return;
        this.aiStatus.innerHTML = `
            <span class="status-dot ${isActive ? 'active' : ''}"></span>
            ${text}
        `;
    }

    toast(msg) {
        // Clear any existing toasts to prevent overlapping
        const existing = document.querySelectorAll('.app-toast');
        existing.forEach(old => {
            old.style.opacity = "0";
            old.style.transform = "translateX(-50%) translateY(-20px)";
            setTimeout(() => { if (old.parentNode) old.remove(); }, 400);
        });

        const t = document.createElement("div");
        t.className = "app-toast";
        Object.assign(t.style, {
            position: "fixed", bottom: "32px", left: "50%", transform: "translateX(-50%)",
            background: "rgba(15, 23, 42, 0.95)", backdropFilter: "blur(12px)", 
            color: "#fff", padding: "12px 28px",
            borderRadius: "100px", zIndex: "10000", fontSize: "13px", fontWeight: "600",
            border: "1px solid rgba(255,255,255,0.15)", pointerEvents: "none",
            boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.5)",
            transition: "all 0.4s cubic-bezier(0.4, 0, 0.2, 1)",
            opacity: "0", filter: "blur(10px)"
        });
        t.innerText = msg;
        document.body.appendChild(t);
        
        // Trigger animation
        requestAnimationFrame(() => {
            t.style.opacity = "1";
            t.style.filter = "blur(0)";
            t.style.bottom = "40px";
        });

        setTimeout(() => {
            t.style.opacity = "0";
            t.style.filter = "blur(10px)";
            t.style.bottom = "32px";
            setTimeout(() => { if (t.parentNode) t.remove(); }, 400);
        }, 4000);
    }
}

window.dashboard = new TherapyDashboard();