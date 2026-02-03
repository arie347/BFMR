#!/bin/bash
# BFMR Auto-Buyer - DigitalOcean Setup Script
# Run this on a fresh Ubuntu 22.04 droplet

set -e

echo "🚀 Setting up BFMR Auto-Buyer..."

# Update system
echo "📦 Updating system packages..."
sudo apt-get update
sudo apt-get upgrade -y

# Install Node.js 20
echo "📦 Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Chrome/Chromium dependencies for Puppeteer
echo "🌐 Installing Chrome dependencies..."
sudo apt-get install -y \
    chromium-browser \
    fonts-liberation \
    libatk-bridge2.0-0t64 \
    libatk1.0-0t64 \
    libcups2t64 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0t64 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    wget || echo "Some packages may have different names, continuing..."

# Install PM2 globally
echo "⚙️ Installing PM2..."
sudo npm install -g pm2

# Clone the repo (if not already cloned)
if [ ! -d "/root/BFMR" ]; then
    echo "📂 Cloning BFMR repository..."
    cd /root
    git clone https://github.com/arie347/BFMR.git
fi

cd /root/BFMR

# Install dependencies
echo "📦 Installing npm dependencies..."
npm install

# Create necessary directories
mkdir -p logs data screenshots

# Set up PM2
echo "🔧 Configuring PM2..."
pm2 start ecosystem.config.js
pm2 startup
pm2 save

# Set up firewall
echo "🔒 Configuring firewall..."
sudo ufw allow 22
sudo ufw allow 3002
sudo ufw --force enable

echo ""
echo "✅ Setup complete!"
echo ""
echo "📊 Dashboard available at: http://$(curl -s ifconfig.me):3002"
echo ""
echo "📝 Useful commands:"
echo "   pm2 status          - Check if BFMR is running"
echo "   pm2 logs bfmr       - View logs"
echo "   pm2 restart bfmr    - Restart the app"
echo "   cd /root/BFMR && git pull && pm2 restart bfmr  - Update from GitHub"
echo ""
