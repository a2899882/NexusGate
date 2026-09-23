#!/usr/bin/env bash
set -u

[[ "${EUID}" -eq 0 ]] || { printf '请使用 root 运行\n' >&2; exit 1; }
[[ -r /etc/nexusgate/agent.env ]] || { printf '未安装 NexusGate Agent\n' >&2; exit 1; }
# Local root-owned configuration. Never print the enrollment key.
source /etc/nexusgate/agent.env
printf '控制面：%s\n' "${NG_CONTROLLER:-未配置}"
printf 'Agent 版本：'
node -p "require('fs').readFileSync('/opt/nexusgate-agent/agent.js','utf8').match(/const VERSION = '([^']+)'/)[1]" 2>/dev/null || printf '无法读取\n'
if command -v systemctl >/dev/null && [[ -d /run/systemd/system ]]; then
  for name in nexusgate-agent nexusgate-xray; do
    printf '%s：' "$name"
    systemctl is-active "$name" 2>&1 || true
  done
else
  rc-service nexusgate-agent status || true
  rc-service nexusgate-xray status || true
fi
printf '控制面连通性：'
curl --max-time 8 -fsS "${NG_CONTROLLER%/}/healthz" 2>&1 | head -c 350 || true
printf '\nXray 配置校验：\n'
if [[ -f /etc/nexusgate/xray/config.json ]]; then
  /usr/local/bin/xray run -test -config /etc/nexusgate/xray/config.json 2>&1 | tail -n 12
else
  printf '配置文件不存在\n'
fi
printf '\n最近 Agent 与 Xray 日志：\n'
if command -v journalctl >/dev/null && [[ -d /run/systemd/system ]]; then
  journalctl -u nexusgate-agent -u nexusgate-xray -n 45 --no-pager -o short-iso 2>&1 | sed -E 's/(Bearer |NG_AGENT_KEY=)[^[:space:]]+/\1[REDACTED]/g'
else
  tail -n 45 /var/log/nexusgate/xray-error.log 2>/dev/null || true
fi
