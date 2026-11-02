"""Energy and cost tracker for the ByteMe2 power dashboard.

Integrates watts into per-day Wh, one row per (day, source), in its own small SQLite file:
  ups              UPS output (the samples table's load column, 5 s cadence)
  <server>         a server's BMC total (psu_collect, 15 s cadence)
  <server>/<PSU>   each server PSU on its own

The UPS battery outlets hold only one PSU per server; the other PSU of each server sits on the UPS's surge-only
outlets, which the UPS does not meter. So lab total = ups + the surge-side PSU of each server. Which PSU that is
lives in the config (surge_psus) and is applied when reporting, so fixing it later re-totals history too. It is
learned automatically the first time the UPS runs on battery: the surge outlets go dead with the wall feed.
"""
import calendar, json, sqlite3, threading, time
from datetime import date, datetime, timedelta
from pathlib import Path

EDB = Path("/var/lib/ups-dashboard/energy.sqlite3")
CONF = Path("/var/lib/ups-dashboard/energy.json")
# Rate is the September 2026 bill: $355.81 electric charge / 2788 kWh.
DEFAULT = {"rate": 0.1276, "cycle_day": 13, "surge_psus": {}}
UPS_RATED_W = 900       # LX1500GAVR; before 2026-09-20 pwrstat reported load only as a percentage of this
MAX_GAP = 30            # seconds credited per sample gap at most, so an outage in collection is not invented
PSU_MAX_GAP = 60
lock = threading.Lock()
_last_psu = {}


def conf():
    c = json.loads(json.dumps(DEFAULT))
    try: c.update(json.loads(CONF.read_text()))
    except Exception: pass
    return c


def save_conf(c):
    tmp = CONF.with_suffix(".tmp"); tmp.write_text(json.dumps(c, indent=1)); tmp.replace(CONF)


def connect():
    c = sqlite3.connect(EDB, timeout=10)
    c.execute("CREATE TABLE IF NOT EXISTS energy(day TEXT, source TEXT, wh REAL, secs REAL, est INTEGER DEFAULT 0, PRIMARY KEY(day, source))")
    c.execute("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)")
    return c


def meta(c, key, default=None):
    r = c.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return r[0] if r else default


def set_meta(c, key, value):
    c.execute("INSERT OR REPLACE INTO meta VALUES(?,?)", (key, str(value)))


def add(c, ts, source, watts, dt, est=0):
    day = datetime.fromtimestamp(ts).strftime("%Y-%m-%d")
    c.execute("INSERT INTO energy VALUES(?,?,?,?,?) ON CONFLICT(day, source) DO UPDATE SET "
              "wh=wh+excluded.wh, secs=secs+excluded.secs, est=max(est, excluded.est)",
              (day, source, watts * dt / 3600.0, dt, est))


def _integrate(c, rows):
    """rows: (ts, load %, load_w) oldest first. Before 2026-09-20 pwrstat gave only the percentage."""
    prev = int(meta(c, "ups_last_ts", 0))
    for ts, load, load_w in rows:
        if load is None and load_w is None: continue
        pct = load_w is None
        watts = load * UPS_RATED_W / 100.0 if pct else load_w
        if prev: add(c, ts, "ups", watts, min(MAX_GAP, max(0, ts - prev)), est=int(pct))
        prev = ts
    if rows: set_meta(c, "ups_last_ts", prev)


def catch_up(samples_db, psql=None):
    """Fold new UPS samples into daily energy. First run also backfills from the Postgres archive."""
    with lock:
        c = connect()
        s = sqlite3.connect(samples_db, timeout=10)
        if meta(c, "archive_done") is None and psql:
            first = s.execute("SELECT min(ts) FROM samples").fetchone()[0] or int(time.time())
            raw = psql(f"COPY (SELECT ts, load FROM ups_samples WHERE ts < {int(first)} ORDER BY ts) TO STDOUT WITH (FORMAT csv);", timeout=120)
            if raw is not None:
                rows = []
                for line in raw.splitlines():
                    a, _, b = line.partition(",")
                    try: rows.append((int(a), float(b) if b else None, None))
                    except ValueError: pass
                _integrate(c, rows)
                set_meta(c, "archive_done", 1)
        last = int(meta(c, "ups_last_ts", 0))
        rows = s.execute("SELECT ts, load, load_w FROM samples WHERE ts > ? AND connected=1 ORDER BY ts LIMIT 200000", (last,)).fetchall()
        _integrate(c, rows)
        c.commit(); c.close(); s.close()


def record_psu(name, doc, ups_online):
    """Called per BMC reading. Also learns the surge-side PSU: on battery, the surge outlets are dead."""
    now = time.time()
    psus = (doc or {}).get("psus") or []
    total = ((doc or {}).get("power") or {}).get("now_w")
    if total is None and psus: total = sum(p.get("watts") or 0 for p in psus)
    with lock:
        prev = _last_psu.get(name); _last_psu[name] = now
        if prev and total is not None:
            dt = min(PSU_MAX_GAP, now - prev)
            c = connect()
            add(c, now, name, total, dt)
            for p in psus:
                if p.get("watts") is not None: add(c, now, f"{name}/{p['name']}", p["watts"], dt)
            c.commit(); c.close()
        if ups_online is False and len(psus) > 1:
            dead = [p["name"] for p in psus if not p.get("ok", True) or (p.get("watts") is not None and p["watts"] < 2)]
            live = [p for p in psus if p["name"] not in dead]
            cf = conf()
            if len(dead) == 1 and live and cf["surge_psus"].get(name) != dead[0]:
                cf["surge_psus"][name] = dead[0]
                cf.setdefault("surge_learned", {})[name] = int(now)
                save_conf(cf)


