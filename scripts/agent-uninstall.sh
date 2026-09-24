#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${EUID}" -eq 0 ]] || { printf '请使用 root 运行\n' >&2; exit 1; }
if [[ "${1:-}" != "--yes" ]]; then
  printf '将停止并删除此机器上的 NexusGate Agent、专属 Xray 服务、节点资源和密钥。\n'
  printf '请先在控制台停用/删除关联线路；如设备已离线，之后在控制台执行“强制遗忘”。\n'
  printf '输入 UNINSTALL 确认：' > /dev/tty
  read -r confirmation < /dev/tty
  [[ "$confirmation" == "UNINSTALL" ]] || { printf '已取消\n'; exit 1; }
fi

if command -v systemctl >/dev/null && [[ -d /run/systemd/system ]]; then
  systemctl disable --now nexusgate-agent.service 2>/dev/null || true
  systemctl disable --now nexusgate-xray.service 2>/dev/null || true
  systemctl disable --now nexusgate-sing-box.service 2>/dev/null || true
  systemctl disable --now nexusgate-cert-renew.timer 2>/dev/null || true
  systemctl disable --now nexusgate-agent-logrotate.timer 2>/dev/null || true
  rm -f -- /etc/systemd/system/nexusgate-agent.service /etc/systemd/system/nexusgate-xray.service /etc/systemd/system/nexusgate-sing-box.service /etc/systemd/system/nexusgate-cert-renew.service /etc/systemd/system/nexusgate-cert-renew.timer /etc/systemd/system/nexusgate-agent-logrotate.service /etc/systemd/system/nexusgate-agent-logrotate.timer
  systemctl daemon-reload
fi
if command -v rc-service >/dev/null; then
  rc-service nexusgate-agent stop 2>/dev/null || true
  rc-service nexusgate-xray stop 2>/dev/null || true
  rc-service nexusgate-sing-box stop 2>/dev/null || true
  rc-update del nexusgate-agent default 2>/dev/null || true
  rc-update del nexusgate-xray default 2>/dev/null || true
  rm -f -- /etc/init.d/nexusgate-agent /etc/init.d/nexusgate-xray /etc/init.d/nexusgate-sing-box
  rm -f -- /etc/periodic/daily/nexusgate-cert-renew
  rm -f -- /etc/periodic/hourly/nexusgate-agent-logrotate
fi

rm -rf -- /opt/nexusgate-agent /etc/nexusgate /var/log/nexusgate
rm -f -- /etc/logrotate.d/nexusgate-agent
rm -f -- /etc/letsencrypt/renewal-hooks/deploy/nexusgate-reload.sh
rm -f -- /usr/local/sbin/ng-agent /usr/local/sbin/ng-agent-update /usr/local/sbin/ng-agent-uninstall /usr/local/sbin/ng-agent-doctor /usr/local/sbin/ng-agent-cert /usr/local/sbin/ng-agent-singbox /usr/local/sbin/ng-agent-logrotate-setup /usr/local/bin/nexusgate-sing-box /usr/local/bin/nexusgate-sing-box-stats
printf 'NexusGate Agent 与其资源已删除。系统共用的 Node.js、Xray 可执行文件和其他服务未删除。\n'
printf 'Certbot 管理的证书仍保留；若曾使用 CF DNS 验证，其令牌已删除，保留的续签任务需另行配置或在确认没有其他服务使用后用 certbot delete 清理。\n'
printf '请在控制台删除/遗忘此设备，以撤销其 Agent 密钥和登记。\n'
