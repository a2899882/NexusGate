#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${NG_REPO:-a2899882/NexusGate}"
BRANCH="${NG_BRANCH:-main}"
CONTROLLER=""
TOKEN=""

die() { printf '错误：%s\n' "$*" >&2; exit 1; }
info() { printf '\033[1;36m[NexusGate Agent]\033[0m %s\n' "$*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) CONTROLLER="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    *) die "未知参数：$1" ;;
  esac
done

[[ "${EUID}" -eq 0 ]] || die "请使用 root 运行"
[[ "$CONTROLLER" =~ ^https?:// ]] || die "--server 必须是完整的 HTTP(S) 地址"
[[ -n "$TOKEN" ]] || die "缺少 --token"
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq ca-certificates curl unzip nodejs openssl logrotate
elif command -v dnf >/dev/null; then
  dnf install -y ca-certificates curl unzip nodejs openssl logrotate
elif command -v apk >/dev/null; then
  apk add --no-cache bash ca-certificates curl unzip nodejs openrc openssl logrotate
else
  die "当前安装器支持 Debian/Ubuntu、RHEL 系和 Alpine"
fi
node_major="$(node -p 'process.versions.node.split(`.`)[0]')"
[[ "$node_major" -ge 18 ]] || die "需要 Node.js 18 或更高版本"

case "$(uname -m)" in
  x86_64|amd64) xray_arch="64" ;;
  aarch64|arm64) xray_arch="arm64-v8a" ;;
  armv7l) xray_arch="arm32-v7a" ;;
  *) die "暂不支持的架构：$(uname -m)" ;;
esac

tmp_dir="$(mktemp -d /tmp/nexusgate-agent.XXXXXX)"
trap 'rm -rf -- "$tmp_dir"' EXIT
info "下载 Xray-core"
xray_asset="Xray-linux-${xray_arch}.zip"
curl -fL --retry 3 "https://github.com/XTLS/Xray-core/releases/latest/download/${xray_asset}" -o "$tmp_dir/xray.zip"
unzip -q "$tmp_dir/xray.zip" xray -d "$tmp_dir/xray"
install -m 0755 "$tmp_dir/xray/xray" /usr/local/bin/xray

install -d -m 0755 /opt/nexusgate-agent
curl -fL --retry 3 "https://raw.githubusercontent.com/${REPO}/${BRANCH}/agent/agent.js" -o /opt/nexusgate-agent/agent.js
curl -fL --retry 3 "https://raw.githubusercontent.com/${REPO}/${BRANCH}/agent/run.sh" -o /opt/nexusgate-agent/run.sh
curl -fL --retry 3 "https://raw.githubusercontent.com/${REPO}/${BRANCH}/scripts/agent-update.sh" -o /usr/local/sbin/ng-agent-update
curl -fL --retry 3 "https://raw.githubusercontent.com/${REPO}/${BRANCH}/scripts/agent-uninstall.sh" -o /usr/local/sbin/ng-agent-uninstall
curl -fL --retry 3 "https://raw.githubusercontent.com/${REPO}/${BRANCH}/scripts/agent-doctor.sh" -o /usr/local/sbin/ng-agent-doctor
curl -fL --retry 3 "https://raw.githubusercontent.com/${REPO}/${BRANCH}/scripts/agent-cert.sh" -o /usr/local/sbin/ng-agent-cert
curl -fL --retry 3 "https://raw.githubusercontent.com/${REPO}/${BRANCH}/scripts/agent-singbox.sh" -o /usr/local/sbin/ng-agent-singbox
curl -fL --retry 3 "https://raw.githubusercontent.com/${REPO}/${BRANCH}/scripts/agent-logrotate.conf" -o /etc/logrotate.d/nexusgate-agent
cat > /usr/local/sbin/ng-agent <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
case "${1:-}" in
  update) exec ng-agent-update ;;
  uninstall) shift; exec ng-agent-uninstall "$@" ;;
  doctor|status) exec ng-agent-doctor ;;
  cert) shift; exec ng-agent-cert "$@" ;;
  engine) shift; exec ng-agent-singbox "$@" ;;
  *) printf 'NexusGate Agent: ng-agent doctor | ng-agent cert | ng-agent engine install | ng-agent update | ng-agent uninstall\n' ;;
esac
EOF
chmod 0644 /opt/nexusgate-agent/agent.js
chmod 0755 /opt/nexusgate-agent/run.sh /usr/local/sbin/ng-agent-update /usr/local/sbin/ng-agent-uninstall /usr/local/sbin/ng-agent-doctor /usr/local/sbin/ng-agent-cert /usr/local/sbin/ng-agent-singbox /usr/local/sbin/ng-agent
install -d -m 0700 /etc/nexusgate /etc/nexusgate/xray /etc/nexusgate/xray/resources /etc/nexusgate/sing-box
install -d -m 0750 /var/log/nexusgate
if [[ ! -f /etc/nexusgate/xray/config.json ]]; then
  printf '{"log":{"loglevel":"warning"},"inbounds":[],"outbounds":[]}\n' > /etc/nexusgate/xray/config.json
