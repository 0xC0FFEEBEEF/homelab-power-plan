#!/usr/bin/env python3
"""ByteMe2 UPS dashboard: collector, history API, and static web server."""
import csv, hmac, io, json, os, re, signal, sqlite3, subprocess, threading, time
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import energy

ROOT = Path(__file__).resolve().parent
DB = Path(os.environ.get("UPS_DASH_DB", "/var/lib/ups-dashboard/telemetry.sqlite3"))
STATE = Path("/var/lib/ups-guardian")
INTERVAL = int(os.environ.get("UPS_DASH_INTERVAL", "5"))
PORT = int(os.environ.get("UPS_DASH_PORT", "8787"))
HOST = os.environ.get("UPS_DASH_HOST", "0.0.0.0")
ARCHIVE_CT = os.environ.get("UPS_DASH_ARCHIVE_CT", "112")
ARCHIVE_DB = os.environ.get("UPS_DASH_ARCHIVE_DB", "ups_telemetry")
LOCAL_SECONDS = int(os.environ.get("UPS_DASH_LOCAL_SECONDS", "86400"))
ADMIN_TOKEN = os.environ.get("UPS_DASH_ADMIN_TOKEN", "")
LAST_REALTEST = Path(os.environ.get("UPS_DASH_LAST_REALTEST", "/var/lib/ups-dashboard/last-realtest.json"))
latest = {}; latest_lock = threading.Lock(); stop = threading.Event()
dryrun={"running":False,"started":None,"finished":None,"exit_code":None,"lines":[]}; dryrun_lock=threading.Lock()
realtest={"running":False,"started":None,"finished":None,"exit_code":None,"phase":"idle","lines":[],"timeline":[],"abort_requested":False}; realtest_lock=threading.Lock()

def run(*args, timeout=4):
    try:
        p = subprocess.run(args, text=True, capture_output=True, timeout=timeout)
        return p.stdout.strip() if p.returncode == 0 else ""
    except Exception: return ""

def number(value):
    m = re.search(r"-?[\d.]+", value or "")
    return float(m.group()) if m else None

def parse_pwrstat(raw):
    aliases = {
      "model name":"model", "firmware number":"firmware", "rating voltage":"rated_voltage",
      "rating power":"rated_va", "power supply by":"source", "utility voltage":"input_voltage",
      "output voltage":"output_voltage", "battery capacity":"battery", "remaining runtime":"runtime_min",
      "load":"load", "line interaction":"line_interaction", "test result":"test_result",
      "last power event":"last_event"
    }
    out = {"raw": raw}
    for line in raw.splitlines():
        # CyberPower uses dotted leaders ("Battery Capacity..... 100 %").
        # Accept a colon too for compatibility with other pwrstat releases.
        m = re.match(r"^\s*([^.:][^:]*?)(?:\.{2,}|:\s+)(.*?)\s*$", line)
        if not m: continue
        k,v = m.group(1).strip(),m.group(2).strip()
        key = aliases.get(k.lower(), re.sub(r"\W+","_",k.lower()).strip("_"))
        out[key] = v
    raw_load = str(out.get("load", ""))
    for key in ("rated_voltage","rated_va","input_voltage","output_voltage","battery","runtime_min","load"):
        if key in out: out[key] = number(out[key])
    # Since the UPS reconnect on 2026-09-20 pwrstat prints "378 Watt(42 %)"; before that just "43 %".
    m = re.match(r"\s*([\d.]+)\s*Watt\s*\(\s*([\d.]+)\s*%", raw_load)
    if m: out["load_w"], out["load"] = float(m.group(1)), float(m.group(2))
    else: out["load_w"] = None
    src = str(out.get("source", "unknown")).lower()
    out["online"] = "utility" in src
    out["connected"] = bool(raw)
    return out

