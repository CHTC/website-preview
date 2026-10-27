#!/bin/sh
set -eu
NS=$(awk '/^nameserver/ {print $2; exit}' /etc/resolv.conf)
case "$NS" in *:*) NS="[$NS]" ;; esac
echo "resolver $NS valid=30s ipv6=off;" > /tmp/resolver.conf
mkdir -p /srv/sites/.tmp
df -Pk /srv/sites | awk 'NR == 2 {print $2}' > /tmp/sites-capacity   # njs can't statfs

# server_name lines for nginx.conf, from PREVIEW_DOMAIN (e.g. website-preview.chtc.chtc.io)
case "${PREVIEW_DOMAIN:-}" in
  ''|*[!a-z0-9.-]*) echo "PREVIEW_DOMAIN must be set to a lowercase host name" >&2; exit 1 ;;
esac
RE=$(printf '%s' "$PREVIEW_DOMAIN" | sed 's/\./\\./g')
printf 'server_name ~^(?<label>[a-z0-9-]+)\\.%s$;\n' "$RE" > /tmp/sites-server-name.conf
printf 'server_name push.%s;\n' "$PREVIEW_DOMAIN" > /tmp/push-server-name.conf
