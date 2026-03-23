#!/bin/bash
# MCP Chat - AWS EC2 Deployment Script
# Run this on the EC2 instance after SSH'ing in

set -e

DOMAIN="your-domain.com"
EMAIL="your-email@example.com"  # For Let's Encrypt notifications

echo "=== MCP Chat Deployment ==="

# Install Docker if not present
if ! command -v docker &> /dev/null; then
  echo "Installing Docker..."
  sudo yum update -y
  sudo yum install -y docker git
  sudo systemctl start docker
  sudo systemctl enable docker
  sudo usermod -aG docker ec2-user
  echo "Docker installed. You may need to log out and back in for group changes."
fi

# Install Docker Compose if not present
if ! command -v docker-compose &> /dev/null; then
  echo "Installing Docker Compose..."
  sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
  sudo chmod +x /usr/local/bin/docker-compose
fi

# Create .env if it doesn't exist
if [ ! -f .env ]; then
  echo "Creating .env file..."
  cat > .env << 'ENVEOF'
DB_PASSWORD=CHANGE_ME_STRONG_PASSWORD
JWT_SECRET=CHANGE_ME_RANDOM_STRING
GOOGLE_CLIENT_ID=YOUR_GOOGLE_CLIENT_ID
APP_URL=https://your-domain.com
ENVEOF
  echo "IMPORTANT: Edit .env with your actual values before continuing!"
  exit 1
fi

# Create nginx.conf from template if it doesn't exist
if [ ! -f nginx.conf ]; then
  echo "Creating nginx.conf from template..."
  sed "s/your-domain.com/$DOMAIN/g" nginx.conf.example > nginx.conf
  echo "nginx.conf created for $DOMAIN"
fi

# Initial SSL certificate (HTTP-only nginx first)
if [ ! -d "certbot/conf/live/$DOMAIN" ]; then
  echo "Getting initial SSL certificate..."

  # Create temporary nginx config for cert challenge
  cat > nginx-temp.conf << NGINXEOF
server {
    listen 80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    location / {
        return 200 'MCP Chat - Setting up SSL...';
        add_header Content-Type text/plain;
    }
}
NGINXEOF

  mkdir -p certbot/www certbot/conf

  # Start nginx with temp config
  docker run -d --name nginx-temp \
    -p 80:80 \
    -v "$(pwd)/nginx-temp.conf:/etc/nginx/conf.d/default.conf" \
    -v "$(pwd)/certbot/www:/var/www/certbot" \
    nginx:alpine

  # Get certificate
  docker run --rm \
    -v "$(pwd)/certbot/conf:/etc/letsencrypt" \
    -v "$(pwd)/certbot/www:/var/www/certbot" \
    certbot/certbot certonly --webroot \
    --webroot-path=/var/www/certbot \
    --email "$EMAIL" \
    --agree-tos \
    --no-eff-email \
    -d "$DOMAIN"

  docker stop nginx-temp && docker rm nginx-temp
  rm nginx-temp.conf
  echo "SSL certificate obtained!"
fi

# Build and start everything
echo "Building and starting services..."
docker-compose up -d --build

echo ""
echo "=== Deployment complete ==="
echo "MCP Chat is running at https://$DOMAIN"
echo ""
echo "To view logs: docker-compose logs -f"
echo "To stop: docker-compose down"
echo "To tear down completely: docker-compose down -v (removes data too)"
