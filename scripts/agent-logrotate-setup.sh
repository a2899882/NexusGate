#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${EUID}" -eq 0 ]] || { printf '请使用 root 运行\n' >&2; exit 1; }
config='/etc/nexusgate/agent-logrotate.conf'
[[ -s "$config" ]] || { printf '缺少 Agent 日志轮转配置\n' >&2; exit 1; }
logrotate_bin="$(command -v logrotate)"

if command -v systemctl >/dev/null && [[ -d /run/systemd/system ]]; then
  cat > /etc/systemd/system/nexusgate-agent-logrotate.service <<EOF
[Unit]
Description=Rotate NexusGate node logs

[Service]
Type=oneshot
ExecStart=$logrotate_bin -s /etc/nexusgate/logrotate.status $config
EOF
  cat > /etc/systemd/system/nexusgate-agent-logrotate.timer <<'EOF'
[Unit]
Description=Check NexusGate node log size hourly

[Timer]
OnCalendar=hourly
Persistent=true
RandomizedDelaySec=5m

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now nexusgate-agent-logrotate.timer
elif command -v rc-service >/dev/null; then
  install -d -m 0755 /etc/periodic/hourly
  cat > /etc/periodic/hourly/nexusgate-agent-logrotate <<EOF
#!/bin/sh
$logrotate_bin -s /etc/nexusgate/logrotate.status $config
EOF
  chmod 0755 /etc/periodic/hourly/nexusgate-agent-logrotate
else
  printf '未检测到 systemd 或 OpenRC，日志轮转定时器未安装\n' >&2
  exit 1
fi

# The old daily task must not rotate the same files with a separate state.
rm -f -- /etc/logrotate.d/nexusgate-agent
