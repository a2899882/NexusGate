#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${EUID}" -eq 0 ]] || { printf '请使用 root 运行\n' >&2; exit 1; }
action="${1:-setup}" domain="${2:-}"
if [[ "$action" == setup ]]; then
  exec 3</dev/tty || { printf '交互式申请需要 SSH 终端；请使用 ng-agent cert issue 域名 邮箱\n' >&2; exit 1; }
  printf '节点证书一键申请（已在 Cloudflare 配置的入口域名）\n'
  read -r -p '节点域名（如 node.example.com）：' domain <&3
  read -r -p '证书通知邮箱（可留空，建议填写）：' setup_email <&3
  [[ -z "$setup_email" || "$setup_email" == *@* ]] || { printf '请输入有效邮箱\n' >&2; exit 1; }
fi
[[ "$domain" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$ ]] || { printf '请输入有效节点域名\n' >&2; exit 1; }
domain="${domain,,}"
target="/etc/nexusgate/tls/$domain"

sync_panel() {
  [[ -r /etc/nexusgate/agent.env ]] || return 0
  if ! ( set -a; source /etc/nexusgate/agent.env; set +a
    NG_CERT_DOMAIN="$domain" node <<'NODE'
const controller = String(process.env.NG_CONTROLLER || '').replace(/\/$/, '');
const key = process.env.NG_AGENT_KEY;
const domain = process.env.NG_CERT_DOMAIN;
if (!controller || !key) process.exit(1);
fetch(`${controller}/api/agent/tls-domain`, { method:'POST',
  headers:{ authorization:`Bearer ${key}`, 'content-type':'application/json' },
  body:JSON.stringify({ domain }), signal:AbortSignal.timeout(10000) })
  .then((response) => { if (!response.ok) throw Error(`HTTP ${response.status}`); console.log('面板设备 TLS 域名已同步'); })
  .catch((error) => { console.error('面板同步失败：', error.message); process.exitCode = 1; });
NODE
  ); then
    printf '证书已安装，但面板未同步；请在“服务器 → 编辑”手动填写 %s 后再部署。\n' "$domain" >&2
  fi
}

validate() {
  local cert="$1" key="$2" a b
  openssl x509 -in "$cert" -noout -checkend 86400 >/dev/null || { printf '证书不存在、格式错误或将在 24 小时内过期\n' >&2; exit 1; }
  openssl x509 -in "$cert" -noout -checkhost "$domain" | grep -q 'does match' || { printf '证书与节点域名不匹配\n' >&2; exit 1; }
  openssl verify -verify_hostname "$domain" -untrusted "$cert" "$cert" >/dev/null || { printf '证书链不受系统信任，请使用受信任 CA 签发的证书\n' >&2; exit 1; }
  a="$(openssl x509 -in "$cert" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256)"
  b="$(openssl pkey -in "$key" -pubout -outform DER | openssl dgst -sha256)"
  [[ "$a" == "$b" ]] || { printf '证书和私钥不匹配\n' >&2; exit 1; }
}

activate() {
  flush_usage
  if command -v systemctl >/dev/null && [[ -d /run/systemd/system ]]; then
    systemctl try-restart nexusgate-xray.service || printf 'Xray 重启失败，请运行 ng-agent doctor\n' >&2
    systemctl try-restart nexusgate-sing-box.service || printf 'sing-box 重启失败，请运行 ng-agent doctor\n' >&2
  elif command -v rc-service >/dev/null; then
    rc-service nexusgate-xray status >/dev/null 2>&1 && rc-service nexusgate-xray restart || true
    rc-service nexusgate-sing-box status >/dev/null 2>&1 && rc-service nexusgate-sing-box restart || true
  fi
  printf '证书已安装：%s；有效期：' "$target"
  openssl x509 -in "$target/fullchain.pem" -enddate -noout
  sync_panel
}

