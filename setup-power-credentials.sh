#!/bin/bash
# Gives slerm-orch (on slerm-head) power control. Run from the desktop, by you:
#   bash ~/slerm-dynamic/setup-power-credentials.sh
# Nothing secret is printed: each secret goes straight into a 0600 file on the head.
#
# 1. Proxmox, on byteme and byteme2: user slerm-orch@pve, token "orch".
#    - may START/SHUT DOWN only the slerm node VMs (303/304, 301/302) -- never slerm-head
#    - may READ the other VMs (memory, PCI devices) and the host's memory
#    -> ~/.config/slerm-orch/pve.json on slerm-head
# 2. deadlock BMC: user 7 "slerm", OPERATOR (power on/off/status; no user or config
#    changes), random 16-char password -> ~/.config/slerm-orch/bmc-deadlock
# Undo: pveum user delete slerm-orch@pve; pveum role delete SlermOrch (each host);
#       on deadlock: sudo ipmitool user disable 7; rm ~/.config/slerm-orch/{pve.json,bmc-deadlock}
set -euo pipefail

pve_setup() {   # host-ip node vmids...
    local ip="$1" node="$2"; shift 2
    ssh root@"$ip" bash -s -- "$node" "$@" <<'EOF'
set -euo pipefail
node="$1"; shift
pveum role add SlermOrch -privs "VM.Audit VM.PowerMgmt" 2>/dev/null || \
    pveum role modify SlermOrch -privs "VM.Audit VM.PowerMgmt"
pveum user add slerm-orch@pve --comment "slerm orchestrator on slerm-head" 2>/dev/null || true
pveum acl modify /vms -user slerm-orch@pve -role PVEAuditor
pveum acl modify "/nodes/$node" -user slerm-orch@pve -role PVEAuditor
for v in "$@"; do pveum acl modify "/vms/$v" -user slerm-orch@pve -role SlermOrch; done
pveum user token remove slerm-orch@pve orch 2>/dev/null || true
pveum user token add slerm-orch@pve orch --privsep 0 --output-format json
EOF
}

b1=$(pve_setup 192.0.2.4 byteme 303 304)
b2=$(pve_setup 192.0.2.2 byteme2 301 302)
python3 - "$b1" "$b2" <<'EOF' | ssh slerm-head 'umask 077; mkdir -p ~/.config/slerm-orch; cat > ~/.config/slerm-orch/pve.json'
import json, sys
out = {}
for node, raw in (("byteme", sys.argv[1]), ("byteme2", sys.argv[2])):
    t = json.loads(raw)
    out[node] = {"tokenid": t["full-tokenid"], "secret": t["value"], "node": node}
print(json.dumps(out))
EOF
echo "Proxmox tokens stored on slerm-head."

ssh slerm-node05 'set -e
P=$(head -c 64 /dev/urandom | tr -dc "A-Za-z0-9" | head -c 16)
sudo -n ipmitool user set name 7 slerm >/dev/null
sudo -n ipmitool user set password 7 "$P" 16 >/dev/null
sudo -n ipmitool channel setaccess 1 7 callin=on ipmi=on link=on privilege=3 >/dev/null
sudo -n ipmitool user enable 7 >/dev/null
printf %s "$P"' | ssh slerm-head 'umask 077; cat > ~/.config/slerm-orch/bmc-deadlock'
echo "deadlock BMC operator stored on slerm-head."

ssh slerm-head 'systemctl --user restart slerm-orch; sleep 25; grep "power control" ~/slerm-orch/orch.log | tail -1;
  python3 -c "import json; d=json.load(open(\"/data/llm/run/orchestrator.json\")); print(\"power control:\", d[\"power_control\"], \"deadlock power:\", d[\"deadlock\"].get(\"power\"), d[\"deadlock\"].get(\"power_error\",\"\"))"'
