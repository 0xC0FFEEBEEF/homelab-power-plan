#!/bin/bash
# read-only sampler for the 2026-10-01 live power test
D=/root/powertest-20261001
while true; do
  ts=$(date +%FT%T)
  s=$(pwrstat -status 2>/dev/null)
  st=$(echo "$s" | awk -F"\\.\\.+ " "/State/{print \$2}")
  by=$(echo "$s" | awk -F"\\.\\.+ " "/Power Supply by/{print \$2}")
  uv=$(echo "$s" | awk -F"\\.\\.+ " "/Utility Voltage/{print \$2}")
  cap=$(echo "$s" | awk -F"\\.\\.+ " "/Battery Capacity/{print \$2}")
  rt=$(echo "$s" | awk -F"\\.\\.+ " "/Remaining Runtime/{print \$2}")
  ld=$(echo "$s" | awk -F"\\.\\.+ " "/^\\s*Load/{print \$2}")
  vms=$(qm list 2>/dev/null | awk "\$3==\"running\"{printf \"%s \", \$1}")
  cts=$(pct list 2>/dev/null | awk "\$2==\"running\"{printf \"%s \", \$1}")
  p=""; for h in 192.0.2.4 198.51.100.205 198.51.100.200 203.0.113.1; do ping -c1 -W1 $h >/dev/null 2>&1 && p="$p $h:up" || p="$p $h:DOWN"; done
  echo "$ts | $st | $by | in=$uv | cap=$cap | rt=$rt | load=$ld | vms=[$vms] cts=[$cts] |$p" >> $D/samples.log
  sleep 3
done