def cycle_start(d, day):
    if d.day >= day: return date(d.year, d.month, day)
    y, m = (d.year, d.month - 1) if d.month > 1 else (d.year - 1, 12)
    return date(y, m, day)


def next_cycle(start):
    y, m = (start.year, start.month + 1) if start.month < 12 else (start.year + 1, 1)
    return date(y, m, start.day)


def report():
    cf = conf(); rate = float(cf["rate"]); cday = int(cf["cycle_day"])
    with lock:
        c = connect()
        rows = c.execute("SELECT day, source, wh, secs, est FROM energy").fetchall()
        c.close()
    surge = {f"{srv}/{psu}" for srv, psu in cf["surge_psus"].items()}
    days = {}
    servers = set()
    for day, src, wh, secs, est in rows:
        d = days.setdefault(day, {"ups": 0.0, "ups_secs": 0.0, "surge": 0.0, "est": 0, "srv": {}})
        if src == "ups": d["ups"] += wh; d["ups_secs"] += secs; d["est"] = max(d["est"], est)
        elif src in surge: d["surge"] += wh
        elif "/" not in src: d["srv"][src] = d["srv"].get(src, 0.0) + wh; servers.add(src)
    psu_names = {}
    for day, src, *_ in rows:
        if "/" in src:
            srv, psu = src.split("/", 1); psu_names.setdefault(srv, set()).add(psu)

    def summarize(start, end):
        span = [(start + timedelta(n)).isoformat() for n in range((end - start).days)]
        have = [days[x] for x in span if x in days]
        ups = sum(d["ups"] for d in have); sg = sum(d["surge"] for d in have); secs = sum(d["ups_secs"] for d in have)
        kwh = (ups + sg) / 1000.0; hours = secs / 3600.0
        avg_w = (ups + sg) / hours if hours else None
        full_h = (end - start).days * 24
        return {"start": start.isoformat(), "end": (end - timedelta(1)).isoformat(), "days": (end - start).days,
                "measured_days": round(hours / 24, 1), "kwh": round(kwh, 2), "kwh_ups": round(ups / 1000, 2),
                "kwh_surge": round(sg / 1000, 2), "cost": round(kwh * rate, 2), "avg_w": round(avg_w) if avg_w else None,
                "est": any(d["est"] for d in have),
                "projected_kwh": round(avg_w * full_h / 1000, 1) if avg_w else None,
                "projected_cost": round(avg_w * full_h / 1000 * rate, 2) if avg_w else None,
                "servers": {s: round(sum(d["srv"].get(s, 0) for d in have) / 1000, 2) for s in sorted(servers)}}

    today = date.today(); start = cycle_start(today, cday); cycles = []
    earliest = min(days) if days else today.isoformat()
    while True:
        end = next_cycle(start); cycles.append(summarize(start, end))
        if start.isoformat() <= earliest or len(cycles) >= 24: break
        start = cycle_start(start - timedelta(1), cday)
    cur = cycles[0]
    cur["elapsed_days"] = (today - date.fromisoformat(cur["start"])).days + 1
    td = summarize(today, today + timedelta(1))
    now = datetime.now(); hours_today = now.hour + now.minute / 60
    daily = []
    for n in range(61, -1, -1):
        dd = (today - timedelta(n)).isoformat(); d = days.get(dd)
        cs = cycle_start(today - timedelta(n), cday).isoformat()
        daily.append({"day": dd, "kwh": round((d["ups"] + d["surge"]) / 1000, 3) if d else None,
                      "hours": round(d["ups_secs"] / 3600, 1) if d else 0, "est": bool(d and d["est"]),
                      "cycle": "cur" if cs == cycles[0]["start"] else ("prev" if len(cycles) > 1 and cs == cycles[1]["start"] else None)})
    return {"config": {**cf, "psus": {k: sorted(v) for k, v in psu_names.items()}}, "cycles": cycles,
            "daily": daily, "today": {**td, "hours_elapsed": round(hours_today, 1)},
            "surge_mapped": sorted(cf["surge_psus"]), "servers": sorted(servers),
            "psu_from": min((r[0] for r in rows if "/" in r[1]), default=None)}


def update_conf(body):
    cf = conf()
    if "rate" in body:
        r = float(body["rate"])
        if not 0.01 <= r <= 1.5: raise ValueError("Rate must be $0.01-$1.50 per kWh")
        cf["rate"] = r
    if "cycle_day" in body:
        d = int(body["cycle_day"])
        if not 1 <= d <= 28: raise ValueError("Cycle day must be 1-28")
        cf["cycle_day"] = d
    if "surge_psus" in body:
        m = body["surge_psus"]
        if not isinstance(m, dict) or not all(isinstance(k, str) and isinstance(v, str) and len(k) < 40 and len(v) < 40 for k, v in m.items()):
            raise ValueError("surge_psus must map server -> PSU name")
        cf["surge_psus"] = {k: v for k, v in m.items() if v}
    save_conf(cf)
    return "Energy settings saved"
