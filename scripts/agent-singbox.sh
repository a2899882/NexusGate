#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${EUID}" -eq 0 ]] || { printf '请使用 root 运行\n' >&2; exit 1; }
[[ "${1:-install}" == install ]] || { printf '用法：ng-agent engine install\n' >&2; exit 1; }

# Build a version pinned to the configuration model tested by NexusGate.
# Official builds do not guarantee the optional V2Ray statistics API.
version='v1.12.23'
target='/usr/local/bin/nexusgate-sing-box'
if [[ -x "$target" && "${2:-}" != '--force' ]]; then
  printf 'sing-box 已安装：%s（如需重装，运行 ng-agent-singbox install --force）\n' "$target"
  exit 0
fi

if ! command -v go >/dev/null; then
  if command -v apt-get >/dev/null; then
    apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq golang-go
  elif command -v dnf >/dev/null; then
    dnf install -y golang
  elif command -v apk >/dev/null; then
    apk add --no-cache go
  else
    printf '请先安装 Go 1.23.1 或更新版本\n' >&2; exit 1
  fi
fi

build_dir="$(mktemp -d /tmp/nexusgate-singbox.XXXXXX)"
trap 'rm -rf -- "$build_dir"' EXIT
printf '构建 sing-box %s（启用 V2Ray 统计 API，首次需下载 Go 依赖）...\n' "$version"
GOBIN="$build_dir" GOTOOLCHAIN=auto GOMAXPROCS=2 go install -p 2 -tags with_v2ray_api "github.com/sagernet/sing-box/cmd/sing-box@${version}"
[[ -s "$build_dir/sing-box" ]] || { printf 'sing-box 构建失败\n' >&2; exit 1; }

# A configuration with a statistics endpoint must pass validation before replacing a working binary.
cat > "$build_dir/check.json" <<'EOF'
{"log":{"level":"warn"},"inbounds":[],"outbounds":[{"type":"direct","tag":"direct"}],"experimental":{"v2ray_api":{"listen":"127.0.0.1:10086","stats":{"enabled":true,"inbounds":[]}}}}
EOF
"$build_dir/sing-box" check -c "$build_dir/check.json"
install -m 0755 "$build_dir/sing-box" "$target.next"
mv -f -- "$target.next" "$target"
printf 'sing-box 统计版已安装：%s\n' "$target"
if [[ -f /etc/nexusgate/sing-box/config.json ]]; then
  if command -v systemctl >/dev/null && [[ -d /run/systemd/system ]]; then
    systemctl restart nexusgate-sing-box.service
  elif command -v rc-service >/dev/null; then
    rc-service nexusgate-sing-box restart
  fi
fi
