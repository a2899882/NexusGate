#!/bin/sh
set -eu
set -a
. /etc/nexusgate/agent.env
set +a
exec /usr/bin/node /opt/nexusgate-agent/agent.js
