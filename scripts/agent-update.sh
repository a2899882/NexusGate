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
curl -fL --retry 3 "https://raw.githubusercontent.com/${REPO}/${BRANCH}/scripts/agent-uninstall.sh" -o "$tmp_dir/uninstall.sh"
curl -fL --retry 3 "https://raw.githubusercontent.com/${REPO}/${BRANCH}/scripts/agent-doctor.sh" -o "$tmp_dir/doctor.sh"
curl -fL --retry 3 "https://raw.githubusercontent.com/${REPO}/${BRANCH}/scripts/agent-cert.sh" -o "$tmp_dir/cert.sh"
curl -fL --retry 3 "https://raw.githubusercontent.com/${REPO}/${BRANCH}/scripts/agent-update.sh" -o "$tmp_dir/update.sh"
curl -fL --retry 3 "https://raw.githubusercontent.com/${REPO}/${BRANCH}/scripts/agent-singbox.sh" -o "$tmp_dir/singbox.sh"
curl -fL --retry 3 "https://raw.githubusercontent.com/${REPO}/${BRANCH}/scripts/agent-logrotate.conf" -o "$tmp_dir/logrotate.conf"
curl -fL --retry 3 "https://raw.githubusercontent.com/${REPO}/${BRANCH}/scripts/agent-logrotate-setup.sh" -o "$tmp_dir/logrotate-setup.sh"
[[ -s "$tmp_dir/update.sh" ]] || die 'Agent 升级脚本下载不完整'
node --check "$tmp_dir/agent.js"
# Updating can rewrite an older HY2 configuration and restart Xray. Persist
# its current bidirectional counters before the running process is replaced.
if [[ -f /opt/nexusgate-agent/agent.js ]]; then
  ( set -a; source /etc/nexusgate/agent.env; set +a; node /opt/nexusgate-agent/agent.js flush-usage ) \
    || die '更新前流量统计上报失败，保留原 Agent；检查控制面连接和 ng-agent doctor 后重试'
fi
install -m 0644 "$tmp_dir/agent.js" /opt/nexusgate-agent/agent.js
install -m 0755 "$tmp_dir/run.sh" /opt/nexusgate-agent/run.sh
install -m 0755 "$tmp_dir/uninstall.sh" /usr/local/sbin/ng-agent-uninstall
install -m 0755 "$tmp_dir/doctor.sh" /usr/local/sbin/ng-agent-doctor
install -m 0755 "$tmp_dir/cert.sh" /usr/local/sbin/ng-agent-cert
install -m 0755 "$tmp_dir/singbox.sh" /usr/local/sbin/ng-agent-singbox
install -m 0644 "$tmp_dir/logrotate.conf" /etc/nexusgate/agent-logrotate.conf
install -m 0755 "$tmp_dir/logrotate-setup.sh" /usr/local/sbin/ng-agent-logrotate-setup
install -m 0755 "$tmp_dir/update.sh" /usr/local/sbin/ng-agent-update.next
mv -f -- /usr/local/sbin/ng-agent-update.next /usr/local/sbin/ng-agent-update
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
chmod 0755 /usr/local/sbin/ng-agent
if [[ "${NG_INSTALL_ANYTLS:-0}" == 1 ]]; then
  if ! NG_REPO="$REPO" NG_BRANCH="$BRANCH" ng-agent-singbox install; then
    info 'sing-box 构建未完成；现有 Xray 节点正常。修复后运行 ng-agent engine install 重试。'
  fi
elif [[ -x /usr/local/bin/nexusgate-sing-box && ! -x /usr/local/bin/nexusgate-sing-box-stats ]]; then
  info '发现未完成的 sing-box 安装；更新 Agent 不会再次编译，请在需要 AnyTLS 的入口机运行 ng-agent engine install。'
fi
if command -v systemctl >/dev/null && [[ -d /run/systemd/system ]]; then
  curl -fL --retry 3 "https://raw.githubusercontent.com/${REPO}/${BRANCH}/systemd/nexusgate-agent.service" -o /etc/systemd/system/nexusgate-agent.service
  curl -fL --retry 3 "https://raw.githubusercontent.com/${REPO}/${BRANCH}/systemd/nexusgate-xray.service" -o /etc/systemd/system/nexusgate-xray.service
  curl -fL --retry 3 "https://raw.githubusercontent.com/${REPO}/${BRANCH}/systemd/nexusgate-sing-box.service" -o /etc/systemd/system/nexusgate-sing-box.service
  systemctl daemon-reload
  rm -f -- /etc/nexusgate/last-heartbeat.json
  systemctl restart nexusgate-agent.service
  systemctl is-active --quiet nexusgate-agent.service || die "Agent 重启失败"
elif command -v rc-service >/dev/null; then
  curl -fL --retry 3 "https://raw.githubusercontent.com/${REPO}/${BRANCH}/openrc/nexusgate-agent" -o /etc/init.d/nexusgate-agent
  curl -fL --retry 3 "https://raw.githubusercontent.com/${REPO}/${BRANCH}/openrc/nexusgate-xray" -o /etc/init.d/nexusgate-xray
  curl -fL --retry 3 "https://raw.githubusercontent.com/${REPO}/${BRANCH}/openrc/nexusgate-sing-box" -o /etc/init.d/nexusgate-sing-box
  chmod 0755 /etc/init.d/nexusgate-agent /etc/init.d/nexusgate-xray /etc/init.d/nexusgate-sing-box
  if [[ -e /etc/init.d/crond ]]; then
    rc-update add crond default >/dev/null 2>&1 || true
    rc-service crond start >/dev/null 2>&1 || true
  fi
  rm -f -- /etc/nexusgate/last-heartbeat.json
  rc-service nexusgate-agent restart
  rc-service nexusgate-agent status >/dev/null || die "Agent 重启失败"
else
  die "未检测到 systemd 或 OpenRC"
fi
ng-agent-logrotate-setup
for _ in {1..35}; do
  [[ -s /etc/nexusgate/last-heartbeat.json ]] && break
  sleep 1
done
[[ -s /etc/nexusgate/last-heartbeat.json ]] || die 'Agent 已重启，但尚未连接控制面；请执行 ng-agent doctor'
info "Agent 更新完成"
