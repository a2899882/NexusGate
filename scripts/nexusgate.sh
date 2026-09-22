#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${NG_REPO:-a2899882/NexusGate}"
BRANCH="${NG_BRANCH:-main}"

die() { printf '错误：%s\n' "$*" >&2; exit 1; }
info() { printf '\033[1;36m[NexusGate]\033[0m %s\n' "$*"; }
need_root() { [[ "${EUID}" -eq 0 ]] || die "请使用 root 运行"; }

backup() {
  need_root
  local output="${1:-/root/nexusgate-backup-$(date +%Y%m%d-%H%M%S).tar.gz}"
  local stage
  stage="$(mktemp -d /tmp/nexusgate-backup.XXXXXX)"
  trap 'rm -rf -- "$stage"' RETURN
  cp -a /var/lib/nexusgate "$stage/data"
  cp -a /etc/nexusgate.env "$stage/nexusgate.env"
  [[ -f /etc/caddy/Caddyfile.d/nexusgate.caddy ]] && cp -a /etc/caddy/Caddyfile.d/nexusgate.caddy "$stage/nexusgate.caddy"
  tar -czf "$output" -C "$stage" .
  chmod 0600 "$output"
  info "备份已生成：$output"
}

restore() {
  need_root
  local archive="${1:-}"
  if [[ -z "$archive" ]]; then archive="$(find /root -maxdepth 1 -type f -name 'nexusgate-backup-*.tar.gz' -printf '%T@ %p\n' | sort -nr | head -n1 | cut -d' ' -f2-)"; fi
  [[ -f "$archive" ]] || die "未找到备份文件"
  if tar -tzf "$archive" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then die "备份包包含不安全路径"; fi
  local stage safety
  stage="$(mktemp -d /tmp/nexusgate-restore.XXXXXX)"
  trap 'rm -rf -- "$stage"' RETURN
  tar -xzf "$archive" -C "$stage"
  [[ -f "$stage/data/nexusgate.json" && -f "$stage/nexusgate.env" ]] || die "备份包不完整"
  safety="/root/nexusgate-before-restore-$(date +%Y%m%d-%H%M%S).tar.gz"
  backup "$safety"
  systemctl stop nexusgate
  find /var/lib/nexusgate -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
  cp -a "$stage/data/." /var/lib/nexusgate/
  chown -R nexusgate:nexusgate /var/lib/nexusgate
  chmod 0700 /var/lib/nexusgate
  cp -a "$stage/nexusgate.env" /etc/nexusgate.env && chmod 0600 /etc/nexusgate.env
  if [[ -f "$stage/nexusgate.caddy" ]]; then cp -a "$stage/nexusgate.caddy" /etc/caddy/Caddyfile.d/nexusgate.caddy; fi
  systemctl start nexusgate
  systemctl reload caddy || true
  info "恢复完成；恢复前快照：$safety"
}

update_panel() {
  need_root
  local stage current_backup
  current_backup="/root/nexusgate-before-update-$(date +%Y%m%d-%H%M%S).tar.gz"
  backup "$current_backup"
  stage="$(mktemp -d /tmp/nexusgate-update.XXXXXX)"
  trap 'rm -rf -- "$stage"' RETURN
  curl -fL --retry 3 "https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz" -o "$stage/source.tgz"
  mkdir -p "$stage/source" && tar -xzf "$stage/source.tgz" -C "$stage/source" --strip-components=1
  [[ -f "$stage/source/server.js" ]] || die "更新包不完整"
  systemctl stop nexusgate
  cp -a "$stage/source/." /opt/nexusgate/
  install -m 0644 /opt/nexusgate/systemd/nexusgate.service /etc/systemd/system/nexusgate.service
  install -m 0755 /opt/nexusgate/scripts/nexusgate.sh /usr/local/sbin/nexusgate
  chown -R nexusgate:nexusgate /var/lib/nexusgate
  chmod 0700 /var/lib/nexusgate
  [[ ! -f /var/lib/nexusgate/nexusgate.json ]] || chmod 0600 /var/lib/nexusgate/nexusgate.json
  systemctl daemon-reload && systemctl start nexusgate
  local healthy=false
  for _ in {1..30}; do
    if curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1; then healthy=true; break; fi
    sleep 1
  done
  if [[ "$healthy" != true ]]; then
    systemctl status nexusgate --no-pager || true
    journalctl -u nexusgate -n 100 --no-pager || true
    die "更新后控制面启动失败；可使用上方备份恢复"
  fi
  info "更新完成；更新前备份：$current_backup"
}