flush_usage() {
  [[ -r /etc/nexusgate/agent.env && -f /opt/nexusgate-agent/agent.js ]] || return 0
  if ! ( set -a; source /etc/nexusgate/agent.env; set +a
    node /opt/nexusgate-agent/agent.js flush-usage ); then
    printf '重启前未能上报入口计数，本次尚未上报的流量可能漏计；请检查 ng-agent doctor。\n' >&2
  fi
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
  install -d -m 0700 "$target" || return 1
  ln -sfn "$cert/fullchain.pem" "$target/fullchain.pem" || return 1
  ln -sfn "$cert/privkey.pem" "$target/privkey.pem" || return 1
  install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy || return 1
  cat > /etc/letsencrypt/renewal-hooks/deploy/nexusgate-reload.sh <<'EOF'
#!/usr/bin/env bash
if [[ -r /etc/nexusgate/agent.env && -f /opt/nexusgate-agent/agent.js ]]; then
  if ! ( set -a; source /etc/nexusgate/agent.env; set +a
    node /opt/nexusgate-agent/agent.js flush-usage ); then
    printf '证书续签后核心重启前计数上报失败，可能漏计流量；请检查 ng-agent doctor。\n' >&2
  fi
fi
if command -v systemctl >/dev/null && [[ -d /run/systemd/system ]]; then
  systemctl try-restart nexusgate-xray.service
  systemctl try-restart nexusgate-sing-box.service
elif command -v rc-service >/dev/null; then
  rc-service nexusgate-xray status >/dev/null 2>&1 && rc-service nexusgate-xray restart || true
  rc-service nexusgate-sing-box status >/dev/null 2>&1 && rc-service nexusgate-sing-box restart || true
fi
EOF
  chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/nexusgate-reload.sh
  if command -v systemctl >/dev/null && [[ -d /run/systemd/system ]]; then
    if systemctl is-enabled --quiet certbot.timer 2>/dev/null && systemctl start certbot.timer; then
      # Distribution Certbot already runs renew. Keep only one scheduled job.
      systemctl disable --now nexusgate-cert-renew.timer >/dev/null 2>&1 || true
      printf '使用系统已有的 certbot.timer 自动续签。\n'
      activate
      return
    fi
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
    systemctl daemon-reload && systemctl enable --now nexusgate-cert-renew.timer || return 1
  elif command -v rc-service >/dev/null; then
    install -d -m 0755 /etc/periodic/daily
    printf '#!/bin/sh\ncertbot renew --quiet\n' > /etc/periodic/daily/nexusgate-cert-renew
    chmod 0755 /etc/periodic/daily/nexusgate-cert-renew
    rc-service crond start >/dev/null 2>&1 || true
  fi
  activate
}

issue_http() {
  local -a registration=(--non-interactive --agree-tos)
  if [[ -n "$1" ]]; then registration+=(--email "$1"); else registration+=(--register-unsafely-without-email); fi
  install_certbot || return 1
  certbot certonly --standalone --preferred-challenges http --cert-name "$domain" \
    "${registration[@]}" -d "$domain" || return 1
  activate_renewal
}

credential_token() {
  local line
  cf_token=''
  while IFS= read -r line; do
    if [[ "$line" =~ ^[[:space:]]*dns_cloudflare_api_token[[:space:]]*=(.*)$ ]]; then
      cf_token="${BASH_REMATCH[1]}"
      cf_token="${cf_token#"${cf_token%%[![:space:]]*}"}"
      cf_token="${cf_token%"${cf_token##*[![:space:]]}"}"
      return 0
    fi
  done < "$1"
  return 1
}

verify_cf_token() {
  local token="$1"
  [[ -n "$token" && "$token" != *[$'\r\n']* ]] || { printf 'CF Token 不能为空或包含换行\n' >&2; return 1; }
  printf '%s' "$token" | node -e '
    const fs = require("node:fs");
    const token = fs.readFileSync(0, "utf8");
    if (/\s/.test(token)) { console.error("请只粘贴 Cloudflare API Token 的值，不要粘贴 Bearer 前缀或整条 curl 命令"); process.exit(1); }
    fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12000)
    }).then(async response => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.success || body.result?.status !== "active") {
        const codes = (body.errors || []).map(item => item.code).filter(Number.isInteger).join(", ");
        console.error(`Cloudflare Token 未通过验证（HTTP ${response.status}${codes ? `，代码 ${codes}` : ""}）。请到 My Profile → API Tokens 新建对应 Zone 的 Edit zone DNS Token，仅粘贴令牌值；不要使用 Global API Key。`);
        process.exitCode = 1;
      } else console.log("Cloudflare Token 已验证有效");
    }).catch(error => { console.error(`无法连接 Cloudflare API 验证令牌：${error.cause?.code || error.name}；请检查出站网络`); process.exitCode = 2; });
  '
}

issue_cloudflare() {
  local credentials="$2" cf_token
  [[ -f "$credentials" && -O "$credentials" ]] || { printf 'Cloudflare 凭据文件须由 root 拥有\n' >&2; return 1; }
  chmod 0600 "$credentials"
  credential_token "$credentials" || {
    printf '凭据文件须包含 dns_cloudflare_api_token = ...\n' >&2; return 1;
  }
  verify_cf_token "$cf_token" || return 1
  unset cf_token
  install_certbot || return 1
  install_cloudflare_plugin || return 1
  local -a registration=(--non-interactive --agree-tos)
  if [[ -n "$1" ]]; then registration+=(--email "$1"); else registration+=(--register-unsafely-without-email); fi
  env -u CF_API_KEY -u CF_API_EMAIL -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_API_KEY -u CLOUDFLARE_EMAIL \
    certbot certonly --dns-cloudflare --dns-cloudflare-credentials "$credentials" --dns-cloudflare-propagation-seconds 30 \
    --cert-name "$domain" "${registration[@]}" -d "$domain" || return 1
  activate_renewal
}

