#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${EUID}" -eq 0 ]] || { printf '请使用 root 运行\n' >&2; exit 1; }
action="${1:-}" domain="${2:-}"
[[ "$domain" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$ ]] || { printf '请输入有效节点域名\n' >&2; exit 1; }
domain="${domain,,}"
target="/etc/nexusgate/tls/$domain"

validate() {
  local cert="$1" key="$2" a b
  openssl x509 -in "$cert" -noout -checkend 86400 >/dev/null || { printf '证书不存在、格式错误或将在 24 小时内过期\n' >&2; exit 1; }
  openssl x509 -in "$cert" -noout -checkhost "$domain" | grep -q 'does match' || { printf '证书与节点域名不匹配\n' >&2; exit 1; }
  a="$(openssl x509 -in "$cert" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256)"
  b="$(openssl pkey -in "$key" -pubout -outform DER | openssl dgst -sha256)"
  [[ "$a" == "$b" ]] || { printf '证书和私钥不匹配\n' >&2; exit 1; }
}

activate() {
  if command -v systemctl >/dev/null && [[ -d /run/systemd/system ]]; then
    systemctl try-restart nexusgate-xray.service
    systemctl try-restart nexusgate-sing-box.service
  elif command -v rc-service >/dev/null; then
    rc-service nexusgate-xray restart
    rc-service nexusgate-sing-box status >/dev/null 2>&1 && rc-service nexusgate-sing-box restart || true
  fi
  printf '证书已安装：%s；有效期：' "$target"
  openssl x509 -in "$target/fullchain.pem" -enddate -noout
}

install_certbot() {
  if ! command -v certbot >/dev/null; then
    if command -v apt-get >/dev/null; then apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot
    elif command -v dnf >/dev/null; then dnf install -y certbot
    elif command -v apk >/dev/null; then apk add --no-cache certbot
    else printf '无法安装 certbot，请使用 import 导入有效证书\n' >&2; exit 1; fi
  fi
}

install_cloudflare_plugin() {
  if certbot plugins 2>/dev/null | grep -q 'dns-cloudflare'; then return; fi
  if command -v apt-get >/dev/null; then
    apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-certbot-dns-cloudflare
  elif command -v dnf >/dev/null; then
    dnf install -y python3-certbot-dns-cloudflare
  elif command -v apk >/dev/null; then
    apk add --no-cache certbot-dns-cloudflare
  else
    printf '无法自动安装 Cloudflare DNS 插件，请参照 Certbot 文档安装后重试\n' >&2; exit 1
  fi
  certbot plugins 2>/dev/null | grep -q 'dns-cloudflare' || { printf '当前 certbot 未发现 dns-cloudflare 插件；检查 Certbot 与插件是否来自同一安装来源\n' >&2; exit 1; }
}

activate_renewal() {
  local cert="/etc/letsencrypt/live/$domain"
  validate "$cert/fullchain.pem" "$cert/privkey.pem"
  install -d -m 0700 "$target"
  ln -sfn "$cert/fullchain.pem" "$target/fullchain.pem"
  ln -sfn "$cert/privkey.pem" "$target/privkey.pem"
  install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
  cat > /etc/letsencrypt/renewal-hooks/deploy/nexusgate-reload.sh <<'EOF'
#!/usr/bin/env bash
if command -v systemctl >/dev/null && [[ -d /run/systemd/system ]]; then
  systemctl try-restart nexusgate-xray.service
  systemctl try-restart nexusgate-sing-box.service
elif command -v rc-service >/dev/null; then
  rc-service nexusgate-xray restart
  rc-service nexusgate-sing-box status >/dev/null 2>&1 && rc-service nexusgate-sing-box restart || true
fi
EOF
  chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/nexusgate-reload.sh
  if command -v systemctl >/dev/null && [[ -d /run/systemd/system ]]; then
    cat > /etc/systemd/system/nexusgate-cert-renew.service <<'EOF'
[Unit]
Description=Renew NexusGate node TLS certificate
[Service]
Type=oneshot
ExecStart=/usr/bin/env certbot renew --quiet
EOF
    cat > /etc/systemd/system/nexusgate-cert-renew.timer <<'EOF'
[Unit]
Description=Check NexusGate node TLS certificates daily
[Timer]
OnCalendar=daily
RandomizedDelaySec=3h
Persistent=true
[Install]
WantedBy=timers.target
EOF
    systemctl daemon-reload && systemctl enable --now nexusgate-cert-renew.timer
  elif command -v rc-service >/dev/null; then
    install -d -m 0755 /etc/periodic/daily
    printf '#!/bin/sh\ncertbot renew --quiet\n' > /etc/periodic/daily/nexusgate-cert-renew
    chmod 0755 /etc/periodic/daily/nexusgate-cert-renew
    rc-service crond start >/dev/null 2>&1 || true
  fi
  activate
}

case "$action" in
  import)
    [[ $# -eq 4 ]] || { printf '用法：ng-agent cert import 域名 /path/fullchain.pem /path/privkey.pem\n' >&2; exit 1; }
    validate "$3" "$4"
    install -d -m 0700 "$target"
    install -m 0600 "$3" "$target/fullchain.pem"
    install -m 0600 "$4" "$target/privkey.pem"
    activate ;;
  issue)
    [[ $# -eq 3 && "$3" == *@* ]] || { printf '用法：ng-agent cert issue 域名 邮箱（节点须放行 80/TCP，且没有其他程序占用）\n' >&2; exit 1; }
    install_certbot
    certbot certonly --standalone --preferred-challenges http --non-interactive --agree-tos --email "$3" -d "$domain"
    activate_renewal ;;
  issue-cloudflare)
    [[ $# -eq 4 && "$3" == *@* && -f "$4" ]] || { printf '用法：ng-agent cert issue-cloudflare 域名 邮箱 /root/cloudflare.ini\n' >&2; exit 1; }
    [[ -O "$4" ]] || { printf 'Cloudflare 凭据文件须由 root 拥有\n' >&2; exit 1; }
    chmod 0600 "$4"
    grep -Eq '^[[:space:]]*dns_cloudflare_api_token[[:space:]]*=' "$4" || { printf '凭据文件须包含 dns_cloudflare_api_token = ...\n' >&2; exit 1; }
    install_certbot
    install_cloudflare_plugin
    certbot certonly --dns-cloudflare --dns-cloudflare-credentials "$4" --dns-cloudflare-propagation-seconds 30 \
      --non-interactive --agree-tos --email "$3" -d "$domain"
    activate_renewal ;;
  status)
    [[ -f "$target/fullchain.pem" ]] || { printf '未找到该节点证书\n' >&2; exit 1; }
    validate "$target/fullchain.pem" "$target/privkey.pem"
    openssl x509 -in "$target/fullchain.pem" -enddate -noout ;;
  *) printf '用法：ng-agent cert {issue 域名 邮箱|issue-cloudflare 域名 邮箱 /root/cloudflare.ini|import 域名 证书 私钥|status 域名}\n' >&2; exit 1 ;;
esac