def host_metrics():
    load = os.getloadavg()
    mem = {}
    try:
        for line in Path('/proc/meminfo').read_text().splitlines():
            k,v = line.split(':',1); mem[k] = number(v) or 0
    except Exception: pass
    total, avail = mem.get('MemTotal',0), mem.get('MemAvailable',0)
    temps=[]
    for p in Path('/sys/class/thermal').glob('thermal_zone*/temp'):
        try:
            v=float(p.read_text())/1000
            if 0 < v < 150: temps.append(v)
        except Exception: pass
    uptime = number(Path('/proc/uptime').read_text()) or 0
    mhz=[]
    try:
        for line in Path('/proc/cpuinfo').read_text().splitlines():
            if line.lower().startswith('cpu mhz'): mhz.append(number(line.split(':',1)[1]))
    except Exception: pass
    return {"load1":round(load[0],2),"load5":round(load[1],2),"load15":round(load[2],2),
      "memory_pct":round((1-avail/total)*100,1) if total else None,
      "temperature":round(max(temps),1) if temps else None,"uptime":int(uptime),
      "cpu_count":os.cpu_count() or 1,
      "cpu_mhz":round(sum(x for x in mhz if x is not None)/len(mhz),1) if mhz else None}

def guests():
    q = run("qm","list"); p = run("pct","list")
    def counts(text, index):
        rows=text.splitlines()[1:] if text else []
        return {"total":len(rows),"running":sum(1 for x in rows if len(x.split())>index and x.split()[index]=="running")}
    # Names for the response console's guest chips (qm: VMID NAME STATUS ..., pct: VMID Status [Lock] Name).
    listed=[]
    for line in (q.splitlines()[1:] if q else []):
        x=line.split()
        if len(x)>=3 and x[0].isdigit(): listed.append({"type":"VM","id":int(x[0]),"name":x[1],"status":x[2]})
    for line in (p.splitlines()[1:] if p else []):
        x=line.split()
        if len(x)>=3 and x[0].isdigit(): listed.append({"type":"CT","id":int(x[0]),"name":x[-1],"status":x[1]})
    return {"vms":counts(q,2),"containers":counts(p,1),"list":listed}

def guardian():
    names=("powerfail_active","remote_shutdown_requested","remote_shutdown_success","qemu_vms","lxc_cts")
    g={n:(STATE/n).exists() for n in names}
    try: until=int((STATE/"disarmed_until").read_text().strip())
    except Exception: until=0
    g["disarmed_until"]=until if until>time.time() else None
    g["onbatt_suppressed"]=(STATE/"onbatt_suppressed").exists()
    g["mode"] = "restore" if g["powerfail_active"] and g["remote_shutdown_success"] else ("outage" if g["powerfail_active"] else "standby")
    return g

