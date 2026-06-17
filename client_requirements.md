# Deployment Requirements Questionnaire (For Client)

Dear Client,

To successfully deploy and configure the **AI Therapy Dashboard & Website** live on AWS with fully functional features (such as secure payments, live therapist AI communication, and email notifications), please provide the details and credentials requested below.

---

## 1. AI Conversation Service (OpenAI) [DONE - Configured]
Our therapy dashboard uses OpenAI's GPT models, Text-to-Speech (TTS), and Whisper (Speech-to-Text) APIs.
* [x] **OpenAI API Key (Live):** Configured and saved in environment files.

---

## 2. Payment Gateway (PayPal & Venmo)
To allow clinicians to purchase session minutes securely on the dashboard.
* [ ] **PayPal Live Client ID:**
  * *Format:* A long alphanumeric string.
* [ ] **PayPal Live Client Secret:**
  * *Format:* A long secret string.
  * *Where to find:* Log in to the [PayPal Developer Dashboard](https://developer.paypal.com/), switch from **Sandbox** to **Live** mode in the top right, go to **Apps & Credentials**, and create a Live REST API App.

---

## 3. Email Notification Server (SMTP Settings) [DONE - Already Configured]
For sending therapist registration approvals, welcome emails, and payment invoices.
* [x] **SMTP Server Host:** `smtp.aol.com`
* [x] **SMTP Port:** `465` (SSL Enabled)
* [x] **SMTP User/Email:** `jonkogen@aol.com`
* [x] **SMTP Password / API Key:** `Aa!363636`

---

## 4. Hosting Server (AWS Account)
To host the application secure and scalable on Amazon Web Services.
* [ ] **AWS IAM User Access:**
  * **Access Key ID:** 
  * **Secret Access Key:** 
  * *Permissions required:* Deploy permissions for AWS App Runner, Amazon RDS, and AWS IAM (or Admin Access for the duration of the deployment).
  * *Alternative:* Temporarily share login access to the AWS Console.

---

## 5. Domain & DNS Configuration [IN PROGRESS]
Browsers strictly require HTTPS (SSL) for capturing microphone audio in voice therapy.
* [x] **Target Domain Name:** `psychotherapynow.net` (and/or `www.psychotherapynow.net`)
* [x] **DNS Provider:** Namecheap
  * *Note:* During deployment, we will generate a DNS record (like a CNAME or A Record) that must be added to your DNS console to verify SSL certificates and route traffic. Let us know if you prefer we set this up directly, or if your IT team will handle DNS updates.

---

*Thank you! Please compile these details securely (e.g., via a secure password manager like Bitwarden, 1Password, or a secure link).*
