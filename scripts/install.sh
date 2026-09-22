#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${NG_REPO:-a2899882/NexusGate}"
BRANCH="${NG_BRANCH:-main}"
DOMAIN=""
EMAIL=""

die() { printf '错误：%s\n' "$*" >&2; exit 1; }
info() { printf '\033[1;36m[NexusGate]\033[0m %s\n' "$*"; }
ask() {
  local prompt="$1" value=""
  if [[ -r /dev/tty ]]; then read -r -p "$prompt" value </dev/tty; fi
  printf '%s' "$value"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    *) die "未知参数：$1" ;;
  esac
done

[[ "${EUID}" -eq 0 ]] || die "请使用 root 运行"
[[ -f /etc/debian_version ]] || die "控制面一键安装器当前支持 Debian 12 / Ubuntu 22.04+"
[[ ! -e /opt/nexusgate ]] || die "检测到已有安装，请运行 nexusgate update"

if [[ -z "$DOMAIN" ]]; then DOMAIN="$(ask '请输入面板域名（如 gate.example.com）：')"; fi
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "域名格式不正确"
if [[ -z "$EMAIL" ]]; then EMAIL="$(ask '证书邮箱（可留空）：')"; fi

info "安装系统依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl tar openssl nodejs caddy
node_major="$(node -p 'process.versions.node.split(`.`)[0]')"
[[ "$node_major" -ge 18 ]] || die "需要 Node.js 18 或更高版本"

tmp_dir="$(mktemp -d /tmp/nexusgate-install.XXXXXX)"
trap 'rm -rf -- "$tmp_dir"' EXIT
info "下载 ${REPO}@${BRANCH}"
curl -fL --retry 3 "https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz" -o "$tmp_dir/source.tgz"
mkdir -p "$tmp_dir/source"
tar -xzf "$tmp_dir/source.tgz" -C "$tmp_dir/source" --strip-components=1
[[ -f "$tmp_dir/source/server.js" ]] || die "安装包不完整"

getent group nexusgate >/dev/null || groupadd --system nexusgate
id nexusgate >/dev/null 2>&1 || useradd --system --gid nexusgate --home-dir /var/lib/nexusgate --shell /usr/sbin/nologin nexusgate
install -d -o root -g root -m 0755 /opt/nexusgate
cp -a "$tmp_dir/source/." /opt/nexusgate/
install -d -o nexusgate -g nexusgate -m 0700 /var/lib/nexusgate

admin_password="$(openssl rand -base64 24 | tr -d '\n')"
session_secret="$(openssl rand -hex 32)"
cat > /etc/nexusgate.env <<EOF
NODE_ENV=production
NG_HOST=127.0.0.1
NG_PORT=8787
NG_DATA_FILE=/var/lib/nexusgate/nexusgate.json
NG_COOKIE_SECURE=true
NG_ADMIN_USERNAME=admin
NG_ADMIN_PASSWORD=${admin_password}
NG_SESSION_SECRET=${session_secret}
EOF
chmod 0600 /etc/nexusgate.env

install -m 0644 /opt/nexusgate/systemd/nexusgate.service /etc/systemd/system/nexusgate.service
install -m 0755 /opt/nexusgate/scripts/nexusgate.sh /usr/local/sbin/nexusgate
ln -sf /usr/local/sbin/nexusgate /usr/local/sbin/ng

install -d -m 0755 /etc/caddy/Caddyfile.d
cat > /etc/caddy/Caddyfile.d/nexusgate.caddy <<EOF
${DOMAIN} {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8787
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        -Server
    }
    log {
        output file /var/log/caddy/nexusgate-access.log {
            roll_size 20MiB
            roll_keep 5
            roll_keep_for 168h
        }
    }
EOF
if [[ -n "$EMAIL" ]]; then printf '    tls %s\n' "$EMAIL" >> /etc/caddy/Caddyfile.d/nexusgate.caddy; fi
printf '}\n' >> /etc/caddy/Caddyfile.d/nexusgate.caddy
if ! grep -qF 'import /etc/caddy/Caddyfile.d/*' /etc/caddy/Caddyfile; then
  printf '\nimport /etc/caddy/Caddyfile.d/*\n' >> /etc/caddy/Caddyfile
fi
caddy fmt --overwrite /etc/caddy/Caddyfile
caddy fmt --overwrite /etc/caddy/Caddyfile.d/nexusgate.caddy
caddy validate --config /etc/caddy/Caddyfile

systemctl daemon-reload
systemctl enable --now nexusgate.service
healthy=false
for _ in {1..30}; do
  if curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1; then healthy=true; break; fi
  sleep 1
done
if [[ "$healthy" != true ]]; then
  systemctl status nexusgate --no-pager || true
  journalctl -u nexusgate -n 100 --no-pager || true
  die "控制面启动失败，诊断信息已输出"
fi
sed -i '/^NG_ADMIN_PASSWORD=/d' /etc/nexusgate.env
systemctl enable --now caddy
systemctl reload caddy

printf '\n\033[1;32m安装完成\033[0m\n'
printf '地址：https://%s\n账号：admin\n密码：%s\n' "$DOMAIN" "$admin_password"
printf '管理命令：nexusgate 或 ng\n请立即登录并妥善保存密码。\n'
