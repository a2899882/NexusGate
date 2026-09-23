#!/usr/bin/env bash
set -Eeuo pipefail

singbox="${NG_SINGBOX_BIN:-/usr/local/bin/nexusgate-sing-box}"
stats="${NG_SINGBOX_STATS_BIN:-/usr/local/bin/nexusgate-sing-box-stats}"
command -v "$singbox" >/dev/null || { printf 'sing-box binary missing\n' >&2; exit 1; }
command -v "$stats" >/dev/null || { printf 'sing-box statistics helper missing\n' >&2; exit 1; }
tmp="$(mktemp -d /tmp/nexusgate-anytls-smoke.XXXXXX)"
server_pid='' client_pid='' http_pid=''
cleanup() {
  for pid in "$client_pid" "$server_pid" "$http_pid"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done
  rm -rf -- "$tmp"
}
trap cleanup EXIT

openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout "$tmp/key.pem" -out "$tmp/cert.pem" \
  -subj '/CN=node.test' -addext 'subjectAltName=DNS:node.test' >/dev/null 2>&1
NG_SMOKE_DIR="$tmp" node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.NG_SMOKE_DIR;
const { newCredentialSet, buildDirectResource } = require('./lib/protocols');
const { combinedSingBoxConfig } = require('./agent/agent');
const credentials = newCredentialSet('anytls');
const resource = buildDirectResource({ resourceId:'res_smoke_test', tagPrefix:'smoke', port:23456,
  protocol:'anytls', credentials, customer:{ id:'smoke-customer' }, tlsDomain:'node.test' });
resource.inbounds[0].listen = '127.0.0.1';
resource.inbounds[0].tls.certificate_path = path.join(root, 'cert.pem');
resource.inbounds[0].tls.key_path = path.join(root, 'key.pem');
const server = combinedSingBoxConfig([resource]);
server.log.output = path.join(root, 'access.log');
server.experimental.v2ray_api.listen = '127.0.0.1:23457';
fs.writeFileSync(path.join(root, 'server.json'), JSON.stringify(server));
const client = { log:{ level:'warn' },
  inbounds:[{ type:'mixed', listen:'127.0.0.1', listen_port:23458, tag:'local' }],
  outbounds:[{ type:'anytls', tag:'server', server:'127.0.0.1', server_port:23456,
    password:credentials.relayPassword, tls:{ enabled:true, server_name:'node.test', insecure:true } }],
  route:{ final:'server' } };
fs.writeFileSync(path.join(root, 'client.json'), JSON.stringify(client));
NODE
"$singbox" check -c "$tmp/server.json"
"$singbox" check -c "$tmp/client.json"
node -e 'require("http").createServer((_,res)=>res.end("NexusGate AnyTLS smoke OK")).listen(23459,"127.0.0.1")' & http_pid=$!
"$singbox" run -c "$tmp/server.json" > "$tmp/server.out" 2>&1 & server_pid=$!
"$singbox" run -c "$tmp/client.json" > "$tmp/client.out" 2>&1 & client_pid=$!
for _ in {1..40}; do
  if curl -fsS --max-time 2 --noproxy '' --socks5-hostname 127.0.0.1:23458 http://127.0.0.1:23459/ > "$tmp/response" 2>/dev/null; then break; fi
  sleep 0.25
done
if [[ "$(cat "$tmp/response" 2>/dev/null || true)" != 'NexusGate AnyTLS smoke OK' ]]; then
  cat "$tmp/server.out" "$tmp/client.out" >&2
  exit 1
fi
"$stats" --server=127.0.0.1:23457 > "$tmp/stats.json"
NG_SMOKE_STATS="$tmp/stats.json" node <<'NODE'
const stats = JSON.parse(require('node:fs').readFileSync(process.env.NG_SMOKE_STATS));
const counters = new Map((stats.stat || []).map(item => [item.name, Number(item.value)]));
for (const direction of ['uplink','downlink']) {
  const value = counters.get(`inbound>>>smoke-in>>>traffic>>>${direction}`);
  if (!(value > 0)) throw new Error(`missing AnyTLS ${direction} counter`);
}
console.log('AnyTLS live handshake, round trip, and dual direction stats OK');
NODE
