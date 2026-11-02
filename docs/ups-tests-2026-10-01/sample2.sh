#!/bin/bash
# read-only sampler for the 2026-10-01 live power tests (run 2)
D=/root/powertest-20261001
f() { grep "$1" <<<"$s" | sed "s/.*\.\. //"; }
while true; do
  s=$(pwrstat -status 2>/dev/null)
  vms=$(qm list 2>/dev/null | awk '$3=="running"{printf "%s ", $1}')
  cts=$(pct list 2>/dev/null | awk '$2=="running"{printf "%s ", $1}')
  p=""; for h in 192.0.2.4 198.51.100.205 198.51.100.200 203.0.113.1; do ping -c1 -W1 $h >/dev/null 2>&1 && p="$p $h:up" || p="$p $h:DOWN"; done
  echo "$(date +%FT%T) | $(f 'State\.\.') | $(f 'Power Supply by') | cap=$(f 'Battery Capacity') | rt=$(f 'Remaining Runtime') | load=$(f 'Load\.\.') | vms=[$vms] cts=[$cts] |$p" >> $D/samples2.log
  sleep 2
done
