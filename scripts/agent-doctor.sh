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
  for name in nexusgate-agent nexusgate-xray nexusgate-sing-box; do
    printf '%s：' "$name"
    systemctl is-active "$name" 2>&1 || true
  done
else
  rc-service nexusgate-agent status || true
  rc-service nexusgate-xray status || true
  rc-service nexusgate-sing-box status || true
fi
printf '\nsing-box 构建与配置：\n'
if [[ -x /usr/local/bin/nexusgate-sing-box ]]; then
  /usr/local/bin/nexusgate-sing-box version | head -n 4
  if [[ -f /etc/nexusgate/sing-box/config.json ]]; then
    /usr/local/bin/nexusgate-sing-box check -c /etc/nexusgate/sing-box/config.json 2>&1 | tail -n 12
    printf 'AnyTLS 入站流量统计（累计）：\n'
    /usr/local/bin/xray api statsquery --server="127.0.0.1:${NG_SINGBOX_API_PORT:-10086}" -pattern 'inbound>>>' 2>&1 | head -c 900
    printf '\n'
  else
    printf '已安装，当前没有 AnyTLS 资源\n'
  fi
else
  printf '未安装；运行 ng-agent engine install\n'
fi
printf '控制面连通性：'
curl --max-time 8 -fsS "${NG_CONTROLLER%/}/healthz" 2>&1 | head -c 350 || true
printf '\nXray 配置校验：\n'
if [[ -f /etc/nexusgate/xray/config.json ]]; then
  /usr/local/bin/xray run -test -config /etc/nexusgate/xray/config.json 2>&1 | tail -n 12
else
  printf '配置文件不存在\n'
fi
printf '\nXray 入站流量统计（累计，查询不会清零）：\n'
stats_output="$(/usr/local/bin/xray api statsquery --server="127.0.0.1:${NG_XRAY_API_PORT:-10085}" -pattern 'inbound>>>' 2>&1)"
if [[ $? -ne 0 ]]; then
  printf '查询失败：%.250s\n' "$stats_output"
else
  STATS_OUTPUT="$stats_output" node -e '
    try {
      const stats = JSON.parse(process.env.STATS_OUTPUT).stat || [];
      const entries = stats.filter(item => /^inbound>>>ng-.*>>>traffic>>>(uplink|downlink)$/.test(item.name));
      if (!entries.length) console.log("尚无入口流量计数；请确认客户端确实连接本机节点后再测试");
      else for (const item of entries.slice(0, 24)) console.log(`${item.name}: ${item.value} B`);
    } catch { console.log("统计返回格式无效，请升级 Xray 和 Agent"); }
  '
fi
printf '\n最近 Agent 与 Xray 日志：\n'
if command -v journalctl >/dev/null && [[ -d /run/systemd/system ]]; then
  journalctl -u nexusgate-agent -u nexusgate-xray -u nexusgate-sing-box -n 45 --no-pager -o short-iso 2>&1 | sed -E 's/(Bearer |NG_AGENT_KEY=)[^[:space:]]+/\1[REDACTED]/g; s/[Pp]rivate[[:space:]]*[Kk]ey:[[:space:]]*[^[:space:]]+/PrivateKey: [REDACTED]/g'
else
  tail -n 45 /var/log/nexusgate/xray-error.log 2>/dev/null || true
fi
