# AWS Deployment Guide

This guide provides step-by-step instructions to deploy the AI Therapy Dashboard to AWS.

---

## Option A: AWS App Runner (Recommended)

AWS App Runner is the easiest way to deploy containerized web applications. It handles load balancing, scaling, and SSL/HTTPS automatically.

### Prerequisites
1. **GitHub Repository:** Push this codebase to a private or public GitHub repository.
2. **Amazon RDS PostgreSQL Instance:** (Required because SQLite files are ephemeral in containers):
   - In AWS Console, go to **RDS** -> **Create Database**.
   - Choose **PostgreSQL** (Free tier template is fine).
   - Set database name, master username, and password.
   - Under connectivity, make sure the RDS database allows incoming traffic from App Runner (or set "Publicly Accessible" to Yes during setup, but restrict IP access in security groups for production security).

### Deployment Steps
1. Go to the **AWS App Runner** Console.
2. Click **Create service**.
3. Choose **Source code repository** and link your GitHub account.
4. Select your repository and branch.
5. In **Deployment settings**, select **Automatic** (so it deploys on every git push).
6. In **Configure build**:
   - Choose **Use a configuration file** (it will detect `Dockerfile`) or configure settings manually.
   - Choose **Port**: `8000`.
7. Under **Environment variables**, add:
   - `OPENAI_API_KEY`: *Your OpenAI API Key*
   - `SECRET_KEY`: *Generate a strong secret key (e.g. `openssl rand -hex 32`)*
   - `DATABASE_URL`: `postgresql://username:password@rds-endpoint:5432/dbname`
   - `PAYPAL_MODE`: `live` (or `sandbox`)
   - `PAYPAL_CLIENT_ID`: *Your Paypal Client ID*
   - `PAYPAL_CLIENT_SECRET`: *Your Paypal Client Secret*
   - `SMTP_USER`: *Email address to send invoices from*
   - `SMTP_PASSWORD`: *Email service password*
8. Click **Create & Deploy**.
9. AWS App Runner will build the Docker container and deploy it, giving you a secure `https://xxxx.awsapprunner.com` URL.
10. *(Optional)* Link a custom domain in the **Custom domains** tab of your App Runner service.

---

## Option B: Amazon EC2 (Low Cost / Free Tier)

This options hosts the application on a virtual server, allowing you to use SQLite directly on persistent disk.

### 1. Launch EC2 Instance
1. In AWS Console, go to **EC2** -> **Launch Instance**.
2. Name the instance and select **Ubuntu Server 22.04 LTS**.
3. Choose instance type (e.g., `t3.micro` which is Free Tier eligible).
4. Select or create a **Key Pair** for SSH.
5. In Network settings, allow **SSH**, **HTTP**, and **HTTPS** traffic.
6. Click **Launch**.

### 2. Configure EC2 Server
Connect to your EC2 instance via SSH:
```bash
ssh -i your-key.pem ubuntu@your-ec2-ip
```

Update system packages and install dependencies:
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y python3-pip python3-venv nginx git
```

### 3. Clone and Setup Project
```bash
git clone <your-repository-url> app
cd app
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Create a `.env` file inside the root directory:
```bash
nano .env
```
Add environment variables:
```env
OPENAI_API_KEY=your_openai_key
SECRET_KEY=your_secret_key
PAYPAL_MODE=live
PAYPAL_CLIENT_ID=your_paypal_client_id
PAYPAL_CLIENT_SECRET=your_paypal_client_secret
SMTP_USER=your_smtp_user
SMTP_PASSWORD=your_smtp_password
```

### 4. Setup Systemd Service
Create a service to keep your FastAPI backend running:
```bash
sudo nano /etc/systemd/system/therapy.service
```
Paste this configuration:
```ini
[Unit]
Description=FastAPI AI Therapy Dashboard Server
After=network.target

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/app
ExecStart=/home/ubuntu/app/venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000
Restart=always

[Install]
WantedBy=multi-user.target
```
Start and enable the service:
```bash
sudo systemctl daemon-reload
sudo systemctl start therapy
sudo systemctl enable therapy
```

### 5. Setup Nginx Reverse Proxy
```bash
sudo nano /etc/nginx/sites-available/default
```
Replace content with:
```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Enable WebSocket streaming support
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }
}
```
Restart Nginx:
```bash
sudo systemctl restart nginx
```

### 6. Install Certbot for Free SSL (HTTPS)
FastAPI and the client microphone require HTTPS to communicate:
```bash
sudo apt install snapd -y
sudo snap install core; sudo snap refresh core
sudo snap install --classic certbot
sudo ln -s /snap/bin/certbot /usr/bin/certbot
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```
Follow prompts to complete SSL configuration. Certbot will automatically rewrite the Nginx config to serve over HTTPS.
