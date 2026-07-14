#!/bin/sh
set -eu

PORT="${PORT:-8000}"
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"

if [ -z "$LAN_IP" ]; then
  echo "No LAN address found on en0. Connect this Mac to Wi-Fi or Ethernet first."
  exit 1
fi

mkdir -p .dev-certs
openssl req -x509 -newkey rsa:2048 -nodes -days 7 \
  -keyout .dev-certs/gymos-key.pem \
  -out .dev-certs/gymos-cert.pem \
  -subj "/CN=$LAN_IP" \
  -addext "subjectAltName=IP:$LAN_IP" >/dev/null 2>&1

echo "Starting secure GymOS development server: https://$LAN_IP:$PORT"
HTTPS=1 PORT="$PORT" .venv/bin/python3 app.py