fi
chmod 0600 /etc/nexusgate/xray/config.json
if [[ "${NG_INSTALL_ANYTLS:-0}" == 1 ]]; then
  NG_REPO="$REPO" NG_BRANCH="$BRANCH" ng-agent-singbox install || die 'AnyTLS 引擎安装失败；修复后运行 ng-agent engine install'
else
  info '基础节点只安装 Xray；需要 AnyTLS 时在入口机运行 ng-agent engine install。'
fi

info "向控制面注册"
enroll_json="$(TOKEN_VALUE="$TOKEN" node -e 'process.stdout.write(JSON.stringify({token:process.env.TOKEN_VALUE,hostname:require("node:os").hostname(),version:"0.6.7",system:{platform:process.platform,arch:process.arch}}))')"
response="$(curl -fsS -H 'content-type: application/json' --data "$enroll_json" "${CONTROLLER%/}/api/agent/enroll")" || die "注册失败，请检查地址和令牌"
agent_key="$(RESPONSE_VALUE="$response" node -e 'const r=JSON.parse(process.env.RESPONSE_VALUE); if(!r.agentKey) process.exit(1); process.stdout.write(r.agentKey)')" || die "控制面返回无效"

{
  printf 'NG_CONTROLLER=%q\n' "${CONTROLLER%/}"
  printf 'NG_AGENT_KEY=%q\n' "$agent_key"
  printf 'NG_XRAY_BIN=/usr/local/bin/xray\n'
  printf 'NG_CONFIG_DIR=/etc/nexusgate/xray\n'
  printf 'NG_KEY_FILE=/etc/nexusgate/keys.json\n'
} > /etc/nexusgate/agent.env
chmod 0600 /etc/nexusgate/agent.env

if command -v systemctl >/dev/null && [[ -d /run/systemd/system ]]; then
  curl -fL --retry 3 "https://raw.githubusercontent.com/${REPO}/${BRANCH}/systemd/nexusgate-agent.service" -o /etc/systemd/system/nexusgate-agent.service
  curl -fL --retry 3 "https://raw.githubusercontent.com/${REPO}/${BRANCH}/systemd/nexusgate-xray.service" -o /etc/systemd/system/nexusgate-xray.service
  curl -fL --retry 3 "https://raw.githubusercontent.com/${REPO}/${BRANCH}/systemd/nexusgate-sing-box.service" -o /etc/systemd/system/nexusgate-sing-box.service
  systemctl daemon-reload
  systemctl enable nexusgate-xray.service nexusgate-agent.service
  systemctl restart nexusgate-xray.service
  rm -f -- /etc/nexusgate/last-heartbeat.json
  systemctl restart nexusgate-agent.service
  service_manager="systemd"
elif command -v rc-service >/dev/null; then
  install -d -m 0755 /etc/init.d
  curl -fL --retry 3 "https://raw.githubusercontent.com/${REPO}/${BRANCH}/openrc/nexusgate-agent" -o /etc/init.d/nexusgate-agent
  curl -fL --retry 3 "https://raw.githubusercontent.com/${REPO}/${BRANCH}/openrc/nexusgate-xray" -o /etc/init.d/nexusgate-xray
  curl -fL --retry 3 "https://raw.githubusercontent.com/${REPO}/${BRANCH}/openrc/nexusgate-sing-box" -o /etc/init.d/nexusgate-sing-box
  chmod 0755 /etc/init.d/nexusgate-agent /etc/init.d/nexusgate-xray /etc/init.d/nexusgate-sing-box
  rc-update add nexusgate-xray default >/dev/null
  rc-update add nexusgate-agent default >/dev/null
  # Alpine runs /etc/periodic/daily/logrotate through BusyBox crond.
  if [[ -e /etc/init.d/crond ]]; then
    rc-update add crond default >/dev/null 2>&1 || true
    rc-service crond start >/dev/null 2>&1 || true
  fi
  rc-service nexusgate-xray restart
  rm -f -- /etc/nexusgate/last-heartbeat.json
  rc-service nexusgate-agent restart
  service_manager="OpenRC"
else
  die "未检测到 systemd 或 OpenRC"
fi
for _ in {1..35}; do
  [[ -s /etc/nexusgate/last-heartbeat.json ]] && break
  sleep 1
done
if [[ ! -s /etc/nexusgate/last-heartbeat.json ]]; then
  if [[ "$service_manager" == systemd ]]; then journalctl -u nexusgate-agent.service -n 35 --no-pager || true; fi
  die 'Agent 注册成功但没有向控制面上报心跳；运行 ng-agent doctor 排查后再重试'
fi
printf '\n\033[1;32mAgent 安装、注册和首次心跳完成（%s）。\033[0m\n' "$service_manager"
printf '后续更新 Agent：ng-agent-update\n'
printf '卸载 Agent：ng-agent uninstall\n'
printf '检查 Agent 与 Xray：ng-agent doctor\n'
if [[ "$service_manager" == systemd ]] && ! systemctl is-active --quiet nexusgate-agent.service; then
  journalctl -u nexusgate-agent.service -n 35 --no-pager || true
  die 'Agent 注册已完成，但服务没有运行；请执行 ng-agent doctor 检查原因'
fi
