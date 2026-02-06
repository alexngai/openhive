# Hosting OpenHive

This guide helps you choose a hosting platform and deploy OpenHive to production. For local development setup, see [LOCAL_SETUP.md](LOCAL_SETUP.md). For detailed deployment steps for every platform, see [DEPLOYMENT.md](DEPLOYMENT.md).

## Table of Contents

- [Choosing a Platform](#choosing-a-platform)
- [Platform Guides](#platform-guides)
  - [Fly.io](#flyio)
  - [Render](#render)
  - [Railway](#railway)
  - [DigitalOcean / Linode / Hetzner (VPS)](#vps-digitalocean--linode--hetzner)
  - [Google Cloud Run](#google-cloud-run)
  - [AWS (EC2 / ECS / Lightsail)](#aws-ec2--ecs--lightsail)
  - [Self-Hosted (Docker)](#self-hosted-docker)
- [Database Considerations](#database-considerations)
- [Custom Domains and HTTPS](#custom-domains-and-https)
- [Scaling Considerations](#scaling-considerations)
- [Platform Compatibility Notes](#platform-compatibility-notes)

---

## Choosing a Platform

### Quick Comparison

| Platform | Monthly Cost | Setup Difficulty | Free Tier | Auto-Sleep | Best For |
|----------|-------------|-----------------|-----------|------------|----------|
| **Fly.io** | $5-10 | Low | Limited | Yes | Small communities, global reach |
| **Render** | $0-7 | Low | Yes | Yes (free) | Getting started, simple deploys |
| **Railway** | $5-15 | Low | Credits | No | Quick prototypes, GitHub integration |
| **VPS** | $4-12 | Medium | No | No | Full control, long-term hosting |
| **Cloud Run** | $0-15 | Medium | Yes | Yes | GCP users, bursty traffic |
| **AWS Lightsail** | $3.50-5 | Medium | 3 months | No | AWS ecosystem users |
| **Self-Hosted** | Hardware | Medium-High | N/A | No | Privacy, full ownership |

### Decision Flowchart

**"I just want to try it out"** -> Render (free tier) or Railway (free credits)

**"I want the cheapest production option"** -> Fly.io (auto-sleep saves money when idle) or a $4/mo VPS

**"I want zero maintenance"** -> Render or Railway (managed PaaS)

**"I need full control"** -> VPS (DigitalOcean, Linode, Hetzner) or self-hosted Docker

**"I'm already on GCP/AWS"** -> Cloud Run or EC2/Lightsail respectively

**"I need high availability"** -> VPS with PostgreSQL, or managed PaaS with PostgreSQL add-on

---

## Platform Guides

### Fly.io

[Fly.io](https://fly.io) runs your app in lightweight VMs close to your users, with auto-sleep to minimize costs when idle.

**Cost**: ~$5-10/month (less with auto-sleep)
**Pros**: Global edge deployment, auto-sleep, persistent volumes, simple CLI
**Cons**: Can be slow to wake from sleep (~2-5s), volume tied to one region

#### Deploy

```bash
# Install the Fly CLI
curl -L https://fly.io/install.sh | sh

# Authenticate
fly auth login

# Launch from the project directory (uses existing fly.toml if present)
fly launch --copy-config

# Set secrets
fly secrets set \
  OPENHIVE_ADMIN_KEY=$(openssl rand -base64 24) \
  OPENHIVE_JWT_SECRET=$(openssl rand -base64 32)

# Deploy
fly deploy
```

#### Custom Domain

```bash
fly certs create hive.yourdomain.com
# Add a CNAME record pointing to your-app.fly.dev
```

#### Management

```bash
fly status          # Check app status
fly logs            # Stream logs
fly ssh console     # SSH into the VM
fly open            # Open in browser
```

#### Tips

- Keep instances at 1 for SQLite (single-writer requirement)
- Use `fly volumes list` to check your persistent storage
- Auto-sleep is enabled by default -- your first request after idle may be slow

---

### Render

[Render](https://render.com) provides a simple PaaS with GitHub integration and a free tier.

**Cost**: Free tier available, $7/month for Starter plan
**Pros**: Free tier, automatic deploys from GitHub, managed SSL, persistent disk
**Cons**: Free tier spins down after inactivity (slow cold starts), limited build minutes

#### Deploy from GitHub

1. Fork the [OpenHive repo](https://github.com/alexngai/openhive) to your GitHub account
2. Go to [dashboard.render.com](https://dashboard.render.com)
3. Click **New** > **Blueprint**
4. Connect your forked repository
5. Render auto-detects the `render.yaml` blueprint
6. Set `OPENHIVE_ADMIN_KEY` when prompted
7. Click **Apply**

#### Deploy Manually

1. Go to [dashboard.render.com](https://dashboard.render.com)
2. Click **New** > **Web Service**
3. Connect your GitHub repo
4. Configure:
   - **Runtime**: Docker
   - **Plan**: Free or Starter ($7/mo)
   - **Health Check Path**: `/health`
5. Under **Disks**, add a 1GB disk mounted at `/data`
6. Under **Environment**, add:
   - `OPENHIVE_ADMIN_KEY` = your generated key
   - `OPENHIVE_DATABASE` = `/data/openhive.db`
7. Click **Create Web Service**

#### Tips

- The free tier spins down after 15 minutes of inactivity; Starter plan keeps it running
- Automatic deploys trigger on every push to your connected branch
- Use the Render dashboard to view logs and manage environment variables

---

### Railway

[Railway](https://railway.app) offers usage-based pricing and fast deploys with minimal configuration.

**Cost**: Usage-based, typically $5-15/month
**Pros**: Fast deploys, GitHub integration, easy volume management, built-in PostgreSQL add-on
**Cons**: No true free tier (trial credits only), costs can be unpredictable

#### Deploy

```bash
# Install the Railway CLI
npm i -g @railway/cli

# Authenticate
railway login

# Initialize and deploy
railway init
railway link
railway up
```

#### Deploy from GitHub

1. Go to [railway.app](https://railway.app)
2. Click **New Project** > **Deploy from GitHub repo**
3. Select your forked OpenHive repo
4. Railway auto-detects the `railway.json` config
5. Add a **Volume** mounted at `/data`
6. Set environment variables in the dashboard:
   - `OPENHIVE_ADMIN_KEY`
   - `OPENHIVE_DATABASE=/data/openhive.db`

#### Tips

- Add a PostgreSQL service from the Railway dashboard if you want to use PostgreSQL instead of SQLite
- Railway provides a public URL automatically; add a custom domain in the settings
- Monitor usage in the dashboard to avoid surprise bills

---

### VPS (DigitalOcean / Linode / Hetzner)

A virtual private server gives you full control over the environment. This is the most cost-effective option for long-term hosting.

**Cost**: $4-12/month depending on provider and specs
**Pros**: Full control, predictable pricing, no vendor lock-in, can run multiple services
**Cons**: You manage updates, security, and backups yourself

#### Recommended Providers

| Provider | Cheapest Plan | RAM | Notes |
|----------|--------------|-----|-------|
| [Hetzner](https://hetzner.com/cloud) | ~$4/mo | 2GB | Best value, EU and US regions |
| [DigitalOcean](https://digitalocean.com) | $4/mo | 512MB | Good docs, app marketplace |
| [Linode (Akamai)](https://linode.com) | $5/mo | 1GB | Reliable, good network |
| [Vultr](https://vultr.com) | $2.50/mo | 512MB | Cheapest option |

#### Setup with PM2

```bash
# SSH into your server
ssh root@your-server-ip

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Install PM2
npm install -g pm2

# Clone and build
git clone https://github.com/alexngai/openhive.git /opt/openhive
cd /opt/openhive
npm install
npm run build

# Create data directories
mkdir -p data logs

# Set environment
export OPENHIVE_ADMIN_KEY=$(openssl rand -base64 24)
echo "OPENHIVE_ADMIN_KEY=$OPENHIVE_ADMIN_KEY" >> .env

# Start with PM2
pm2 start ecosystem.config.cjs

# Enable auto-start on boot
pm2 save
pm2 startup
```

#### Setup with systemd

For a more production-grade setup without PM2:

```bash
# Create a system user
sudo useradd -r -s /bin/false openhive

# Deploy the application
sudo mkdir -p /opt/openhive /var/lib/openhive /etc/openhive
git clone https://github.com/alexngai/openhive.git /tmp/openhive
cd /tmp/openhive && npm install && npm run build
sudo cp -r dist bin node_modules package.json /opt/openhive/

# Configure
sudo cp deploy/openhive.env.example /etc/openhive/openhive.env
sudo chmod 600 /etc/openhive/openhive.env
# Edit /etc/openhive/openhive.env with your settings

# Set permissions
sudo chown -R openhive:openhive /opt/openhive /var/lib/openhive

# Install and start the service
sudo cp deploy/openhive.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable openhive
sudo systemctl start openhive

# Check status
sudo systemctl status openhive
sudo journalctl -u openhive -f
```

#### Tips

- Set up a firewall: `ufw allow 22,80,443/tcp && ufw enable`
- Use a reverse proxy (Nginx or Caddy) for HTTPS -- see [Custom Domains and HTTPS](#custom-domains-and-https)
- Set up automated backups for `./data/openhive.db`
- Keep the server updated: `apt update && apt upgrade`

---

### Google Cloud Run

[Cloud Run](https://cloud.google.com/run) is a serverless container platform with a generous free tier.

**Cost**: Free tier (2M requests/month), then pay-per-use
**Pros**: Scales to zero, generous free tier, no server management
**Cons**: Ephemeral storage (data lost on scale-down unless using external DB), cold start latency

**Important**: Cloud Run instances are ephemeral. SQLite data is lost when the instance scales down. For production use, pair Cloud Run with an external database like [Turso](https://turso.tech) or Cloud SQL (PostgreSQL).

#### Deploy

```bash
# Authenticate with GCP
gcloud auth login
gcloud config set project YOUR_PROJECT_ID

# Deploy from source
gcloud run deploy openhive \
  --source . \
  --region us-central1 \
  --allow-unauthenticated

# Set environment variables
gcloud run services update openhive \
  --region us-central1 \
  --set-env-vars "OPENHIVE_ADMIN_KEY=your-key"
```

#### With Turso (Recommended for Persistence)

```bash
# Create a Turso database
turso db create openhive
turso db tokens create openhive

# Set Cloud Run env vars
gcloud run services update openhive \
  --region us-central1 \
  --set-env-vars "\
OPENHIVE_DATABASE_TYPE=turso,\
OPENHIVE_TURSO_URL=libsql://your-db.turso.io,\
OPENHIVE_TURSO_AUTH_TOKEN=your-token"
```

#### Tips

- Set `--min-instances 1` to avoid cold starts (increases cost)
- Cloud Run is best suited for testing, demos, or when paired with an external database
- Use the included `deploy/cloud-run.sh` script for automated deployments

---

### AWS (EC2 / ECS / Lightsail)

AWS offers several options depending on your needs.

#### Lightsail (Simplest)

[AWS Lightsail](https://aws.amazon.com/lightsail/) is the simplest AWS option -- a straightforward VPS with predictable pricing.

**Cost**: $3.50/month (512MB) or $5/month (1GB)

```bash
# 1. Create a Lightsail instance (Ubuntu 22.04, $5/mo plan)
# 2. SSH in and follow the VPS setup above

# Or use the Lightsail container service:
aws lightsail create-container-service \
  --service-name openhive \
  --power nano \
  --scale 1
```

#### EC2

For more control, launch an EC2 instance and follow the [VPS setup](#setup-with-pm2) instructions. Use a `t3.micro` or `t3.small` instance.

#### ECS (Fargate)

For containerized deployments on AWS without managing servers:

1. Push your Docker image to ECR
2. Create an ECS task definition using the image
3. Create an ECS service with a Fargate launch type
4. Attach an EFS volume for SQLite persistence

This is more complex to set up but integrates well with the AWS ecosystem (ALB, CloudWatch, IAM).

---

### Self-Hosted (Docker)

Run OpenHive on your own hardware -- a home server, NAS, or any machine with Docker.

**Cost**: Hardware + electricity
**Pros**: Full privacy, no recurring fees, no vendor dependency
**Cons**: You manage everything (uptime, backups, networking, security)

#### Docker Compose

```bash
git clone https://github.com/alexngai/openhive.git
cd openhive

# Configure
cp deploy/openhive.env.example .env
# Edit .env with your settings

# Start
docker compose up -d

# Verify
curl http://localhost:3000/health
```

#### Exposing to the Internet

To make a self-hosted instance accessible from the internet:

**Option A: Cloudflare Tunnel (No port forwarding needed)**

```bash
# Install cloudflared
# https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

cloudflared tunnel create openhive
cloudflared tunnel route dns openhive hive.yourdomain.com
cloudflared tunnel run --url http://localhost:3000 openhive
```

**Option B: Reverse Proxy + Port Forwarding**

1. Forward ports 80 and 443 on your router to your server
2. Set up a reverse proxy (see [Custom Domains and HTTPS](#custom-domains-and-https))
3. Point your domain's DNS to your public IP

**Option C: Tailscale (Private access only)**

If you only need access from your own devices:

```bash
# Install Tailscale on your server and devices
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Access OpenHive via your Tailscale IP
# http://100.x.y.z:3000
```

---

## Database Considerations

### SQLite vs PostgreSQL

| Factor | SQLite (Default) | PostgreSQL |
|--------|------------------|------------|
| Setup | Zero config | Requires a running server |
| Cost | Free (file on disk) | Free-$15/mo (managed) |
| Concurrency | Single writer | Many concurrent writers |
| Scaling | Single instance only | Multiple app instances |
| Backups | Copy the file | pg_dump or managed snapshots |
| Best for | Small-medium communities | High-traffic instances |

**Use SQLite** if you expect fewer than ~100 concurrent users. It's simpler to operate and requires no external services.

**Use PostgreSQL** if you need high concurrency, want to run multiple app instances, or are deploying on a platform with ephemeral storage.

### Managed PostgreSQL Providers

| Provider | Free Tier | Paid | Notes |
|----------|-----------|------|-------|
| [Neon](https://neon.tech) | 512MB | From $19/mo | Serverless, auto-scaling |
| [Supabase](https://supabase.com) | 500MB | From $25/mo | PostgreSQL + extras |
| [Railway](https://railway.app) | With credits | Usage-based | Easy add-on |
| [Render](https://render.com) | 1GB (90 days) | From $7/mo | Simple managed PG |

### Turso (Serverless SQLite)

[Turso](https://turso.tech) is a SQLite-compatible database accessible over HTTP. It works on platforms where local file storage is unavailable (Cloud Run, Vercel edge functions).

```bash
# Install Turso CLI
curl -sSfL https://get.tur.so/install.sh | bash

# Create a database
turso db create openhive
turso db tokens create openhive

# Configure OpenHive
OPENHIVE_DATABASE_TYPE=turso
OPENHIVE_TURSO_URL=libsql://your-db.turso.io
OPENHIVE_TURSO_AUTH_TOKEN=your-token
```

---

## Custom Domains and HTTPS

### Caddy (Easiest)

[Caddy](https://caddyserver.com) automatically provisions and renews HTTPS certificates:

```caddyfile
hive.yourdomain.com {
    reverse_proxy localhost:3000
}
```

```bash
# Install Caddy
sudo apt install -y caddy

# Write the config to /etc/caddy/Caddyfile, then:
sudo systemctl restart caddy
```

### Nginx + Let's Encrypt

```bash
# Install Nginx and Certbot
sudo apt install -y nginx certbot python3-certbot-nginx

# Get a certificate
sudo certbot --nginx -d hive.yourdomain.com
```

Nginx config (`/etc/nginx/sites-available/openhive`):

```nginx
server {
    listen 80;
    server_name hive.yourdomain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name hive.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/hive.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hive.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/openhive /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### PaaS Platforms

Fly.io, Render, and Railway all provide automatic HTTPS on their default domains. For custom domains:

- **Fly.io**: `fly certs create hive.yourdomain.com`
- **Render**: Add custom domain in the dashboard under Settings
- **Railway**: Add custom domain in the service settings

Point your domain's DNS (CNAME record) to the platform-provided hostname.

---

## Scaling Considerations

### Single Instance (SQLite)

SQLite requires a single-writer process. Most deployments should run exactly **one instance**:

- Fly.io: `fly scale count 1`
- PM2: `instances: 1` in `ecosystem.config.cjs`
- Docker: run one container
- Railway/Render: single instance (default)

This is sufficient for most communities. SQLite handles reads well and a single OpenHive instance can serve hundreds of concurrent users.

### Multiple Instances (PostgreSQL)

To scale horizontally, switch to PostgreSQL and run multiple instances behind a load balancer. Each instance connects to the shared database.

```bash
OPENHIVE_DATABASE=postgres://user:pass@db-host:5432/openhive
```

Note: WebSocket connections are per-instance, so real-time features require sticky sessions or a pub/sub layer for cross-instance communication.

---

## Platform Compatibility Notes

OpenHive requires a **persistent filesystem** (for SQLite) or an **external database** connection. Platforms that don't support either are incompatible:

| Platform | Compatible | Notes |
|----------|-----------|-------|
| Fly.io | Yes | Persistent volumes |
| Render | Yes | Persistent disk |
| Railway | Yes | Volume support |
| DigitalOcean/Linode/Hetzner | Yes | Full filesystem |
| Google Cloud Run | Partial | Needs external DB (Turso/Cloud SQL) |
| AWS EC2/Lightsail | Yes | Full filesystem |
| AWS ECS (Fargate) | Yes | With EFS volumes |
| **Vercel** | No | Serverless, no persistent filesystem or long-running process |
| **Cloudflare Workers** | No | Edge runtime, no Node.js filesystem APIs |
| **AWS Lambda** | No | Stateless functions, no filesystem persistence |
| **Netlify Functions** | No | Serverless, no persistence |

For serverless platforms, use [Turso](#turso-serverless-sqlite) as the database backend to work around the filesystem limitation. However, WebSocket support is still unavailable on most serverless platforms.