def settings_data():
    raw=run("pwrstat","-config",timeout=6)
    def pick(pattern, cast=str):
        m=re.search(pattern,raw,re.I)
        try: return cast(m.group(1)) if m else None
        except Exception: return None
    script=Path('/usr/local/sbin/ups-guardian').read_text(errors='replace')
    def constant(name):
        m=re.search(rf'^{re.escape(name)}="?([^"\n]+)',script,re.M); return m.group(1) if m else None
    return {"ups":{"alarm":pick(r'Alarm\s*\.+\s*(On|Off)',str),"hibernate":pick(r'Hibernate\s*\.+\s*(On|Off)',str),"cloud":pick(r'Cloud\s*\.+\s*(On|Off)',str),"runtime_threshold":pick(r'Remaining runtime threshold\s*\.+\s*(\d+)',int),"capacity_threshold":pick(r'Battery capacity threshold\s*\.+\s*(\d+)',int),"powerfail_delay":pick(r'Delay time since Power failure\s*\.+\s*(\d+)',int),"raw":raw},"guardian":{"shutdown_deadline":constant('SHUTDOWN_DEADLINE_SECONDS'),"remote_delay":constant('REMOTE_SHUTDOWN_DELAY'),"remote_timeout":constant('REMOTE_POWEROFF_CONFIRM_TIMEOUT'),"vm_timeout":constant('VM_SHUTDOWN_TIMEOUT'),"ct_timeout":constant('CT_SHUTDOWN_TIMEOUT'),"power_cap_watts":constant('LOCAL_ILO_POWER_CAP_WATTS'),"protected_vms":constant('PROTECTED_VMS'),"protected_lxc":constant('PROTECTED_LXC')},"storage":{"local_hours":LOCAL_SECONDS//3600,"archive_lxc":ARCHIVE_CT,"database":ARCHIVE_DB},"writes_enabled":True,"auth_required":bool(ADMIN_TOKEN)}

def apply_setting(action, body):
    if action=='alarm':
        value=body.get('value');
        if value not in ('on','off'): raise ValueError('Alarm must be on or off')
        cmd=('pwrstat','-alarm',value)
    elif action=='thresholds':
        capacity=int(body.get('capacity',0)); runtime=int(body.get('runtime',0))
        if not 10<=capacity<=90: raise ValueError('Capacity must be between 10 and 90%')
        if not 60<=runtime<=1800: raise ValueError('Runtime must be between 60 and 1800 seconds')
        cmd=('pwrstat','-lowbatt','-capacity',str(capacity),'-runtime',str(runtime))
    elif action=='disarm':
        minutes=int(body.get('minutes',0))
        if not 0<=minutes<=240: raise ValueError('Disarm must be 0-240 minutes')
        f=STATE/'disarmed_until'
        if minutes==0:
            f.unlink(missing_ok=True); subprocess.run(('logger','-t','ups-guardian','Guardian re-armed from dashboard'))
            return 'Guardian armed'
        until=int(time.time())+minutes*60; f.write_text(f'{until}\n')
        subprocess.run(('logger','-t','ups-guardian',f'Guardian disarmed from dashboard for {minutes} min'))
        return f'Guardian disarmed for {minutes} min'
    elif action=='mute': cmd=('pwrstat','-mute')
    elif action=='test': cmd=('pwrstat','-test')
    else: raise ValueError('Unsupported action')
    p=subprocess.run(cmd,text=True,capture_output=True,timeout=30)
    if p.returncode: raise RuntimeError((p.stderr or p.stdout or 'pwrstat failed').strip())
    return (p.stdout or 'Setting applied').strip()

def run_guardian_dryrun():
    with dryrun_lock: dryrun.update(running=True,started=int(time.time()),finished=None,exit_code=None,lines=[])
    env=os.environ.copy(); env['UPS_GUARDIAN_DRY_RUN']='1'
    try:
        p=subprocess.Popen(['/usr/local/sbin/ups-guardian','onbatt'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1,env=env)
        for line in p.stdout:
            clean=line.rstrip()
            with dryrun_lock: dryrun['lines']=(dryrun['lines']+[clean])[-300:]
        code=p.wait(timeout=300)
    except Exception as e:
        code=1
        with dryrun_lock: dryrun['lines'].append(f'Dry run error: {e}')
    with dryrun_lock: dryrun.update(running=False,finished=int(time.time()),exit_code=code)

def start_guardian_dryrun():
    with dryrun_lock:
        if dryrun['running']: raise ValueError('A dry run is already in progress')
        dryrun.update(running=True,started=int(time.time()),finished=None,exit_code=None,lines=[])
    threading.Thread(target=run_guardian_dryrun,daemon=True).start()

def run_guardian_realtest():
    with realtest_lock:
        now=int(time.time()); tl=(realtest.get('timeline') or [])+[{"ts":now,"key":"preflight","label":"Preflight checks passed"}]
        realtest.update(running=True,started=realtest.get('started') or now,finished=None,exit_code=None,phase='shutdown',lines=[],timeline=tl,abort_requested=False)
    env=os.environ.copy(); env['UPS_GUARDIAN_REAL_TEST']='1'
    code=1
    try:
        for phase,args in [('shutdown',['/usr/local/sbin/ups-guardian','onbatt']),('restore',['/usr/local/sbin/ups-guardian','online'])]:
            if phase=='restore':
                live=parse_pwrstat(run('pwrstat','-status',timeout=6))
                if not live.get('online'):
                    with realtest_lock: realtest['lines'].append('SAFETY STOP: utility is not online; leaving guardian in real outage state for normal recovery watcher')
                    code=2; break
            with realtest_lock:
                realtest['phase']=phase
                realtest['lines'].append(f'--- {phase.upper()} PHASE ---')
                realtest['timeline'].append({"ts":int(time.time()),"key":phase,"label":"Real shutdown started" if phase=='shutdown' else "Automatic restoration started"})
            p=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1,env=env)
            for line in p.stdout:
                clean=line.rstrip(); low=clean.lower(); milestone=None
                if 'remote power-off dispatched' in low: milestone=('remote','Remote-host power-off dispatched')
                elif 'dispatched ' in low and 'guest shutdown' in low: milestone=('guests_down','Parallel guest shutdown dispatched')
                elif 'local power cap active' in low: milestone=('cap','90 W host power cap active')
                elif 'could not activate local power cap' in low or 'could not set local power cap' in low: milestone=('cap','90 W host power cap unavailable (non-fatal)')
                elif 'power cap deactivated' in low: milestone=('uncap','Host power cap removed')
                elif 'starting vm ' in low or 'starting lxc ' in low: milestone=('guests_up','Saved guest restoration started')
                elif 'restore complete' in low: milestone=('restored','Guardian restoration completed')
                with realtest_lock:
                    realtest['lines']=(realtest['lines']+[clean])[-500:]
                    if milestone and not any(x['key']==milestone[0] for x in realtest['timeline']): realtest['timeline'].append({"ts":int(time.time()),"key":milestone[0],"label":milestone[1]})
            phase_code=p.wait(timeout=600)
            if phase=='shutdown' and phase_code:
                with realtest_lock: realtest['lines'].append(f'Shutdown phase returned {phase_code}; attempting restoration')
            if phase=='restore': code=phase_code
    except Exception as e:
        with realtest_lock: realtest['lines'].append(f'Real test error: {e}')
    with realtest_lock:
        finished=int(time.time()); realtest['timeline'].append({"ts":finished,"key":"complete" if code==0 else "attention","label":"Normal operation verified" if code==0 else "Manual review required"})
        realtest.update(running=False,finished=finished,exit_code=code,phase='complete' if code==0 else 'attention')
        snap={**realtest,"lines":list(realtest['lines']),"timeline":list(realtest['timeline'])}
    try:
        LAST_REALTEST.parent.mkdir(parents=True,exist_ok=True); LAST_REALTEST.write_text(json.dumps(snap))
    except Exception: pass

def start_guardian_realtest(body):
    if body.get('confirmation')!='REAL OUTAGE TEST': raise ValueError('Typed confirmation does not match')
    with realtest_lock:
        if realtest['running']: raise ValueError('A real recovery test is already running')
    with dryrun_lock:
        if dryrun['running']: raise ValueError('Wait for the dry run to finish')
    ups=parse_pwrstat(run('pwrstat','-status',timeout=6))
    if not ups.get('online'): raise ValueError('Utility power must be online')
    if (ups.get('battery') or 0)<50: raise ValueError('UPS battery must be at least 50%')
    if (STATE/'powerfail_active').exists(): raise ValueError('Guardian already has an active power-failure marker')
    Path('/run/ups-guardian-realtest-abort').unlink(missing_ok=True)
    with realtest_lock:
        now=int(time.time()); realtest.update(running=True,started=now,finished=None,exit_code=None,phase='starting',lines=[],timeline=[{"ts":now,"key":"requested","label":"Real recovery test requested"}])
    threading.Thread(target=run_guardian_realtest,daemon=True).start()

def abort_guardian_realtest():
    with realtest_lock:
        if not realtest['running']: raise ValueError('No real recovery test is running')
        if realtest['phase']!='shutdown': raise ValueError('Recovery has already started and should not be interrupted')
        if realtest.get('abort_requested'): raise ValueError('Abort-to-recovery is already requested')
        realtest['abort_requested']=True
        realtest['timeline'].append({"ts":int(time.time()),"key":"abort","label":"Abort requested; transitioning safely to recovery"})
        realtest['lines'].append('ABORT REQUESTED: stop further shutdown progression and begin safe recovery')
    Path('/run/ups-guardian-realtest-abort').touch()

def connect():
    DB.parent.mkdir(parents=True,exist_ok=True)
    c=sqlite3.connect(DB,timeout=10); c.execute("PRAGMA journal_mode=WAL")
    c.execute("CREATE TABLE IF NOT EXISTS samples(ts INTEGER PRIMARY KEY, online INTEGER, connected INTEGER, battery REAL, runtime REAL, load REAL, input_v REAL, output_v REAL, host_load REAL, memory REAL, temperature REAL, payload TEXT, cpu_mhz REAL)")
    cols={r[1] for r in c.execute('PRAGMA table_info(samples)')}
    if 'cpu_mhz' not in cols: c.execute("ALTER TABLE samples ADD COLUMN cpu_mhz REAL")
    if 'load_w' not in cols: c.execute("ALTER TABLE samples ADD COLUMN load_w REAL")
    if 'surge_w' not in cols: c.execute("ALTER TABLE samples ADD COLUMN surge_w REAL")
    c.execute("CREATE TABLE IF NOT EXISTS events(ts INTEGER, kind TEXT, message TEXT, UNIQUE(ts,message))")
    return c

def psql(sql, stdin=None, timeout=30):
    """Run psql locally inside the dedicated PostgreSQL LXC; no network secret required."""
    cmd=("pct","exec",ARCHIVE_CT,"--","su","-","postgres","-c",
         f"psql -X -q -v ON_ERROR_STOP=1 -d {ARCHIVE_DB}")
    try:
        p=subprocess.run(cmd,input=(sql if stdin is None else stdin),text=True,capture_output=True,timeout=timeout)
        return p.stdout.strip() if p.returncode==0 else None
    except Exception: return None

ARCHIVE_COLS="ts,online,battery,runtime,load,input_v,output_v,host_load,memory,temperature,cpu_mhz,load_w,surge_w"

def archive_old(c, max_batches=30):
    cutoff=int(time.time())-LOCAL_SECONDS
    for _ in range(max_batches):
        rows=c.execute(f"SELECT {ARCHIVE_COLS} FROM samples WHERE ts<? ORDER BY ts LIMIT 10000",(cutoff,)).fetchall()
        if not rows: return
        buf=io.StringIO(); w=csv.writer(buf,lineterminator='\n'); w.writerows(rows)
        sql=(f"BEGIN; CREATE TEMP TABLE batch (LIKE ups_samples) ON COMMIT DROP;\nCOPY batch({ARCHIVE_COLS}) FROM STDIN WITH (FORMAT csv);\n"
             +buf.getvalue()+"\\.\n"+f"INSERT INTO ups_samples({ARCHIVE_COLS}) SELECT {ARCHIVE_COLS} FROM batch ON CONFLICT (ts) DO NOTHING; COMMIT;\n")
        if psql(sql,timeout=120) is None:
            print("archive: batch failed, keeping rows locally"); return
        c.execute("DELETE FROM samples WHERE ts<=?",(rows[-1][0],)); c.commit()

def remote_history(since, before):
    if before<=since: return []
    sql=f"COPY (SELECT row_to_json(x) FROM (SELECT ts,online,battery,runtime,load,input_v,output_v,host_load,memory,temperature,cpu_mhz,load_w,surge_w FROM ups_samples WHERE ts >= {int(since)} AND ts < {int(before)} ORDER BY ts) x) TO STDOUT;"
    raw=psql(sql,timeout=45)
    if raw is None: return []
    try: return [json.loads(x) for x in raw.splitlines() if x.strip()]
    except Exception: return []

def ingest_log(c):
    p=STATE/'ups-guardian.log'
    if not p.exists(): return
    try: lines=p.read_text(errors='replace').splitlines()[-300:]
    except Exception: return
    for line in lines:
        m=re.match(r"(\S+)\s+(.*)",line)
        if not m: continue
        try: ts=int(datetime.fromisoformat(m.group(1)).timestamp())
        except Exception: continue
        msg=m.group(2); low=msg.lower()
        kind='danger' if any(x in low for x in ('failure','low battery','failed','force-stopp','deadline')) else ('success' if any(x in low for x in ('restored','completed','powered on')) else 'info')
        c.execute("INSERT OR IGNORE INTO events VALUES(?,?,?)",(ts,kind,msg))

def surge_now():
    """Watts on the UPS's surge-only outlets = each server's surge-side PSU (energy surge_psus), from BMC readings.
    None unless every mapped server has a reading under a minute old, so the line never shows a partial sum."""
    mapping=energy.conf().get("surge_psus") or {}
    if not mapping: return None
    total=0.0; now=time.time()
    with psu_lock:
        for srv,psu in mapping.items():
            sv=psu_servers.get(srv) or {}
            if not sv.get("ok") or now-(sv.get("fetched") or 0)>60: return None
            w=next((x.get("watts") for x in (sv.get("data") or {}).get("psus",[]) if x.get("name")==psu),None)
            if w is None: return None
            total+=w
    return total

def collect():
    c=connect(); cycle=0
    while not stop.is_set():
        started=time.time(); now=int(started)
        ups=parse_pwrstat(run("pwrstat","-status",timeout=6)); host=host_metrics()
        data={"ts":now,"ups":ups,"host":host,"guardian":guardian(),"guests":guests() if cycle%6==0 else latest.get("guests",{})}
        with latest_lock: latest.clear(); latest.update(data)
        c.execute("INSERT OR REPLACE INTO samples(ts,online,connected,battery,runtime,load,input_v,output_v,host_load,memory,temperature,payload,cpu_mhz,load_w,surge_w) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",(now,int(ups['online']),int(ups['connected']),ups.get('battery'),ups.get('runtime_min'),ups.get('load'),ups.get('input_voltage'),ups.get('output_voltage'),host['load1'],host['memory_pct'],host['temperature'],json.dumps(data),host['cpu_mhz'],ups.get('load_w'),surge_now()))
        if cycle%12==0: ingest_log(c); c.execute("DELETE FROM events WHERE ts < ?",(now-366*86400,))
        if cycle%720==0: archive_old(c)
        c.commit(); cycle+=1; stop.wait(max(.2,INTERVAL-(time.time()-started)))
    c.close()

# Server PSU telemetry (iLO / iDRAC via ipmitool), polled on its own slower loop so a slow BMC can never delay
# the 5 s UPS samples. byteme is read over a forced-command key that can only run psu-telemetry there.
PSU_INTERVAL = int(os.environ.get("UPS_DASH_PSU_INTERVAL", "15"))
PSU_SOURCES = (("byteme2", ("/usr/local/bin/psu-telemetry",)),
               ("byteme", ("ssh", "-i", "/root/.ssh/psu_telemetry_ed25519", "-o", "BatchMode=yes",
                           "-o", "ConnectTimeout=5", "root@192.0.2.4")),
               # deadlock is read straight from its Intel BMC over IPMI-over-LAN (OPERATOR user byteme2).
               ("deadlock", ("/usr/local/bin/psu-telemetry", "--lan", "198.51.100.18", "byteme2", "/root/.bmc_deadlock", "deadlock")))
psu_servers = {}; psu_lock = threading.Lock()

def psu_collect():
    while not stop.is_set():
        for name, cmd in PSU_SOURCES:
            raw = run(*cmd, timeout=30)
            try:
                doc = json.loads(raw); err = None
            except Exception:
                doc, err = None, "no reading from " + name
            # psu-telemetry says so when the BMC itself is silent; that is not a
            # reading, whatever the JSON parses to.
            reach = "unreachable" if doc is None or doc.get("bmc") == "unreachable" else "ok"
            if reach == "unreachable":
                err = "BMC not answering" if doc is not None else err
                doc = None
            with psu_lock:
                prev = psu_servers.get(name, {})
                psu_servers[name] = {"name": name, "ok": doc is not None, "error": err, "bmc": reach,
                                     "chassis": (doc or {}).get("chassis"),
                                     "fetched": int(time.time()) if doc else prev.get("fetched"),
                                     "data": doc or prev.get("data")}
            with latest_lock: u=latest.get("ups") or {}
            try: energy.record_psu(name, doc, u.get("online") if u.get("connected") else None)
            except Exception as e: print("energy psu:", e)
        stop.wait(PSU_INTERVAL)

def energy_collect():
    while not stop.is_set():
        try: energy.catch_up(DB, psql)
        except Exception as e: print("energy:", e)
        stop.wait(60)

def history(seconds, limit=1400):
    c=connect(); since=int(time.time())-seconds
    count=c.execute("SELECT count(*) FROM samples WHERE ts>=?",(since,)).fetchone()[0]
    step=max(1,(count+limit-1)//limit)
    rows=c.execute("SELECT ts,online,battery,runtime,load,input_v,output_v,host_load,memory,temperature,cpu_mhz,load_w,surge_w FROM samples WHERE ts>=? AND rowid % ?=0 ORDER BY ts",(since,step)).fetchall()
    cols=("ts","online","battery","runtime","load","input_v","output_v","host_load","memory","temperature","cpu_mhz","load_w","surge_w")
    local=[dict(zip(cols,r)) for r in rows]
    oldest=local[0]['ts'] if local else int(time.time())
    remote=remote_history(since,oldest) if seconds>LOCAL_SECONDS else []
    all_rows=remote+local
    stride=max(1,(len(all_rows)+limit-1)//limit)
    out=all_rows[::stride]
    # Surge load on the same scale as UPS load (% of the UPS's rated watts), so the two lines compare directly.
    for r in out: r["surge_pct"]=round(r["surge_w"]*100/energy.UPS_RATED_W,1) if r.get("surge_w") is not None else None
    return out

class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*a,**kw): super().__init__(*a,directory=str(ROOT/'static'),**kw)
    def log_message(self,fmt,*args): pass
    def send_json(self,obj,status=200):
        b=json.dumps(obj,separators=(',',':')).encode(); self.send_response(status); self.send_header('Content-Type','application/json'); self.send_header('Cache-Control','no-store'); self.send_header('Content-Length',str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        u=urlparse(self.path)
        if u.path=='/api/status':
            with latest_lock: data=dict(latest)
            with psu_lock: data["servers"]=[dict(v) for v in psu_servers.values()]
            data["surge_psus"]=energy.conf()["surge_psus"]
            return self.send_json(data)
        if u.path=='/api/history':
            q=parse_qs(u.query); seconds=max(60,min(31622400,int(q.get('seconds',['3600'])[0])))
            return self.send_json({"seconds":seconds,"points":history(seconds)})
        if u.path=='/api/events':
            c=connect(); rows=c.execute("SELECT ts,kind,message FROM events ORDER BY ts DESC LIMIT 100").fetchall(); c.close()
            return self.send_json([{"ts":r[0],"kind":r[1],"message":r[2]} for r in rows])
        if u.path=='/api/settings': return self.send_json(settings_data())
        if u.path=='/api/energy': return self.send_json(energy.report())
        if u.path=='/api/dryrun':
            with dryrun_lock: data={**dryrun,"lines":list(dryrun['lines'])}
            return self.send_json(data)
        if u.path=='/api/realtest':
            with realtest_lock: data={**realtest,"lines":list(realtest['lines'])}
            return self.send_json(data)
        if u.path=='/api/guardian/log':
            # Live tail of the guardian log for the outage console (events are only ingested every minute).
            try: since=int(parse_qs(u.query).get('since',['0'])[0])
            except ValueError: since=0
            out=[]
            try: lines=(STATE/'ups-guardian.log').read_text(errors='replace').splitlines()[-400:]
            except Exception: lines=[]
            for line in lines:
                m=re.match(r"(\S+)\s",line)
                try: ts=int(datetime.fromisoformat(m.group(1)).timestamp()) if m else None
                except Exception: ts=None
                if ts is not None and ts>=since: out.append(line)
            return self.send_json({"since":since,"lines":out})
        if u.path=='/api/realtest/last':
            try: return self.send_json(json.loads(LAST_REALTEST.read_text()))
            except Exception: return self.send_json({"started":None})
        return super().do_GET()
    def do_POST(self):
        u=urlparse(self.path)
        if not u.path.startswith('/api/settings/'): return self.send_json({"error":"Not found"},404)
        supplied=self.headers.get('X-Admin-Token','')
        if ADMIN_TOKEN and not hmac.compare_digest(supplied,ADMIN_TOKEN): return self.send_json({"error":"Invalid admin token"},403)
        try:
            size=int(self.headers.get('Content-Length','0'))
            if size>4096: raise ValueError('Request too large')
            body=json.loads(self.rfile.read(size) or b'{}')
            action=u.path.rsplit('/',1)[-1]
            if action=='dryrun':
                start_guardian_dryrun(); result='Outage simulation started'
            elif action=='realtest':
                start_guardian_realtest(body); result='Real recovery test started'
            elif action=='energy':
                result=energy.update_conf(body)
            elif action=='abort-realtest':
                abort_guardian_realtest(); result='Safe abort requested; recovery will begin after the current atomic operation'
            else: result=apply_setting(action,body)
            return self.send_json({"ok":True,"message":result,"settings":settings_data()})
        except (ValueError,RuntimeError,json.JSONDecodeError) as e: return self.send_json({"error":str(e)},400)

if __name__=='__main__':
    threading.Thread(target=collect,daemon=True).start()
    threading.Thread(target=psu_collect,daemon=True).start()
    threading.Thread(target=energy_collect,daemon=True).start()
    server=ThreadingHTTPServer((HOST,PORT),Handler)
    def shutdown(*_):
        stop.set()
        # BaseServer.shutdown must be called from a different thread.
        threading.Thread(target=server.shutdown,daemon=True).start()
    signal.signal(signal.SIGTERM,shutdown)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: stop.set(); server.server_close()