change_domain() {
  need_root
  local domain="${1:-}"
  if [[ -z "$domain" && -r /dev/tty ]]; then read -r -p '新域名：' domain </dev/tty; fi
  [[ "$domain" =~ ^[A-Za-z0-9.-]+$ ]] || die "域名格式不正确"
  sed -i -E "1s/^[^ ]+/${domain}/" /etc/caddy/Caddyfile.d/nexusgate.caddy
  caddy fmt --overwrite /etc/caddy/Caddyfile.d/nexusgate.caddy
  caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
  info "域名已更新为 https://${domain}"
}

change_password() {
  need_root
  local username="${1:-admin}" first second
  if [[ -r /dev/tty ]]; then
    read -r -s -p '新密码（至少 10 位）：' first </dev/tty; printf '\n'
    read -r -s -p '再次输入新密码：' second </dev/tty; printf '\n'
  else
    die "修改密码需要交互终端"
  fi
  [[ "$first" == "$second" ]] || die "两次输入不一致"
  [[ ${#first} -ge 10 ]] || die "密码至少需要 10 个字符"
  systemctl stop nexusgate
  set +e
  NG_DATA_FILE=/var/lib/nexusgate/nexusgate.json NG_NEW_PASSWORD="$first" node /opt/nexusgate/scripts/reset-password.js "$username"
  local result=$?
  unset first second
  set -e
  if [[ $result -eq 0 ]]; then
    chown nexusgate:nexusgate /var/lib/nexusgate/nexusgate.json
    chmod 0600 /var/lib/nexusgate/nexusgate.json
    sed -i '/^NG_ADMIN_PASSWORD=/d' /etc/nexusgate.env
  fi
  systemctl start nexusgate
  [[ $result -eq 0 ]] || die "密码更新失败"
  info "密码已更新，现有登录会话将在服务重启后失效"
}

menu() {
  printf '\nNexusGate 管理菜单\n'
  printf '1. 状态\n2. 重启\n3. 查看日志\n4. 备份\n5. 恢复备份\n6. 更新\n7. 更换域名\n8. 修改密码\n0. 退出\n'
  local choice
  read -r -p '请选择：' choice </dev/tty
  case "$choice" in
    1) systemctl status nexusgate --no-pager ;;
    2) need_root; systemctl restart nexusgate caddy; info '已重启' ;;
    3) journalctl -u nexusgate -n 120 --no-pager ;;
    4) backup ;;
    5) restore ;;
    6) update_panel ;;
    7) change_domain ;;
    8) change_password ;;
    0) exit 0 ;;
    *) die '无效选择' ;;
  esac
}

case "${1:-menu}" in
  status) systemctl status nexusgate --no-pager ;;
  restart) need_root; systemctl restart nexusgate caddy ;;
  logs) journalctl -u nexusgate -n "${2:-120}" --no-pager ;;
  backup) backup "${2:-}" ;;
  restore) restore "${2:-}" ;;
  update) update_panel ;;
  domain) change_domain "${2:-}" ;;
  password) change_password "${2:-admin}" ;;
  menu|"") menu ;;
  *) die "用法：nexusgate {status|restart|logs|backup|restore|update|domain|password|menu}" ;;
esac
