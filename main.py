import os
import uuid
import time
import json
from typing import Dict, List, Optional, Set
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse, RedirectResponse
from pydantic import BaseModel
from dotenv import load_dotenv
from openai import OpenAI
from sqlalchemy.orm import Session
from database import SessionLocal, engine, Base, get_db
from models import User, TherapistProfile, Wallet
from fastapi import Depends, Header

# Create database tables if they don't exist
Base.metadata.create_all(bind=engine)

# --- CONFIG & INITIALIZATION ---
load_dotenv()
from openai import AsyncOpenAI
client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))

app = FastAPI(title="AI Therapy Platform - Production")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- MODELS ---

class UserProfile(BaseModel):
    email: str
    name: str = "Demo User"
    role: str = "patient"  # patient, therapist
    age: str = "25"
    gender: str = "Female"
    credits: float = 25.0

class SignupRequest(BaseModel):
    email: str
    password: str
    full_name: str
    role: str = "therapist"
    license_data: Optional[str] = None
    state: Optional[str] = None
    username: Optional[str] = None

class SessionConfig(BaseModel):
    mode: str = "normal"
    ai_role: str = "therapist"
    patient_age: str = "25"
    patient_sex: str = "Female"
    training_type: str = "trainee_therapist_session"
    approach: str = "CBT"
    custom_instruction: str = ""
    voice_gender: str = "female"
    speed: float = 1.0
    tempo: str = "normal"    # slow | normal | fast
    pitch: str = "normal"    # low | normal | high
    pitch_shift: float = 0.0  # -5 to +5 (best-effort directive)

class SessionState:
    def __init__(self, session_id: str):
        self.session_id = session_id
        self.user_id: Optional[int] = None
        self.email: Optional[str] = None
        self.patient_ws: Optional[WebSocket] = None
        self.patient_name: str = "Patient"
        self.therapist_wss: Set[WebSocket] = set()

        self.session_active = False
        self.paused = False
        self.mode = "normal"
        self.ai_role = "therapist"
        self.instruction_to_ai = ""
        self.approach = "CBT"
        self.patient_age = "25"
        self.patient_sex = "Female"
        self.start_time: Optional[float] = None
        self.minutes_remaining: float = 25.0

        # Voice configuration
        self.voice_gender: str = "female"
        self.speed: float = 1.0
        self.tempo: str = "normal"
        self.pitch: str = "normal"
        self.pitch_shift: float = 0.0

        # Instruction channels (both consumed on next user_message)
        self.therapist_whisper: str = ""        # from whisper mic
        self.therapist_text_instruction: str = ""  # from typed therapist text

        self.transcript: List[Dict] = []
        self.last_sync: float = time.time()


# --- GLOBAL REGISTRIES ---
ACTIVE_SESSIONS: Dict[str, SessionState] = {}
AUTH_USERS: Dict[str, UserProfile] = {
    "patient@demo.com": UserProfile(email="patient@demo.com", name="Alex Patient", role="patient"),
    "therapist@demo.com": UserProfile(email="therapist@demo.com", name="Dr. Sarah Therapist", role="therapist")
}

# --- CORE UTILITIES ---

TEMPO_TO_SPEED = {"slow": 0.75, "normal": 1.0, "fast": 1.25}
PITCH_DIRECTIVES = {
    "low": "(Speak in a deep, low-pitched, calm tone.)",
    "normal": "",
    "high": "(Speak in a slightly higher-pitched, warm tone.)"
}

def get_tts_speed(session: SessionState) -> float:
    """Map tempo string to OpenAI TTS speed float, then apply live speed nudge."""
    base = TEMPO_TO_SPEED.get(session.tempo, 1.0)
    # Apply live speed adjustment (speed field may differ from tempo base if live-tweaked)
    # Use session.speed directly if it has been tweaked away from the tempo default
    tempo_default = TEMPO_TO_SPEED.get(session.tempo, 1.0)
    if abs(session.speed - tempo_default) > 0.01:
        # Live-tweaked; use session.speed
        return max(0.25, min(4.0, session.speed))
    return max(0.25, min(4.0, base))

