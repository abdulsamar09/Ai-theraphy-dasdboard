/* 
  AI THERAPY PLATFORM - ENTERPRISE LOGIC CONTROLLER
  Implementation: Real-time Microphone STT & AI Voice TTS Response
  
  CLINICAL PRIVACY COMPLIANCE [REQ 3]: 
  - ZERO persistence policy. 
  - NO clinical notes, transcripts, or PHI are saved to any database or local storage.
  - Session state is purely in-memory and lost upon refresh.
*/

const CONFIG = {
  BACKEND_BASE_URL: window.location.origin,
  ENDPOINTS: {
    HEALTH: "/health",
    TTS: "/api/tts",
    STT: "/api/stt"
  }
};

const WS_URL = CONFIG.BACKEND_BASE_URL.replace(/^http/, "ws") + "/ws/chat";

class EnterpriseSession {
  constructor() {
    this.sessionActive = false;
    this.timerSeconds = 0;
    this.timerInterval = null;
    this.isPaused = false;
    this.lastWasWhisper = false;

    // WebSocket state
    this.socket = null;
    this.chatBuffer = "";
    this.currentMode = "normal";
    this.currentRole = "therapist";

    // Voice Config
    this.voiceGender = "female"; // Default
    this.tempo = "normal";
    this.pitch = "normal";
    this.speed = 1.0;
    this.pitch_shift = 0;

    // Media Capture Properties
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.activeMicType = null;

    // Audio Context for unlocking playback
    this.audioCtx = null;

    // UI Refs
    this.timerEl = document.getElementById("sessionTimer");
    this.statusText = document.getElementById("aiStatus");
    this.startTherapyBtn = document.getElementById("startTherapyBtn");
    this.pauseSessionBtn = document.getElementById("pauseSessionBtn");
    this.stopSessionBtn = document.getElementById("stopSessionBtn");

    this.micStateIcon = document.getElementById("micStateIcon");
    this.micStatusLabel = document.getElementById("micStatusLabel");

    this.startPatientBtn = document.getElementById("startPatientBtn");
    this.stopPatientBtn = document.getElementById("stopPatientBtn");
    this.startTherapistBtn = document.getElementById("startTherapistBtn"); // REQ 6
    this.stopTherapistBtn = document.getElementById("stopTherapistBtn");   // REQ 6
    this.startWhisperBtn = document.getElementById("startWhisperBtn");
    this.stopWhisperBtn = document.getElementById("stopWhisperBtn");

    // Supervision Specific Refs
    this.supervisionBanner = document.getElementById("supervisionBanner");
    this.supervisionWhisperPanel = document.getElementById("supervisionWhisperPanel");
    this.supervisionMetricsPanel = document.getElementById("supervisionMetricsPanel");
    this.whisperInput = document.getElementById("whisperInput");
    this.whisperMicBtn = document.getElementById("whisperMicBtn");
    this.aiAnalysisBtn = document.getElementById("aiAnalysisBtn");

    // Inputs
    this.ageInput = document.getElementById("ageInput");
    this.sexInput = document.getElementById("sexInput");

    // AI Feedback Refs
    this.patientTranscript = document.getElementById("patientTranscript");
    this.aiTranscript = document.getElementById("aiTranscript");
    this.whisperActiveIndicator = document.getElementById("whisperActiveIndicator");
    this.speakerVisualizer = document.getElementById("speakerVisualizer");

    // Metrics Refs
    this.emotionalityVal = document.getElementById("emotionalityValue");
    this.emotionalityFill = document.getElementById("emotionalityFill");

    this.init();
  }

  init() {
    console.log("[QA AUDIT] Initializing Dashboard Core...");
    this.updateMicUI("off");
    this.bindEvents();
    this.connectWS();
  }

  unlockAudio() {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
  }

  startTherapy() {
    this.unlockAudio();
    this.wsSend({ type: "session_control", command: "START_THERAPY" });
    this.sessionActive = true;
    this.statusText.innerText = "Session Active";
    if (this.startTherapyBtn) this.startTherapyBtn.style.display = "none";
    if (this.pauseSessionBtn) this.pauseSessionBtn.style.display = "block";
    if (this.stopSessionBtn) this.stopSessionBtn.style.display = "block";

    this.startClock();
    this.updateMicUI("off");
    this.playFeedbackBeep();
  }

