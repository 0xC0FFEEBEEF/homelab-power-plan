# homelab-power

The power plan for my home servers: what happens when the UPS goes on battery, how everything comes back,
and the dashboard that shows and tests it.

| Folder | Lives at | What it is |
|---|---|---|
| `guardian/ups-guardian` | `byteme2:/usr/local/sbin` | Brings the estate down cleanly before the UPS runs out. Sized for about 7 minutes of battery, with a hard deadline that force-stops whatever is left. |
| `guardian/ups-guardian-restore-watch` | `byteme2:/usr/local/sbin` | Runs every 15 s. Acts on a power failure that arrived while the guardian was disarmed, keeps checking for low battery during an outage, and runs the guardian's `online` step once utility power is back. |
| `guardian/slerm-ups-push` | `byteme2:/usr/local/sbin` | Tells the slerm orchestrator the UPS state every 60 s and on every change, so it never powers machines on during a power event. |
| `guardian/powerlog` | `byteme2:/usr/local/sbin` | Shows the guardian log and the pwrstatd hook log. |
| `guardian/psu-telemetry` | `/usr/local/bin` on byteme2 and byteme | Read-only PSU readings from the local BMC (Dell iDRAC or HP iLO) as one JSON document. |
| `pwrstatd/` | `byteme2:/etc` | `pwrstatd.conf` and the two scripts pwrstatd calls on power failure and low battery. |
| `dashboard/` | `byteme2:/opt/ups-dashboard` | UPS and outage dashboard on port 8787 (`ups-dashboard.service`): telemetry collector, history API, energy tracker, simulation and real-test controls. |
| `systemd/` | `byteme2:/etc/systemd/system` | Units and timers for the above. |
| `byteme/` | byteme | `pve-guest-restore`: records the running guests every minute and starts exactly those again after the host comes back. |
| `docs/ups-tests-2026-10-01/` | | Probe scripts and samples from the two live UPS pulls on 2026-10-01. |
| `setup-power-credentials.sh` | this desktop | Gives the slerm orchestrator its Proxmox tokens and BMC account. Prints no secrets. |

## Not in the repo

Secrets and state stay on the servers: `/etc/ups-dashboard.env`, the BMC credential files under `/root`,
`pwrstatd.pwd` and its certificates, the telemetry and energy databases, and the guardian logs. Dated
rollback copies (`*.bak-*`, `*.before-*`) are left out as well; git history replaces them from here on.

The orchestrator end of the UPS push (`ups-push-recv`) is in [slerm-cluster](https://github.com/0xC0FFEEBEEF/slerm-cluster).

## About this copy

A cleaned public snapshot of my private working repo, which is what the servers deploy from. Addresses are
replaced with documentation-range IPs that keep the last octet, and the user and mail account with
placeholders. The story of the first live test is on [nbdevlab.com](https://www.nbdevlab.com/projects).

## License

GNU General Public License v3.0 or later, see [`LICENSE`](LICENSE).

<sub>Preparing this public copy from my private repo was done with help from Claude.</sub>
