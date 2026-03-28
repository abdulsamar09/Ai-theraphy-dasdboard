/* 
  AI THERAPY PLATFORM - PRODUCTION CONTROLLER v2
  Implementation: Shared Sessions, Monitoring Fan-out, Voice Config, Therapist Text
*/

const CONFIG = {
    BACKEND_BASE_URL: window.location.origin,
    WS_URL: window.location.origin.replace(/^http/, "ws") + "/ws/chat",
    ENDPOINTS: {
        HEALTH: "/health",
        LOGIN: "/api/auth/login",
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
        this.sessionActive = false;
        this.isPaused = false;
        this.timerSeconds = 0;
        this.timerInterval = null;

        this.user = null;
        this.socket = null;
        this.sessionId = null;
        this.isSupervising = false;

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
        this.applyRoleUI();
        this.bindVoiceControls();
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
    }

    bindEvents() {
        this.loginBtn.onclick = () => this.handleLogin();
        this.logoutBtn.onclick = () => window.location.reload();
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

        this.startBtn.onclick = () => this.startSession();
        this.pauseBtn.onclick = () => this.togglePause();
        this.stopBtn.onclick = () => this.endSession();
        this.joinConfirmBtn.onclick = () => this.joinSupervision();

        document.getElementById("startPatientBtn").onclick = () => this.startMic("patient");
        document.getElementById("stopPatientBtn").onclick = () => this.stopMic();

        const tMicStart = document.getElementById("startTherapistBtn");
        if (tMicStart) tMicStart.onclick = () => this.startMic("therapist");
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

        // Stage Join (Therapist)
        if (this.stageJoinBtn) this.stageJoinBtn.onclick = () => this.joinFromStage();
        if (this.stageSessionInput) {
            this.stageSessionInput.onkeydown = (e) => {
                if (e.key === "Enter") this.joinFromStage();
            };
        }

        // Patient audio monitor toggle (therapist)
        if (this.monitorPatientAudioBtn) {
            this.monitorPatientAudioBtn.onclick = () => this.togglePatientAudioMonitor();
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
        const age = this.loginAge ? this.loginAge.value.trim() : "";
        const gender = this.loginGender ? this.loginGender.value : "";

        const body = { email };
        if (age) body.age = age;
        if (gender) body.gender = gender;

        const res = await fetch(CONFIG.ENDPOINTS.LOGIN, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (res.ok) {
            this.user = data.user;
            // Override with client-side values if provided (richer UX)
            if (age) this.user.age = age;
            if (gender) this.user.gender = gender;
            this.applyRoleUI();
            this.connectWS();
        } else {
            this.toast("Login Failed: " + (data.detail || "Unknown error"));
        }
    }

    applyRoleUI() {
        if (!this.user) return this.loginOverlay.classList.add("active");
        this.loginOverlay.classList.remove("active");
        this.profileBar.style.display = "flex";
        if (this.topLoginBtn) this.topLoginBtn.style.display = "none";
        this.userAvatar.innerText = this.user.name.split(" ").map(n => n[0]).join("");

        const isTherapist = this.user.role === "therapist";

        // Role-gated elements
        document.querySelectorAll("[data-role]").forEach(el => {
            const role = el.dataset.role;
            const isVisible = (role === "therapist" && isTherapist) || (role === "patient" && !isTherapist);
            
            if (isVisible) {
                // Determine display mode
                const needsFlex = ["therapistMics", "patientAudioMonitorRow", "stageJoinGroup"].includes(el.id);
                el.style.display = needsFlex ? "flex" : "block";
            } else {
                el.style.display = "none";
            }
        });

        if (this.modeTabs) this.modeTabs.style.display = "none";
        if (this.trainingJoinPanel) this.trainingJoinPanel.style.display = "none";
        if (this.leftSidebar) this.leftSidebar.style.display = isTherapist ? "flex" : "none";

        // Billing (patient only)
        if (this.billingPill && !isTherapist) {
            this.billingPill.style.display = "flex";
            this.creditVal.innerText = this.user.credits;
        }

        // Voice config panel — now handled by data-role loop (patient only)

        // Patient profile card (right sidebar)
        const patientInfoCard = document.getElementById("patientInfoCard");
        if (patientInfoCard && !isTherapist) {
            patientInfoCard.style.display = "block";
            document.getElementById("infoCardName").innerText = this.user.name;
            document.getElementById("infoCardMeta").innerText =
                `Age: ${this.user.age || "--"} | Gender: ${this.user.gender || "--"}`;
            document.getElementById("infoCardRole").innerText = this.user.role.toUpperCase();
        }

        // Therapist own profile card
        const therapistInfoCard = document.getElementById("supervisedPatientCard");
        if (therapistInfoCard && isTherapist) {
            therapistInfoCard.style.display = "block";
            document.getElementById("svdPatientName").innerText = this.user.name;
            document.getElementById("svdPatientMeta").innerText = "Role: Clinician";
            document.getElementById("svdPatientSession").innerText = "Enter a session ID to supervise";
            document.getElementById("svdSessionStatus").innerText = "Status: Awaiting Session Join";
            therapistInfoCard.style.background = "rgba(44, 132, 91, 0.08)";
            therapistInfoCard.style.borderColor = "rgba(44, 132, 91, 0.3)";
            const firstDiv = therapistInfoCard.querySelector("div");
            if (firstDiv) {
                firstDiv.innerText = "YOUR PROFILE";
                firstDiv.style.color = "var(--color-primary-light)";
            }
        }

        // Therapist mic row: ensure flex direction is column
        const therapistMics = document.getElementById("therapistMics");
        if (therapistMics && isTherapist) therapistMics.style.flexDirection = "column";

        // Hide clinical instructions panel by default (not needed yet)
        if (this.clinicalInstructionsPanel) {
            this.clinicalInstructionsPanel.style.display = "none";
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
    }

    // ─── WEBSOCKET ────────────────────────────────────────────────────────────

    connectWS() {
        this.socket = new WebSocket(CONFIG.WS_URL);
        this.socket.binaryType = "arraybuffer";
        this.socket.onopen = () => {
            this.wsSend({ type: "auth", email: this.user.email });
            if (this.user.role === "patient") {
                this.wsSend({ type: "create_session" });
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
    }

    handleWSMessage(data) {
        switch (data.type) {
            case "session_created":
                this.sessionId = data.session_id;
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
                if (this.sessionIdLabel) this.sessionIdLabel.innerText = this.sessionId;
                if (this.displaySessionId) this.displaySessionId.innerText = this.sessionId;
                if (this.patientIdBadge) this.patientIdBadge.style.display = "flex";

                // Populate therapist supervised patient card
                const svdCard = document.getElementById("supervisedPatientCard");
                if (svdCard) {
                    svdCard.style.display = "block";
                    svdCard.style.background = "rgba(168,85,247,0.08)";
                    svdCard.style.borderColor = "rgba(168,85,247,0.3)";
                    const svdHeader = svdCard.querySelector("div");
                    if (svdHeader) { svdHeader.innerText = "SUPERVISED PATIENT"; svdHeader.style.color = "#a855f7"; }
                    document.getElementById("svdPatientName").innerText = data.patient_name || "Patient";
                    document.getElementById("svdPatientMeta").innerText = `Age: ${data.patient_age} | Sex: ${data.patient_sex}`;
                    document.getElementById("svdPatientSession").innerText = `Session: ${data.session_id}`;
                    document.getElementById("svdSessionStatus").innerText = `Status: ${data.session_active ? "🟢 Active" : "⚫ Inactive"}`;
                }

                // Sync voice config from session to UI
                if (data.voice_gender) this._setSegmentActive("genderSelect", data.voice_gender);
                if (data.tempo) { this._setSegmentActive("tempoSelect", data.tempo); this.voiceState.tempo = data.tempo; }
                if (data.pitch) { this._setSegmentActive("pitchSelect", data.pitch); this.voiceState.pitch = data.pitch; }
                if (data.speed) this.voiceState.speed = data.speed;
                if (data.voice_gender) this.voiceState.gender = data.voice_gender;

                // Populate ageInput/sexInput in therapist sidebar
                if (document.getElementById("ageInput")) document.getElementById("ageInput").value = data.patient_age;
                if (document.getElementById("sexInput")) document.getElementById("sexInput").value = data.patient_sex;

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
                    this.aiStatus.innerText = "⏸ Session Paused";
                    const pStart = document.getElementById("startPatientBtn");
                    if (pStart) { pStart.disabled = true; pStart.style.opacity = "0.3"; }
                }
                if (msg.includes("Resumed")) {
                    this.isPaused = false;
                    this.pauseBtn.innerText = "PAUSE";
                    this.aiStatus.innerText = "▶ Session Active";
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
                    entry.style.cssText = "color: #94a3b8; border-left: 2px solid var(--color-primary); padding-left: 8px; margin-bottom: 6px; font-size: 11px;";
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
                    entry.style.cssText = "color: #cbd5e1; border-left: 2px solid #cbd5e1; padding-left: 8px; margin-bottom: 6px; font-size: 11px; opacity: 0.8;";
                    entry.innerText = `[AI] ${data.text}`;
                    this.consultationLog.prepend(entry);
                }
                // Handle any remaining text in buffer
                this.processTextForTTS("", true); 
                break;

            case "credits":
                this.creditVal.innerText = data.remaining;
                break;

            case "therapist_reply":
                const tEntry = document.createElement("div");
                tEntry.style.cssText = "color: #a855f7; border-left: 2px solid #a855f7; padding-left: 8px; margin-bottom: 6px; font-size: 11px;";
                tEntry.innerText = "[THERAPIST] " + data.text;
                if (this.consultationLog) this.consultationLog.prepend(tEntry);
                break;

            case "error":
                this.toast("⚠ " + data.message);
                break;
        }
    }

    wsSend(payload) {
        if (this.socket && this.socket.readyState === 1) {
            this.socket.send(JSON.stringify({ ...payload, session_id: this.sessionId }));
        }
    }

    // ─── SESSION CONTROLS ─────────────────────────────────────────────────────

    startSession() { this.wsSend({ type: "session_control", command: "START_THERAPY" }); }
    togglePause() {
        this.isPaused = !this.isPaused;
        this.wsSend({ type: "session_control", command: this.isPaused ? "PAUSE" : "RESUME" });
        this.pauseBtn.innerText = this.isPaused ? "RESUME" : "PAUSE";
    }
    endSession() { this.wsSend({ type: "session_control", command: "STOP" }); }

    joinSupervision() {
        const id = this.targetSessionInput.value.trim().toUpperCase();
        if (id) {
            this.isSupervising = true;
            this.wsSend({ type: "join_supervision", target_session_id: id });
        }
    }

    onSessionStarted() {
        this.sessionActive = true;
        this.activeControls.style.display = "flex";
        if (this.clinicalStartOverlay) this.clinicalStartOverlay.style.display = "none";
        if (this.lockedStatusHint) this.lockedStatusHint.style.display = "none";
        this.startClock();
        const pStart = document.getElementById("startPatientBtn");
        if (pStart) pStart.disabled = false;
        this.aiStatus.innerText = "▶ Session Active";
    }

    onSessionEnded() {
        this.sessionActive = false;
        clearInterval(this.timerInterval);
        this.aiStatus.innerText = "Session Ended";
        this.aiStatus.style.color = "var(--color-danger)";
        this.activeControls.style.display = "none";
        ["startPatientBtn", "stopPatientBtn", "startTherapistBtn", "stopTherapistBtn"].forEach(id => {
            const el = document.getElementById(id);
            if (el) { el.disabled = true; el.style.opacity = "0.3"; }
        });
        if (this.clinicalStartOverlay) this.clinicalStartOverlay.style.display = "flex";
    }

    joinFromStage() {
        const id = this.stageSessionInput.value.trim().toUpperCase();
        if (id) {
            this.isSupervising = true;
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

            if (this.ttsQueue.length === 0 && this.audioWave) {
                 this.audioWave.style.opacity = "0";
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

        if (icon) icon.style.background = on
            ? (channel === "patient" ? "var(--color-primary)" : "#a855f7")
            : "#94a3b8";
        if (label) label.innerText = on ? `Listening (${channel})...` : "Not Listening";

        if (on) {
            if (pStart) pStart.disabled = true;
            if (tStart) tStart.disabled = true;
            if (wStart) wStart.disabled = true;
            if (channel === "patient" && pStop) pStop.disabled = false;
            if (channel === "therapist" && tStop) tStop.disabled = false;
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

    // ─── THERAPIST INSTRUCTIONS ───────────────────────────────────────────────

    sendTherapistInstruction() {
        const val = this.therapistTextInput?.value.trim();
        if (val) {
            this.wsSend({ type: "therapist_instruction", text: val });
            // Show confirmation in consultation log
            if (this.consultationLog) {
                const entry = document.createElement("div");
                entry.style.cssText = "color: #38bdf8; border-left: 2px solid #38bdf8; padding-left: 8px; margin-bottom: 6px; font-size: 11px;";
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

    startClock() {
        this.timerInterval = setInterval(() => {
            if (this.isPaused) return;
            this.timerSeconds++;
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

    toast(msg) {
        const t = document.createElement("div");
        Object.assign(t.style, {
            position: "fixed", top: "20px", left: "50%", transform: "translateX(-50%)",
            background: "var(--color-primary)", color: "#fff", padding: "10px 24px",
            borderRadius: "100px", zIndex: "10000", fontSize: "12px",
            border: "1px solid rgba(255,255,255,0.2)", pointerEvents: "none",
            transition: "opacity 0.4s"
        });
        t.innerText = msg;
        document.body.appendChild(t);
        setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 400); }, 2600);
    }
}

window.dashboard = new TherapyDashboard();