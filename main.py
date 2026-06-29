import os
import httpx
import uuid
import time
import json
import smtplib
import asyncio
from typing import Dict, List, Optional, Set
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, HTTPException, Depends, Header, BackgroundTasks
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse, RedirectResponse
from pydantic import BaseModel
from dotenv import load_dotenv
from openai import OpenAI
from sqlalchemy import func, or_
from sqlalchemy.orm import Session
from database import SessionLocal, engine, Base, get_db
from models import User, TherapistProfile, Wallet
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.utils import formatdate, make_msgid, formataddr

from email.mime.application import MIMEApplication
from fpdf import FPDF
import time

# Create database tables if they don't exist
Base.metadata.create_all(bind=engine)

# Load environment variables
load_dotenv()

# --- EMAIL CONFIG ---
SMTP_SERVER = "smtp.aol.com"
SMTP_PORT = 465
SMTP_USER = os.getenv("SMTP_USER", "jonkogen@aol.com")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM_NAME = "Psychotherapy Now"

def build_email_msg(to_email: str, subject: str, text_body: str, html_body: str) -> MIMEMultipart:
    """Build a properly-structured email message with anti-spam headers."""
    msg = MIMEMultipart('alternative')
    msg['From'] = formataddr((SMTP_FROM_NAME, SMTP_USER))
    msg['To'] = to_email
    msg['Subject'] = subject
    msg['Date'] = formatdate(localtime=True)
    msg['Message-ID'] = make_msgid(domain='aol.com')
    msg['Reply-To'] = SMTP_USER
    msg.attach(MIMEText(text_body, 'plain', 'utf-8'))
    msg.attach(MIMEText(html_body, 'html', 'utf-8'))
    return msg

def send_email(msg: MIMEMultipart, label: str, to_email: str):
    """Send an email message via SMTP with logging."""
    with smtplib.SMTP_SSL(SMTP_SERVER, SMTP_PORT, timeout=15) as server:
        server.login(SMTP_USER, SMTP_PASSWORD)
        server.send_message(msg)
    print(f"--- EMAIL SENT SUCCESS ({label}): {to_email} ---")

def get_html_template(title: str, headline: str, content_html: str) -> str:
    return f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; font-family:Arial, Helvetica, sans-serif; color:#333333;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f5f5; padding:20px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background-color:#ffffff; border:1px solid #dddddd;">
          <tr>
            <td style="background-color:#1a1a2e; padding:20px; text-align:center;">
              <h1 style="color:#ffffff; margin:0; font-size:20px; font-weight:bold;">{headline}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:24px; font-size:15px; line-height:1.6; color:#333333;">
              {content_html}
            </td>
          </tr>
          <tr>
            <td style="padding:16px; text-align:center; font-size:12px; color:#888888; border-top:1px solid #eeeeee;">
              Psychotherapy Now
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
"""

def send_approval_email(to_email: str, full_name: str):
    print(f"--- ATTEMPTING TO SEND APPROVAL EMAIL TO: {to_email} ---")
    try:
        text = f"""Dear {full_name},

Congratulations! Your therapist account on Psychotherapy Now has been approved by our Clinical Review Team.

You can now log in to the therapist dashboard and start hosting therapy sessions. As a welcome bonus, your account has been credited with a free 20-minute practice session.

Please log in using the link below:
https://psychotherapynow.net/register-login.html

Best regards,
The Clinical Review Team
Psychotherapy Now"""

        html_content = f"""
        <p>Dear {full_name},</p>
        <p>Congratulations! We are pleased to inform you that your therapist account on <strong>Psychotherapy Now</strong> has been successfully reviewed and approved by our Clinical Review Team.</p>
        <p>You can now log in to access your therapist dashboard and start using the platform. As a welcome bonus, your account has been credited with a <strong>free 20-minute practice session</strong> to help you get started.</p>
        <p style="text-align:center; margin:24px 0;">
          <a href="https://psychotherapynow.net/register-login.html" style="background-color:#1a1a2e; color:#ffffff; text-decoration:none; padding:12px 28px; font-weight:bold; display:inline-block;">Log In to Dashboard</a>
        </p>
        <p>If you have any questions or require assistance setting up your profile, please do not hesitate to contact our therapist support desk.</p>
        <p>Best regards,<br><strong>The Clinical Review Team</strong><br>Psychotherapy Now</p>
        """
        html = get_html_template("Account Approved", "Account Approved!", html_content)
        msg = build_email_msg(to_email, "Your Therapist Account has been Approved! - Psychotherapy Now", text, html)
        send_email(msg, "Approval", to_email)
    except Exception as e:
        print(f"--- SMTP ERROR (Approval): {str(e)} ---")
        import traceback
        traceback.print_exc()

def send_rejection_email(to_email: str, full_name: str):
    print(f"--- ATTEMPTING TO SEND REJECTION EMAIL TO: {to_email} ---")
    try:
        text = f"""Dear {full_name},

Thank you for your interest in joining Psychotherapy Now.

After carefully reviewing your application and credentials, our Clinical Review Team has determined that we are unable to approve your therapist account at this time.

If you believe this is a mistake or if you have updated credential documentation, please reply to this email or contact our therapist support team.

Best regards,
The Clinical Review Team
Psychotherapy Now"""

        html_content = f"""
        <p>Dear {full_name},</p>
        <p>Thank you for your interest in joining <strong>Psychotherapy Now</strong>.</p>
        <p>After carefully reviewing your submitted credentials and application, we regret to inform you that we are unable to approve your therapist account at this time.</p>
        <p>If you believe there has been a misunderstanding, or if you have additional supporting documentations to provide, please reach out to our therapist support team for assistance.</p>
        <p>Best regards,<br><strong>The Clinical Review Team</strong><br>Psychotherapy Now</p>
        """
        html = get_html_template("Application Update", "Application Update", html_content)
        msg = build_email_msg(to_email, "Update on Your Therapist Application - Psychotherapy Now", text, html)
        send_email(msg, "Rejection", to_email)
    except Exception as e:
        print(f"--- SMTP ERROR (Rejection): {str(e)} ---")
        import traceback
        traceback.print_exc()

def send_welcome_email(to_email: str, full_name: str):
    print(f"--- ATTEMPTING TO SEND WELCOME EMAIL TO: {to_email} ---")
    try:
        text = f"""Dear {full_name},

Thank you for registering with Psychotherapy Now.

We have successfully received your therapist application. Our team is currently reviewing your state credentials and license documentation.

Once approved, you can log in directly to access your 20-minute free practice demo automatically in your account dashboard. You will receive an email notification as soon as your account is approved.

Best regards,
The Clinical Review Team
Psychotherapy Now"""

        html_content = f"""
        <p>Dear {full_name},</p>
        <p>Thank you for registering with <strong>Psychotherapy Now</strong>.</p>
        <p>We have successfully received your therapist application. Our Clinical Review Team is currently validating your state licensing details and documents.</p>
        <p>Once approved, you can log in directly to access your 20-minute free practice demo automatically in your account dashboard. We will email you with an account activation notice as soon as the review process is complete.</p>
        <p>Best regards,<br><strong>The Clinical Review Team</strong><br>Psychotherapy Now</p>
        """
        html = get_html_template("Application Received", "Application Received", html_content)
        msg = build_email_msg(to_email, "Registration Received - Psychotherapy Now", text, html)
        send_email(msg, "Welcome", to_email)
    except Exception as e:
        print(f"--- SMTP ERROR (Welcome): {str(e)} ---")
        import traceback
        traceback.print_exc()

def send_password_recovery_email(to_email: str, full_name: str, password_hash: str):
    print(f"--- ATTEMPTING TO SEND PASSWORD RECOVERY EMAIL TO: {to_email} ---")
    try:
        text = f"""Dear {full_name},

