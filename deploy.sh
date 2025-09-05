#!/bin/bash

# Usage: bash deploy.sh yourdomain.com
DOMAIN=$1

if [ -z "$DOMAIN" ]; then
  echo "❌ Please provide your domain: bash deploy.sh yourdomain.com"
  exit 1
fi

echo "🚀 Starting deployment for $DOMAIN"

# Update & install dependencies
sudo apt update -y
sudo apt install -y nginx certbot python3-certbot-nginx curl

# Install Node.js & npm if not installed
if ! command -v node &> /dev/null; then
  echo "📦 Installing Node.js..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
fi

# Install PM2 if not already installed
if ! command -v pm2 &> /dev/null; then
  echo "📦 Installing PM2..."
  sudo npm install -g pm2
fi

cd /root/AvtoExpertBack || exit

# Install production deps
echo "📦 Installing npm dependencies..."
npm ci --only=production

# Start app with PM2
echo "▶️ Starting app with PM2..."
pm2 start app.js --name "car-scraper-app"
pm2 save
pm2 startup systemd

# Nginx config
echo "⚙️ Configuring Nginx..."
sudo tee /etc/nginx/sites-available/$DOMAIN > /dev/null <<EOL
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name $DOMAIN;

    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;

    location / {
        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
    }
}
EOL

# Enable Nginx site
sudo ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# Setup SSL
echo "🔐 Setting up SSL with Certbot..."
sudo certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m amirzeyev3@gmail.com

echo "✅ Deployment finished!"
echo "👉 API base: https://$DOMAIN/"
echo "👉 Health check: https://$DOMAIN/health"
echo "👉 Metrics: https://$DOMAIN/metrics"