  /* ================================
     WEBSOCKET LOGIC
  ==================================*/

  connectWS() {
    this.socket = new WebSocket(WS_URL);

    this.socket.onopen = () => {
      console.log("[WS] Connected to Backend");
      this.sendSessionConfig();
    };

    this.socket.onclose = () => {
      console.warn("[WS] Connection lost, reconnecting...");
      setTimeout(() => this.connectWS(), 2000);
    };

    this.socket.onerror = (err) => console.error("[WS] Socket error", err);

    this.socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === "chunk") {
          const content = data.content || data.text || "";
          if (this.chatBuffer === "") {
            this.statusText.innerText = "AI is Responding...";
            console.time("AI_RESPONSE_TIME");
          }
          this.chatBuffer += content;
          if (this.aiTranscript) {
            const prefix = this.lastWasWhisper ? "AI (WHISPER RESPONSE): " : "AI THERAPIST: ";
            this.aiTranscript.innerText = `${prefix}${this.chatBuffer}...`;
          }
        } else if (data.type === "final") {
          const finalText = data.content || data.text || this.chatBuffer;
          console.timeEnd("AI_RESPONSE_TIME");

          if (this.aiTranscript) {
            const prefix = this.lastWasWhisper ? "AI (WHISPER RESPONSE): " : "AI THERAPIST: ";
            this.aiTranscript.innerText = `${prefix}${finalText}`;
          }
          this.chatBuffer = "";

          if (this.lastWasWhisper) {
            console.log("[QA AUDIT] Whisper response (Silent):", finalText.substring(0, 30));
            this.showToast("AI received instruction");
            this.lastWasWhisper = false; // Reset
          } else {
            console.log("[QA AUDIT] Triggering TTS for normal response");
            this.handleTTSRequest(finalText);
          }
        } else if (data.type === "metrics") {
          if (data.emotionality_score !== undefined) {
            this.updateEmotionality(data.emotionality_score);
          }
        } else if (data.type === "reflection_start") {
          const reflectContent = document.getElementById("reflectionContent");
          if (reflectContent) reflectContent.innerText = "";
        } else if (data.type === "reflection_chunk") {
          const reflectContent = document.getElementById("reflectionContent");
          if (reflectContent) {
            reflectContent.innerHTML += data.text || "";
            reflectContent.scrollTop = reflectContent.scrollHeight;
          }
        } else if (data.type === "reflection_done") {
          this.showToast("Reflection Complete");
        } else if (data.type === "reflection_result") {
          const reflectContent = document.getElementById("reflectionContent");
          if (reflectContent) reflectContent.innerText = data.text;
        }
      } catch (err) {
        console.warn("[WS] Message parsing error", err);
      }
    };
  }

  wsSend(payload) {
    if (this.socket && this.socket.readyState === 1) {
      console.log("[WS] OUT ->", payload.type);
      this.socket.send(JSON.stringify(payload));
    } else {
      this.showToast("Connection Lost. Reconnecting...");
    }
  }

  sendSessionConfig() {
    const payload = {
      type: "session_config",
      mode: this.currentMode,
      ai_role: this.currentRole,
      patient_age: this.ageInput?.value || "",
      patient_sex: this.sexInput?.value || "",
      notes: "",
      voice_gender: this.voiceGender.charAt(0).toUpperCase() + this.voiceGender.slice(1),
      tempo: this.tempo,
      pitch: this.pitch,
      speed: this.speed,
      pitch_shift: this.pitch_shift
    };
    this.wsSend(payload);
  }

  bindEvents() {
    this.startTherapyBtn?.addEventListener("click", () => this.startTherapy());

    // --- MIC CONTROLS [REQ 6] ---
    this.startPatientBtn?.addEventListener("click", () => { this.unlockAudio(); this.startRecording("patient"); });
    this.stopPatientBtn?.addEventListener("click", () => { this.stopRecording(); });

    this.startTherapistBtn?.addEventListener("click", () => { this.unlockAudio(); this.startRecording("therapist"); });
    this.stopTherapistBtn?.addEventListener("click", () => { this.stopRecording(); });

    this.startWhisperBtn?.addEventListener("click", () => { this.unlockAudio(); this.startRecording("whisper"); });
    this.stopWhisperBtn?.addEventListener("click", () => { this.stopRecording(); });

    // --- SUPERVISION CONTROLS ---
    this.whisperMicBtn?.addEventListener("click", () => { this.unlockAudio(); this.startRecording("whisper"); });
    this.aiAnalysisBtn?.addEventListener("click", () => this.requestAIAnalysis());

    this.whisperInput?.addEventListener("keypress", (e) => {
      if (e.key === "Enter" && this.whisperInput.value.trim() !== "") {
        const text = this.whisperInput.value.trim();
        this.lastWasWhisper = true;
        this.wsSend({ type: "whisper", text: text });
        this.whisperInput.value = "";
        this.showToast("Whisper Command Sent");
      }
    });

    // --- MODE SWITCHING ---
    document.querySelectorAll(".tab-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        this.currentMode = btn.dataset.mode;

        // Update visibility of Supervision panels
        const isSupervision = this.currentMode === "supervision";
        const isRoleplay = this.currentMode === "roleplay";

        if (this.supervisionBanner) this.supervisionBanner.style.display = isSupervision ? "block" : "none";
        if (this.supervisionWhisperPanel) this.supervisionWhisperPanel.style.display = isSupervision ? "block" : "none";
        // if (this.supervisionMetricsPanel) this.supervisionMetricsPanel.style.display = isSupervision ? "block" : "none";

        const rpPanel = document.getElementById("roleplayOptions");
        if (rpPanel) rpPanel.style.display = isRoleplay ? "block" : "none";

        this.sendSessionConfig();
      });
    });

    // --- ROLE PLAY TOGGLES ---
    document.querySelectorAll(".rp-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".rp-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        this.currentRole = btn.dataset.role;
        this.sendSessionConfig();
      });
    });

    // --- VOICE CONTROLS ---
    document.querySelectorAll(".segment-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const parent = btn.closest(".segment-control");
        parent.querySelectorAll(".segment-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");

        const label = btn.closest(".setting-row")?.querySelector("label")?.innerText;
        if (label === "Voice Gender" || label === "Gender Preference") {
          // QA FIX: Ensure the value sent to backend is what it expects.
          // If "female" works but "male" doesn't, we check capitalization.
          this.voiceGender = btn.innerText.toLowerCase();
          console.log("[QA AUDIT] voiceGender changed to:", this.voiceGender);
        } else if (label === "Speech Tempo") {
          this.tempo = btn.dataset.val;
        } else if (label === "Speech Pitch") {
          this.pitch = btn.dataset.val;
        }
        this.sendSessionConfig();
      });
    });

    // --- LIVE ADJUST ---
    document.getElementById("adjFaster")?.addEventListener("click", () => { this.speed = Math.min(1.3, this.speed + 0.05); this.sendSessionConfig(); });
    document.getElementById("adjSlower")?.addEventListener("click", () => { this.speed = Math.max(0.7, this.speed - 0.05); this.sendSessionConfig(); });
    document.getElementById("adjHigher")?.addEventListener("click", () => { this.pitch_shift += 1; this.sendSessionConfig(); });
    document.getElementById("adjLower")?.addEventListener("click", () => { this.pitch_shift -= 1; this.sendSessionConfig(); });

    // --- SESSION CONTROLS ---
    this.pauseSessionBtn?.addEventListener("click", () => {
      this.isPaused = !this.isPaused;
      const command = this.isPaused ? "PAUSE" : "RESUME";
      this.wsSend({ type: "session_control", command: command });
      this.pauseSessionBtn.innerText = this.isPaused ? "RESUME" : "PAUSE";
      this.statusText.innerText = this.isPaused ? "Session Paused" : "Therapy Session Active";

      if (this.aiAnalysisBtn) {
        this.aiAnalysisBtn.disabled = !this.isPaused;
      }
    });

    const modal = document.getElementById("modal");
    this.stopSessionBtn?.addEventListener("click", () => modal.classList.add("active"));
    document.getElementById("cancelModal")?.addEventListener("click", () => modal.classList.remove("active"));
    document.getElementById("confirmEnd")?.addEventListener("click", () => {
      this.wsSend({ type: "session_control", command: "STOP" });
      this.endSession();
      modal.classList.remove("active");
      if (this.aiAnalysisBtn) this.aiAnalysisBtn.disabled = true;
    });
  }

  /* ================================
     MICROPHONE LOGIC
  ==================================*/

  async startRecording(type) {
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      this.showToast("Error: Browser lacks recording features.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';

      this.mediaRecorder = new MediaRecorder(stream, { mimeType: mimeType });
      this.audioChunks = [];
      this.activeMicType = type;

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.audioChunks.push(e.data);
      };

      this.mediaRecorder.onstop = async () => {
        const blob = new Blob(this.audioChunks, { type: mimeType });
        await this.sendToSTT(blob, type);
        stream.getTracks().forEach(track => track.stop());
      };

      this.mediaRecorder.start();
      this.updateMicUI("on", type);
    } catch (err) {
      console.error("[MIC ERROR]", err);
      this.showToast(`Microphone error: ${err.name}`);
      this.updateMicUI("off");
    }
  }

  stopRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      this.mediaRecorder.stop();
      this.updateMicUI("off");
    }
  }

  updateMicUI(state, type) {
    const disabled = !this.sessionActive;

    // Patient Mic
    if (this.startPatientBtn) this.startPatientBtn.disabled = disabled || state === "on";
    if (this.stopPatientBtn) this.stopPatientBtn.disabled = state !== "on" || this.activeMicType !== "patient";

    // Therapist Mic
    if (this.startTherapistBtn) this.startTherapistBtn.disabled = disabled || state === "on";
    if (this.stopTherapistBtn) this.stopTherapistBtn.disabled = state !== "on" || this.activeMicType !== "therapist";

    // Whisper Mics
    if (this.startWhisperBtn) this.startWhisperBtn.disabled = disabled || state === "on";
    if (this.stopWhisperBtn) this.stopWhisperBtn.disabled = state !== "on" || this.activeMicType !== "whisper";
    if (this.whisperMicBtn) this.whisperMicBtn.disabled = disabled || state === "on";

    const wave = document.getElementById("audioWave");
    if (state === "on") {
      if (type === "patient") {
        this.micStateIcon.style.background = "#22c55e"; // Green
        this.micStatusLabel.innerText = "Listening to Patient";
      } else if (type === "therapist") {
        this.micStateIcon.style.background = "#3b82f6"; // Blue
        this.micStatusLabel.innerText = "Listening to Therapist";
      } else if (type === "whisper") {
        this.micStateIcon.style.background = "#a855f7"; // Purple
        this.micStatusLabel.innerText = "Whisper Mode Active";
        if (this.whisperActiveIndicator) this.whisperActiveIndicator.style.display = "block";
      }
      this.micStateIcon.classList.add("recording");
      if (wave) wave.style.opacity = "1";
    } else {
      this.micStateIcon.style.background = "#94a3b8";
      this.micStateIcon.classList.remove("recording");
      this.micStatusLabel.innerText = "Not Listening";
      if (this.whisperActiveIndicator) this.whisperActiveIndicator.style.display = "none";
      if (wave) wave.style.opacity = "0";
      this.activeMicType = null;
    }
  }

  async sendToSTT(blob, channel) {
    console.time("STT_TIME");
    const formData = new FormData();
    formData.append("file", blob, "recording.webm");
    formData.append("channel", channel);

    try {
      this.statusText.innerText = "AI is Thinking...";
      const response = await fetch(`${CONFIG.BACKEND_BASE_URL}/api/stt`, {
        method: "POST",
        body: formData
      });
      console.timeEnd("STT_TIME");

      if (!response.ok) throw new Error("STT Request Failed");

      const result = await response.json();
      if (result.text) {
        if (channel === "patient" || channel === "therapist") {
          const prefix = channel === "patient" ? "PATIENT: " : "THERAPIST: ";
          if (this.patientTranscript) {
            this.patientTranscript.innerText = `${prefix}${result.text}`;
          }
          if (this.sessionActive) {
            this.lastWasWhisper = false;
            this.wsSend({ type: "user_message", text: result.text });
          }
        } else if (channel === "whisper") {
          console.log("[SUPERVISION] Private Instruction Captured");
          this.lastWasWhisper = true;
          this.wsSend({ type: "whisper", text: result.text });
          this.showToast("Private Whisper Sent");
        }
      }
    } catch (err) {
      console.error("[STT ERROR]", err);
      this.showToast("STT Processing Error");
    } finally {
      this.statusText.innerText = this.sessionActive ? "Session Active" : "Setup Mode: Adjust parameters and click Start Therapy";
    }
  }

  requestAIAnalysis() {
    this.unlockAudio();
    if (!this.isPaused) {
      this.showToast("Pause the session first to request Clinical Reflection.");
      return;
    }
    const reflectContent = document.getElementById("reflectionContent");
    if (reflectContent) reflectContent.innerText = "Analyzing session history...";
    this.wsSend({ type: "clinical_reflection" });
    this.showToast("Generating Clinical Reflection...");
  }

  async handleTTSRequest(text) {
    if (!text || text.trim().length === 0) return;

    try {
      console.time("TTS_LATENCY");
      const response = await fetch(`${CONFIG.BACKEND_BASE_URL}/api/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: text,
          voice_gender: this.voiceGender.charAt(0).toUpperCase() + this.voiceGender.slice(1),
          tempo: this.tempo,
          pitch: this.pitch,
          speed: this.speed,
          pitch_shift: this.pitch_shift
        })
      });

      if (!response.ok) throw new Error("TTS Request Failed");

      const blob = await response.blob();
      console.timeEnd("TTS_LATENCY");
      this.playAudio(blob);
    } catch (err) {
      console.error("[TTS ERROR]", err);
    }
  }

  playAudio(blob) {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);

    if (this.speakerVisualizer) this.speakerVisualizer.style.opacity = "1";
    const ring = document.querySelector(".avatar-ring");

    audio.play().catch(e => {
      this.showToast("Click anywhere to hear AI");
      document.body.addEventListener('click', () => audio.play(), { once: true });
    });

    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (this.speakerVisualizer) this.speakerVisualizer.style.opacity = "0";
      if (ring) {
        ring.style.boxShadow = "";
        ring.style.transform = "";
      }
    };
  }

  playFeedbackBeep() {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.05, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.1);
    } catch (e) { }
  }

  /* ================================
     ANALYTICS & UI
  ==================================*/

  startClock() {
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.timerInterval = setInterval(() => {
      if (!this.sessionActive || this.isPaused) return;
      this.timerSeconds++;
      if (this.timerEl) {
        const m = String(Math.floor(this.timerSeconds / 60)).padStart(2, '0');
        const s = String(this.timerSeconds % 60).padStart(2, '0');
        this.timerEl.innerText = `${m}:${s}`;
      }
    }, 1000);
  }

  updateEmotionality(val) {
    if (!this.emotionalityFill || !this.emotionalityVal) return;
    this.emotionalityFill.style.width = `${val}%`;
    this.emotionalityVal.innerText = `${val}%`;

    if (val <= 30) this.emotionalityFill.style.background = "#38bdf8"; // Low (Blue)
    else if (val <= 70) this.emotionalityFill.style.background = "var(--color-primary)"; // Moderate (Green)
    else this.emotionalityFill.style.background = "#ef4444"; // High (Red)
  }

  showToast(msg) {
    const toast = document.createElement("div");
    Object.assign(toast.style, {
      position: "fixed", bottom: "30px", left: "50%", transform: "translateX(-50%)",
      background: "#38bdf8", color: "#000", padding: "10px 20px", borderRadius: "8px",
      fontSize: "13px", fontWeight: "bold", zIndex: "10000", border: "1px solid #334155",
      boxShadow: "0 5px 15px rgba(0,0,0,0.4)", pointerEvents: "none"
    });
    toast.innerText = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
  }

  endSession() {
    this.sessionActive = false;
    this.isPaused = false;
    clearInterval(this.timerInterval);
    this.statusText.innerText = "Session ended. No data stored.";
    this.statusText.style.color = "var(--color-danger)";
    this.updateMicUI("off");
    document.querySelectorAll(".ctrl-btn").forEach(b => b.disabled = true);
    if (this.aiAnalysisBtn) this.aiAnalysisBtn.disabled = true;
    document.querySelector(".avatar-core").style.background = "#334155";
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new EnterpriseSession();
});