We received a request to recover your password for your Psychotherapy Now account.

Your current account password is: {password_hash}

If you did not request this, please secure your account immediately or contact our support team.

Best regards,
The Support Team
Psychotherapy Now"""

        html_content = f"""
        <p>Dear {full_name},</p>
        <p>We received a request to retrieve the password associated with your account on <strong>Psychotherapy Now</strong>.</p>
        <p>Your current password is:</p>
        <p style="background-color:#f1f5f9; border:1px dashed #cccccc; padding:18px; text-align:center; font-size:20px; font-family:monospace; font-weight:bold; color:#1a1a2e; letter-spacing:1px; margin:24px 0;">{password_hash}</p>
        <p>Please log in using this password. If you did not request this information, you can safely ignore this email, or reach out to our support team if you have concerns.</p>
        <p>Best regards,<br><strong>The Support Team</strong><br>Psychotherapy Now</p>
        """
        html = get_html_template("Password Recovery", "Password Recovery", html_content)
        msg = build_email_msg(to_email, "Password Recovery - Psychotherapy Now", text, html)
        send_email(msg, "Password Recovery", to_email)
    except Exception as e:
        print(f"--- SMTP ERROR (Password Recovery): {str(e)} ---")
        import traceback
        traceback.print_exc()

def send_admin_notification_email(user_email: str, full_name: str, user_id: int, base_url: str):
    recipient = "jonkogen@aol.com"
    print(f"--- ATTEMPTING TO SEND ADMIN NOTIFICATION TO: {recipient} ---")
    try:
        approve_link = f"{base_url}api/admin/quick-approve/{user_id}"
        dashboard_link = f"{base_url}admin.html"

        text = f"""Hello Admin,

A new therapist has registered on the platform and is waiting for approval.

Details:
Name: {full_name}
Email: {user_email}

Click the link below to APPROVE this therapist instantly:
{approve_link}

Or view full details in the Admin Dashboard:
{dashboard_link}

Clinical Platform System"""

        html_content = f"""
        <p>Hello Admin,</p>
        <p>A new therapist has registered on the platform and is waiting for approval.</p>
        <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px; margin: 20px 0;">
          <strong>Name:</strong> {full_name}<br>
          <strong>Email:</strong> {user_email}
        </div>
        <p style="text-align:center; margin:24px 0;">
          <a href="{approve_link}" style="background-color:#1a1a2e; color:#ffffff; text-decoration:none; padding:12px 28px; font-weight:bold; display:inline-block;">Approve Instantly</a>
        </p>
        <p>Or view full details in the <a href="{dashboard_link}">Admin Dashboard</a>.</p>
        <p>Clinical Platform System</p>
        """
        html = get_html_template("New Registration", "New Therapist Registered", html_content)
        msg = build_email_msg(recipient, f"New Therapist Registration: {full_name}", text, html)
        send_email(msg, "Admin Notification", recipient)
    except Exception as e:
        print(f"--- SMTP ERROR (Admin Notification): {str(e)} ---")
        import traceback
        traceback.print_exc()

def send_payment_invoice_email(to_email: str, full_name: str, amount: float, minutes: float):
    print(f"--- ATTEMPTING TO SEND INVOICE EMAIL TO: {to_email} ---")
    try:
        # 1. Generate PDF
        pdf = FPDF()
        pdf.add_page()
        pdf.set_font("Helvetica", "B", 20)
        pdf.cell(0, 20, "INVOICE - Clinical Platform", ln=True, align='C')
        pdf.ln(10)
        
        pdf.set_font("Helvetica", "B", 12)
        pdf.cell(100, 10, "Billed To:")
        pdf.cell(0, 10, "Invoice Details:", ln=True)
        
        pdf.set_font("Helvetica", "", 12)
        pdf.cell(100, 8, full_name)
        pdf.cell(0, 8, f"Date: {time.strftime('%Y-%m-%d')}", ln=True)
        pdf.cell(100, 8, to_email)
        pdf.cell(0, 8, f"Invoice #: INV-{uuid.uuid4().hex[:6].upper()}", ln=True)
        pdf.ln(15)
        
        # Table Header
        pdf.set_fill_color(240, 240, 240)
        pdf.set_font("Helvetica", "B", 12)
        pdf.cell(140, 12, "Description", 1, 0, 'L', True)
        pdf.cell(0, 12, "Amount", 1, 1, 'C', True)
        
        # Table Content
        pdf.set_font("Helvetica", "", 12)
        pdf.cell(140, 12, f"Clinical Minutes Top-up ({int(minutes)} minutes)", 1)
        pdf.cell(0, 12, f"${amount:.2f}", 1, 1, 'C')
        pdf.ln(10)
        
        pdf.set_font("Helvetica", "B", 14)
        pdf.cell(140, 12, "Total Paid:", 0, 0, 'R')
        pdf.cell(0, 12, f"${amount:.2f}", 0, 1, 'C')
        
        pdf.ln(20)
        pdf.set_font("Helvetica", "I", 10)
        pdf.cell(0, 10, "Thank you for supporting Clinical Precision.", ln=True, align='C')
        
        pdf_filename = f"invoice_{uuid.uuid4().hex[:8]}.pdf"
        pdf.output(pdf_filename)

        # 2. Send Email
        msg = MIMEMultipart('alternative')
        msg['From'] = SMTP_USER
        msg['To'] = to_email
        msg['Subject'] = f"Payment Successful: {int(minutes)} Clinical Minutes Added"

        text = f"""Dear {full_name},

Thank you for your purchase. We have successfully added {int(minutes)} clinical minutes to your account balance.

Your invoice is attached to this email.