port80_free() {
  node -e 'const s=require("node:net").createServer();s.on("error",()=>process.exit(1));s.listen(80,"0.0.0.0",()=>s.close(()=>process.exit(0)))' >/dev/null 2>&1
}

setup() {
  if [[ -f "/etc/letsencrypt/live/$domain/fullchain.pem" ]] &&
    openssl x509 -in "/etc/letsencrypt/live/$domain/fullchain.pem" -checkend 2592000 -noout >/dev/null 2>&1; then
    printf '发现已有有效证书，配置自动续签并同步面板。\n'
    activate_renewal
    return
  fi
  printf 'DNS 验证不需要公网 80 端口，但首次需输入一次 CF API Token；HTTP 验证无需 Token，但必须公网放行 80/TCP。\n'
  local answer
  if port80_free; then
    read -r -p '验证方式：[1] Cloudflare DNS（推荐） [2] HTTP 80 端口，默认 1：' answer <&3
    if [[ "$answer" == 2 ]]; then
      if issue_http "$setup_email"; then return; fi
      printf 'HTTP 验证失败：检查 DNS 灰云、域名 A/AAAA 指向以及机器防火墙和服务商安全组的 80/TCP；可继续改用 DNS 验证。\n' >&2
    fi
  else
    printf '本机 80/TCP 已占用，使用 Cloudflare DNS 验证。\n'
  fi
  local credentials="/etc/nexusgate/cloudflare/$domain.ini" cf_token
  if [[ -f "$credentials" && -O "$credentials" ]] && credential_token "$credentials" && verify_cf_token "$cf_token"; then
    printf '继续使用已保存的 Cloudflare 凭据。\n'
  else
    printf '请到 Cloudflare → My Profile → API Tokens 创建 Edit zone DNS Token（只限此域名的 Zone），只粘贴 Token 值；输入不会回显。\n'
    read -r -s -p 'CF API Token：' cf_token <&3; printf '\n'
    cf_token="${cf_token#"${cf_token%%[![:space:]]*}"}"
    cf_token="${cf_token%"${cf_token##*[![:space:]]}"}"
    cf_token="${cf_token#Bearer }"
    cf_token="${cf_token#bearer }"
    cf_token="${cf_token#\"}"; cf_token="${cf_token%\"}"
    verify_cf_token "$cf_token" || return 1
    install -d -m 0700 /etc/nexusgate/cloudflare
    local credential_tmp
    credential_tmp="$(mktemp "/etc/nexusgate/cloudflare/.${domain}.XXXXXX")"
    chmod 0600 "$credential_tmp"
    printf 'dns_cloudflare_api_token = %s\n' "$cf_token" > "$credential_tmp"
    mv -f -- "$credential_tmp" "$credentials"
  fi
  unset cf_token
  issue_cloudflare "$setup_email" "$credentials"
}

case "$action" in
  setup) setup ;;
  import)
    [[ $# -eq 4 ]] || { printf '用法：ng-agent cert import 域名 /path/fullchain.pem /path/privkey.pem\n' >&2; exit 1; }
    validate "$3" "$4"
    install -d -m 0700 "$target"
    install -m 0600 "$3" "$target/fullchain.pem"
    install -m 0600 "$4" "$target/privkey.pem"
    activate ;;
  issue)
    [[ $# -eq 3 && "$3" == *@* ]] || { printf '用法：ng-agent cert issue 域名 邮箱（节点须放行 80/TCP，且没有其他程序占用）\n' >&2; exit 1; }
    issue_http "$3" ;;
  issue-cloudflare)
    [[ $# -eq 4 && "$3" == *@* && -f "$4" ]] || { printf '用法：ng-agent cert issue-cloudflare 域名 邮箱 /root/cloudflare.ini\n' >&2; exit 1; }
    issue_cloudflare "$3" "$4" ;;
  status)
    [[ -f "$target/fullchain.pem" ]] || { printf '未找到该节点证书\n' >&2; exit 1; }
    validate "$target/fullchain.pem" "$target/privkey.pem"
    openssl x509 -in "$target/fullchain.pem" -enddate -noout ;;
  *) printf '用法：ng-agent cert [交互式申请] | ng-agent cert {issue 域名 邮箱|issue-cloudflare 域名 邮箱 /root/cloudflare.ini|import 域名 证书 私钥|status 域名}\n' >&2; exit 1 ;;
esac