def get_tts_voice(session: SessionState) -> str:
    """Map voice gender to OpenAI TTS voice name."""
    if session.voice_gender == "male":
        return "onyx"
    return "shimmer"  # female default

def get_system_prompt(session: SessionState) -> str:
    base = (
        "You are an AI on a Clinical Therapy Training & Supervision Platform. "
        f"Therapeutic Approach: {session.approach}. "
    )
    if session.ai_role == "therapist":
        role_desc = f"Role: ACT AS THE THERAPIST. Patient: {session.patient_age}y/o {session.patient_sex}. Methodology: {session.approach}."
    else:
        role_desc = f"Role: ACT AS THE PATIENT. Act as a {session.patient_age}y/o {session.patient_sex} in a therapy session. Respond emotionally to the therapist's questions."

    # Directives from supervisor (Crucial Priority)
    hidden_parts = []
    
    # 1. Permanent session config instructions
    if session.instruction_to_ai:
        hidden_parts.append(f"### [SESSION-LEVEL INSTRUCTIONS]: {session.instruction_to_ai}")
        
    # 2. Dynamic clinician instructions (Highest priority)
    if session.therapist_text_instruction:
        hidden_parts.append(f"### [SUPERVISOR IMMEDIATE DIRECTIVE - DO NOT IGNORE]: {session.therapist_text_instruction}")
        
    if session.therapist_whisper:
        hidden_parts.append(f"### [INSTRUCTOR WHISPER - DO NOT IGNORE]: {session.therapist_whisper}")

    # Pitch/Tone hints
    pitch_hint = PITCH_DIRECTIVES.get(session.pitch, "")
    if pitch_hint:
        hidden_parts.append(f"Tone Hint: {pitch_hint}")

    hidden = ("\n\n" + "\n".join(hidden_parts)) if hidden_parts else ""
    
    # Combine everything. We reinforce instructions by putting them at the VERY end
    # of the system prompt to avoid being overridden by older conversation history.
    return base + role_desc + hidden + "\n\nCRITICAL: Always follow the [SUPERVISOR IMMEDIATE DIRECTIVE] if present, even if it contradicts the previous flow."

async def broadcast_to_session(session: SessionState, message: dict, exclude: Optional[WebSocket] = None):
    targets = []
    if session.patient_ws:
        targets.append(session.patient_ws)
    targets.extend(list(session.therapist_wss))
    for ws in targets:
        if ws == exclude:
            continue
        try:
            await ws.send_json(message)
        except:
            pass

async def broadcast_binary_to_therapists(session: SessionState, data: bytes):
    """Send raw binary audio data to all connected therapists."""
    for ws in list(session.therapist_wss):
        try:
            await ws.send_bytes(data)
        except:
            pass

# --- API ENDPOINTS ---

@app.get("/health")
async def health():
    return {"status": "ok", "sessions": len(ACTIVE_SESSIONS)}

SECRET_KEY = "my_secret_key"
ALGORITHM = "HS256"
import jwt

def create_tokens(user_email: str, role: str):
    payload = {"user_id": user_email, "role": role}
    refresh_payload = {"user_id": user_email, "role": role, "type": "refresh"}
    return {
        "access_token": jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM),
        "refresh_token": jwt.encode(refresh_payload, SECRET_KEY, algorithm=ALGORITHM)
    }

