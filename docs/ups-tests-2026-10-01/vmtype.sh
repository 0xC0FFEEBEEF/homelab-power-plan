#!/bin/bash
# vmtype.sh VMID "text"  - type text on the VM console via qm sendkey, then Enter
vm=$1; s=$2
for ((i=0; i<${#s}; i++)); do
  c=${s:i:1}
  case "$c" in
    [a-z0-9]) k=$c ;; .) k=dot ;; -) k=minus ;; /) k=slash ;; " ") k=spc ;; *) echo "no key for [$c]"; exit 1 ;;
  esac
  qm sendkey "$vm" "$k"
done
qm sendkey "$vm" ret
