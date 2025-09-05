#!/bin/bash

# Usage: bash deploy_ip.sh <SERVER_IP>
SERVER_IP=$1

if [ -z "$SERVER_IP" ]; then
  echo "❌ Please provide your server IP: bash deploy_ip.sh <IP>"
  exit 1
fi

echo "🚀 Starting deployment for $SERVER_IP"

# Update & install dependencies
sudo apt update -y
sudo apt install -y nginx curl

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

# Navigate to app directory
cd /root/AvtoExpertBack || exit

# Install production dependencies
echo "📦 Installing npm dependencies..."
npm ci --only=production

# Start app with PM2
echo "▶️ Starting app with PM2..."
pm2 start app.js --name "car-scraper-app"
pm2 save
pm2 startup systemd -u $USER --hp $HOME

# Configure Nginx reverse proxy
echo "⚙️ Configuring Nginx..."
sudo tee /etc/nginx/sites-available/car-scraper-app > /dev/null <<EOL
server {
    listen 80;
    server_name $SERVER_IP;

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
sudo ln -sf /etc/nginx/sites-available/car-scraper-app /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

echo "✅ Deployment finished!"
echo "👉 Your app should be available at: http://$SERVER_IP/"
echo "👉 Health check: http://$SERVER_IP/health"
echo "👉 Metrics: http://$SERVER_IP/metrics"
