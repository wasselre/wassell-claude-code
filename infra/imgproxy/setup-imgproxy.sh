#!/usr/bin/env bash
# Additive install of the imgproxy sidecar next to WAHA. Touches nothing WAHA owns
# except appending a route to the existing Caddy site (backed up first).
set -euo pipefail

TOKEN="$1"

sudo mkdir -p /opt/imgproxy
sudo mv /tmp/imgproxy.py /opt/imgproxy/imgproxy.py
sudo chmod 0755 /opt/imgproxy/imgproxy.py

# --- systemd unit -----------------------------------------------------------
sudo tee /etc/systemd/system/imgproxy.service >/dev/null <<UNIT
[Unit]
Description=Wassel image proxy (allowlisted Aqar photo fetcher for the Fly worker)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=IMGPROXY_TOKEN=${TOKEN}
Environment=IMGPROXY_PORT=8090
ExecStart=/usr/bin/python3 /opt/imgproxy/imgproxy.py
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now imgproxy.service
sleep 2
sudo systemctl is-active imgproxy.service

# --- Caddy route ------------------------------------------------------------
sudo cp -n /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.preimgproxy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'CADDY'
34-18-239-19.sslip.io {
    handle_path /imgproxy/* {
        reverse_proxy localhost:8090
    }
    handle {
        reverse_proxy localhost:3000
    }
}
CADDY

sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
sleep 2
sudo systemctl is-active caddy

echo "--- local smoke test ---"
curl -s -o /dev/null -w "no-token=%{http_code}\n" "http://127.0.0.1:8090/fetch?url=https%3A%2F%2Fimages.aqar.fm%2Fwebp%2F750x0%2Fprops%2F000186980_1772136349581.jpg"
curl -s -o /dev/null -w "bad-host=%{http_code}\n" -H "Authorization: Bearer ${TOKEN}" "http://127.0.0.1:8090/fetch?url=https%3A%2F%2Fexample.com%2Fx.jpg"
curl -s -o /dev/null -w "metadata-ssrf=%{http_code}\n" -H "Authorization: Bearer ${TOKEN}" "http://127.0.0.1:8090/fetch?url=http%3A%2F%2F169.254.169.254%2F"
curl -s -o /dev/null -w "good=%{http_code} bytes=%{size_download} type=%{content_type}\n" -H "Authorization: Bearer ${TOKEN}" "http://127.0.0.1:8090/fetch?url=https%3A%2F%2Fimages.aqar.fm%2Fwebp%2F750x0%2Fprops%2F000186980_1772136349581.jpg"
echo "--- waha still up? ---"
curl -s -o /dev/null -w "waha=%{http_code}\n" http://127.0.0.1:3000/
