#!/usr/bin/env bash
set -Eeuo pipefail

xray="${NG_XRAY_BIN:-/usr/local/bin/xray}"
singbox="${NG_SINGBOX_BIN:-/usr/local/bin/nexusgate-sing-box}"
command -v "$xray" >/dev/null || { printf 'Xray binary missing\n' >&2; exit 1; }
command -v "$singbox" >/dev/null || { printf 'sing-box binary missing\n' >&2; exit 1; }
tmp="$(mktemp -d /tmp/nexusgate-hy2-smoke.XXXXXX)"
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
const { combinedConfig } = require('./agent/agent');
const credentials = newCredentialSet('hysteria2');
const resource = buildDirectResource({ resourceId:'res_hy2_smoke', tagPrefix:'smoke', port:23460,
  protocol:'hysteria2', credentials, customer:{ id:'smoke-customer' }, tlsDomain:'node.test' });
resource.inbounds[0].listen = '127.0.0.1';
const certificate = resource.inbounds[0].streamSettings.tlsSettings.certificates[0];
certificate.certificateFile = path.join(root, 'cert.pem');
certificate.keyFile = path.join(root, 'key.pem');
const server = combinedConfig([resource]);
server.inbounds[0].port = 23461;
server.log.access = path.join(root, 'access.log');
server.log.error = path.join(root, 'error.log');
fs.writeFileSync(path.join(root, 'server.json'), JSON.stringify(server));
const client = { log:{ level:'warn' },
  inbounds:[{ type:'mixed', listen:'127.0.0.1', listen_port:23462, tag:'local' }],
  outbounds:[{ type:'hysteria2', tag:'server', server:'127.0.0.1', server_port:23460,
    password:credentials.relayPassword, tls:{ enabled:true, server_name:'node.test', insecure:true, alpn:['h3'] } }],
  route:{ final:'server' } };
fs.writeFileSync(path.join(root, 'client.json'), JSON.stringify(client));
NODE
"$xray" run -test -config "$tmp/server.json"
"$singbox" check -c "$tmp/client.json"
node -e 'require("http").createServer((_,res)=>res.end("NexusGate HY2 smoke OK")).listen(23463,"127.0.0.1")' & http_pid=$!
"$xray" run -config "$tmp/server.json" > "$tmp/server.out" 2>&1 & server_pid=$!
"$singbox" run -c "$tmp/client.json" > "$tmp/client.out" 2>&1 & client_pid=$!
for _ in {1..40}; do
  if curl -fsS --max-time 2 --noproxy '' --socks5-hostname 127.0.0.1:23462 http://127.0.0.1:23463/ > "$tmp/response" 2>/dev/null; then break; fi
  sleep 0.25
done
if [[ "$(cat "$tmp/response" 2>/dev/null || true)" != 'NexusGate HY2 smoke OK' ]]; then
  cat "$tmp/server.out" "$tmp/client.out" "$tmp/error.log" >&2
  exit 1
fi
NG_SMOKE_PID="$server_pid" node <<'NODE'
const { udpPortsForPid } = require('./agent/agent');
if (!udpPortsForPid(Number(process.env.NG_SMOKE_PID)).has(23460)) throw new Error('Xray has no UDP listener on the HY2 port');
NODE
"$xray" api statsquery --server=127.0.0.1:23461 -pattern 'inbound>>>' > "$tmp/stats.json"
NG_SMOKE_STATS="$tmp/stats.json" node <<'NODE'
const stats = JSON.parse(require('node:fs').readFileSync(process.env.NG_SMOKE_STATS));
const counters = new Map((stats.stat || []).map((item) => [item.name, Number(item.value)]));
for (const direction of ['uplink','downlink']) {
  const value = counters.get(`inbound>>>smoke-in>>>traffic>>>${direction}`);
  if (!(value > 0)) throw new Error(`missing HY2 ${direction} counter`);
}
console.log('HY2 UDP listener, sing-box handshake, round trip, and dual direction stats OK');
NODE
