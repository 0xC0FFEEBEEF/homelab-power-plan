#!/usr/bin/env bash
{
    echo "$(date -Is) pwrstatd-powerfail hook called"
    echo "$(date -Is) running as: $(id)"
    echo "$(date -Is) PATH=$PATH"
    # Capture rc first: $(date) inside the echo used to reset $? to 0.
    /usr/local/sbin/ups-guardian onbatt
    rc=$?
    echo "$(date -Is) ups-guardian onbatt exit code: $rc"
} >> /var/lib/ups-guardian/pwrstatd-hook.log 2>&1
