#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${NG_REPO:-a2899882/NexusGate}"
BRANCH="${NG_BRANCH:-main}"
die() { printf '错误：%s\n' "$*" >&2; exit 1; }
info() { printf '\033[1;36m[NexusGate Agent]\033[0m %s\n' "$*"; }
[[ "${EUID}" -eq 0 ]] || die "请使用 root 运行"
[[ -f /etc/nexusgate/agent.env ]] || die "未检测到已安装的 NexusGate Agent"
command -v curl >/dev/null || die "缺少 curl"
tmp_dir="$(mktemp -d /tmp/nexusgate-agent-update.XXXXXX)"
trap 'rm -rf -- "$tmp_dir"' EXIT
curl -fL --retry 3 "https://raw.githubusercontent.com/${REPO}/${BRANCH}/agent/agent.js" -o "$tmp_dir/agent.js"
curl -fL --retry 3 "https://raw.githubusercontent.com/${REPO}/${BRANCH}/agent/run.sh" -o "$tmp_dir/run.sh"
node --check "$tmp_dir/agent.js"
install -m 0644 "$tmp_dir/agent.js" /opt/nexusgate-agent/agent.js
install -m 0755 "$tmp_dir/run.sh" /opt/nexusgate-agent/run.sh
if command -v systemctl >/dev/null && [[ -d /run/systemd/system ]]; then
  systemctl restart nexusgate-agent.service
  systemctl is-active --quiet nexusgate-agent.service || die "Agent 重启失败"
elif command -v rc-service >/dev/null; then
  rc-service nexusgate-agent restart
  rc-service nexusgate-agent status >/dev/null || die "Agent 重启失败"
else
  die "未检测到 systemd 或 OpenRC"
fi
info "Agent 更新完成"
