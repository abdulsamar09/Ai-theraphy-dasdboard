/* 
   PSYCHOTHERAPY NOW - DASHBOARD CONTROLLER JS
   Features: Clinician Dashboard, Patient Dashboard, Selectable Modes, Voice Customization, Text Sizes, Drawers
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
        try {
            const chunk = this.queue.shift();
            this.sourceBuffer.appendBuffer(chunk);
        } catch (e) {
            console.warn("MSE segment append failed:", e);
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
        console.log("TherapyDashboard Redesigned Initialized");
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

        // Session mode selected state
        this.sessionMode = "supervised_client"; // default

        // Comfort settings
        this.textSize = "medium";
        this.volume = "normal";
        this.captionsEnabled = true;

        // Voice settings
        this.voiceState = {
            gender: "female",
            tempo: "normal",
            pitch: "normal",
            speed: 1.0,
            pitchShift: 0.0
        };

        // Patient audio monitoring
        this.monitoringPatientAudio = false;
        this.audioStreamer = null;

        // Sentence-based TTS Queue
        this.ttsQueue = [];
        this.isTTSSpeaking = false;
        this.currentTextBuffer = "";

        // Visualizer setup
        this.audioCtx = null;
        this.analyser = null;
        this.visData = new Uint8Array(20);
        this.visInterval = null;

        // Active streaming elements reference
        this.currentAiBubble = null;
        this.currentAiWorkspaceBlock = null;

        document.body.classList.add("session-inactive");

        this.init();
    }

    init() {
        this.checkURLParams();
        this.bindEvents();
    }

    checkURLParams() {
        const params = new URLSearchParams(window.location.search);
        let joinId = params.get("sid") || params.get("join") || sessionStorage.getItem('active_session_id');
        
        if (joinId) {
            console.log("Re-establishing session ID:", joinId);
            this.sessionId = joinId.toUpperCase();
            if (sessionStorage.getItem('is_supervising') === 'true') {
                this.isSupervising = true;
            }
        }
    }

    bindEvents() {
        // Esc key closes mobile drawer
        window.addEventListener('keydown', (e) => {
            if (e.key === "Escape") {
                this.toggleMobileDrawer(false);
            }
        });

        // Window resize event to close mobile drawer if expanded past mobile threshold
        window.addEventListener('resize', () => {
            if (window.innerWidth > 1023) {
                const drawer = document.getElementById("navigationDrawer");
                if (drawer && drawer.classList.contains("active")) {
                    this.toggleMobileDrawer(false);
                }
            }
        });
    }

    toggleMobileDrawer(open) {
        const drawer = document.getElementById("navigationDrawer");
        const backdrop = document.getElementById("drawerBackdrop");
        if (drawer && backdrop) {
            if (open) {
                this.activeDrawerType = (this.user && this.user.role === "therapist") ? "setup" : "patient";
                this.buildMobileDrawer();
                drawer.classList.add("active");
                backdrop.classList.add("active");
                document.body.classList.add("drawer-open");
            } else {
                drawer.classList.remove("active");
                backdrop.classList.remove("active");
                document.body.classList.remove("drawer-open");
                this.cleanupMobileDrawer();
                this.activeDrawerType = null;
            }
        }
    }

    toggleSettingsDrawer(open) {
        const drawer = document.getElementById("navigationDrawer");
        const backdrop = document.getElementById("drawerBackdrop");
        if (drawer && backdrop) {
            if (open) {
                this.activeDrawerType = "settings";
                this.buildMobileDrawer();
                drawer.classList.add("active");
                backdrop.classList.add("active");
                document.body.classList.add("drawer-open");
            } else {
                drawer.classList.remove("active");
                backdrop.classList.remove("active");
                document.body.classList.remove("drawer-open");
                this.cleanupMobileDrawer();
                this.activeDrawerType = null;
            }
        }
    }

    buildMobileDrawer() {
        const body = document.getElementById("drawerBodyContent");
        if (!body) return;
        body.innerHTML = "";

        const titleText = document.getElementById("drawerTitleText");
        const isTherapist = this.user && this.user.role === "therapist";

        if (isTherapist) {
            if (titleText) {
                titleText.innerText = this.activeDrawerType === "settings" ? "SESSION CONTROLS" : "SESSION SETUP";
            }
            if (this.activeDrawerType === "settings") {
                const rightCol = document.querySelector("#clinicianView .right-col .column-body");
                if (rightCol) {
                    this._shiftedFrom = rightCol;
                    while (rightCol.firstChild) {
                        body.appendChild(rightCol.firstChild);
                    }
                }
            } else {
                const leftCol = document.querySelector("#clinicianView .left-col .column-body");
                if (leftCol) {
                    this._shiftedFrom = leftCol;
                    while (leftCol.firstChild) {
                        body.appendChild(leftCol.firstChild);
                    }
                }
            }
        } else {
            if (titleText) {
                titleText.innerText = "PATIENT DASHBOARD";
            }
            // Patient View: Create wrapper dividers to cleanly distinguish and restore left/right contents
            const guideWrapper = document.createElement("div");
            guideWrapper.className = "drawer-shifted-guide";
            const settingsWrapper = document.createElement("div");
            settingsWrapper.className = "drawer-shifted-settings";
            
            body.appendChild(guideWrapper);
            body.appendChild(settingsWrapper);

            const leftCol = document.querySelector("#patientView .left-col .column-body");
            const rightCol = document.querySelector("#patientView .right-col .column-body");

            if (leftCol) {
                while (leftCol.firstChild) {
                    guideWrapper.appendChild(leftCol.firstChild);
                }
            }
            if (rightCol) {
                while (rightCol.firstChild) {
                    settingsWrapper.appendChild(rightCol.firstChild);
                }
            }
        }
    }

    cleanupMobileDrawer() {
        const body = document.getElementById("drawerBodyContent");
        if (!body) return;

        const isTherapist = this.user && this.user.role === "therapist";
        if (isTherapist) {
            if (this._shiftedFrom) {
                while (body.firstChild) {
                    this._shiftedFrom.appendChild(body.firstChild);
                }
                this._shiftedFrom = null;
            }
        } else {
            // Patient View cleanup: Move guide and settings back to their respective sidebars
            const guideWrapper = body.querySelector(".drawer-shifted-guide");
            const settingsWrapper = body.querySelector(".drawer-shifted-settings");
            
            const leftCol = document.querySelector("#patientView .left-col .column-body");
            const rightCol = document.querySelector("#patientView .right-col .column-body");

            if (guideWrapper && leftCol) {
                while (guideWrapper.firstChild) {
                    leftCol.appendChild(guideWrapper.firstChild);
                }
            }
            if (settingsWrapper && rightCol) {
                while (settingsWrapper.firstChild) {
                    rightCol.appendChild(settingsWrapper.firstChild);
                }
            }
        }
        body.innerHTML = "";
    }

    selectSessionMode(mode) {
        this.sessionMode = mode;
        
        // Update cards
        document.querySelectorAll(".mode-selection-card").forEach(c => c.classList.remove("active"));
        const activeCard = document.getElementById("mode-card-" + mode);
        if (activeCard) activeCard.classList.add("active");
        
        // Toggle setup forms
        document.querySelectorAll(".mode-fields-group").forEach(g => g.style.display = "none");
        const activeFields = document.getElementById("fields-" + mode);
        if (activeFields) activeFields.style.display = "block";
        
        // Update Title of setup
        const titleEl = document.getElementById("modeSetupTitle");
        if (titleEl) {
            const formattedName = mode === "supervised_client" ? "AI-Assisted Therapy Session" :
                                  mode === "clinician_as_client" ? "AI as Therapist (Clinician as Client)" :
                                  mode === "ai_therapist_training" ? "AI as Therapist (Training Modality)" :
                                  "AI as Patient";
            titleEl.innerText = "SETUP FOR " + formattedName.toUpperCase();
        }

        // Hide patient link related fields on status cards for solo modes
        const patientRow = document.getElementById("statusPatientRow");
        const joinRow = document.getElementById("statusJoinRow");
        if (patientRow) patientRow.style.display = (mode === "supervised_client") ? "flex" : "none";
        if (joinRow) joinRow.style.display = (mode === "supervised_client") ? "flex" : "none";

        // Update active mode status display
        const statusModeEl = document.getElementById("statusActiveModeText");
        if (statusModeEl) {
            const formattedNames = {
                supervised_client: "AI-Assisted Therapy",
                clinician_as_client: "Clinician as Client",
                ai_therapist_training: "Training Modality",
                ai_patient_roleplay: "AI as Patient"
            };
            statusModeEl.innerText = formattedNames[mode] || mode;
        }
        
        // Send state update
        this.updateModeSettings();
    }

    getActiveModeConfig() {
        const mode = this.sessionMode;
        const config = {
            type: "session_config",
            session_mode: mode,
            approach: "CBT",
            special_instructions: "",
            patient_profile: {},
            roleplay_profile: {}
        };

        if (mode === "supervised_client") {
            const app = document.getElementById("approach-supervised_client")?.value || "CBT";
            config.approach = app;
        } else if (mode === "clinician_as_client") {
            const app = document.getElementById("approach-clinician_as_client")?.value || "CBT";
            config.approach = app;
            config.special_instructions = document.getElementById("inst-clinician_as_client")?.value || "";
        } else if (mode === "ai_therapist_training") {
            const app = document.getElementById("approach-ai_therapist_training")?.value || "CBT";
            config.approach = app;
            config.roleplay_profile = {
                client_type: document.getElementById("roleplay-client_type")?.value || "Adult client",
                presenting_problem: document.getElementById("roleplay-problem")?.value || "Anxiety",
                training_instructions: document.getElementById("inst-ai_therapist_training")?.value || ""
            };
            config.special_instructions = config.roleplay_profile.training_instructions;
        } else if (mode === "ai_patient_roleplay") {
            config.approach = "";
            config.patient_profile = {
                age: document.getElementById("ai_patient-age")?.value || "30",
                gender: document.getElementById("ai_patient-gender")?.value || "Female",
                presenting_problem: document.getElementById("ai_patient-problem")?.value || "Panic attacks",
                personality_style: document.getElementById("ai_patient-personality")?.value || "Avoidant",
                diagnosis: document.getElementById("ai_patient-diagnosis")?.value || "GAD"
            };
            config.special_instructions = document.getElementById("inst-ai_patient_roleplay")?.value || "";
        }

        // Include audio config parameters
        config.voice_gender = this.voiceState.gender;
        config.tempo = this.voiceState.tempo;
        config.pitch = this.voiceState.pitch;
        config.speed = this.voiceState.speed;
        config.pitch_shift = this.voiceState.pitchShift;

        return config;
    }

    updateModeSettings() {
        if (!this.sessionId) return;
        const config = this.getActiveModeConfig();
        this.wsSend(config);
    }

    sendClinicalDirective() {
        const input = document.getElementById("clinicianTextDirectiveInput");
        if (!input) return;
        const text = input.value.trim();
        if (text) {
            this.wsSend({ type: "therapist_instruction", text: text });
            
            // Append note block locally
            this.appendWorkspaceBlock("note", "CLINICIAN NOTE", text);
            input.value = "";
            this.toast("Clinical directive sent to AI");
        }
    }

    handleDirectiveKey(e) {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            this.sendClinicalDirective();
        }
    }

    sendPatientTextMessage() {
        const input = document.getElementById("patientTextInput");
        if (!input) return;
        const text = input.value.trim();
        if (text) {
            this.wsSend({ type: "user_message", text: text });
            
            // Append bubble locally
            this.appendPatientBubble("you", "YOU", text);
            input.value = "";
        }
    }

    handlePatientTextKey(e) {
        if (e.key === "Enter") {
            e.preventDefault();
            this.sendPatientTextMessage();
        }
    }

    changeTextSize(size) {
        this.textSize = size;
        const body = document.getElementById("patientChatBody");
        if (body) {
            body.style.fontSize = size === 'small' ? '12px' : size === 'large' ? '16px' : '14px';
        }
        this._setSegmentActive("patientTextSize", size);
    }

    changeVolume(level) {
        this.volume = level;
        this._setSegmentActive("patientVolume", level);
    }

    toggleCaptions() {
        const toggle = document.getElementById("captionsToggle");
        if (toggle) {
            this.captionsEnabled = toggle.checked;
        }
    }

    changeVoiceSetting(type, val) {
        if (type === 'gender') {
            this.voiceState.gender = val;
            this._setSegmentActive("clinicianVoiceGender", val);
        } else if (type === 'tempo') {
            this.voiceState.tempo = val;
            this.voiceState.speed = TEMPO_SPEED_MAP[val] ?? 1.0;
            this._setSegmentActive("clinicianVoiceSpeed", val);
        } else if (type === 'pitch') {
            this.voiceState.pitch = val;
            this._setSegmentActive("clinicianVoicePitch", val);
        }
        this.pushVoiceConfig();
        this.toast(`AI voice setting updated: ${type} -> ${val}`);
    }

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

    applyRoleUI() {
        if (!this.user) return;

        const isTherapist = this.user.role === "therapist";
        const clinicianView = document.getElementById("clinicianView");
        const patientView = document.getElementById("patientView");

        if (isTherapist) {
            document.body.classList.add("role-therapist");
            document.body.classList.remove("role-patient");
            if (clinicianView) clinicianView.style.display = "flex";
            if (patientView) patientView.style.display = "none";

            // Default Setup Mode Card
            this.selectSessionMode("supervised_client");

            const displayEl = document.getElementById("clinicianSessionIdDisplay");
            if (displayEl) displayEl.value = this.sessionId || this.user.fixed_room_id || "";
            
            const nameEl = document.getElementById("statusClinicianName");
            if (nameEl) nameEl.innerText = this.user.name;
        } else {
            document.body.classList.add("role-patient");
            document.body.classList.remove("role-therapist");
            if (clinicianView) clinicianView.style.display = "none";
            if (patientView) patientView.style.display = "flex";

            // Patient comfort size defaults
            this.changeTextSize("medium");

            document.querySelectorAll(".session-id-val").forEach(el => el.innerText = this.sessionId || "--------");

            // Verify Intake completeness
            const needsIntake = !this.user.age || !this.user.gender || this.user.age === 'Pending' || this.user.gender === 'Pending';
            const intakeDone = sessionStorage.getItem('patient_intake_complete') === 'true';
            const modal = document.getElementById("patientIntakeModal");
            
            if (needsIntake && !intakeDone && modal) {
                modal.classList.add("active");
            }
        }

        // Init Avatars
        const initials = this.user.name.split(" ").map(n => n[0]).join("");
        document.querySelectorAll(".user-avatar-val").forEach(el => el.innerText = initials);

        // Update Wallet Balance
        this.updateCreditsUI();
    }

    connectWS() {
        this.socket = new WebSocket(CONFIG.WS_URL);
        this.socket.binaryType = "arraybuffer";
        this.socket.onopen = () => {
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
                this.handlePatientAudioBlob(e.data);
            } else {
                this.handleWSMessage(JSON.parse(e.data));
            }
        };
        this.socket.onclose = (e) => {
            console.warn("[WS] Connection lost. Attempting reconnect in 3s...", e.code);
            if (e.code !== 4401 && e.code !== 4001) {
                setTimeout(() => this.connectWS(), 3000);
            }
        };
        this.socket.onerror = (err) => console.error("WS Controller Error:", err);
    }

    handleWSMessage(data) {
        switch (data.type) {
            case "session_created":
                this.sessionId = data.session_id;
                sessionStorage.setItem('active_session_id', this.sessionId);
                document.querySelectorAll(".session-id-val").forEach(el => el.innerText = this.sessionId);
                
                if (data.minutes_remaining !== undefined) {
                    this.remainingCredits = data.minutes_remaining;
                    this.updateCreditsUI();
                }
                
                // Initialize default voice parameters on server
                this.pushVoiceConfig();
                this.wsSend({
                    type: "session_config",
                    patient_age: this.user.age || "25",
                    patient_sex: this.user.gender || "Female"
                });
                break;

            case "session_sync":
                this.sessionId = data.session_id;
                sessionStorage.setItem('active_session_id', this.sessionId);
                document.querySelectorAll(".session-id-val").forEach(el => el.innerText = this.sessionId);
                
                if (data.elapsed_seconds !== undefined) this.timerSeconds = data.elapsed_seconds;

                // Sync therapist dashboard UI
                if (this.user.role === "therapist") {
                    const statusPatOnline = document.getElementById("statusPatientOnline");
                    const statusJoOnline = document.getElementById("statusJoinOnline");
                    
                    if (statusPatOnline) {
                        statusPatOnline.innerText = data.patient_online ? "🟢 Active" : "⚫ Offline";
                        statusPatOnline.style.color = data.patient_online ? "var(--green)" : "var(--muted)";
                    }
                    if (statusJoOnline) {
                        statusJoOnline.innerText = "🟢 Connected";
                        statusJoOnline.style.color = "var(--green)";
                    }
                    
                    const sidEl = document.getElementById("clinicianSessionIdDisplay");
                    if (sidEl) sidEl.value = this.sessionId;

                    if (data.session_mode) {
                        this.sessionMode = data.session_mode;
                        this.selectSessionMode(data.session_mode);
                    }
                } else {
                    // Sync patient dashboard UI
                    if (data.session_mode) {
                        this.sessionMode = data.session_mode;
                        const statusModeLabel = document.getElementById("statusModeLabel");
                        if (statusModeLabel) {
                            const formattedNames = {
                                supervised_client: "AI-Assisted Therapy",
                                clinician_as_client: "Clinician as Client",
                                ai_therapist_training: "Training Modality",
                                ai_patient_roleplay: "AI as Patient"
                            };
                            statusModeLabel.innerText = formattedNames[data.session_mode] || data.session_mode;
                        }
                    }
                }

                // Sync text voice settings from database
                if (data.voice_gender) this._setSegmentActive("clinicianVoiceGender", data.voice_gender);
                if (data.tempo) this._setSegmentActive("clinicianVoiceSpeed", data.tempo);
                if (data.pitch) this._setSegmentActive("clinicianVoicePitch", data.pitch);

                if (data.minutes_remaining !== undefined) {
                    this.remainingCredits = data.minutes_remaining;
                    this.updateCreditsUI();
                }

                // Load historic transcripts
                if (data.transcript) {
                    const therapistBody = document.getElementById("clinicianWorkspaceBody");
                    const patientBody = document.getElementById("patientChatBody");
                    
                    if (therapistBody) therapistBody.innerHTML = "";
                    if (patientBody) patientBody.innerHTML = "";
                    
                    const thEmpty = document.getElementById("clinicianWorkspaceEmpty");
                    const patEmpty = document.getElementById("patientChatEmpty");
                    if (thEmpty) thEmpty.style.display = "none";
                    if (patEmpty) patEmpty.style.display = "none";

                    data.transcript.forEach(msg => {
                        const sender = msg.role === "patient" ? "CLIENT" : "AI";
                        const patSender = msg.role === "patient" ? "YOU" : "AI THERAPIST";
                        
                        if (this.user.role === "therapist") {
                            this.appendWorkspaceBlock(msg.role, sender, msg.text);
                        } else {
                            this.appendPatientBubble(msg.role === "patient" ? "you" : "ai", patSender, msg.text);
                        }
                    });
                }

                if (data.session_active) this.onSessionStarted();
                break;

            case "status":
                this.toast(data.message);
                if (data.message.includes("Started")) this.onSessionStarted();
                if (data.message.includes("Ended")) this.onSessionEnded();
                if (data.message.includes("Paused")) {
                    this.isPaused = true;
                    this.updateAIStatus("⏸ Session Paused", false);
                }
                if (data.message.includes("Resumed")) {
                    this.isPaused = false;
                    this.updateAIStatus("▶ Session Active", true);
                }
                break;

            case "monitor_patient_text":
                if (this.user.role === "therapist") {
                    this.appendWorkspaceBlock("client", "CLIENT", data.text);
                }
                break;

            case "chunk":
                this.processTextForTTS(data.text);
                this.updateLiveAIStream(data.text, false);
                break;

            case "monitor_ai_reply":
                if (this.user.role === "therapist") {
                    this.updateLiveAIStream(data.text, false);
                }
                break;

            case "final":
                this.processTextForTTS("", true);
                this.updateLiveAIStream(data.text, true);
                break;

            case "credits":
                this.remainingCredits = data.remaining;
                this.updateCreditsUI();
                break;

            case "therapist_reply":
                if (this.user.role === "therapist") {
                    this.appendWorkspaceBlock("note", "THERAPIST RESPONSE", data.text);
                }
                break;

            case "error":
                this.toast("⚠ " + data.message);
                if (data.message.toLowerCase().includes("trial ended") || data.message.toLowerCase().includes("purchase")) {
                    setTimeout(() => this.buyMinutes(), 1500);
                }
                break;
        }
    }

    wsSend(payload) {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({ ...payload, session_id: this.sessionId }));
        }
    }

    appendWorkspaceBlock(type, sender, text, timeStr) {
        const body = document.getElementById("clinicianWorkspaceBody");
        const empty = document.getElementById("clinicianWorkspaceEmpty");
        if (!body) return;

        if (empty) empty.style.display = "none";

        const block = document.createElement("div");
        block.className = `workspace-block ${type}-block`;

        const finalTime = timeStr || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        block.innerHTML = `
            <div class="block-header">
                ${sender}
                <span class="block-time">${finalTime}</span>
            </div>
            <div class="block-text">${text}</div>
        `;

        body.appendChild(block);
        body.scrollTop = body.scrollHeight;
    }

    appendPatientBubble(type, sender, text, timeStr) {
        const body = document.getElementById("patientChatBody");
        const empty = document.getElementById("patientChatEmpty");
        if (!body) return;

        if (empty) empty.style.display = "none";

        const wrapper = document.createElement("div");
        wrapper.className = `bubble-wrapper ${type}`;

        const finalTime = timeStr || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        wrapper.innerHTML = `
            <div class="bubble-sender">${sender} <span style="font-size:9px; color:var(--muted); font-weight:normal; margin-left:4px;">${finalTime}</span></div>
            <div class="chat-bubble">${text}</div>
        `;

        body.appendChild(wrapper);
        body.scrollTop = body.scrollHeight;
    }

    updateLiveAIStream(chunkText, isFinal) {
        const isTherapist = this.user.role === "therapist";
        
        if (isTherapist) {
            const body = document.getElementById("clinicianWorkspaceBody");
            if (!body) return;

            if (isFinal) {
                if (this.currentAiWorkspaceBlock) {
                    this.currentAiWorkspaceBlock.querySelector(".block-text").innerText = chunkText;
                    this.currentAiWorkspaceBlock.classList.remove("streaming");
                    this.currentAiWorkspaceBlock = null;
                } else {
                    this.appendWorkspaceBlock("ai", "AI", chunkText);
                }
            } else {
                if (!this.currentAiWorkspaceBlock) {
                    this.appendWorkspaceBlock("ai", "AI", "");
                    this.currentAiWorkspaceBlock = body.querySelector(".workspace-block.ai-block:last-child");
                    this.currentAiWorkspaceBlock.classList.add("streaming");
                }
                const blockText = this.currentAiWorkspaceBlock.querySelector(".block-text");
                if (blockText) blockText.innerText += chunkText;
            }
        } else {
            const body = document.getElementById("patientChatBody");
            if (!body) return;

            if (isFinal) {
                if (this.currentAiBubble) {
                    this.currentAiBubble.querySelector(".chat-bubble").innerText = chunkText;
                    this.currentAiBubble.classList.remove("streaming");
                    this.currentAiBubble = null;
                } else {
                    this.appendPatientBubble("ai", "AI THERAPIST", chunkText);
                }
            } else {
                if (!this.currentAiBubble) {
                    this.appendPatientBubble("ai", "AI THERAPIST", "");
                    this.currentAiBubble = body.querySelector(".bubble-wrapper.ai:last-child");
                    this.currentAiBubble.classList.add("streaming");
                }
                const bubbleText = this.currentAiBubble.querySelector(".chat-bubble");
                if (bubbleText) bubbleText.innerText += chunkText;
            }
        }
    }

    startClinicalSession() {
        if (this.remainingCredits < 1) {
            const modal = document.getElementById("rechargeModal");
            if (modal) modal.classList.add("active");
            return;
        }

        const config = this.getActiveModeConfig();
        this.wsSend(config);
        this.wsSend({ type: "session_control", command: "START_THERAPY" });
    }

    togglePause() {
        this.isPaused = !this.isPaused;
        this.wsSend({ type: "session_control", command: this.isPaused ? "PAUSE" : "RESUME" });
        const pauseBtn = document.getElementById("clinicianPauseBtn");
        if (pauseBtn) pauseBtn.innerText = this.isPaused ? "RESUME SESSION" : "PAUSE SESSION";
    }

    endSession() {
        this.wsSend({ type: "session_control", command: "STOP" });
    }

    buyMinutes() {
        if (this.user.role !== "therapist") {
            this.toast("Only clinicians can purchase platform minutes.");
            return;
        }

        const modal = document.getElementById("paymentModal");
        if (!modal) {
            this.executePurchase();
            return;
        }

        modal.style.display = "flex";

        const container = document.getElementById("paypal-button-container");
        const loading   = document.getElementById("paypal-loading");
        const errorBox  = document.getElementById("paypal-error");
        if (container) container.innerHTML = "";
        if (errorBox)  { errorBox.style.display = "none"; errorBox.textContent = ""; }

        if (typeof paypal === "undefined") {
            if (loading) loading.textContent = "PayPal payment system failed to load. Reload required.";
            return;
        }
        if (loading) loading.style.display = "none";

        paypal.Buttons({
            style: { layout: "vertical", color: "blue", shape: "rect", label: "pay" },
            createOrder: (data, actions) => {
                return actions.order.create({
                    purchase_units: [{
                        amount: { value: "24.00", currency_code: "USD" },
                        description: "60 Clinical Minutes — Psychotherapy Now"
                    }]
                });
            },
            onApprove: async (data, actions) => {
                try {
                    await actions.order.capture();
                    modal.style.display = "none";
                    await this.executePurchase(data.orderID);
                } catch (err) {
                    if (errorBox) {
                        errorBox.textContent = "Capture error. Try again.";
                        errorBox.style.display = "block";
                    }
                }
            },
            onCancel: () => {
                modal.style.display = "none";
                this.toast("Payment cancelled.");
            },
            onError: (err) => {
                if (errorBox) {
                    errorBox.textContent = "Transaction failed.";
                    errorBox.style.display = "block";
                }
            }
        }).render("#paypal-button-container");
    }

    async executePurchase(orderId) {
        try {
            const token = window.sessionService.token;
            const res = await fetch(CONFIG.BACKEND_BASE_URL + '/api/account/purchase-minutes', {
                method: "POST",
                headers: { 
                    "Authorization": "Bearer " + token,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ order_id: orderId || "local_bypass" })
            });
            const data = await res.json();
            if (res.ok) {
                this.toast("Deposit processed successfully!");
                setTimeout(() => window.location.reload(), 1000);
            } else {
                this.toast("Deposit error: " + (data.detail || "Verification failed"));
            }
        } catch (err) {
            this.toast("Payment backend communication error.");
        }
    }

    generateInviteLink() {
        let roomId = this.sessionId || this.user.fixed_room_id;
        if (!roomId) roomId = "ROOM-" + Math.floor(1000 + Math.random() * 9000);
        
        const base = window.location.origin + window.location.pathname;
        const link = `${base}?role=patient&sid=${roomId}`;
        
        const linkInput = document.getElementById("patientLinkInput");
        if (linkInput) linkInput.value = link;
        
        this.sessionId = roomId;
        const idDisplay = document.getElementById("clinicianSessionIdDisplay");
        if (idDisplay) idDisplay.value = roomId;
        
        this.toast("Generated patient invite link!");
    }
    
    copyInviteLink() {
        const linkInput = document.getElementById("patientLinkInput");
        if (linkInput && linkInput.value) {
            navigator.clipboard.writeText(linkInput.value).then(() => {
                this.toast("Invite link copied!");
            }).catch(() => {
                linkInput.select();
                document.execCommand('copy');
                this.toast("Link copied.");
            });
        } else {
            this.toast("Click 'Generate Link' first.");
        }
    }

    async sendPatientInviteEmail() {
        const feedbackEl = document.getElementById("inviteFeedbackText");
        if (feedbackEl) {
            feedbackEl.style.display = "none";
            feedbackEl.innerText = "";
        }

        const linkInput = document.getElementById("patientLinkInput");
        const patientLink = linkInput ? linkInput.value.trim() : "";
        
        // 1. Check if patient link is generated
        if (!patientLink) {
            this.showInviteFeedback("Please generate a patient link first.", "error");
            return;
        }

        const emailInput = document.getElementById("patientInviteEmailInput");
        const email = emailInput ? emailInput.value.trim() : "";

        // 2. Validate email input
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            this.showInviteFeedback("Please enter a valid patient email.", "error");
            return;
        }

        try {
            const sendBtn = document.getElementById("invite-send-btn");
            if (sendBtn) {
                sendBtn.disabled = true;
                sendBtn.innerText = "Sending...";
            }

            const response = await fetch(`${CONFIG.BACKEND_BASE_URL}/api/session/send-invite`, {
                method: "POST",
                headers: { 
                    "Authorization": "Bearer " + window.sessionService.token,
                    "Content-Type": "application/json" 
                },
                body: JSON.stringify({
                    session_id: this.sessionId,
                    email: email,
                    patient_link: patientLink
                })
            });

            if (response.ok) {
                this.showInviteFeedback("Invite sent successfully.", "success");
                if (emailInput) emailInput.value = ""; // clear email input on success
            } else {
                const error = await response.json();
                this.showInviteFeedback(error.detail || "Invite could not be sent. Please try again.", "error");
            }
        } catch (err) {
            this.showInviteFeedback("Invite could not be sent. Please try again.", "error");
        } finally {
            const sendBtn = document.getElementById("invite-send-btn");
            if (sendBtn) {
                sendBtn.disabled = false;
                sendBtn.innerText = "Send Invite";
            }
        }
    }

    showInviteFeedback(msg, type) {
        const feedbackEl = document.getElementById("inviteFeedbackText");
        if (feedbackEl) {
            feedbackEl.innerText = msg;
            feedbackEl.style.display = "flex";
            if (type === "success") {
                feedbackEl.style.color = "var(--green)";
            } else {
                feedbackEl.style.color = "var(--red)"; // Matches --red in styles.css
            }
        }
    }
    
    copySessionId() {
        const idDisplay = document.getElementById("clinicianSessionIdDisplay");
        if (idDisplay && idDisplay.value) {
            navigator.clipboard.writeText(idDisplay.value).then(() => {
                this.toast("Session ID copied!");
            });
        }
    }

    submitIntake() {
        const age = document.getElementById("intakeAge")?.value;
        const sex = document.getElementById("intakeSex")?.value;
        if (!age || !sex) {
            this.toast("Please provide both age and gender details.");
            return;
        }
        
        this.user.age = age;
        this.user.gender = sex;
        sessionStorage.setItem('patient_intake_complete', 'true');
        
        document.getElementById("patientIntakeModal").classList.remove("active");
        
        this.wsSend({
            type: "session_config",
            patient_name: this.user.name,
            patient_age: age,
            patient_sex: sex
        });
        
        this.wsSend({ type: "session_control", command: "START_THERAPY" });
        this.toast("Intake completed. Initiating session...");
        this.applyRoleUI();
    }

    onSessionStarted() {
        if (this.sessionActive) return;
        this.sessionActive = true;
        document.body.classList.add("session-active");
        document.body.classList.remove("session-inactive");
        this.startClock();
        
        this.updateAIStatus("▶ Session Active", true);
        
        // Remove start overlays
        const fieldBlock = document.getElementById("fields-supervised_client");
        if (fieldBlock) {
            const startTriggers = document.querySelectorAll(".start-session-trigger");
            startTriggers.forEach(btn => btn.disabled = true);
        }
        this.toast("Session initialized");
        this.toggleMobileDrawer(false);
    }

    onSessionEnded() {
        this.sessionActive = false;
        document.body.classList.remove("session-active");
        document.body.classList.add("session-inactive");
        clearInterval(this.timerInterval);
        this.updateAIStatus("⚫ Session Inactive", false);
        this.toast("Session concluded.");
        this.toggleMobileDrawer(false);
        
        setTimeout(() => {
            sessionStorage.removeItem('active_session_id');
            sessionStorage.removeItem('is_supervising');
            window.location.reload();
        }, 2000);
    }

    /* MICROPHONE RELAY & AUDIO CAPTURE */
    async startMic(channel) {
        if (!this.sessionId && channel === "patient") return this.toast("Room not ready.");
        try {
            if (this.audioCtx && this.audioCtx.state === 'suspended') {
                await this.audioCtx.resume();
            }

            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.setupVisualizer(stream);

            const types = ['audio/webm; codecs=opus', 'audio/webm', 'audio/ogg; codecs=opus', 'audio/mp4', ''];
            let mimeType = '';
            for (const t of types) {
                if (t === '' || MediaRecorder.isTypeSupported(t)) {
                    mimeType = t;
                    break;
                }
            }

            this.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
            this.audioChunks = [];
            
            this.mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) {
                    this.audioChunks.push(e.data);
                    if (channel === "patient" && this.sessionId) {
                        this._relayPatientAudioToTherapist(e.data);
                    }
                }
            };

            this.mediaRecorder.onstop = async () => {
                this.stopVisualizer();
                const blob = new Blob(this.audioChunks, { type: this.mediaRecorder.mimeType || "audio/webm" });
                if (blob.size < 1000) return;

                this.toast("AI Processing audio...");
                
                const fd = new FormData();
                fd.append("file", blob);
                try {
                    const res = await fetch(CONFIG.ENDPOINTS.STT, { method: "POST", body: fd });
                    const data = await res.json();
                    if (data.text) {
                        const type = channel === "patient" ? "user_message" : "whisper";
                        this.wsSend({ type, text: data.text });

                        if (type === "whisper" && this.user.role === "therapist") {
                            this.appendWorkspaceBlock("note", "VOICE WHISPER DIRECTIVE", data.text);
                        } else if (type === "user_message" && this.user.role === "patient") {
                            this.appendPatientBubble("you", "YOU", data.text);
                        }
                    }
                } catch (e) {
                    this.toast("Transcribe error.");
                }
                stream.getTracks().forEach(t => t.stop());
            };

            this.mediaRecorder.start(250);
            this.activeChannel = channel;
            this.updateMicUI(true, channel);
        } catch (err) {
            this.toast("Microphone connection denied.");
        }
    }

    stopMic() {
        if (this.mediaRecorder?.state === "recording") {
            this.mediaRecorder.stop();
            this.updateMicUI(false);
            this.activeChannel = null;
        }
    }

    toggleSessionMic(channel) {
        if (this.activeChannel === channel) {
            this.stopMic();
        } else {
            if (this.activeChannel) this.stopMic();
            this.startMic(channel);
        }
    }

    updateMicUI(on, channel) {
        const clinicianWave = document.querySelector(".clinician-audio-wave");
        const patientWave = document.querySelector(".patient-audio-wave");
        
        const speakBtn = document.getElementById("speakToClientBtn");
        const whisperBtn = document.getElementById("whisperBtn");
        const patientMicBtn = document.getElementById("patientMicBtn");

        if (on) {
            if (clinicianWave && this.user.role === "therapist") clinicianWave.style.opacity = "1";
            if (patientWave && this.user.role === "patient") patientWave.style.opacity = "1";

            if (channel === "patient") {
                if (speakBtn) speakBtn.classList.add("btn-teal");
                if (patientMicBtn) { patientMicBtn.classList.add("btn-danger"); patientMicBtn.innerText = "Listening... Tap to Stop"; }
            } else if (channel === "whisper") {
                if (whisperBtn) whisperBtn.classList.add("btn-teal");
            }
        } else {
            if (clinicianWave) clinicianWave.style.opacity = "0";
            if (patientWave) patientWave.style.opacity = "0";

            if (speakBtn) speakBtn.classList.remove("btn-teal");
            if (whisperBtn) whisperBtn.classList.remove("btn-teal");
            if (patientMicBtn) { patientMicBtn.classList.remove("btn-danger"); patientMicBtn.innerText = "Tap to Speak"; }
        }
    }

    processTextForTTS(chunk, isFinal = false) {
        this.currentTextBuffer += chunk;
        const sentences = this.currentTextBuffer.split(/([.?!:;]\s+|[.?!:;]$|\n+)/);
        let completeSentences = [];
        
        for (let i = 0; i < sentences.length - 1; i += 2) {
            const sentence = (sentences[i] + (sentences[i+1] || "")).trim();
            if (sentence.length > 3) {
                completeSentences.push(sentence);
            }
        }

        if (completeSentences.length > 0) {
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

            // Respect patient comfort volume setting
            const volumeMultiplier = this.volume === 'low' ? 0.4 : this.volume === 'high' ? 1.0 : 0.7;
            audio.volume = volumeMultiplier;

            // Trigger AI visualizer ring ripple
            const ringId = this.user.role === "therapist" ? "clinicianOrb" : "patientOrb";
            const ring = document.getElementById(ringId);
            if (ring) ring.classList.add("vis-active");

            await new Promise((resolve) => {
                audio.onended = () => {
                    URL.revokeObjectURL(url);
                    resolve();
                };
                audio.onerror = resolve;
                audio.play().catch(resolve);
            });

            if (ring) ring.classList.remove("vis-active");

        } catch (e) {
            console.error("Queue play error:", e);
        }

        setTimeout(() => this.playNextInTTSQueue(), 150);
    }

    setupVisualizer(stream) {
        try {
            if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
            this.analyser = this.audioCtx.createAnalyser();
            const source = this.audioCtx.createMediaStreamSource(stream);
            source.connect(this.analyser);
            
            const ringId = this.user.role === "therapist" ? "clinicianOrb" : "patientOrb";
            const ring = document.getElementById(ringId);
            if (ring) ring.classList.add("vis-active");

            this.visInterval = setInterval(() => {
                if (this.analyser) {
                    this.analyser.getByteFrequencyData(this.visData);
                }
            }, 60);
        } catch (e) { console.warn("Visualizer init failure", e); }
    }

    stopVisualizer() {
        if (this.visInterval) clearInterval(this.visInterval);
        this.visInterval = null;
        
        const ringId = this.user.role === "therapist" ? "clinicianOrb" : "patientOrb";
        const ring = document.getElementById(ringId);
        if (ring) ring.classList.remove("vis-active");
    }

    _relayPatientAudioToTherapist(blob) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
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

    handlePatientAudioBlob(arrayBuffer) {
        if (this.user.role !== "therapist") return;
        
        if (!this.audioStreamer) {
            const player = document.createElement("audio");
            player.id = "patientAudioPlayer";
            document.body.appendChild(player);
            this.audioStreamer = new PatientAudioStreamer(player);
        }
        
        this.audioStreamer.push(arrayBuffer);
    }

    updateCreditsUI() {
        const mins = Math.max(0, this.remainingCredits).toFixed(1);
        document.querySelectorAll(".minutes-remaining-val").forEach(el => {
            el.innerText = mins;
            if (this.remainingCredits < 5) {
                el.style.color = "var(--red)";
            } else {
                el.style.color = "var(--teal)";
            }
        });
    }

    startClock() {
        if (this.timerInterval) clearInterval(this.timerInterval);
        this.timerInterval = setInterval(() => {
            if (this.isPaused) return;
            this.timerSeconds++;
            
            if (this.sessionActive) {
                this.remainingCredits -= (1 / 60);
                this.updateCreditsUI();
                
                if (this.remainingCredits <= 0) {
                    this.toast("Session balance fully utilized.");
                    this.endSession();
                }
            }

            const m = String(Math.floor(this.timerSeconds / 60)).padStart(2, "0");
            const s = String(this.timerSeconds % 60).padStart(2, "0");
            document.querySelectorAll(".session-timer-val").forEach(el => el.innerText = `${m}:${s}`);
        }, 1000);
    }

    _setSegmentActive(containerId, val) {
        const containers = document.querySelectorAll("#" + containerId + ", ." + containerId);
        containers.forEach(container => {
            container.querySelectorAll(".segment-btn").forEach(btn => {
                btn.classList.toggle("active", btn.innerText.toLowerCase() === val.toLowerCase() || btn.dataset.val === val);
            });
        });
    }

    updateAIStatus(text, isActive) {
        document.querySelectorAll(".ai-status-text").forEach(el => {
            const dot = el.querySelector(".status-dot");
            if (dot) dot.classList.toggle("active", isActive);
            el.innerHTML = `<span class="status-dot ${isActive ? 'active' : ''}"></span>${text}`;
        });
    }

    toast(msg) {
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
            background: "rgba(12, 20, 34, 0.95)", backdropFilter: "blur(12px)", 
            color: "#fff", padding: "12px 28px",
            borderRadius: "100px", zIndex: "100000", fontSize: "13px", fontWeight: "600",
            border: "1px solid var(--border)", pointerEvents: "none",
            boxShadow: "var(--shadow-lg)",
            transition: "all 0.4s cubic-bezier(0.4, 0, 0.2, 1)",
            opacity: "0", filter: "blur(10px)"
        });
        t.innerText = msg;
        document.body.appendChild(t);
        
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

    logout() {
        localStorage.removeItem('access_token');
        localStorage.removeItem('refresh_token');
        sessionStorage.removeItem('access_token');
        sessionStorage.removeItem('refresh_token');
        sessionStorage.removeItem('patient_intake_complete');
        sessionStorage.removeItem('active_session_id');
        sessionStorage.removeItem('is_supervising');
        window.location.href = '/register-login.html';
    }
}

window.dashboard = new TherapyDashboard();