#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${EUID}" -eq 0 ]] || { printf '请使用 root 运行\n' >&2; exit 1; }
[[ "${1:-install}" == install ]] || { printf '用法：ng-agent engine install\n' >&2; exit 1; }

# Build a version pinned to the configuration model tested by NexusGate.
# Official builds do not guarantee the optional V2Ray statistics API.
version='v1.12.23'
target='/usr/local/bin/nexusgate-sing-box'
stats_target='/usr/local/bin/nexusgate-sing-box-stats'
if [[ -x "$target" && -x "$stats_target" && "${2:-}" != '--force' ]]; then
  printf 'sing-box 已安装：%s（如需重装，运行 ng-agent-singbox install --force）\n' "$target"
  exit 0
fi

build_dir="$(mktemp -d /tmp/nexusgate-singbox.XXXXXX)"
trap 'rm -rf -- "$build_dir"' EXIT
# Go's module and build caches can occupy hundreds of MB indefinitely on a
# 1 GB relay. Keep this one-time build in the temporary directory instead.
export GOMODCACHE="$build_dir/gomod" GOCACHE="$build_dir/gocache"
go_version="$(go version 2>/dev/null || true)"
go_major=0 go_minor=0
if [[ "$go_version" =~ go([0-9]+)\.([0-9]+) ]]; then
  go_major="${BASH_REMATCH[1]}"
  go_minor="${BASH_REMATCH[2]}"
fi
if (( go_major < 1 || (go_major == 1 && go_minor < 23) )); then
  case "$(uname -m)" in
    x86_64|amd64) go_arch=amd64; go_sha=49bbb517cfa9eee677e1e7897f7cf9cfdbcf49e05f61984a2789136de359f9bd ;;
    aarch64|arm64) go_arch=arm64; go_sha=faec7f7f8ae53fda0f3d408f52182d942cc89ef5b7d3d9f23ff117437d4b2d2f ;;
    armv7l) go_arch=armv6l; go_sha=6c7832c7dcd8fb6d4eb308f672a725393403c74ee7be1aeccd8a443015df99de ;;
    *) printf '此架构无法自动构建 sing-box：%s\n' "$(uname -m)" >&2; exit 1 ;;
  esac
  printf '系统 Go 版本过旧；下载已校验的 Go 1.23.1 构建工具链...\n'
  curl -fL --retry 3 "https://go.dev/dl/go1.23.1.linux-${go_arch}.tar.gz" -o "$build_dir/go.tar.gz"
  printf '%s  %s\n' "$go_sha" "$build_dir/go.tar.gz" | sha256sum -c -
  tar -C "$build_dir" -xzf "$build_dir/go.tar.gz"
  export PATH="$build_dir/go/bin:$PATH"
fi
printf '构建 sing-box %s（启用 V2Ray 统计 API，首次需下载 Go 依赖）...\n' "$version"
GOBIN="$build_dir" GOTOOLCHAIN=auto GOMAXPROCS=1 go install -trimpath -ldflags='-s -w' -p 1 -tags with_v2ray_api "github.com/sagernet/sing-box/cmd/sing-box@${version}"
[[ -s "$build_dir/sing-box" ]] || { printf 'sing-box 构建失败\n' >&2; exit 1; }

repo="${NG_REPO:-a2899882/NexusGate}"
branch="${NG_BRANCH:-main}"
curl -fL --retry 3 "https://raw.githubusercontent.com/${repo}/${branch}/agent/stats-query.go" -o "$build_dir/stats-query.go"
( cd "$build_dir"
  GOTOOLCHAIN=auto go mod init nexusgate/statsquery
  GOTOOLCHAIN=auto go get "github.com/sagernet/sing-box@${version}"
  GOTOOLCHAIN=auto GOMAXPROCS=1 go mod tidy
  GOTOOLCHAIN=auto GOMAXPROCS=1 go build -trimpath -ldflags='-s -w' -p 1 -o "$build_dir/stats-query" stats-query.go
)
[[ -s "$build_dir/stats-query" ]] || { printf 'sing-box 统计组件构建失败\n' >&2; exit 1; }

# A configuration with a statistics endpoint must pass validation before replacing a working binary.
cat > "$build_dir/check.json" <<'EOF'
{"log":{"level":"warn"},"inbounds":[],"outbounds":[{"type":"direct","tag":"direct"}],"experimental":{"v2ray_api":{"listen":"127.0.0.1:10086","stats":{"enabled":true,"inbounds":[]}}}}
EOF
"$build_dir/sing-box" check -c "$build_dir/check.json"
install -m 0755 "$build_dir/sing-box" "$target.next"
install -m 0755 "$build_dir/stats-query" "$stats_target.next"
mv -f -- "$target.next" "$target"
mv -f -- "$stats_target.next" "$stats_target"
printf 'sing-box 统计版已安装：%s\n' "$target"
if [[ -f /etc/nexusgate/sing-box/config.json ]]; then
  if command -v systemctl >/dev/null && [[ -d /run/systemd/system ]]; then
    systemctl restart nexusgate-sing-box.service
  elif command -v rc-service >/dev/null; then
    rc-service nexusgate-sing-box restart
  fi
fi