@app.post("/api/auth/login")
@app.post("/auth/login")
async def login(req: Request, db: Session = Depends(get_db)):
    data = await req.json()
    email = data.get("email", "").lower().strip()
    
    # Simple demo accounts shortcut
    if email == "patient": email = "patient@demo.com"
    if email == "therapist": email = "therapist@demo.com"
    
    # Check database
    db_user = db.query(User).filter(User.email == email).first()
    
    if db_user:
        if db_user.role == "therapist":
            status = db_user.profile.approval_status if db_user.profile else "pending"
            if status == "rejected":
                raise HTTPException(status_code=403, detail="Your clinical access application has been rejected. Please contact clinical support for review.")
            if status != "approved":
                raise HTTPException(status_code=403, detail="Your account is pending approval")

        # Update session-level profile info
        user_p = UserProfile(
            email=db_user.email,
            name=db_user.full_name,
            role=db_user.role,
            age=db_user.age or "25",
            gender=db_user.gender or "Female",
            credits=float(db.query(Wallet).filter(Wallet.user_id == db_user.id).first().minutes_remaining) if db.query(Wallet).filter(Wallet.user_id == db_user.id).first() else 15.0
        )
        # Update from request if provided
        age = data.get("age")
        gender = data.get("gender")
        if age: user_p.age = str(age)
        if gender: user_p.gender = str(gender)
        
        # Cache in AUTH_USERS for existing websocket logic
        AUTH_USERS[email] = user_p
        
        print(f"Login successful for {email}")
        tokens = create_tokens(email, db_user.role)
        return {"access_token": tokens["access_token"], "refresh_token": tokens["refresh_token"], "user": user_p.model_dump()}
        
    # Fallback to hardcoded demo users if database is empty/not found
    if email in AUTH_USERS:
        user = AUTH_USERS[email]
        tokens = create_tokens(email, user.role)
        return {"access_token": tokens["access_token"], "refresh_token": tokens["refresh_token"], "user": user.model_dump()}

    raise HTTPException(status_code=401, detail="User not found")

