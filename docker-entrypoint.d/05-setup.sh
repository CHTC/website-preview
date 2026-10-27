#!/bin/sh
set -eu
NS=$(awk '/^nameserver/ {print $2; exit}' /etc/resolv.conf)
case "$NS" in *:*) NS="[$NS]" ;; esac
echo "resolver $NS valid=30s ipv6=off;" > /tmp/resolver.conf
mkdir -p /srv/sites/.tmp
df -Pk /srv/sites | awk 'NR == 2 {print $2}' > /tmp/sites-capacity   # njs can't statfs