Best regards,
The Clinical Platform Team"""

        html_content = f"""
        <p>Dear {full_name},</p>
        <p>Thank you for your purchase. We have successfully added <strong>{int(minutes)} clinical minutes</strong> to your account balance.</p>
        <p>Your official invoice has been generated and is attached to this email as a PDF.</p>
        <p>Best regards,<br><strong>The Clinical Platform Team</strong></p>
        """
        html = get_html_template("Payment Successful", "Payment Received", html_content)

        msg.attach(MIMEText(text, 'plain'))
        msg.attach(MIMEText(html, 'html'))

        with open(pdf_filename, "rb") as f:
            attach = MIMEApplication(f.read(), _subtype="pdf")
            attach.add_header('Content-Disposition', 'attachment', filename="Invoice.pdf")
            msg.attach(attach)

        with smtplib.SMTP_SSL(SMTP_SERVER, SMTP_PORT, timeout=15) as server:
            server.login(SMTP_USER, SMTP_PASSWORD)
            server.send_message(msg)
            
        if os.path.exists(pdf_filename):
            os.remove(pdf_filename)
            
        print(f"--- INVOICE EMAIL SENT SUCCESS: {to_email} ---")
    except Exception as e:
        print(f"--- SMTP ERROR (Invoice): {str(e)} ---")
        import traceback
        traceback.print_exc()

# --- APP CONFIG ---
load_dotenv()
from openai import AsyncOpenAI
client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))

app = FastAPI(title="Psychotherapy Now - Production")

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
    age: str = "Pending"
    gender: str = "Pending"
    credits: float = 100.0

class SignupRequest(BaseModel):
    email: str
    password: str
    full_name: str
    role: str = "therapist"
    license_data: Optional[str] = None
    state: Optional[str] = None
    username: Optional[str] = None
    degree: Optional[str] = None
    license_type: Optional[str] = None
    license_number: Optional[str] = None

class SessionConfig(BaseModel):
    mode: str = "normal"
    ai_role: str = "therapist"
    patient_age: str = "Pending"
    patient_sex: str = "Pending"
    training_type: str = "trainee_therapist_session"
    approach: str = "CBT"
    special_instructions: str = ""
    voice_gender: str = "female"
    speed: float = 1.0
    tempo: str = "normal"    # slow | normal | fast
    pitch: str = "normal"    # low | normal | high
    pitch_shift: float = 0.0  # -5 to +5 (best-effort directive)

class InviteRequest(BaseModel):
    session_id: str
    email: str
    patient_link: str

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
        self.patient_age = "Pending"
        self.patient_sex = "Pending"
        self.session_mode = "supervised_client"
        self.patient_profile = {}
        self.roleplay_profile = {}
        self.start_time: Optional[float] = None
        self.minutes_remaining: float = 100.0
        self.therapist_emails: Set[str] = set()

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
        self.therapist_name: str = "Dr. Alex Thompson"


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
    tempo_default = TEMPO_TO_SPEED.get(session.tempo, 1.0)
    if abs(session.speed - tempo_default) > 0.01:
        return max(0.25, min(4.0, session.speed))
    return max(0.25, min(4.0, base))

def get_tts_voice(session: SessionState) -> str:
    """Map voice gender to OpenAI TTS voice name."""
    if session.voice_gender == "male":
        return "onyx"
    return "shimmer"

def load_master_prompt():
    # Attempt to load master therapist instructions from file
    for name in ["Master_Therapist_Instructions_FINAL .txt", "Master_Therapist_Instructions_FINAL.txt"]:
        if os.path.exists(name):
            try:
                with open(name, "r", encoding="utf-8") as f:
                    return f.read()
            except Exception as e:
                print(f"Error reading {name}: {e}")
    # Hardcoded fallback if file is missing
    return (
        "MASTER THERAPIST INSTRUCTIONS\n\n"
        "You are an AI reflective tool used within psychotherapy under supervision.\n"
        "You integrate Gestalt, NLP, and Behavioral therapies fluidly. You never adhere to one modality. "
        "You respond moment-to-moment based on the patient's current experience. Focus on behavioral options."
    )

MASTER_THERAPIST_PROMPT = load_master_prompt()

def get_system_prompt(session: SessionState) -> str:
    mode = getattr(session, "session_mode", "supervised_client")
    ai_role = getattr(session, "ai_role", "therapist")
    
    base = "You are an AI on a Clinical Therapy Training & Supervision Platform called Psychotherapy Now.\n\n"
    
    if ai_role == "patient":
        # AI is patient, trainee is therapist.
        profile = getattr(session, "patient_profile", {})
        age = profile.get("age", session.patient_age or "30")
        gender = profile.get("gender", session.patient_sex or "Male")
        problem = profile.get("presenting_problem", "mild depression and difficulty sleeping")
        personality = profile.get("personality_style", "guarded and hesitant")
        diagnosis = profile.get("diagnosis", "Adjustment Disorder")
        
        role_desc = (
            "Role: ACT AS THE PATIENT.\n"
            f"You must strictly act as a simulated patient in a therapy session. Do NOT act as a therapist.\n"
            f"Your Patient Profile:\n"
            f"- Age: {age}\n"
            f"- Gender: {gender}\n"
            f"- Presenting Problem: {problem}\n"
            f"- Personality/Behavior Style: {personality}\n"
            f"- Diagnosis/Complexity: {diagnosis}\n"
            "Stay in character at all times. Respond emotionally, share your simulated thoughts and feelings, "
            "and answer the therapist's questions as a client would. Do not break character."
        )
        prompt = base + role_desc
    else:
        # AI is therapist. Incorporate the Master Therapist Instructions!
        prompt = base + MASTER_THERAPIST_PROMPT + "\n\n"
        
        if mode == "supervised_client":
            age = session.patient_age or "25"
            sex = session.patient_sex or "Female"
            role_desc = (
                "Role: ACT AS THE THERAPIST under direct live supervision.\n"
                f"You are conducting a live session with a client ({age}y/o {sex}).\n"
                "A licensed therapist is supervising this session and may send you private directives or instructions. "
                "Respond directly to the client as their therapist, keeping your tone professional, empathetic, and therapeutically sound. "
                "Maintain clinical boundaries."
            )
        elif mode == "clinician_as_client":
            role_desc = (
                "Role: ACT AS THE THERAPIST.\n"
                "You are conducting a session where the user is a therapist experiencing the session as a client (for personal exploration or training).\n"
                "Help them explore their thoughts/feelings from the client's perspective."
            )
        elif mode == "ai_therapist_training":
            roleplay = getattr(session, "roleplay_profile", {})
            client_type = roleplay.get("client_type", "Adult client")
            presenting_problem = roleplay.get("presenting_problem", "anxiety and work stress")
            training_inst = roleplay.get("training_instructions", "")
            
            role_desc = (
                "Role: ACT AS THE THERAPIST (Training Modality).\n"
                "You are acting as the therapist in a simulated training session.\n"
                f"The trainee is role-playing a client described as: {client_type}.\n"
                f"Presenting Problem of the simulated client: {presenting_problem}.\n"
            )
            if training_inst:
                role_desc += f"Training Focus / Setup: {training_inst}\n"
        else:
            role_desc = "Role: ACT AS THE THERAPIST."
            
        prompt += role_desc

    # Directives from supervisor (Crucial Priority)
    hidden_parts = []
    
    # 1. Permanent session config instructions (Special Instructions)
    if session.instruction_to_ai:
        hidden_parts.append(f"### [SPECIAL INSTRUCTIONS - CRITICAL]: {session.instruction_to_ai}")
        
    # 2. Dynamic clinician instructions (Highest priority)
    if session.therapist_text_instruction:
        hidden_parts.append(f"### [SUPERVISOR IMMEDIATE DIRECTIVE - DO NOT IGNORE]: {session.therapist_text_instruction}")
        
    if session.therapist_whisper:
        hidden_parts.append(f"### [INSTRUCTOR WHISPER - DO NOT IGNORE]: {session.therapist_whisper}")

    # Pitch/Tone hints
    pitch_hint = PITCH_DIRECTIVES.get(session.pitch, "")
    if pitch_hint:
        hidden_parts.append(f"Tone Hint: {pitch_hint}")

    if hidden_parts:
        prompt += "\n\n" + "\n".join(hidden_parts)
        
    prompt += "\n\nCRITICAL: Always follow the [SUPERVISOR IMMEDIATE DIRECTIVE] if present, even if it contradicts the previous flow."
    return prompt

async def check_and_apply_chat_commands(session: SessionState, text: str) -> bool:
    lower_text = text.lower().strip()
    mode_changed = False
    
    # Check for "role play a patient" or similar (sets ai_role=patient under training therapist mode)
    if any(phrase in lower_text for phrase in [
        "role play a patient", "roleplay a patient", "role-play a patient",
        "act as a patient", "be a patient", "be the patient", "simulate a patient",
        "role play client", "roleplay client", "role-play client", "act as a client",
        "play a patient", "play patient", "play a client", "play client",
        "role play patient", "roleplay patient", "role-play patient"
    ]):
        session.session_mode = "ai_therapist_training"
        session.ai_role = "patient"
        mode_changed = True
    # Check for "role play a therapist" / training modality (Mode 1)
    # Check this FIRST before clinician_as_client to avoid ambiguity
    elif any(phrase in lower_text for phrase in [
        "role play a therapist", "roleplay a therapist", "role-play a therapist",
        "act as a therapist", "be the therapist", "be a therapist", "training modality",
        "trainee role play", "trainee role-play", "trainee roleplay", "trainee",
        "play a therapist", "play therapist", "role play therapist", "roleplay therapist",
        "role-play therapist"
    ]):
        session.session_mode = "ai_therapist_training"
        session.ai_role = "therapist"
        mode_changed = True
    # Check for "clinician as client" or "me as client" (Mode 4)
    elif any(phrase in lower_text for phrase in [
        "clinician as client", "me as client", "i will be client", "i will be the client",
        "i am client", "i am the client", "experience as a client", "explore as client",
        "therapist as client"
    ]):
        session.session_mode = "clinician_as_client"
        session.ai_role = "therapist"
        mode_changed = True
    # Check for "regular session" or "supervised session" (Mode 3)
    elif any(phrase in lower_text for phrase in [
        "regular session", "supervised session", "supervise my client", 
        "supervise with my client", "conduct a regular session"
    ]):
        session.session_mode = "supervised_client"
        session.ai_role = "therapist"
        mode_changed = True

    if mode_changed:
        # Broadcast the updated config to all participants in the session
        await broadcast_to_session(session, {
            "type": "session_sync",
            "session_id": session.session_id,
            "patient_name": session.patient_name,
            "patient_age": session.patient_age,
            "patient_sex": session.patient_sex,
            "approach": session.approach,
            "mode": session.mode,
            "session_mode": session.session_mode,
            "patient_profile": session.patient_profile,
            "roleplay_profile": session.roleplay_profile,
            "transcript": session.transcript,
            "session_active": session.session_active,
            "voice_gender": session.voice_gender,
            "tempo": session.tempo,
            "pitch": session.pitch,
            "speed": session.speed,
            "pitch_shift": session.pitch_shift,
            "minutes_remaining": round(session.minutes_remaining, 1),
            "special_instructions": session.instruction_to_ai,
            "therapist_name": session.therapist_name
        })
        
        # Send a status message to acknowledge the switch
        await broadcast_to_session(session, {
            "type": "status",
            "message": f"Session Mode switched dynamically to: {session.session_mode.replace('_', ' ').title()}"
        })
        return True
    return False

async def broadcast_to_session(session: SessionState, message: dict, exclude: Optional[WebSocket] = None):
    # Send to patient (strip clinical-only private keys)
    if session.patient_ws and session.patient_ws != exclude:
        try:
            pat_msg = dict(message)
            pat_msg.pop("special_instructions", None)
            pat_msg.pop("patient_profile", None)
            pat_msg.pop("roleplay_profile", None)
            pat_msg.pop("therapist_whisper", None)
            pat_msg.pop("therapist_text_instruction", None)
            await session.patient_ws.send_json(pat_msg)
        except:
            pass

    # Send to therapists (keep all keys)
    for ws in list(session.therapist_wss):
        if ws != exclude:
            try:
                await ws.send_json(message)
            except:
                pass

async def session_credit_deductor():
    """Background task to deduct credits every 10 seconds for all active sessions."""
    while True:
        await asyncio.sleep(10)
        # Create a list of keys to avoid 'dictionary changed size during iteration'
        for sid in list(ACTIVE_SESSIONS.keys()):
            session = ACTIVE_SESSIONS.get(sid)
            if not session: continue
            
            if session.session_active and not session.paused:
                now = time.time()
                elapsed = (now - session.last_sync) / 60.0
                session.minutes_remaining = max(0, session.minutes_remaining - elapsed)
                session.last_sync = now
                
                # Broadcast live update
                await broadcast_to_session(session, {
                    "type": "credits", 
                    "remaining": round(session.minutes_remaining, 1)
                })
                
                # Periodic Sync to DB (every cycle now for better persistence on reload)
                if session.user_id:
                    try:
                        db = next(get_db())
                        wallet = db.query(Wallet).filter(Wallet.user_id == session.user_id).first()
                        if wallet:
                            wallet.minutes_remaining = max(0, session.minutes_remaining)
                            db.commit()
                    except Exception as e:
                        print(f"Periodic sync error: {e}")

                # Auto-stop if empty
                if session.minutes_remaining <= 0:
                    session.session_active = False
                    await broadcast_to_session(session, {
                        "type": "status", 
                        "message": "Session ended: Your clinical trial minutes have been fully utilized. Please top up to continue clinical practice."
                    })

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(session_credit_deductor())

async def broadcast_binary_to_therapists(session: SessionState, data: bytes, exclude: Optional[WebSocket] = None):
    """Send raw binary audio data to all connected therapists."""
    for ws in list(session.therapist_wss):
        if ws != exclude:
            try:
                await ws.send_bytes(data)
            except:
                pass

# --- API ENDPOINTS ---

@app.get("/health")
async def health():
    return {"status": "ok", "sessions": len(ACTIVE_SESSIONS)}

import subprocess
DEPLOY_TOKEN = os.getenv("DEPLOY_TOKEN", "pt-deploy-nchynoneytibofjy-2024")

@app.post("/api/deploy")
async def deploy_webhook(request: Request):
    """Secure deployment webhook - pulls latest code from GitHub and restarts service."""
    token = request.headers.get("X-Deploy-Token", "")
    if token != DEPLOY_TOKEN:
        raise HTTPException(status_code=403, detail="Forbidden")
    try:
        result = subprocess.run(
            "cd /home/ubuntu/app && git fetch origin main && git reset --hard origin/main && sudo systemctl restart therapy",
            shell=True, capture_output=True, text=True, timeout=60
        )
        return {
            "status": "deployed",
            "stdout": result.stdout[-500:] if result.stdout else "",
            "stderr": result.stderr[-200:] if result.stderr else "",
            "returncode": result.returncode
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

SECRET_KEY = os.getenv("SECRET_KEY", "my_secret_key")
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
    
    # Check database (by email or username)
    db_user = db.query(User).filter(
        or_(
            User.email == email,
            func.lower(User.username) == email
        )
    ).first()
    
    if db_user:
        # Verify password
        password = data.get("password", "")
        if db_user.password_hash != password:
            raise HTTPException(status_code=401, detail="Incorrect password")

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
            credits=float(db.query(Wallet).filter(Wallet.user_id == db_user.id).first().minutes_remaining) if db.query(Wallet).filter(Wallet.user_id == db_user.id).first() else 20.0
        )
        # Update from request if provided
        age = data.get("age")
        gender = data.get("gender")
        if age: user_p.age = str(age)
        if gender: user_p.gender = str(gender)
        
        # Cache in AUTH_USERS for existing websocket logic
        AUTH_USERS[db_user.email] = user_p
        
        print(f"Login successful for {db_user.email}")
        tokens = create_tokens(db_user.email, db_user.role)
        return {"access_token": tokens["access_token"], "refresh_token": tokens["refresh_token"], "user": user_p.model_dump()}
        
    # Fallback to hardcoded demo users if database is empty/not found
    elif email in AUTH_USERS:
        user_profile = AUTH_USERS[email]
        # Check for live session for guest
        live_session = next((s for s in ACTIVE_SESSIONS.values() if s.email == email), None)
        mins = float(live_session.minutes_remaining) if live_session else 25.0
        used = False
        sub_active = False
        user_profile.credits = mins
        tokens = create_tokens(email, user_profile.role)
        return {"access_token": tokens["access_token"], "refresh_token": tokens["refresh_token"], "user": user_profile.model_dump()}

    raise HTTPException(status_code=401, detail="User not found")

@app.post("/api/auth/signup")
@app.post("/auth/signup")
async def signup(signup_data: SignupRequest, background_tasks: BackgroundTasks, request: Request, db: Session = Depends(get_db)):
    # Check if user exists
    existing = db.query(User).filter(User.email == signup_data.email.lower()).first()
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
        
    # Check if username already exists
    if signup_data.username:
        username_check = db.query(User).filter(func.lower(User.username) == signup_data.username.lower()).first()
        if username_check:
            raise HTTPException(status_code=400, detail="Username already registered")
    
    # Create new user
    new_user = User(
        email=signup_data.email.lower(),
        full_name=signup_data.full_name,
        password_hash=signup_data.password, # Plain text as per existing demo pattern
        role=signup_data.role,
        username=signup_data.username,
        fixed_room_id=f"ROOM-{uuid.uuid4().hex[:4].upper()}"
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    
    # Create initial wallet with 20 minute free session
    new_wallet = Wallet(user_id=new_user.id, minutes_remaining=20.0, free_session_used=False)
    db.add(new_wallet)
    
    # If therapist, create profile (STRICT PENDING status for review)
    if signup_data.role == "therapist":
        profile = TherapistProfile(
            user_id=new_user.id, 
            license_data=signup_data.license_data, 
            state_of_licensure=signup_data.state, 
            approval_status="pending", 
            degree=signup_data.degree, 
            license_type=signup_data.license_type, 
            license_number=signup_data.license_number
        )
        db.add(profile)
        
    db.commit()
    
    # Send Welcome Email
    background_tasks.add_task(send_welcome_email, new_user.email, new_user.full_name)
    
    # Send Admin Notification Email with Quick Approve Link
    base_url = str(request.base_url)
    background_tasks.add_task(send_admin_notification_email, new_user.email, new_user.full_name, new_user.id, base_url)
    
    return {"message": "Registration submitted. Pending clinical review."}

@app.post("/api/auth/forgot-password")
async def forgot_password(request: Request, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    data = await request.json()
    email = data.get("email", "").lower().strip()
    u = db.query(User).filter(User.email == email).first()
    if not u:
        raise HTTPException(status_code=404, detail="Email address not found")

    background_tasks.add_task(send_password_recovery_email, u.email, u.full_name, u.password_hash)
    return {"message": "Password recovery email sent successfully!"}

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
            "full_name": f"{u.full_name}, {p.degree}" if (p and getattr(p, 'degree', None)) else u.full_name,
            "username": u.username,
            "role": u.role,
            "status": p.approval_status if p else "approved" if u.role == "admin" else "N/A",
            "license": p.license_data if p else "N/A",
            "state_of_licensure": p.state_of_licensure if p else "N/A",
            "license_type": p.license_type if p else "N/A",
            "license_number": p.license_number if p else "N/A",
            "created_at": str(u.created_at) if u.created_at else None
        })
    return res

@app.get("/api/admin/quick-approve/{user_id}")
async def admin_quick_approve(user_id: int, request: Request, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    p = db.query(TherapistProfile).filter(TherapistProfile.user_id == user_id).first()
    if p:
        if p.approval_status != "approved":
            p.approval_status = "approved"
            u = db.query(User).filter(User.id == user_id).first()
            if u:
                background_tasks.add_task(send_approval_email, u.email, u.full_name)
            db.commit()
        return RedirectResponse(url="/admin.html")
    raise HTTPException(status_code=404, detail="Profile not found")

@app.post("/api/admin/update-status/{user_id}")
async def admin_update_status(user_id: int, request: Request, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    data = await request.json()
    new_status = data.get("status")
    p = db.query(TherapistProfile).filter(TherapistProfile.user_id == user_id).first()
    if p:
        p.approval_status = new_status
        # If approving, ensure wallet has 20 minutes
        if new_status == "approved":
            u = db.query(User).filter(User.id == user_id).first()
            if u:
                background_tasks.add_task(send_approval_email, u.email, u.full_name)
        elif new_status == "rejected":
            u = db.query(User).filter(User.id == user_id).first()
            if u:
                background_tasks.add_task(send_rejection_email, u.email, u.full_name)
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
    if p:
        if "state_of_licensure" in data:
            p.state_of_licensure = data["state_of_licensure"]
        if "degree" in data:
            p.degree = data["degree"]
        if "license_type" in data:
            p.license_type = data["license_type"]
        if "license_number" in data:
            p.license_number = data["license_number"]
        
    db.commit()
    return {"message": "User updated successfully"}

@app.post("/api/session/send-invite")
async def send_session_invite(invite_req: InviteRequest, background_tasks: BackgroundTasks):
    email = invite_req.email.lower().strip()
    session_id = invite_req.session_id.strip()
    patient_link = invite_req.patient_link.strip()
    
    if not email or not session_id or not patient_link:
        raise HTTPException(status_code=400, detail="Missing required parameters")
        
    try:
        text = f"""Hello,
        