@app.post("/api/auth/signup")
@app.post("/auth/signup")
async def signup(signup_data: SignupRequest, db: Session = Depends(get_db)):
    # Check if user exists
    existing = db.query(User).filter(User.email == signup_data.email.lower()).first()
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    
    # Create new user
    new_user = User(
        email=signup_data.email.lower(),
        full_name=signup_data.full_name,
        password_hash=signup_data.password, # Plain text as per existing demo pattern
        role=signup_data.role,
        username=signup_data.username
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    
    # If therapist, create profile (STRICT PENDING status for review)
    if signup_data.role == "therapist":
        profile = TherapistProfile(user_id=new_user.id, license_data=signup_data.license_data, state_of_licensure=signup_data.state, approval_status="pending")
        db.add(profile)
    
    # Create wallet with 15 minute free session
    wallet = Wallet(user_id=new_user.id, minutes_remaining=15.0)
    db.add(wallet)
    db.commit()
    
    return {"message": "Registration submitted. Pending clinical review."}

# --- ADMIN ENDPOINTS ---

@app.get("/api/admin/users")
async def admin_list_users(db: Session = Depends(get_db)):
    users = db.query(User).all()
    res = []
    for u in users:
        p = u.profile
        res.append({
            "id": u.id,
            "email": u.email,
            "full_name": u.full_name,
            "username": u.username,
            "role": u.role,
            "status": p.approval_status if p else "approved" if u.role == "admin" else "N/A",
            "license": p.license_data if p else "N/A",
            "state_of_licensure": p.state_of_licensure if p else "N/A",
            "created_at": str(u.created_at) if u.created_at else None
        })
    return res

@app.post("/api/admin/update-status/{user_id}")
async def admin_update_status(user_id: int, request: Request, db: Session = Depends(get_db)):
    data = await request.json()
    new_status = data.get("status")
    p = db.query(TherapistProfile).filter(TherapistProfile.user_id == user_id).first()
    if p:
        p.approval_status = new_status
        # If approving, ensure wallet has 15 minutes
        if new_status == "approved":
            w = db.query(Wallet).filter(Wallet.user_id == user_id).first()
            if w and w.minutes_remaining == 0:
                w.minutes_remaining = 15.0
        db.commit()
        return {"message": f"User status updated to {new_status}"}
    raise HTTPException(status_code=404, detail="Profile not found")

@app.post("/api/admin/update-user/{user_id}")
async def admin_update_user(user_id: int, request: Request, db: Session = Depends(get_db)):
    data = await request.json()
    u = db.query(User).filter(User.id == user_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
        
    if "full_name" in data:
        u.full_name = data["full_name"]
    if "email" in data:
        u.email = data["email"]
    if "username" in data:
        u.username = data["username"]
        
    p = db.query(TherapistProfile).filter(TherapistProfile.user_id == user_id).first()
    if p and "state_of_licensure" in data:
        p.state_of_licensure = data["state_of_licensure"]
        
    db.commit()
    return {"message": "User updated successfully"}

@app.get("/api/auth/guest")
async def guest_login():
    guest_id = f"guest_{uuid.uuid4().hex[:8]}"
    tokens = create_tokens(guest_id, "patient")
    # Add dummy user to AUTH_USERS
    AUTH_USERS[guest_id] = UserProfile(email=guest_id, role="patient", name="Guest Patient")
    return {"access_token": tokens["access_token"], "refresh_token": tokens["refresh_token"]}

@app.get("/api/dashboard/bootstrap")
async def dashboard_bootstrap(authorization: str = Header(None), db: Session = Depends(get_db)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    token = authorization.split(" ")[1]
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email = payload.get("user_id")
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")
        
    db_user = db.query(User).filter(User.email == email).first()
    
    if db_user:
        user_profile = {
            "full_name": db_user.full_name, 
            "role": db_user.role, 
            "email": db_user.email,
            "approval_status": db_user.profile.approval_status if db_user.role == "therapist" and db_user.profile else "approved"
        }
        wallet = db.query(Wallet).filter(Wallet.user_id == db_user.id).first()
        mins = float(wallet.minutes_remaining) if wallet else 15.0
        used = wallet.free_session_used if wallet else False
        sub_active = wallet.subscription_active if wallet else False
    elif email in AUTH_USERS:
        user = AUTH_USERS[email]
        user_profile = {"full_name": user.name, "role": user.role, "email": user.email, "approval_status": "approved"}
        mins = float(user.credits)
        used = False
        sub_active = False
    else:
        raise HTTPException(status_code=401, detail="User not found")
        
    return {
        "user_profile": user_profile,
        "wallet_status": {"minutes_remaining": mins, "free_session_used": used, "subscription_active": sub_active},
        "session_eligibility": {"can_start": mins > 0 or sub_active}
    }

@app.post("/api/account/purchase-minutes")
async def purchase_minutes(authorization: str = Header(None), db: Session = Depends(get_db)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = authorization.split(" ")[1]
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email = payload.get("user_id")
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")
        
    db_user = db.query(User).filter(User.email == email).first()
    if not db_user:
        raise HTTPException(status_code=401, detail="User not found")
        
    wallet = db.query(Wallet).filter(Wallet.user_id == db_user.id).first()
    if wallet:
        wallet.minutes_remaining += 100.0
        wallet.total_minutes_purchased += 100.0
        wallet.subscription_active = True
        db.commit()
    return {"status": "success", "message": "Payment processing successful via Stripe mock"}

class RefreshRequest(BaseModel):
    refresh_token: str

@app.post("/api/auth/refresh")
async def refresh_token_endpoint(req: RefreshRequest):
    try:
        payload = jwt.decode(req.refresh_token, SECRET_KEY, algorithms=[ALGORITHM])
        email = payload.get("user_id")
        role = payload.get("role")
        if not email: raise Exception
        tokens = create_tokens(email, role)
        return {"access_token": tokens["access_token"], "refresh_token": tokens["refresh_token"]}
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid refresh token")

@app.post("/api/stt")
async def speech_to_text(request: Request):
    form = await request.form()
    file = form.get("file")
    if not file:
        return {"error": "No file"}
    temp_name = f"tmp_{uuid.uuid4()}.webm"
    try:
        content = await file.read()
        with open(temp_name, "wb") as f:
            f.write(content)
        with open(temp_name, "rb") as f:
            res = await client.audio.transcriptions.create(model="whisper-1", file=f)
        return {"text": res.text}
    except Exception as e:
        print(f"STT Error: {e}")
        return {"error": str(e)}
    finally:
        if os.path.exists(temp_name):
            os.remove(temp_name)

@app.post("/api/tts")
async def text_to_speech(req: Request):
    data = await req.json()

    # Resolve voice
    voice_gender = data.get("voice_gender", "female")
    voice = "shimmer" if voice_gender == "female" else "onyx"

    # Resolve speed: prefer explicit speed, then map tempo
    tempo = data.get("tempo", "normal")
    speed = data.get("speed", None)
    if speed is None:
        speed = TEMPO_TO_SPEED.get(tempo, 1.0)
    speed = max(0.25, min(4.0, float(speed)))

    # Best-effort pitch via emotive prefix in text
    pitch = data.get("pitch", "normal")
    pitch_directive = PITCH_DIRECTIVES.get(pitch, "")
    text = data.get("text", "")
    if pitch_directive:
        text = f"{pitch_directive} {text}".strip()

    try:
        response = await client.audio.speech.create(
            model="tts-1",
            voice=voice,
            input=text,
            speed=speed
        )
        return StreamingResponse(response.iter_bytes(), media_type="audio/mpeg")
    except Exception as e:
        print(f"TTS Error: {e}")
        return HTTPException(status_code=500, detail=str(e))

# --- WEBSOCKET HANDLER ---

@app.websocket("/ws/chat")
async def websocket_chat(websocket: WebSocket):
    await websocket.accept()
    user: Optional[UserProfile] = None
    current_sid: Optional[str] = None

    try:
        while True:
            # Handle both text JSON and binary audio frames
            message = await websocket.receive()

            # --- BINARY: patient audio relay to therapist ---
            if message.get("type") == "websocket.receive" and message.get("bytes"):
                raw_bytes = message["bytes"]
                # Parse first 100 bytes as metadata prefix if present
                # Format: b"AUDIO:<session_id>:<n_bytes>:" + audio_data
                try:
                    prefix_end = raw_bytes.index(b"\x00")
                    meta = raw_bytes[:prefix_end].decode("utf-8")
                    audio_data = raw_bytes[prefix_end + 1:]
                    parts = meta.split(":", 2)
                    if parts[0] == "AUDIO" and len(parts) >= 2:
                        sid = parts[1]
                        session = ACTIVE_SESSIONS.get(sid)
                        if session and session.therapist_wss:
                            await broadcast_binary_to_therapists(session, audio_data)
                except Exception:
                    pass  # Malformed binary, ignore
                continue

            # --- TEXT JSON messages ---
            raw_data = message.get("text", "")
            if not raw_data:
                continue
            data = json.loads(raw_data)
            msg_type = data.get("type")

            # 1. AUTH
            if msg_type == "auth":
                try:
                    payload = jwt.decode(data.get("token", ""), SECRET_KEY, algorithms=[ALGORITHM])
                    email = payload.get("user_id")
                    user = AUTH_USERS.get(email)
                    if not user: raise Exception("No user")
                    await websocket.send_json({"type": "status", "message": f"Welcome {user.name}", "user": user.model_dump()})
                except Exception as e:
                    await websocket.close(code=4401)
                    return
                continue

            # 2. PATIENT SESSION CREATION
            if msg_type == "create_session" and user and user.role == "patient":
                sid = data.get("forced_id") or f"ROOM-{uuid.uuid4().hex[:4].upper()}"
                session = SessionState(sid)
                
                # Link to DB user
                db = next(get_db())
                db_user = db.query(User).filter(User.email == user.email).first()
                if db_user:
                    session.user_id = db_user.id
                    session.email = db_user.email
                    wallet = db.query(Wallet).filter(Wallet.user_id == db_user.id).first()
                    if wallet:
                        session.minutes_remaining = float(wallet.minutes_remaining)
                
                session.patient_ws = websocket
                session.patient_name = user.name
                ACTIVE_SESSIONS[sid] = session
                current_sid = sid
                await websocket.send_json({"type": "session_created", "session_id": sid})
                continue

            # 3. THERAPIST JOIN
            if msg_type == "join_supervision" and user and user.role == "therapist":
                sid = data.get("target_session_id")
                if sid in ACTIVE_SESSIONS:
                    session = ACTIVE_SESSIONS[sid]
                    session.therapist_wss.add(websocket)
                    current_sid = sid
                    await websocket.send_json({
                        "type": "session_sync",
                        "session_id": sid,
                        "patient_name": session.patient_name,
                        "patient_age": session.patient_age,
                        "patient_sex": session.patient_sex,
                        "approach": session.approach,
                        "mode": session.mode,
                        "transcript": session.transcript,
                        "session_active": session.session_active,
                        # Voice config sync
                        "voice_gender": session.voice_gender,
                        "tempo": session.tempo,
                        "pitch": session.pitch,
                        "speed": session.speed,
                        "pitch_shift": session.pitch_shift,
                    })
                    await websocket.send_json({"type": "status", "message": "Joined session silently", "session_id": sid})
                else:
                    await websocket.send_json({"type": "error", "message": "Session not found"})
                continue

            # Every subsequent message needs a session_id
            sid = data.get("session_id")
            session = ACTIVE_SESSIONS.get(sid)
            if not session:
                continue

            # 4. CONFIG & CONTROL
            if msg_type == "session_config" and user:
                session.mode = data.get("mode", session.mode)
                session.ai_role = data.get("ai_role", session.ai_role)
                session.patient_age = data.get("patient_age", session.patient_age)
                session.patient_sex = data.get("patient_sex", session.patient_sex)
                session.approach = data.get("approach", session.approach)
                session.instruction_to_ai = data.get("custom_instruction", session.instruction_to_ai)
                # Voice config (accepted from both patient and therapist)
                session.voice_gender = data.get("voice_gender", session.voice_gender)
                session.speed = float(data.get("speed", session.speed))
                session.tempo = data.get("tempo", session.tempo)
                session.pitch = data.get("pitch", session.pitch)
                session.pitch_shift = float(data.get("pitch_shift", session.pitch_shift))
                await websocket.send_json({"type": "status", "message": "Config Updated"})
                continue

            if msg_type == "session_control":
                cmd = data.get("command")
                if cmd == "START_THERAPY":
                    if session.minutes_remaining < 1:
                        await websocket.send_json({"type": "error", "message": "Insufficient Balance"})
                        continue
                    session.session_active = True
                    session.paused = False
                    session.start_time = time.time()
                    await broadcast_to_session(session, {"type": "status", "message": "Session Started"})
                elif cmd == "PAUSE":
                    session.paused = True
                    await broadcast_to_session(session, {"type": "status", "message": "Session Paused"})
                elif cmd == "RESUME":
                    session.paused = False
                    await broadcast_to_session(session, {"type": "status", "message": "Session Resumed"})
                elif cmd == "STOP":
                    session.session_active = False
                    # Sync back to DB
                    if session.user_id:
                        db = next(get_db())
                        wallet = db.query(Wallet).filter(Wallet.user_id == session.user_id).first()
                        if wallet:
                            wallet.minutes_remaining = session.minutes_remaining
                            wallet.free_session_used = True
                            db.commit()
                            print(f"Synced wallet for user {session.user_id}: {session.minutes_remaining} mins")
                    await broadcast_to_session(session, {"type": "status", "message": "Session Ended"})
                continue

            # 5. SHARED CONVERSATION ROUTING
            if msg_type == "user_message":
                if not session.session_active:
                    await websocket.send_json({"type": "error", "message": "Session not active"})
                    continue
                if session.paused:
                    await websocket.send_json({"type": "status", "message": "Session Paused - Resume to continue"})
                    continue

                text = data.get("text", "")
                session.transcript.append({"role": "patient", "text": text})

                # Broadcast patient text to therapists (fan-out)
                await broadcast_to_session(session, {"type": "monitor_patient_text", "text": text, "session_id": sid}, exclude=websocket)

                # Billing
                if session.start_time:
                    elapsed = (time.time() - session.last_sync) / 60
                    session.minutes_remaining -= elapsed
                    session.last_sync = time.time()
                    await websocket.send_json({"type": "credits", "remaining": round(session.minutes_remaining, 1)})

                # Build AI prompt
                prompt_messages = [{"role": "system", "content": get_system_prompt(session)}]
                for t in session.transcript[-10:]:
                    m_role = "user" if t["role"] == "patient" else "assistant"
                    prompt_messages.append({"role": m_role, "content": t["text"]})

                # Consume both instruction channels after building the prompt
                session.therapist_whisper = ""
                session.therapist_text_instruction = ""

                try:
                    stream = await client.chat.completions.create(model="gpt-4o-mini", messages=prompt_messages, stream=True)
                    full_text = ""
                    async for chunk in stream:
                        delta = chunk.choices[0].delta.content or ""
                        if delta:
                            full_text += delta
                            await websocket.send_json({"type": "chunk", "text": delta})
                            await broadcast_to_session(session, {"type": "monitor_ai_reply", "text": delta, "session_id": sid}, exclude=websocket)

                    session.transcript.append({"role": "ai", "text": full_text})
                    # Send final with voice config so everyone (patient & therapist) plays TTS correctly
                    await broadcast_to_session(session, {
                        "type": "final",
                        "text": full_text,
                        "voice_gender": session.voice_gender,
                        "tempo": session.tempo,
                        "pitch": session.pitch,
                        "speed": session.speed,
                    })
                except Exception as e:
                    print(f"LLM Error: {e}")
                    await websocket.send_json({"type": "error", "message": f"AI Error: {str(e)}"})

            # 6. WHISPER MIC (spoken, private)
            elif msg_type == "whisper" and user and user.role == "therapist":
                session.therapist_whisper = data.get("text", "")
                await websocket.send_json({"type": "status", "message": "Whisper Recorded"})

            # 7. THERAPIST TEXT INSTRUCTION (typed, private directive)
            elif msg_type == "therapist_instruction" and user and user.role == "therapist":
                text = data.get("text", "").strip()
                if text:
                    session.therapist_text_instruction = text
                    await websocket.send_json({"type": "status", "message": "Instruction Sent to AI"})

            # 8. THERAPIST DIRECT MESSAGE (broadcast to log, legacy)
            elif msg_type == "therapist_message" and user and user.role == "therapist":
                text = data.get("text", "")
                await broadcast_to_session(session, {"type": "therapist_reply", "text": text})

    except WebSocketDisconnect:
        if user and current_sid and current_sid in ACTIVE_SESSIONS:
            session = ACTIVE_SESSIONS[current_sid]
            if user.role == "patient":
                session.patient_ws = None
                session.session_active = False
                if not session.therapist_wss:
                    del ACTIVE_SESSIONS[current_sid]
            elif user.role == "therapist":
                session.therapist_wss.discard(websocket)


# --- STATIC FILES & ROUTING ---

# Mount the dashboard assets
app.mount("/dashboard", StaticFiles(directory="frontend-dashboard", html=True), name="dashboard")

# Mount website assets (including images/css subfolders)
app.mount("/assets", StaticFiles(directory="website_files/Ai-Therapy-Website-main/assets"), name="website_assets")

@app.get("/dashboard-app")
@app.get("/dashboard")
@app.get("/dashboard/")
async def dashboard_view():
    return FileResponse("frontend-dashboard/index.html")

@app.get("/")
async def serve_website():
    return FileResponse("website_files/Ai-Therapy-Website-main/index.html")

@app.get("/login.html")
@app.get("/login")
async def login_redirect():
    return RedirectResponse(url="/register-login.html")

# Serve specific HTML files from the website folder
@app.get("/{filename}.html")
async def serve_html(filename: str):
    file_path = os.path.join("website_files/Ai-Therapy-Website-main", f"{filename}.html")
    if os.path.isfile(file_path):
        return FileResponse(file_path)
    # Check dashboard folder too
    dash_path = os.path.join("frontend-dashboard", f"{filename}.html")
    if os.path.isfile(dash_path):
        return FileResponse(dash_path)
    raise HTTPException(status_code=404)

# Fallback for other paths (Legacy/Assets)
@app.get("/{path:path}")
async def catch_all(path: str):
    # Check from main website folder
    file_path = os.path.join("website_files/Ai-Therapy-Website-main", path)
    if os.path.isfile(file_path):
        return FileResponse(file_path)
    
    # Check from dashboard folder
    dash_path = os.path.join("frontend-dashboard", path)
    if os.path.isfile(dash_path):
        return FileResponse(dash_path)
    
    # Default to home if nothing else found
    return FileResponse("website_files/Ai-Therapy-Website-main/index.html")

if __name__ == "__main__":
    import uvicorn
    print("--- PSYCHOTHERAPY NOW SERVER STARTING ---")
    uvicorn.run(app, host="0.0.0.0", port=8000)