You have been invited to join a secure, confidential clinical therapy session on Psychotherapy Now.

Please click the link below to join the session:
{patient_link}

Session ID: {session_id}

Best regards,
Psychotherapy Now Team"""

        html_content = f"""
        <p>Hello,</p>
        <p>You have been invited to join a secure, confidential clinical therapy session on <strong>Psychotherapy Now</strong>.</p>
        <p>Please click the button below to join the session:</p>
        <p style="text-align:center; margin:24px 0;">
          <a href="{patient_link}" style="background-color:#20bfe9; color:#050914; text-decoration:none; padding:12px 28px; font-weight:bold; display:inline-block; border-radius:6px; box-shadow: 0 4px 10px rgba(32,191,233,0.25);">Join Session</a>
        </p>
        <p style="font-size: 12px; color: #888888;">If the button above does not work, copy and paste this link into your browser: <br> {patient_link}</p>
        <p><strong>Session ID:</strong> {session_id}</p>
        <p>Best regards,<br>Psychotherapy Now Team</p>
        """
        html = get_html_template("Therapy Session Invitation", "Therapy Session Invitation", html_content)
        msg = build_email_msg(email, f"Invitation to Join Secure Therapy Session (ID: {session_id})", text, html)
        
        background_tasks.add_task(send_email, msg, "Session Invite", email)
        return {"message": "Invite sent successfully."}
    except Exception as e:
        print(f"Invite send error: {e}")
        raise HTTPException(status_code=500, detail="Invite could not be sent. Please try again.")

@app.get("/api/auth/guest")
async def guest_login():
    guest_id = f"guest_{uuid.uuid4().hex[:8]}"
    tokens = create_tokens(guest_id, "patient")
    # Add dummy user to AUTH_USERS
    AUTH_USERS[guest_id] = UserProfile(email=guest_id, role="patient", name="Guest Patient")
    return {"access_token": tokens["access_token"], "refresh_token": tokens["refresh_token"]}

@app.get("/api/dashboard/bootstrap")
async def dashboard_bootstrap(room_id: Optional[str] = None, authorization: str = Header(None), db: Session = Depends(get_db)):
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
        # Lazy-generate fixed_room_id for existing accounts that don't have one
        if not db_user.fixed_room_id:
            db_user.fixed_room_id = f"ROOM-{uuid.uuid4().hex[:4].upper()}"
            db.commit()

        # Cache in AUTH_USERS for WebSocket lookup
        if db_user.email not in AUTH_USERS:
            gender = db_user.gender or "Pending"
            age = db_user.age or "Pending"
            AUTH_USERS[db_user.email] = UserProfile(
                email=db_user.email,
                role=db_user.role,
                name=db_user.full_name,
                age=str(age),
                gender=str(gender)
            )

        user_profile = {
            "full_name": db_user.full_name, 
            "role": db_user.role, 
            "email": db_user.email,
            "approval_status": db_user.profile.approval_status if db_user.role == "therapist" and db_user.profile else "approved",
            "fixed_room_id": db_user.fixed_room_id
        }
        
        wallet = db.query(Wallet).filter(Wallet.user_id == db_user.id).first()
        if not wallet:
            wallet = Wallet(user_id=db_user.id, minutes_remaining=20.0)
            db.add(wallet)
            db.commit()
            db.refresh(wallet)
        
        # Clinical Room Logic: If we are in a therapist's room, show THEIR balance
        if room_id and db_user.role == "patient":
            owner = db.query(User).filter(User.fixed_room_id == room_id, User.role == "therapist").first()
            if owner:
                owner_wallet = db.query(Wallet).filter(Wallet.user_id == owner.id).first()
                if owner_wallet:
                    wallet = owner_wallet
                    print(f"[Bootstrap] Syncing patient {email} with therapist room {room_id} balance.")

        # Check if there's a live session balance to report
        live_session = None
        for sid, s in ACTIVE_SESSIONS.items():
            if s.user_id == db_user.id or s.email == email:
                live_session = s
                break
        
        if live_session:
            mins = float(live_session.minutes_remaining)
        else:
            mins = float(wallet.minutes_remaining) if wallet else 20.0
        used = wallet.free_session_used if wallet else False
        sub_active = wallet.subscription_active if wallet else False
    elif email in AUTH_USERS or (email and email.startswith("guest_")):
        if email not in AUTH_USERS:
            AUTH_USERS[email] = UserProfile(email=email, role="patient", name="Guest Patient")
        user = AUTH_USERS[email]
        user_profile = {
            "full_name": user.name, 
            "role": user.role, 
            "email": user.email, 
            "approval_status": "approved",
            "fixed_room_id": user.email # Use guest ID as their fixed room
        }
        
        # Clinical Room Logic: If guest is in a therapist's room, show THEIR balance
        if room_id:
            owner = db.query(User).filter(User.fixed_room_id == room_id, User.role == "therapist").first()
            if owner:
                owner_wallet = db.query(Wallet).filter(Wallet.user_id == owner.id).first()
                if owner_wallet:
                    print(f"[Bootstrap] Syncing GUEST {email} with therapist room {room_id} balance.")
                    return {
                        "user_profile": user_profile,
                        "wallet_status": {"minutes_remaining": float(owner_wallet.minutes_remaining), "free_session_used": owner_wallet.free_session_used, "subscription_active": owner_wallet.subscription_active},
                        "session_eligibility": {"can_start": True}
                    }

        # Check for live session for guest
        live_session = next((s for s in ACTIVE_SESSIONS.values() if s.email == email), None)
        # Guests default to 20.0 trial balance unless in an active session
        mins = float(live_session.minutes_remaining) if live_session else 20.0
        
        used = False
        sub_active = False
    else:
        raise HTTPException(status_code=401, detail="User not found")
        
    return {
        "user_profile": user_profile,
        "wallet_status": {"minutes_remaining": mins, "free_session_used": used, "subscription_active": sub_active},
        "session_eligibility": {"can_start": mins > 0 or sub_active}
    }

async def get_paypal_access_token(client_id: str, client_secret: str, live: bool = False) -> str:
    url = "https://api-m.paypal.com/v1/oauth2/token" if live else "https://api-m.sandbox.paypal.com/v1/oauth2/token"
    async with httpx.AsyncClient() as client:
        response = await client.post(
            url,
            auth=(client_id, client_secret),
            data={"grant_type": "client_credentials"},
            headers={"Accept": "application/json", "Accept-Language": "en_US"}
        )
        if response.status_code == 200:
            return response.json()["access_token"]
        else:
            raise Exception(f"Failed to get PayPal token: {response.text}")

async def verify_paypal_order(order_id: str, client_id: str, client_secret: str, live: bool = False) -> bool:
    try:
        token = await get_paypal_access_token(client_id, client_secret, live)
        url = f"https://api-m.paypal.com/v2/checkout/orders/{order_id}" if live else f"https://api-m.sandbox.paypal.com/v2/checkout/orders/{order_id}"
        async with httpx.AsyncClient() as client:
            response = await client.get(
                url,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {token}"
                }
            )
            if response.status_code == 200:
                order_data = response.json()
                status = order_data.get("status")
                if status == "COMPLETED":
                    purchase_units = order_data.get("purchase_units", [])
                    if purchase_units:
                        amount_val = purchase_units[0].get("amount", {}).get("value")
                        if float(amount_val) >= 24.00:
                            return True
                return False
            else:
                return False
    except Exception as e:
        print(f"PayPal verification error: {e}")
        return False

class PurchaseRequest(BaseModel):
    order_id: str

@app.post("/api/account/purchase-minutes")
async def purchase_minutes(
    req: PurchaseRequest,
    background_tasks: BackgroundTasks,
    authorization: str = Header(None),
    db: Session = Depends(get_db)
):
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
        
    if db_user.role != "therapist":
        raise HTTPException(status_code=403, detail="Only therapists can purchase clinical minutes.")
        
    paypal_client_id = os.getenv("PAYPAL_CLIENT_ID")
    paypal_client_secret = os.getenv("PAYPAL_CLIENT_SECRET")
    paypal_mode = os.getenv("PAYPAL_MODE", "sandbox")
    
    verified = False
    if not paypal_client_secret:
        print("[PAYMENT WARNING] PAYPAL_CLIENT_SECRET not set. Bypassing validation (development mode).")
        verified = True
    else:
        verified = await verify_paypal_order(
            req.order_id,
            paypal_client_id or "",
            paypal_client_secret,
            live=(paypal_mode == "live")
        )
        
    if not verified:
        raise HTTPException(status_code=400, detail="PayPal payment verification failed.")

    wallet = db.query(Wallet).filter(Wallet.user_id == db_user.id).first()
    if wallet:
        wallet.minutes_remaining += 60.0
        wallet.total_minutes_purchased += 60.0
        wallet.subscription_active = True
        db.commit()
        
        # Send Invoice Email
        background_tasks.add_task(send_payment_invoice_email, db_user.email, db_user.full_name, 24.0, 60.0)
        
        # BROADCAST UPDATE: If user is in any active sessions, update them live
        new_mins = float(wallet.minutes_remaining)
        for sid, session in ACTIVE_SESSIONS.items():
            # Check if this user is the owner (patient) or an attached therapist
            is_participant = (session.user_id == db_user.id) or (email in session.therapist_emails)
            
            if is_participant:
                session.minutes_remaining = new_mins
                await broadcast_to_session(session, {"type": "credits", "remaining": round(new_mins, 1)})

    return {"status": "success", "message": "Payment processing successful", "new_balance": wallet.minutes_remaining if wallet else 0}

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
            res = await client.audio.transcriptions.create(
                model="whisper-1",
                file=f
            )
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
async def generate_ai_response(session: SessionState, sid: str):
    is_to_therapist = False
    if session.transcript and session.transcript[-1]["role"] == "therapist":
        is_to_therapist = True

    prompt_messages = [{"role": "system", "content": get_system_prompt(session)}]
    for t in session.transcript[-10:]:
        m_role = "assistant" if t["role"] in ["ai", "ai_private"] else "user"
        prompt_messages.append({"role": m_role, "content": t["text"]})

    session.therapist_whisper = ""
    session.therapist_text_instruction = ""

    try:
        stream = await client.chat.completions.create(model="gpt-4o-mini", messages=prompt_messages, stream=True)
        full_text = ""
        async for chunk in stream:
            delta = chunk.choices[0].delta.content or ""
            if delta:
                full_text += delta
                # Send chunk to patient
                if session.patient_ws and not is_to_therapist:
                    try:
                        await session.patient_ws.send_json({"type": "chunk", "text": delta})
                    except:
                        pass
                # Send monitor_ai_reply to therapists
                for ws in list(session.therapist_wss):
                    try:
                        await ws.send_json({"type": "monitor_ai_reply", "text": delta, "session_id": sid})
                    except:
                        pass

        role_to_store = "ai_private" if is_to_therapist else "ai"
        session.transcript.append({"role": role_to_store, "text": full_text})
        
        # Send final message
        if is_to_therapist:
            for ws in list(session.therapist_wss):
                try:
                    await ws.send_json({
                        "type": "final_private",
                        "text": full_text,
                        "voice_gender": session.voice_gender,
                        "tempo": session.tempo,
                        "pitch": session.pitch,
                        "speed": session.speed,
                    })
                except:
                    pass
        else:
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
        if session.patient_ws:
            try:
                await session.patient_ws.send_json({"type": "error", "message": f"AI Error: {str(e)}"})
            except:
                pass
        for ws in list(session.therapist_wss):
            try:
                await ws.send_json({"type": "error", "message": f"AI Error: {str(e)}"})
            except:
                pass

# --- WEBSOCKET HANDLER ---

@app.websocket("/ws/chat")
async def websocket_chat(websocket: WebSocket):
    await websocket.accept()
    user: Optional[UserProfile] = None
    current_sid: Optional[str] = None

    try:
        while True:
            try:
                # Handle both text JSON and binary audio frames
                message = await websocket.receive()
            except (WebSocketDisconnect, RuntimeError):
                print(f"[WS] Client disconnected or session closed.")
                break

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
                            await broadcast_binary_to_therapists(session, audio_data, exclude=websocket)
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
                    
                    # Auto-register guest if not in AUTH_USERS
                    if email and email.startswith("guest_") and email not in AUTH_USERS:
                        AUTH_USERS[email] = UserProfile(email=email, role="patient", name="Guest Patient")
                        
                    user = AUTH_USERS.get(email)
                    
                    # If not in AUTH_USERS (e.g. after server restart), check the database
                    if not user:
                        db = next(get_db())
                        db_user = db.query(User).filter(User.email == email).first()
                        if db_user:
                            gender = db_user.gender or "Pending"
                            age = db_user.age or "Pending"
                            user_p = UserProfile(
                                email=db_user.email,
                                role=db_user.role,
                                name=db_user.full_name,
                                age=str(age),
                                gender=str(gender)
                            )
                            AUTH_USERS[db_user.email] = user_p
                            user = user_p
                            
                    if not user:
                        raise Exception("No user")
                    await websocket.send_json({"type": "status", "message": f"Welcome {user.name}", "user": user.model_dump()})
                except Exception as e:
                    await websocket.close(code=4401)
                    return
                continue

            # 2. PATIENT SESSION CREATION
            if msg_type == "create_session" and user and user.role == "patient":
                sid = data.get("forced_id") or f"ROOM-{uuid.uuid4().hex[:4].upper()}"
                
                if sid not in ACTIVE_SESSIONS:
                    session = SessionState(sid)
                    
                    db = next(get_db())
                    # Check if this room belongs to a therapist (Clinical Room Sync)
                    room_owner = db.query(User).filter(User.fixed_room_id == sid, User.role == "therapist").first()
                    
                    if room_owner:
                        # Clinical Mode: Use therapist's wallet even when patient starts the session
                        print(f"Clinical Room {sid} detected (Owner: {room_owner.email}). Syncing therapist minutes.")
                        session.user_id = room_owner.id
                        session.email = room_owner.email
                        session.therapist_name = room_owner.full_name
                        wallet = db.query(Wallet).filter(Wallet.user_id == room_owner.id).first()
                    else:
                        # Individual Mode: Use patient's own balance
                        db_user = db.query(User).filter(User.email == user.email).first()
                        if db_user:
                            session.user_id = db_user.id
                            session.email = db_user.email
                            wallet = db.query(Wallet).filter(Wallet.user_id == db_user.id).first()
                        else:
                            wallet = None

                    if wallet:
                        session.minutes_remaining = float(wallet.minutes_remaining)
                    
                    ACTIVE_SESSIONS[sid] = session
                
                session = ACTIVE_SESSIONS[sid]
                session.patient_ws = websocket
                session.patient_name = user.name
                current_sid = sid
                await websocket.send_json({
                    "type": "session_created", 
                    "session_id": sid,
                    "minutes_remaining": round(session.minutes_remaining, 1)
                })
                # Send initial session sync state to the patient
                await websocket.send_json({
                    "type": "session_sync",
                    "session_id": sid,
                    "patient_name": session.patient_name,
                    "patient_age": session.patient_age,
                    "patient_sex": session.patient_sex,
                    "approach": session.approach,
                    "mode": session.mode,
                    "session_mode": getattr(session, "session_mode", "supervised_client"),
                    "transcript": session.transcript,
                    "session_active": session.session_active,
                    "patient_online": True,
                    "elapsed_seconds": int(time.time() - session.start_time) if (session.session_active and session.start_time) else 0,
                    "voice_gender": session.voice_gender,
                    "tempo": session.tempo,
                    "pitch": session.pitch,
                    "speed": session.speed,
                    "pitch_shift": session.pitch_shift,
                    "minutes_remaining": round(session.minutes_remaining, 1),
                    "therapist_name": session.therapist_name
                })
                continue

            # 3. THERAPIST JOIN
            if msg_type == "join_supervision" and user and user.role == "therapist":
                sid = data.get("target_session_id")
                if sid not in ACTIVE_SESSIONS:
                    session = SessionState(sid)
                    db = next(get_db())
                    db_user = db.query(User).filter(User.email == user.email).first()
                    if db_user:
                        session.user_id = db_user.id
                        session.email = db_user.email
                        wallet = db.query(Wallet).filter(Wallet.user_id == db_user.id).first()
                        if wallet:
                            session.minutes_remaining = float(wallet.minutes_remaining)
                    ACTIVE_SESSIONS[sid] = session
                    
                session = ACTIVE_SESSIONS[sid]
                session.therapist_wss.add(websocket)
                session.therapist_emails.add(user.email)
                if user and hasattr(user, "name") and user.name:
                    session.therapist_name = user.name
                
                # SYNC: When a clinician joins, the session uses THEIR wallet balance
                db = next(get_db())
                db_user = db.query(User).filter(User.email == user.email).first()
                if db_user:
                    session.therapist_name = db_user.full_name
                    wallet = db.query(Wallet).filter(Wallet.user_id == db_user.id).first()
                    if wallet:
                        # Transfer billing ownership to this therapist
                        session.user_id = db_user.id
                        session.minutes_remaining = float(wallet.minutes_remaining)
                        print(f"Session {sid} now using therapist {db_user.id} balance: {session.minutes_remaining}")
                        # Immediately broadcast to sync patient's UI
                        await broadcast_to_session(session, {"type": "credits", "remaining": round(session.minutes_remaining, 1)})
                        
                        # Also confirm to the therapist they are joined
                        await websocket.send_json({
                            "type": "session_sync",
                            "session_id": sid,
                            "minutes_remaining": session.minutes_remaining,
                            "status": "Joined Successfully"
                        })

                current_sid = sid
                # Broadcast session_sync to everyone so patient dashboard receives the updated therapist name and configuration
                await broadcast_to_session(session, {
                    "type": "session_sync",
                    "session_id": sid,
                    "patient_name": session.patient_name,
                    "patient_age": session.patient_age,
                    "patient_sex": session.patient_sex,
                    "approach": session.approach,
                    "mode": session.mode,
                    "session_mode": getattr(session, "session_mode", "supervised_client"),
                    "patient_profile": getattr(session, "patient_profile", {}),
                    "roleplay_profile": getattr(session, "roleplay_profile", {}),
                    "transcript": session.transcript,
                    "session_active": session.session_active,
                    "patient_online": session.patient_ws is not None,
                    "elapsed_seconds": int(time.time() - session.start_time) if (session.session_active and session.start_time) else 0,
                    # Voice config sync
                    "voice_gender": session.voice_gender,
                    "tempo": session.tempo,
                    "pitch": session.pitch,
                    "speed": session.speed,
                    "pitch_shift": session.pitch_shift,
                    "minutes_remaining": round(session.minutes_remaining, 1),
                    "special_instructions": session.instruction_to_ai,
                    "therapist_name": session.therapist_name
                })
                await websocket.send_json({"type": "status", "message": "Joined session silently", "session_id": sid})
                continue

            # Every subsequent message needs a session_id
            sid = data.get("session_id")
            session = ACTIVE_SESSIONS.get(sid)
            if not session:
                continue

            # 4. CONFIG & CONTROL
            if msg_type == "session_config" and user:
                session.mode = data.get("mode", session.mode)
                session.session_mode = data.get("session_mode", getattr(session, "session_mode", "ai_therapist_training"))
                session.patient_profile = data.get("patient_profile", getattr(session, "patient_profile", {}))
                session.roleplay_profile = data.get("roleplay_profile", getattr(session, "roleplay_profile", {}))
                
                # Auto-map ai_role based on session_mode
                if session.session_mode == "ai_patient_roleplay":
                    session.ai_role = "patient"
                else:
                    session.ai_role = "therapist"

                session.patient_age = data.get("patient_age", session.patient_age)
                session.patient_sex = data.get("patient_sex", session.patient_sex)
                session.approach = data.get("approach", session.approach)
                session.instruction_to_ai = data.get("special_instructions", session.instruction_to_ai)
                # Voice config (accepted from both patient and therapist)
                session.voice_gender = data.get("voice_gender", session.voice_gender)
                session.speed = float(data.get("speed", session.speed))
                session.tempo = data.get("tempo", session.tempo)
                session.pitch = data.get("pitch", session.pitch)
                session.pitch_shift = float(data.get("pitch_shift", session.pitch_shift))
                
                # Broadcast the updated config to all OTHER participants in the session
                await broadcast_to_session(session, {
                    "type": "session_sync",
                    "session_id": sid,
                    "patient_name": session.patient_name,
                    "patient_age": session.patient_age,
                    "patient_sex": session.patient_sex,
                    "approach": session.approach,
                    "mode": session.mode,
                    "session_mode": session.session_mode,
                    "patient_profile": session.patient_profile,
                    "roleplay_profile": session.roleplay_profile,
                    "transcript": session.transcript,
                    "session_active": session.session_active,
                    "voice_gender": session.voice_gender,
                    "tempo": session.tempo,
                    "pitch": session.pitch,
                    "speed": session.speed,
                    "pitch_shift": session.pitch_shift,
                    "minutes_remaining": round(session.minutes_remaining, 1),
                    "special_instructions": session.instruction_to_ai,
                    "therapist_name": session.therapist_name
                }, exclude=websocket)
                
                await websocket.send_json({"type": "status", "message": "Config Updated"})
                continue

            if msg_type == "session_control":
                cmd = data.get("command")
                if cmd == "START_THERAPY":
                    if session.minutes_remaining < 1:
                        # Check if they have a free session available to auto-grant
                        db = next(get_db())
                        wallet = db.query(Wallet).filter(Wallet.user_id == session.user_id).first()
                        if wallet and not wallet.free_session_used:
                            print(f"Auto-granting free session to user {session.user_id}")
                            session.minutes_remaining = 20.0
                            wallet.minutes_remaining = 20.0
                            wallet.free_session_used = True # Mark as used now
                            db.commit()
                            # Sync the new balance to everyone
                            await broadcast_to_session(session, {"type": "credits", "remaining": 20.0})
                        else:
                            await websocket.send_json({"type": "error", "message": "Clinical trial ended. Please purchase minutes to continue your clinical sessions."})
                            continue
                    session.session_active = True
                    session.paused = False
                    session.start_time = time.time()
                    session.last_sync = time.time() # Reset sync to current time
                    # Broadcast sync with active state
                    await broadcast_to_session(session, {
                        "type": "session_sync",
                        "session_id": sid,
                        "session_active": True,
                        "elapsed_seconds": 0,
                        "patient_online": session.patient_ws is not None
                    })
                    await broadcast_to_session(session, {"type": "status", "message": "Session Started"})
                elif cmd == "PAUSE":
                    session.paused = True
                    await broadcast_to_session(session, {"type": "status", "message": "Session Paused"})
                elif cmd == "RESUME":
                    session.paused = False
                    session.last_sync = time.time() # Reset sync to current time
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
                
                # Check for dynamic command if sent by therapist
                if user and user.role == "therapist":
                    if await check_and_apply_chat_commands(session, text):
                        continue

                session.transcript.append({"role": "patient", "text": text})

                # Broadcast patient text to therapists (fan-out)
                await broadcast_to_session(session, {"type": "monitor_patient_text", "text": text, "session_id": sid}, exclude=websocket)

                # Generate AI response
                await generate_ai_response(session, sid)

            # 6. WHISPER MIC (spoken, private)
            elif msg_type == "whisper" and user and user.role == "therapist":
                text = data.get("text", "")
                if text:
                    if await check_and_apply_chat_commands(session, text):
                        continue
                    session.therapist_whisper = text
                    await websocket.send_json({"type": "status", "message": "Whisper Recorded"})

            # 7. THERAPIST TEXT INSTRUCTION (typed, private directive)
            elif msg_type == "therapist_instruction" and user and user.role == "therapist":
                text = data.get("text", "").strip()
                if text:
                    if await check_and_apply_chat_commands(session, text):
                        continue
                    session.therapist_text_instruction = text
                    await websocket.send_json({"type": "status", "message": "Instruction Sent to AI"})

            # 8. THERAPIST DIRECT MESSAGE (broadcast to log, legacy)
            elif msg_type == "therapist_message" and user and user.role == "therapist":
                text = data.get("text", "")
                session.transcript.append({"role": "therapist", "text": text})
                await broadcast_to_session(session, {"type": "therapist_reply", "text": text})
                
                # Generate AI response
                await generate_ai_response(session, sid)

    except WebSocketDisconnect:
        if current_sid in ACTIVE_SESSIONS:
            s = ACTIVE_SESSIONS[current_sid]
            if user and user.role == "patient":
                s.patient_ws = None
                # Broadcast patient offline
                await broadcast_to_session(s, {
                    "type": "session_sync",
                    "patient_online": False,
                    "session_id": current_sid,
                    "session_active": s.session_active
                })
            elif user and user.role == "therapist":
                s.therapist_wss.discard(websocket)
            
            # Persist minutes if patient left or session ended
            if s.user_id:
                try:
                    db = next(get_db())
                    wallet = db.query(Wallet).filter(Wallet.user_id == s.user_id).first()
                    if wallet:
                        wallet.minutes_remaining = max(0, s.minutes_remaining)
                        db.commit()
                        print(f"Cleanup sync: {s.minutes_remaining} mins for user {s.user_id}")
                except Exception as e:
                    print(f"Sync error on disconnect: {e}")


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
