/* byteme2 power -- 2026-09-27 redesign. One script for the dashboard, settings
   and the outage response console. Same API as the previous UI (app.js,
   servers.js, energy.js, disarm.js, settings.js -- kept on disk for rollback),
   plus two read-only additions in server.py: guests.list in /api/status and
   GET /api/guardian/log?since=<epoch>.

   The console is driven by guardian output, never by a script:
     dry run   -> /api/dryrun        (700 ms)
     real run  -> /api/realtest      (1 s)
     replay    -> frames rebuilt from /api/realtest/last (800 ms)
     outage    -> /api/guardian/log  (2 s) while /api/status says on battery */
(() => {
"use strict";

// ------------------------------------------------------------------ helpers
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad2 = n => String(Math.max(0, Math.floor(n))).padStart(2, "0");
const num = (v, dp = 0) => v == null || isNaN(v) ? "—" : (+v).toFixed(dp);
const clockTime = s => `${pad2(s / 60)}:${pad2(s % 60)}`;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = s => { const p = s.split("-"); return MON[+p[1] - 1] + " " + (+p[2]); };
const money = v => v == null ? "—" : "$" + v.toFixed(2);
const kwh = v => v == null ? "—" : (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + " kWh";
function duration(n) {
  if (n == null) return "—";
  const d = Math.floor(n / 86400), h = Math.floor(n % 86400 / 3600), m = Math.floor(n % 3600 / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
function flash(el, text, html) {
  if (!el) return;
  const cur = html ? el.innerHTML : el.textContent;
  if (cur === text) return;
  const had = cur !== "" && cur !== "—";
  if (html) el.innerHTML = text; else el.textContent = text;
  if (had && !reduce) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
}
async function getJSON(url) { const r = await fetch(url, { cache: "no-store" }); return r.json(); }

let token = "";
try { token = sessionStorage.getItem("upsAdminToken") || ""; } catch (e) { /* storage blocked */ }
async function post(action, body = {}) {
  const r = await fetch("/api/settings/" + action, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Token": token }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (/token/i.test(d.error || "")) { token = ""; try { sessionStorage.removeItem("upsAdminToken"); } catch (e) {} applyLock(); }
    throw new Error(d.error || "Request failed");
  }
  return d;
}

let toastT;
function toast(msg, err) {
  const t = $("#toast"); t.textContent = msg; t.classList.toggle("err", !!err); t.classList.add("on");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), 4500);
}

// In-page confirmation, styled like the page (window.confirm cannot be).
function ask({ title, body, ok = "Confirm", danger = false }) {
  return new Promise(resolve => {
    const bg = document.createElement("div"); bg.className = "sheet-bg";
    bg.innerHTML = `<div class="sheet${danger ? " danger" : ""}" role="alertdialog" aria-modal="true"><h4>${esc(title)}</h4><p>${esc(body)}</p>
      <div class="row"><button class="ghost" data-a="0">Cancel</button><button class="${danger ? "go-real" : "primary"}" data-a="1">${esc(ok)}</button></div></div>`;
    document.body.appendChild(bg);
    requestAnimationFrame(() => bg.classList.add("on"));
    const done = v => { bg.classList.remove("on"); setTimeout(() => bg.remove(), 200); document.removeEventListener("keydown", key); resolve(v); };
    const key = e => { if (e.key === "Escape") done(false); };
    document.addEventListener("keydown", key);
    bg.addEventListener("click", e => { if (e.target === bg) done(false); const b = e.target.closest("[data-a]"); if (b) done(b.dataset.a === "1"); });
    bg.querySelector('[data-a="1"]').focus();
  });
}

// ------------------------------------------------------------------- header
const tabs = $("#tabs"), ind = $("#ind");
function moveInd() {
  const b = $("button.active", tabs); if (!b) return;
  ind.style.width = (b.offsetWidth - 20) + "px"; ind.style.transform = `translateX(${b.offsetLeft + 10}px)`;
}
function showView(v) {
  $$("button", tabs).forEach(x => x.classList.toggle("active", x.dataset.v === v));
  $$(".view").forEach(el => el.classList.toggle("active", el.id === "v-" + v));
  moveInd();
  if (v === "dash") { drawEnergy(); drawHistory(); } else loadSettings();
}
tabs.addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  history.replaceState(null, "", b.dataset.v === "settings" ? "#settings" : location.pathname);
  showView(b.dataset.v);
});
addEventListener("resize", () => { moveInd(); drawEnergy(); drawHistory(); });
addEventListener("scroll", () => $("#top").classList.toggle("scrolled", scrollY > 4), { passive: true });
if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveInd);

(() => {
  const nav = $("#labnav"), btn = $("#labnav-btn"), menu = $("#labnav-menu");
  const set = open => { menu.hidden = !open; nav.classList.toggle("open", open); btn.setAttribute("aria-expanded", open); };
  btn.addEventListener("click", e => { e.stopPropagation(); set(menu.hidden); if (!menu.hidden) $(".labnav-item:not(.current)", menu).focus(); });
  document.addEventListener("click", e => { if (!nav.contains(e.target)) set(false); });
  document.addEventListener("keydown", e => {
    if (menu.hidden) return;
    if (e.key === "Escape") { set(false); btn.focus(); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = $$(".labnav-item", menu), i = items.indexOf(document.activeElement);
    items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
  });
})();

// ------------------------------------------------------------------- status
const S = { status: null, guests: [], protectedIds: new Set(), lastLoadW: null };
const BMC = { byteme2: "https://ilo/", byteme: "https://idrac/", deadlock: "http://DCMI001E67D74FF0/" };
const ORDER = { byteme2: 0, byteme: 1, deadlock: 2 };

function renderStatus(d) {
  S.status = d;
  const u = d.ups || {}, h = d.host || {}, g = d.guardian || {}, gs = d.guests || {};
  const connected = !!u.connected, online = connected && !!u.online, onBatt = connected && !u.online;
  S.lastLoadW = u.load_w != null ? u.load_w : S.lastLoadW;
  if (Array.isArray(gs.list)) S.guests = gs.list;

  // live indicator
  $("#live-dot").className = "dot pulse " + (!connected ? "bad" : onBatt ? "warn" : "ok");
  $("#live-txt").textContent = !connected ? "UPS unavailable" : onBatt ? "On battery" : "Live";
  $("#clock").textContent = new Date(d.ts * 1000).toLocaleTimeString([], { hour12: false });

  // hero
  $("#hero").classList.toggle("onbatt", onBatt);
  $("#model").textContent = u.model || "UPS";
  $("#state").textContent = !connected ? "UPS unavailable" : online ? "On utility power" : "On battery";
  const disarmedUntil = g.disarmed_until;
  const guardTxt = disarmedUntil ? "guardian disarmed until " + new Date(disarmedUntil * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "guardian armed";
  $("#why").textContent = !connected ? "pwrstatd returned no telemetry"
    : online ? `Line stable · battery ${num(u.battery)}% · ${guardTxt}`
    : disarmedUntil ? "Utility lost · guardian disarmed, so nothing is being shut down"
    : g.mode === "restore" ? "Utility back · guardian restoring guests" : "Utility lost · guardian shedding load · runtime counting down";
  flash($("#f-in"), `${num(u.input_voltage)}<small>V</small>`, true);
  $("#f-line").textContent = u.line_interaction ? "line interaction " + String(u.line_interaction).toLowerCase() : " ";
  flash($("#f-bat"), num(u.battery)); flash($("#f-rt"), num(u.runtime_min));
  $("#f-batbar").style.width = Math.max(0, Math.min(100, u.battery || 0)) + "%";
  flash($("#f-load"), num(u.load_w)); flash($("#f-pct"), num(u.load));
  $("#f-rated").textContent = num(u.rated_va); $("#f-out").textContent = num(u.output_voltage);

  // servers
  const servers = (d.servers || []).slice().sort((a, b) => (ORDER[a.name] ?? 9) - (ORDER[b.name] ?? 9));
  $("#servers-mini").innerHTML = servers.map(sv => {
    const p = (sv.data || {}).power || {}, off = sv.ok && (sv.chassis || (sv.data || {}).chassis) === "off";
    return `<div><span>${esc(sv.name)}</span><span class="num" data-sm="${esc(sv.name)}">${!sv.ok ? "no BMC" : off ? "off" : num(p.now_w) + " W"}</span></div>`;
  }).join("") || '<div><span class="muted">waiting for BMCs</span></div>';
  renderPSUs(servers, d.surge_psus || {});

  // outage response
  $("#guard-mode").textContent = g.mode || "standby";
  renderArm(disarmedUntil);
  const steps = $$("#pipe .pstep"), idx = g.mode === "standby" || !g.mode ? -1 : g.mode === "restore" ? 4 : Math.max(1, (C.parse && C.mode === "outage") ? C.parse.stage : 1);
  steps.forEach((s, i) => { s.classList.toggle("done", idx > i); s.classList.toggle("cur", idx === i); });
  $("#g-vms").textContent = gs.vms ? `${gs.vms.running} / ${gs.vms.total}` : "—";
  $("#g-cts").textContent = gs.containers ? `${gs.containers.running} / ${gs.containers.total}` : "—";
  $("#g-up").textContent = duration(h.uptime);
  $("#g-mem").textContent = h.memory_pct != null ? num(h.memory_pct, 1) + "%" : "—";
  $("#g-temp").textContent = h.temperature != null ? num(h.temperature) + " °C" : "—";
  $("#g-load").textContent = h.load1 != null ? num(h.load1, 2) : "—";

  // UPS detail
  const labels = { firmware: "Firmware", rated_voltage: "Rated voltage", rated_va: "Rated power", state: "State", source: "Power source",
    input_voltage: "Input voltage", output_voltage: "Output voltage", battery: "Battery", runtime_min: "Runtime", load: "Load", load_w: "Load",
    line_interaction: "Line interaction", test_result: "Self-test", last_event: "Last power event" };
  const units = { rated_voltage: " V", rated_va: " W", input_voltage: " V", output_voltage: " V", battery: "%", runtime_min: " min", load: "%", load_w: " W" };
  $("#ups-model").textContent = u.model || "";
  $("#ups-kv").innerHTML = Object.entries(u).filter(([k]) => labels[k])
    .map(([k, v]) => `<div class="kv"><div class="k">${labels[k]}</div><div class="v">${v == null ? "—" : esc(v) + (units[k] || "")}</div></div>`).join("");
  $("#ups-raw").textContent = u.raw || "No output";

  incidentCheck(u, g);
}

function renderPSUs(servers, surge) {
  const host = $("#psus");
  if (!servers.length) { host.innerHTML = '<div class="note">Waiting for the first BMC reading (every 15 s).</div>'; return; }
  host.innerHTML = servers.map(sv => {
    const d = sv.data || {}, p = d.power || {}, age = sv.fetched ? Math.round(Date.now() / 1000 - sv.fetched) : null;
    const off = sv.ok && (sv.chassis || d.chassis) === "off";
    const red = !sv.ok ? ["bad", "BMC unreachable"] : off ? ["warn", "powered off"] : [/fully/i.test(d.redundancy || "") ? "" : "warn", (d.redundancy || "—").toLowerCase()];
    const psus = d.psus || [], sum = psus.reduce((a, x) => a + (x.watts || 0), 0) || 1, sp = surge[sv.name];
    const rows = psus.map(x => {
      const standby = (x.watts || 0) < 15, role = sp ? (sp === x.name ? '<span class="tag surge">SURGE</span>' : '<span class="tag bat">BATTERY</span>') : "<span></span>";
      const extra = [];
      if (x.amps != null) extra.push(x.amps.toFixed(1) + " A"); if (x.volts != null) extra.push(Math.round(x.volts) + " V");
      if (x.load_pct != null) extra.push(Math.round(x.load_pct) + " % load"); if (x.temp_c != null) extra.push(Math.round(x.temp_c) + " °C");
      if ((standby && !x.amps) || x.state === "standby") extra.push("standby"); if (!x.ok && sv.ok) extra.push("FAULT");
      const pct = Math.max(2, Math.round(100 * (x.watts || 0) / sum));
      return `<div class="psu-row"><b>${esc(x.name)}</b>${role}<div class="track"><div class="fill${standby ? " dim" : ""}${!x.ok && sv.ok ? " bad" : ""}" style="width:${pct}%"></div></div><span class="w" data-pw="${esc(sv.name + x.name)}">${x.watts == null ? "—" : Math.round(x.watts) + " W"}</span>${extra.length ? `<span class="x">${esc(extra.join(" · "))}</span>` : ""}</div>`;
    }).join("");
    const e = d.energy, sd = s => { const m = (s || "").match(/^(\d\d)\/(\d\d)\/(\d{4})/); return m ? `${MON[+m[1] - 1]} ${+m[2]}` : (s || ""); };
    const extra = e ? `<div class="psu-extra"><div>energy<b>${e.kwh != null ? e.kwh.toFixed(1) + " kWh" : "—"}</b>since ${esc(sd(e.since))}</div><div>peak power<b>${e.peak_w != null ? Math.round(e.peak_w) + " W" : "—"}</b>${esc(sd(e.peak_w_at))}</div><div>peak current<b>${e.peak_a != null ? e.peak_a.toFixed(1) + " A" : "—"}</b>${esc(sd(e.peak_a_at))}</div></div>` : "";
    const state = !sv.ok ? `<div class="psu-state bad">No answer from the BMC${age != null ? " · last reading " + duration(age) + " ago" : ""}; figures are from then</div>`
      : off ? '<div class="psu-state warn">Host powered off · BMC on standby</div>' : "";
    const win = `BMC window min ${num(p.min_w)} · avg ${num(p.avg_w)} · max ${num(p.max_w)} W${age != null && sv.ok ? " · read " + age + " s ago" : ""}${sv.error ? " · " + esc(sv.error) : ""}`;
    return `<div class="psu-col${off ? " off" : ""}${!sv.ok || age > 90 ? " stale" : ""}">
      <div class="hd"><span class="n">${esc(sv.name)}</span><span class="m">${esc(d.model || "")}</span><span class="r"><span class="red ${red[0]}">${esc(red[1])}</span>${BMC[sv.name] ? `<a class="ghost" href="${BMC[sv.name]}" target="_blank" rel="noopener">BMC ↗</a>` : ""}</span></div>
      <div class="big"><span data-big="${esc(sv.name)}">${num(p.now_w)}</span><small>W</small></div><div class="win">${!sv.ok ? "last known" : off ? "standby draw" : "drawing now"} · ${win}</div>
      ${state}${rows}${extra}</div>`;
  }).join("");
}

// ---------------------------------------------------------- guardian disarm
let disarmUntil = null, armBusy = false;
function renderArm(until) {
  if (!armBusy) disarmUntil = until || null;
  const left = disarmUntil ? disarmUntil - Date.now() / 1000 : 0, off = left > 0;
  const sw = $("#arm");
  sw.setAttribute("aria-checked", String(!off));
  $("#disarm-for").disabled = off;
  $("#arm-t").textContent = off ? `Disarmed · re-arms in ${clockTime(left)}` : "Armed";
  $("#arm-t").style.color = off ? "var(--warn)" : "var(--ok)";
  $("#arm-s").textContent = off ? "Power failures are only logged (low battery still shuts down)" : "A power failure will shut guests down";
}
$("#arm").addEventListener("click", async () => {
  const armed = $("#arm").getAttribute("aria-checked") === "true", mins = +$("#disarm-for").value;
  if (armed && !(await ask({ title: `Disarm the guardian for ${$("#disarm-for").selectedOptions[0].text}?`,
    body: "A power failure in that window is only logged. Low battery still shuts everything down.", ok: "Disarm" }))) return;
  armBusy = true;
  try { const r = await post("disarm", { minutes: armed ? mins : 0 }); disarmUntil = armed ? Date.now() / 1000 + mins * 60 : null; toast(r.message || "Done"); }
  catch (e) { toast(e.message, true); }
  armBusy = false; renderArm(disarmUntil);
});
setInterval(() => renderArm(disarmUntil), 1000);

// ------------------------------------------------------------------- energy
let energy = null;
function renderEnergy(e) {
  energy = e;
  const cf = e.config, cur = e.cycles[0], prev = e.cycles[1], td = e.today || {};
  const ord = n => (n % 10 === 1 && n !== 11) ? "st" : (n % 10 === 2 && n !== 12) ? "nd" : (n % 10 === 3 && n !== 13) ? "rd" : "th";
  $("#en-rate").textContent = `$${cf.rate.toFixed(4)}/kWh · cycle resets on the ${cf.cycle_day}${ord(cf.cycle_day)}`;
  const stats = [];
  const prog = Math.min(100, 100 * (cur.cost || 0) / Math.max(0.01, cur.projected_cost || 0));
  stats.push(["cur", money(cur.cost), `this cycle · ${dayLabel(cur.start)} – ${dayLabel(cur.end)}`,
    `${kwh(cur.kwh)} · avg ${cur.avg_w || "—"} W · day ${cur.elapsed_days} of ${cur.days}`, "money",
    `<div class="cycle-prog" title="spent so far vs projected ${money(cur.projected_cost)}"><i style="width:${prog}%"></i><b style="left:100%"></b></div>`]);
  stats.push(["proj", money(cur.projected_cost), "projected this cycle", `${kwh(cur.projected_kwh)} at the current rate`]);
  if (prev) {
    const partial = prev.measured_days < prev.days - 0.5;
    stats.push(["prev", partial ? money(prev.projected_cost) : money(prev.cost), `last cycle · ${dayLabel(prev.start)} – ${dayLabel(prev.end)}`,
      partial ? `estimated: measured ${prev.measured_days} of ${prev.days} days (${money(prev.cost)})` : `${kwh(prev.kwh)} · avg ${prev.avg_w || "—"} W`]);
  }
  stats.push(["today", money(td.cost), `today · ${td.hours_elapsed} h in`, `${kwh(td.kwh)} · avg ${td.avg_w || "—"} W · full day ${money(td.projected_cost)}`]);
  const host = $("#en-stats");
  stats.forEach(s => {
    let t = host.querySelector(`[data-st="${s[0]}"]`);
    if (!t) { t = document.createElement("div"); t.className = "stat"; t.dataset.st = s[0]; t.innerHTML = '<div class="v"></div><div class="l"></div><div class="s"></div><div class="x"></div>'; host.appendChild(t); }
    const v = $(".v", t); v.classList.toggle("money", s[4] === "money"); flash(v, s[1]);
    $(".l", t).textContent = s[2]; $(".s", t).textContent = s[3]; if (s[5] && !$(".x", t).firstChild) $(".x", t).innerHTML = s[5];
    if (s[5]) $(".cycle-prog i", t).style.width = prog + "%";
  });
  // notes
  const notes = [];
  if (e.servers && e.servers.length) notes.push(`<div class="note">Server BMCs this cycle, both PSUs since ${e.psu_from ? dayLabel(e.psu_from) : "—"}: ` +
    e.servers.map(s => { const v = cur.servers[s] || 0; return `<b>${esc(s)}</b> ${kwh(v)} · ${money(v * cf.rate)}`; }).join(" &nbsp; ") + "</div>");
  const unmapped = (e.servers || []).filter(s => (e.surge_mapped || []).indexOf(s) < 0);
  if (unmapped.length) notes.push(`<div class="note warn">Surge-side PSU not known yet for ${esc(unmapped.join(", "))}, so their surge-outlet draw is not in the total. It is learned the next time the UPS runs on battery, or set it under Rate settings.</div>`);
  const lr = cf.surge_learned || {}, ls = Object.keys(lr).filter(k => cf.surge_psus[k]);
  if (ls.length || e.psu_from) notes.push(`<div class="note">${ls.length ? "Surge-side PSUs learned on battery: " + ls.map(k => `${esc(k)} ${esc(cf.surge_psus[k])} (${new Date(lr[k] * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })})`).join(", ") + ". " : ""}${e.psu_from ? `Totals are UPS output plus each server's surge-side PSU; before ${dayLabel(e.psu_from)} only the UPS outlets were metered.` : ""}</div>`);
  $("#en-notes").innerHTML = notes.join("");
  $("#en-hist").innerHTML = "<tr><th>Cycle</th><th>kWh</th><th>Cost</th><th>Avg W</th><th>Measured</th></tr>" +
    e.cycles.map(c => `<tr><td>${dayLabel(c.start)} – ${dayLabel(c.end)}</td><td>${kwh(c.kwh)}</td><td>${money(c.cost)}</td><td>${c.avg_w || "—"}</td><td>${c.measured_days} / ${c.days} d</td></tr>`).join("");
  drawEnergy();
}
let enDrawn = false;
function drawEnergy() {
  if (!energy) return;
  const svg = $("#en"), wrap = $("#en-wrap"), W = wrap.offsetWidth; if (!W) return;
  const daily = energy.daily, n = daily.length, H = 190, L = 34, R = 4, T = 14, B = 22, rate = energy.config.rate;
  const top = Math.max(1, ...daily.map(x => x.kwh || 0)), step = top > 20 ? 10 : top > 8 ? 4 : 2, max = Math.ceil(top / step) * step;
  const bw = (W - L - R) / n, y = v => T + (1 - v / max) * (H - T - B);
  let g = "";
  for (let v = 0; v <= max; v += step) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" fill="var(--muted)" font-size="11" font-family="Geist Mono, monospace">${v}</text>`;
  g += `<text x="${L}" y="${T - 4}" fill="var(--muted)" font-size="11" font-family="Geist Mono, monospace">kWh/day</text>`;
  const labelEvery = Math.max(1, Math.round(n / 8));
  daily.forEach((d, i) => {
    const x = L + i * bw + Math.min(1.5, bw * .1), w = Math.max(1, bw - Math.min(3, bw * .2)), last = i === n - 1;
    if (d.kwh != null) {
      const fill = last ? "var(--ok)" : d.cycle === "cur" ? "rgba(61,220,151,.55)" : d.cycle ? "#2c3545" : "#1f2632";
      g += `<rect class="enb" data-i="${i}" x="${x.toFixed(1)}" y="${y(d.kwh).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0, y(0) - y(d.kwh)).toFixed(1)}" rx="${Math.min(2, w / 3)}" fill="${fill}"/>`;
    }
    if (i > 0 && d.cycle === "cur" && daily[i - 1].cycle !== "cur")
      g += `<line x1="${x - 1}" x2="${x - 1}" y1="${T}" y2="${y(0)}" stroke="var(--muted)" stroke-dasharray="3 3"/><text x="${x + 3}" y="${T + 10}" fill="var(--text-2)" font-size="11">cycle starts</text>`;
    if (i % labelEvery === 0 || last) g += `<text x="${x + w / 2}" y="${H - 4}" text-anchor="${last ? "end" : "middle"}" fill="var(--muted)" font-size="11" font-family="Geist Mono, monospace">${dayLabel(d.day)}</text>`;
  });
  g += `<rect id="en-hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>`;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.innerHTML = g;
  if (!enDrawn && !reduce && svg.animate) svg.animate([{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], { duration: 900, easing: "cubic-bezier(.2,.8,.2,1)" });
  enDrawn = true;
  const tip = $("#en-tip");
  $("#en-hit").addEventListener("mousemove", ev => {
    const bx = svg.getBoundingClientRect(), i = Math.max(0, Math.min(n - 1, Math.floor((ev.clientX - bx.left - L) / bw))), d = daily[i];
    $$(".enb", svg).forEach(r => r.style.filter = +r.dataset.i === i ? "brightness(1.4)" : "");
    tip.innerHTML = `<span class="mono">${dayLabel(d.day)}</span> · ${d.kwh == null ? "no data" : `${kwh(d.kwh)} · ${money(d.kwh * rate)}${d.hours < 23.5 ? ` · ${d.hours} h measured` : ""}${d.est ? " · from %" : ""}`}`;
    tip.style.left = Math.min(W - 90, Math.max(90, L + i * bw + bw / 2)) + "px"; tip.style.top = (d.kwh != null ? y(d.kwh) : y(0)) + 18 + "px"; tip.classList.add("on");
  });
  $("#en-hit").addEventListener("mouseleave", () => { tip.classList.remove("on"); $$(".enb", svg).forEach(r => r.style.filter = ""); });
}
$("#en-edit").addEventListener("click", () => {
  const f = $("#en-form"); f.hidden = !f.hidden; if (f.hidden || !energy) return;
  const cf = energy.config;
  f.innerHTML = `<label>Rate $/kWh<input id="en-r" type="number" step="0.0001" value="${cf.rate}"></label>
    <label>Cycle starts on day<input id="en-d" type="number" min="1" max="28" value="${cf.cycle_day}"></label>` +
    (energy.servers || []).map(s => `<label>${esc(s)} surge-side PSU<select data-srv="${esc(s)}"><option value="">unknown</option>${(cf.psus[s] || []).map(p => `<option${cf.surge_psus[s] === p ? " selected" : ""}>${esc(p)}</option>`).join("")}</select></label>`).join("") +
    `<button class="primary" type="submit">Save</button><span class="en-msg" id="en-msg"></span>`;
});
$("#en-form").addEventListener("submit", async ev => {
  ev.preventDefault();
  const m = {}; $$("select[data-srv]", ev.target).forEach(s => { if (s.value) m[s.dataset.srv] = s.value; });
  try { await post("energy", { rate: parseFloat($("#en-r").value), cycle_day: parseInt($("#en-d").value, 10), surge_psus: m }); $("#en-msg").textContent = "Saved"; loadEnergy(); }
  catch (e) { $("#en-msg").textContent = e.message; }
});
function loadEnergy() { getJSON("/api/energy").then(renderEnergy).catch(() => {}); }

// ------------------------------------------------------------------ history
const MODES = {
  power: { title: "Battery & load", unit: "%", fixed: [0, 100], series: [["battery", "battery", "#3ddc97"], ["load", "UPS load", "#8ea8ff", "load_w"], ["surge_pct", "surge load", "#b69bff", "surge_w"]] },
  voltage: { title: "Input & output voltage", unit: " V", series: [["input_v", "input", "#8ea8ff"], ["output_v", "output", "#3ddc97"]] },
  runtime: { title: "Estimated battery runtime", unit: " min", series: [["runtime", "runtime", "#b69bff"]] }
};
let histSeconds = 3600, histMode = "power", points = [], hiddenS = new Set(), histFirst = true;
function renderLegend() {
  $("#legend").innerHTML = MODES[histMode].series.map(s => `<button data-s="${s[0]}" class="${hiddenS.has(s[0]) ? "off" : ""}"><i style="background:${s[2]}"></i>${s[1]}</button>`).join("");
}
$("#legend").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; hiddenS.has(b.dataset.s) ? hiddenS.delete(b.dataset.s) : hiddenS.add(b.dataset.s); b.classList.toggle("off"); drawHistory(); });
$("#range").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; $$("#range button").forEach(x => x.classList.toggle("on", x === b)); histSeconds = +b.dataset.s; histFirst = true; loadHistory(); });
$("#mode").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; $$("#mode button").forEach(x => x.classList.toggle("on", x === b)); histMode = b.dataset.m; hiddenS.clear(); $("#bl-title").textContent = MODES[histMode].title; renderLegend(); histFirst = true; drawHistory(); });
function loadHistory() {
  getJSON(`/api/history?seconds=${histSeconds}`).then(d => {
    points = d.points || [];
    $("#bl-count").textContent = `${points.length.toLocaleString()} samples${points.length ? " · since " + new Date(points[0].ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}`;
    drawHistory();
  }).catch(() => {});
}
function drawHistory() {
  const svg = $("#bl"), wrap = $("#bl-wrap"), W = wrap.offsetWidth; if (!W) return;
  const m = MODES[histMode], H = 240, L = 46, R = 8, T = 8, B = 24;
  let lo, hi;
  if (m.fixed) [lo, hi] = m.fixed;
  else {
    const v = []; m.series.forEach(s => points.forEach(o => { if (o[s[0]] != null) v.push(+o[s[0]]); }));
    if (!v.length) [lo, hi] = [0, 1]; else { lo = Math.min(...v); hi = Math.max(...v); if (lo === hi) { lo -= Math.max(1, lo * .05); hi += Math.max(1, hi * .05); } const p = (hi - lo) * .12; lo = Math.max(0, lo - p); hi += p; }
  }
  const y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  let g = "";
  for (let i = 0; i <= 4; i++) { const v = lo + (hi - lo) * i / 4; g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" fill="var(--muted)" font-size="11" font-family="Geist Mono, monospace">${Math.round(v * 10) / 10}${m.unit.trim() === "%" ? "%" : ""}</text>`; }
  if (points.length > 1) {
    const t0 = points[0].ts, t1 = points[points.length - 1].ts || t0 + 1, x = t => L + (t - t0) / (t1 - t0 || 1) * (W - L - R);
    const span = t1 - t0;
    for (let k = 0; k <= 4; k++) { const t = t0 + span * k / 4, dt = new Date(t * 1000);
      const lab = span > 172800 ? dt.toLocaleDateString([], { month: "short", day: "numeric" }) : dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
      g += `<text x="${x(t)}" y="${H - 4}" text-anchor="${k === 0 ? "start" : k === 4 ? "end" : "middle"}" fill="var(--muted)" font-size="11" font-family="Geist Mono, monospace">${lab}</text>`; }
    m.series.forEach(s => {
      if (hiddenS.has(s[0])) return;
      let d = "", pen = false, lastPt = null;
      points.forEach(o => { const v = o[s[0]]; if (v == null) { pen = false; return; } d += `${pen ? "L" : "M"}${x(o.ts).toFixed(1)},${y(+v).toFixed(1)}`; pen = true; lastPt = [x(o.ts), y(+v)]; });
      if (!d) return;
      const anim = histFirst && !reduce ? `stroke-dasharray="6000" stroke-dashoffset="6000"><animate attributeName="stroke-dashoffset" to="0" dur="1.1s" fill="freeze" calcMode="spline" keySplines=".2 .8 .2 1" keyTimes="0;1"/></path>` : "></path>";
      g += `<path d="${d}" fill="none" stroke="${s[2]}" stroke-width="1.6" stroke-linejoin="round" ${anim}`;
      if (lastPt) g += `<circle cx="${lastPt[0]}" cy="${lastPt[1]}" r="3" fill="${s[2]}"/>`;
    });
    g += `<line id="bl-x" y1="${T}" y2="${H - B}" stroke="var(--line-2)" opacity="0"/><rect id="bl-hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>`;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.innerHTML = g; histFirst = false;
    const tip = $("#bl-tip"), cx = $("#bl-x");
    $("#bl-hit").addEventListener("mousemove", e => {
      const bx = svg.getBoundingClientRect(), t = t0 + (e.clientX - bx.left - L) / (W - L - R) * span;
      let i = 0, best = Infinity; points.forEach((o, k) => { const dd = Math.abs(o.ts - t); if (dd < best) { best = dd; i = k; } });
      const o = points[i], px = x(o.ts);
      cx.setAttribute("x1", px); cx.setAttribute("x2", px); cx.setAttribute("opacity", 1);
      tip.innerHTML = `<b class="mono">${new Date(o.ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</b><br>` +
        m.series.map(s => `${s[1]} ${o[s[0]] == null ? "—" : Math.round(o[s[0]] * 10) / 10 + m.unit}${s[3] && o[s[3]] != null ? " · " + Math.round(o[s[3]]) + " W" : ""}`).join("<br>");
      const firstVisible = m.series.find(s => !hiddenS.has(s[0]) && o[s[0]] != null);
      tip.style.left = Math.min(W - 110, Math.max(110, px)) + "px"; tip.style.top = (firstVisible ? y(o[firstVisible[0]]) : T + 40) + 16 + "px"; tip.classList.add("on");
    });
    $("#bl-hit").addEventListener("mouseleave", () => { tip.classList.remove("on"); cx.setAttribute("opacity", 0); });
  } else { svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.innerHTML = g + `<text x="${L + 10}" y="${H / 2}" fill="var(--muted)" font-size="12">Waiting for history</text>`; }
}

// ------------------------------------------------------------------- events
let evTop = null;
function loadEvents() {
  getJSON("/api/events").then(rows => {
    const prevTop = evTop; evTop = rows.length ? rows[0].ts : null;
    $("#events").innerHTML = rows.length ? rows.map(x => `<div class="ev${prevTop != null && x.ts > prevTop ? " new" : ""}"><span class="dot ${esc(x.kind)}"></span><span>${esc(x.message)}</span><span class="t">${new Date(x.ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}</span></div>`).join("")
      : '<div class="note">No power events recorded.</div>';
  }).catch(() => {});
}
$("#ev-refresh").addEventListener("click", loadEvents);

// ----------------------------------------------------------------- settings
let settings = null;
const SLABELS = { alarm: "Alarm", hibernate: "Hibernate", cloud: "Cloud reporting", runtime_threshold: "Runtime threshold", capacity_threshold: "Capacity threshold",
  powerfail_delay: "Power-fail delay", shutdown_deadline: "Total shutdown deadline", remote_delay: "Remote shutdown delay", remote_timeout: "Remote power-off timeout",
  vm_timeout: "VM grace period", ct_timeout: "Container grace period", power_cap_watts: "Battery power cap", protected_vms: "Protected VMs", protected_lxc: "Protected containers",
  local_hours: "Local cache", archive_lxc: "Archive LXC", database: "PostgreSQL database" };
const kvs = (obj, units = {}) => Object.entries(obj).filter(([k]) => k !== "raw")
  .map(([k, v]) => `<div class="kv"><div class="k">${SLABELS[k] || k.replace(/_/g, " ")}</div><div class="v">${v == null ? "—" : esc(v) + (units[k] || "")}</div></div>`).join("");
function writable() { return !!settings && settings.writes_enabled && (!settings.auth_required || !!token); }
function applyLock() {
  const on = writable();
  $$(".w").forEach(e => e.disabled = !on);
  $("#lock-state").textContent = on ? "unlocked" : "locked"; $("#lock-state").style.color = on ? "var(--ok)" : "var(--warn)";
  $("#lock").hidden = !(settings && settings.auth_required);
  $("#lock-btn").textContent = token ? "Lock" : "Unlock"; $("#token").hidden = !!token;
}
$("#lock-btn").addEventListener("click", () => {
  if (token) { token = ""; try { sessionStorage.removeItem("upsAdminToken"); } catch (e) {} applyLock(); return; }
  const v = $("#token").value.trim(); if (!v) { $("#token").focus(); return; }
  token = v; try { sessionStorage.setItem("upsAdminToken", token); } catch (e) {} $("#token").value = ""; applyLock(); toast("Controls unlocked for this browser tab");
});
function loadSettings() {
  return getJSON("/api/settings").then(s => {
    settings = s;
    const u = s.ups, g = s.guardian;
    $("#alarm").setAttribute("aria-checked", String(u.alarm === "On"));
    if (u.capacity_threshold != null) $("#cap").value = u.capacity_threshold;
    if (u.runtime_threshold != null) $("#rtt").value = u.runtime_threshold;
    syncSliders();
    $("#cfg-ups").innerHTML = kvs(u, { runtime_threshold: " s", capacity_threshold: "%", powerfail_delay: " s" });
    $("#cfg-raw").textContent = u.raw || "";
    $("#cfg-guard").innerHTML = kvs(g, { shutdown_deadline: " s", remote_delay: " s", remote_timeout: " s", vm_timeout: " s", ct_timeout: " s", power_cap_watts: " W" });
    $("#cfg-store").innerHTML = kvs(s.storage, { local_hours: " hours" });
    S.protectedIds = new Set([...String(g.protected_vms || "").split(/[\s,]+/).map(x => "VM " + x), ...String(g.protected_lxc || "").split(/[\s,]+/).map(x => "CT " + x)]);
    applyLock();
  }).catch(() => toast("Unable to load the UPS configuration", true));
}
function syncSliders() { $("#cap-v").textContent = $("#cap").value + "%"; $("#rtt-v").textContent = $("#rtt").value + " s"; }
$("#cap").addEventListener("input", syncSliders); $("#rtt").addEventListener("input", syncSliders);
async function act(action, body, q) {
  if (q && !(await ask(q))) { loadSettings(); return; }
  try { const d = await post(action, body); toast(d.message || "Setting applied"); } catch (e) { toast(e.message, true); }
  loadSettings();
}
$("#alarm").addEventListener("click", () => { const on = $("#alarm").getAttribute("aria-checked") !== "true";
  act("alarm", { value: on ? "on" : "off" }, { title: `Turn the UPS audible alarm ${on ? "on" : "off"}?`, body: "This changes the PowerPanel setting directly.", ok: on ? "Turn on" : "Turn off" }); });
$("#save-th").addEventListener("click", () => act("thresholds", { capacity: +$("#cap").value, runtime: +$("#rtt").value },
  { title: "Apply these low-battery thresholds?", body: `Final shutdown starts at ${$("#cap").value}% battery or ${$("#rtt").value} s of runtime, whichever comes first.`, ok: "Apply" }));
$("#mute").addEventListener("click", () => act("mute", {}, { title: "Mute the UPS alarm?", body: "Silences the alarm for the current power event only.", ok: "Mute" }));
$("#selftest").addEventListener("click", () => act("test", {}, { title: "Run the battery self-test now?", body: "The UPS briefly switches to battery to test it.", ok: "Run self-test" }));

$("#dry-btn").addEventListener("click", async () => {
  if (!(await ask({ title: "Start a dry run?", body: "The guardian inspects the current guests and hardware, but every power-changing command stays disabled.", ok: "Start dry run" }))) return;
  try { await post("dryrun"); openConsole("dry"); } catch (e) { toast(e.message, true); }
});
$("#real-cfg").addEventListener("click", () => { $("#confirm").classList.toggle("show"); $("#confirm-in").focus(); });
$("#confirm-in").addEventListener("input", e => $("#go-real").disabled = e.target.value !== "REAL OUTAGE TEST");
$("#go-real").addEventListener("click", async () => {
  if (!(await ask({ title: "Final confirmation", danger: true, ok: "Shut down and restore",
    body: "This really shuts down the eligible guests and the remote hosts, then restores them. Utility must be online and the battery at least 50%." }))) return;
  try { await post("realtest", { confirmation: $("#confirm-in").value }); $("#confirm").classList.remove("show"); $("#confirm-in").value = ""; $("#go-real").disabled = true; openConsole("real"); }
  catch (e) { toast(e.message, true); }
});
$("#replay-btn").addEventListener("click", async () => {
  let frames = null;
  try { frames = framesFromRun(await getJSON("/api/realtest/last")); } catch (e) {}
  if (!frames) { frames = demoFrames(); toast("No stored real run yet; playing a representative demo"); }
  openConsole("replay", frames);
});

// =========================================================== response console
const STAGES = {
  dry: [["Detect", "simulated"], ["Shed remote", "intercepted"], ["Stop guests", "inspected"], ["Cap host", "intercepted"], ["Validate", "no state changed"]],
  real: [["Preflight", "markers, battery"], ["Shed remote", "byteme, deadlock"], ["Stop guests", "in parallel"], ["Cap host", "local iLO"], ["Restore", "saved state"]],
  outage: [["Detect", "pwrstatd event"], ["Shed remote", "byteme, deadlock"], ["Stop guests", "in parallel"], ["Cap host", "local iLO"], ["Restore", "when utility returns"]]
};
STAGES.replay = STAGES.real;
const MODE_LABEL = { dry: "DRY RUN · ZERO CHANGES", real: "REAL RUN · CAUSES DOWNTIME", replay: "REPLAY · LAST REAL RUN", outage: "OUTAGE · ON BATTERY" };
const C = { mode: null, open: false, timer: null, drawT: null, parse: null, shown: 0, prevGuest: {}, hist: [], watts: null, low: Infinity,
  started: null, t0: 0, done: false, frames: null, fi: 0, since: 0, lines: [], msSeen: {}, snap: null };

// Parse guardian output (its log_msg lines, the dry-run "would run" lines and
// the dashboard's phase markers) into what the console shows.
function parseLines(lines, mode) {
  const P = { stage: 0, hosts: { byteme: ["on", "ON"], deadlock: ["on", "ON"], cap: ["none", "UNCAPPED"] }, guests: new Map(),
    wait: null, restoring: false, complete: false, disarmed: false, dry: mode === "dry", starting: [], milestones: [] };
  const ms = (key, label) => { if (!P.milestones.some(m => m[0] === key)) P.milestones.push([key, label]); };
  const setG = (key, st) => { const prev = P.guests.get(key); if (!prev || st === "starting" || rank[st] >= rank[prev]) P.guests.set(key, st); };
  const rank = { seen: 0, stopping: 1, stopped: 2, checked: 2, starting: 3, restored: 4 };
  lines.forEach((raw, idx) => {
    const l = String(raw).toLowerCase();
    if (l.includes("disarmed")) { P.disarmed = true; ms("disarmed", "Guardian disarmed: no shutdown actions"); }
    if (l.includes("power failure detected") || l.includes("--- shutdown phase ---")) ms("detect", "Power failure detected");
    const idrac = /idrac|10\.0\.1\.7|10\.0\.1\.4/.test(l), dl = /deadlock|10\.0\.2\.18/.test(l) && !idrac;
    if (/remote power-off dispatched|sending idrac soft|sending soft power-off to deadlock|deadlock power-off dispatched|would run: ipmitool -h \S+ .*power (soft|off)|would now poll/.test(l)) {
      P.stage = Math.max(P.stage, 1); ms("remote", "Remote power-off dispatched");
      if (idrac && P.hosts.byteme[0] === "on") P.hosts.byteme = ["going", P.dry ? "WOULD SOFT OFF" : "SOFT OFF"];
      if (dl && P.hosts.deadlock[0] === "on") P.hosts.deadlock = ["going", P.dry ? "WOULD SOFT OFF" : "SOFT OFF"];
    }
    if (/would now poll/.test(l)) { if (idrac) P.hosts.byteme = ["off", "WOULD BE OFF"]; if (dl) P.hosts.deadlock = ["off", "WOULD BE OFF"]; }
    if (/confirmed .*power(ed)?[- ]off|already marked powered down/.test(l)) {
      if (l.includes("deadlock")) P.hosts.deadlock = ["off", "OFF"]; else { P.hosts.byteme = ["off", "OFF"]; ms("remote_off", "byteme confirmed off"); }
    }
    if (/could not confirm .*power-off/.test(l)) { if (l.includes("deadlock")) P.hosts.deadlock = ["warn", "UNCONFIRMED"]; else P.hosts.byteme = ["warn", "UNCONFIRMED"]; }
    if (/dispatched \d+ guest shutdowns/.test(l)) { P.stage = Math.max(P.stage, 2); ms("guests", "Parallel guest shutdown dispatched"); }
    let m = raw.match(/\b(VM|CT)\s+(\d+):\s*(.*)$/i);
    if (m) {
      const key = m[1].toUpperCase() + " " + m[2], rest = m[3].toLowerCase();
      P.stage = Math.max(P.stage, 2);
      if (rest.includes("stopped")) setG(key, P.dry ? "checked" : "stopped");
      else if (/shutdown|hard stop|final/.test(rest)) setG(key, "stopping");
    }
    m = raw.match(/force-stopping (VM|CT) (\d+)/i); if (m) setG(m[1].toUpperCase() + " " + m[2], "stopping");
    m = raw.match(/would run: (qm|pct) (shutdown|stop) (\d+)/i); if (m) { P.stage = Math.max(P.stage, 2); setG((m[1] === "qm" ? "VM " : "CT ") + m[3], "checked"); }
    if (/enabling local power cap|would run: hponcfg|set_power_cap/.test(l)) { P.stage = Math.max(P.stage, 3); P.hosts.cap = ["going", P.dry ? "WOULD CAP" : "CAPPING"]; }
    if (l.includes("local power cap active")) { P.stage = Math.max(P.stage, 3); P.hosts.cap = ["cap", "CAPPED"]; ms("cap", "Host power cap active"); }
    if (/could not set local power cap|skipping power-cap step|hponcfg not available/.test(l)) { P.stage = Math.max(P.stage, 3); P.hosts.cap = ["warn", "UNAVAILABLE"]; ms("cap", "Host power cap unavailable (non-fatal)"); }
    if (l.includes("on_battery complete") || l.includes("parallel guest shutdown finished")) P.stage = Math.max(P.stage, 3);
    if (/--- restore phase ---|utility power restored|starting (vm|lxc) \d+/.test(l)) { P.stage = 4; P.restoring = true; ms("restore", "Restoration started"); }
    if (/disabling local power cap|power cap deactivated/.test(l)) P.hosts.cap = ["none", "UNCAPPED"];
    m = l.match(/waiting (\d+)s before powering/); if (m) { P.wait = { secs: +m[1], idx }; P.hosts.byteme = ["wait", "WAITING"]; }
    if (/powering on 10\.0\.1\.4/.test(l)) P.hosts.byteme = ["going", "POWERING ON"];
    if (/10\.0\.1\.4 is powered on/.test(l)) { P.hosts.byteme = ["on", "ON"]; P.wait = null; ms("remote_on", "byteme powered back on"); }
    if (l.includes("deadlock power-on dispatched")) P.hosts.deadlock = ["going", "POWERING ON"];
    if (l.includes("deadlock is powered on")) P.hosts.deadlock = ["on", "ON"];
    m = raw.match(/starting (vm|lxc) (\d+)/i);
    if (m) { const key = (m[1].toLowerCase() === "lxc" ? "CT " : "VM ") + m[2]; P.starting.forEach(k => setG(k, "restored")); P.starting.push(key); setG(key, "starting"); ms("guests_up", "Saved guests starting"); }
    if (l.includes("restore complete")) { P.complete = true; P.starting.forEach(k => setG(k, "restored")); ms("restored", "Restoration complete"); }
  });
  return P;
}

function stageText(P, mode) {
  if (P.disarmed && mode === "outage") return ["Guardian disarmed", "A power failure was detected while the guardian was disarmed, so nothing is being shut down. Low battery still triggers a shutdown."];
  const dry = mode === "dry";
  if (P.restoring) return [P.complete ? "Back to normal" : "Restoring normal state", "Utility is present. Guests come back in their saved order, then the remote hosts power on."];
  return [
    [dry ? "Simulating loss of utility power" : mode === "outage" ? "Utility power lost" : "Real shutdown test starting", dry ? "Violet means a controlled test: every power, guest, marker, iDRAC and BMC change is intercepted." : mode === "outage" ? "The guardian is shedding load in order. Nothing here needs you unless a step turns red." : "This really stops guests and powers off byteme and deadlock, then restores them."],
    [dry ? "Modeling remote load shedding" : "Shedding remote load", "byteme and deadlock get a soft power-off; the guardian confirms each one before moving on."],
    [dry ? "Inspecting every guest shutdown" : "Stopping guests in parallel", "Each guest gets its grace period, then a forced stop if it overruns the deadline."],
    [dry ? "Validating host power reduction" : "Capping byteme2", "The local iLO power cap keeps the host alive on as little battery as possible."],
    [mode === "outage" ? "Holding on battery" : "Checking the result", mode === "outage" ? "Load is shed. The guardian waits for utility to return or the low-battery threshold." : ""]
  ][P.stage];
}

function setTitle(t, sub) {
  const el = $("#c-title");
  if (el.textContent !== t) { el.textContent = t; if (!reduce) { el.classList.remove("swap"); void el.offsetWidth; el.classList.add("swap"); } }
  if (sub != null) $("#c-sub").textContent = sub;
}
function hostRow(id, st) {
  const h = $("#h-" + id); if (!h) return;
  const [state, label] = st;
  h.classList.toggle("off", state === "off"); h.classList.toggle("waiting", state === "wait"); h.classList.toggle("warnst", state === "warn");
  h.querySelector(".dot").className = "dot " + (state === "off" ? "bad" : state === "going" || state === "wait" || state === "warn" ? "warn pulse" : state === "cap" ? "busy" : state === "none" ? "" : "ok");
  if (!(state === "wait" && C.waitShown)) h.querySelector(".hs").textContent = label;
}

function guestList(P) {
  // Everything the guardian named, plus what was running when the console opened.
  const keys = new Map();
  C.baseGuests.forEach(g => keys.set(g.key, g));
  P.guests.forEach((_, k) => { if (!keys.has(k)) keys.set(k, { key: k, name: "", prot: S.protectedIds.has(k) }); });
  return [...keys.values()];
}
function renderGuests(P) {
  const list = guestList(P), host = $("#guests-g");
  list.forEach((g, i) => {
    let chip = host.querySelector(`[data-g="${g.key}"]`);
    if (!chip) {
      chip = document.createElement("div"); chip.className = "gchip" + (g.prot ? " protected" : ""); chip.dataset.g = g.key;
      chip.style.animationDelay = (i * 35) + "ms";
      chip.innerHTML = `<span class="ic"></span><b>${esc(g.key)}${g.name ? " · " + esc(g.name) : ""}</b><small>${g.prot ? "protected" : "running"}</small>`;
      host.appendChild(chip);
    }
    let st = P.guests.get(g.key) || "";
    if (C.done && P.complete && (st === "starting" || st === "stopped")) st = "restored";
    if (C.prevGuest[g.key] === st) return;
    const was = C.prevGuest[g.key]; C.prevGuest[g.key] = st;
    chip.classList.remove("stopping", "stopped", "checked", "starting", "restored", "just-stopped");
    if (st) chip.classList.add(st);
    if ((st === "stopped" || st === "checked") && was !== undefined && !reduce) { void chip.offsetWidth; chip.classList.add("just-stopped"); }
    chip.querySelector("small").textContent = { stopping: "shutting down", stopped: "stopped", checked: "shutdown path checked", starting: "starting", restored: "restored" }[st] || (g.prot ? "protected" : "running");
  });
  const vals = [...P.guests.values()], stopped = vals.filter(v => v === "stopped" || v === "checked").length,
    restored = vals.filter(v => v === "restored").length, total = list.filter(g => !g.prot).length || P.guests.size;
  $("#g-count").textContent = P.restoring ? `${restored} / ${P.starting.length || total} restored` : `${stopped} / ${total} ${P.dry ? "checked" : "stopped"}`;
  C.counts = { stopped, restored, total };
}

function renderLog(lines) {
  const pre = $("#c-log");
  if (lines.length < C.shown) { pre.innerHTML = ""; C.shown = 0; }
  const frag = document.createDocumentFragment();
  for (let i = C.shown; i < lines.length; i++) {
    const raw = String(lines[i]), m = raw.match(/^(\d{4}-\d\d-\d\dT(\d\d:\d\d:\d\d)\S*)\s+(.*)$/), s = document.createElement("span");
    s.textContent = m ? `${m[2]}  ${m[3]}` : raw;
    if (/\[dry-run\]/i.test(raw)) s.className = "dr";
    else if (/---|detected|dispatched \d+|restore complete|power cap active|confirmed|abort/i.test(raw)) s.className = "hl";
    frag.appendChild(s);
  }
  if (lines.length > C.shown) { pre.appendChild(frag); C.shown = lines.length; pre.scrollTop = pre.scrollHeight; }
}
function renderMilestones(P, snap) {
  let items;
  if (snap && snap.timeline && snap.timeline.length && snap.started) items = snap.timeline.map(e => [e.key, e.label, e.ts - snap.started]);
  else items = P.milestones.map(([k, label]) => { if (C.msSeen[k] == null) C.msSeen[k] = Math.round((Date.now() / 1000) - C.t0); return [k, label, C.msSeen[k]]; });
  const host = $("#c-ms"), have = host.children.length / 3;
  if (items.length < have) host.innerHTML = "";
  for (let i = host.children.length / 3; i < items.length; i++)
    host.insertAdjacentHTML("beforeend", `<time>+${clockTime(Math.max(0, items[i][2]))}</time><i></i><span>${esc(items[i][1])}</span>`);
}

function renderStages(P, finished) {
  const n = STAGES[C.mode].length, idx = finished ? n : P.stage;
  $("#st-fill").style.width = Math.min(100, idx / (n - 1) * 100) + "%";
  $$("#st-row .st").forEach((s, k) => { s.classList.toggle("done", k < idx); s.classList.toggle("cur", k === idx); s.querySelector("i").textContent = k < idx ? "✓" : ""; });
  $("#ib-stage").textContent = finished ? "finished" : "guardian: " + STAGES[C.mode][Math.min(P.stage, n - 1)][0].toLowerCase();
}

function renderWait(P) {
  const bar = $("#h-byteme .hbar i");
  if (P.wait && !P.complete) {
    const secs = C.mode === "replay" ? Math.min(P.wait.secs, 6) : P.wait.secs;
    if (C.waitKey !== P.wait.idx) {
      C.waitKey = P.wait.idx; C.waitStart = Date.now(); C.waitSecs = secs;
      bar.style.transition = "none"; bar.style.width = "0"; void bar.offsetWidth; bar.style.transition = `width ${secs}s linear`; bar.style.width = "100%";
    }
    const left = Math.max(0, C.waitSecs - (Date.now() - C.waitStart) / 1000);
    C.waitShown = true; $("#h-byteme .hs").textContent = left > 0 ? `IN ${Math.ceil(left)} s` : "POWERING ON";
  } else C.waitShown = false;
}

function stressOf(P) {
  if (C.done) return 0;
  if (P.dry) return Math.min(40, 8 + P.stage * 8);
  if (P.restoring) { const c = C.counts || {}; return Math.round(60 * (1 - (c.restored || 0) / Math.max(1, P.starting.length || c.total || 1)) + (P.wait ? 18 : 0)); }
  const c = C.counts || {}; return Math.min(100, Math.round(25 + (P.stage >= 1 ? 15 : 0) + 60 * (c.stopped || 0) / Math.max(1, c.total || 1)));
}

function modeledWatts(P) {
  // Replay has no live load, so the trace is modeled from the guardian's steps.
  const base = S.lastLoadW || 280, c = C.counts || {};
  if (P.complete) return base;
  let w = base - (P.hosts.byteme[0] === "off" ? 25 : 0) - (P.hosts.deadlock[0] === "off" ? 35 : 0) - (c.stopped || 0) * 11;
  if (P.hosts.cap[0] === "cap") w = Math.min(w, 130);
  if (P.restoring) w = Math.min(base, 120 + (c.restored || 0) * 13 + (P.hosts.byteme[0] === "on" ? 25 : 0));
  return Math.max(60, w);
}

function renderConsole(snap) {
  const mode = C.mode, lines = snap.lines || [];
  const P = C.parse = parseLines(lines, mode);
  const finished = mode === "outage" ? C.done : (!snap.running && !!snap.finished);
  const ok = finished && (mode === "outage" ? true : snap.exit_code === 0 && (mode !== "dry" || lines.some(l => /\[dry-run\]/i.test(l))));
  if (mode === "real" || mode === "replay") {
    if (snap.phase === "starting") P.stage = 0;
    if (snap.phase === "restore") { P.stage = 4; P.restoring = true; }
  }
  $("#console").classList.toggle("restoring", P.restoring || (finished && ok && mode !== "dry"));
  document.body.classList.toggle("restoring", P.restoring || (finished && ok && mode !== "dry"));
  if (!finished) { const [t, s] = stageText(P, mode); setTitle(t, s); }
  renderStages(P, finished);
  ["byteme", "deadlock", "cap"].forEach(h => hostRow(h, P.hosts[h]));
  renderWait(P);
  renderGuests(P);
  renderLog(lines);
  renderMilestones(P, snap);
  const st = stressOf(P), f = $("#stress"), col = st > 66 ? "#ff6b6b" : st > 33 ? "#f3b64b" : "#3ddc97";
  f.style.width = st + "%"; f.style.background = col; f.style.boxShadow = `0 0 12px ${col}99`; $("#stress-v").textContent = st + "%";
  $("#c-abort").hidden = !(mode === "real" && snap.running && snap.phase === "shutdown");
  $("#c-abort").disabled = !!snap.abort_requested;
  const el = snap.started ? ((snap.finished || Date.now() / 1000) - snap.started) : (Date.now() / 1000 - C.t0);
  $("#c-el").textContent = clockTime(el);
  if (finished && !C.done) finish(ok, snap);
  C.done = C.done || finished;
}

function finish(ok, snap) {
  C.done = true;
  const mode = C.mode, c = C.counts || {}, P = C.parse;
  $("#console").classList.add("finished"); $("#log-meta").textContent = "finished";
  $("#finale").classList.toggle("review", !ok);
  const titles = { dry: ok ? ["Outage plan fully validated", "Every guardian stage completed and no infrastructure state changed."] : ["Simulation needs review", "The trace finished with a warning. Read it before relying on this plan."],
    real: ok ? ["Shutdown and recovery completed", "Every guest is back in its saved state and the remote hosts are on."] : ["Recovery requires attention", "The guardian finished without a clean result. Check the trace and the guests."],
    outage: [P && P.disarmed ? "Back on utility power" : "Recovery complete", P && P.disarmed ? "The guardian was disarmed, so nothing was shut down." : "Utility is back and the guardian restored the saved state."] };
  titles.replay = ok ? ["Replay finished", "That was the last real run, compressed."] : titles.real;
  setTitle(titles[mode][0], titles[mode][1]);
  $("#fin-t").textContent = ok ? (mode === "dry" ? "Everything checks out" : "Recovery complete") : "Needs review";
  $("#fin-s").textContent = ok && mode === "dry" ? " The complete outage plan was validated." : "";
  const shed = P ? ["byteme", "deadlock"].filter(h => P.hosts[h][0] !== "on" || (P.milestones || []).some(m => m[0] === "remote")).length : 0;
  const sum = [[mode === "dry" ? "guests checked" : "guests stopped", c.stopped || 0]];
  if (mode !== "dry") sum.push(["guests restored", c.restored || 0]);
  sum.push(["remote hosts shed", P && P.milestones.some(m => m[0] === "remote") ? 2 : shed]);
  if (C.low < Infinity && mode !== "dry") sum.push(["lowest load", Math.round(C.low) + " W", true]);
  sum.push(["duration", $("#c-el").textContent, true]);
  $("#fin-sum").innerHTML = sum.map(s => `<div>${s[0]}<strong ${s[2] ? "" : `data-to="${s[1]}"`}>${s[2] ? s[1] : 0}</strong></div>`).join("");
  $$("#fin-sum [data-to]").forEach(e => { const to = +e.dataset.to; let v = 0; if (!to) return; const iv = setInterval(() => { v++; e.textContent = Math.min(v, to); if (v >= to) clearInterval(iv); }, 70); });
  if (ok && !reduce) ["#ring1", "#ring2"].forEach(r => { const e = $(r); e.classList.remove("go"); void e.offsetWidth; e.classList.add("go"); });
  $("#c-close").hidden = false; $("#c-min").hidden = true;
  clearInterval(C.timer); C.timer = null;
  if (mode === "outage") setTimeout(endIncident, 4000);
  if (mode === "real") { S.realDone = true; }
  loadEvents();
}

// -- the load trace (canvas)
function drawTrace() {
  const cv = $("#trace"); if (!cv.offsetWidth || !C.open) return;
  if (C.parse) {
    const target = C.mode === "replay" ? modeledWatts(C.parse) : (S.lastLoadW != null ? S.lastLoadW : 0);
    C.watts = C.watts == null ? target : C.watts + (target - C.watts) * .15;
    if (!C.done) C.low = Math.min(C.low, C.watts);
    C.hist.push(C.watts + (C.mode === "replay" ? (Math.random() - .5) * 6 : 0)); if (C.hist.length > 400) C.hist.shift();
    $("#c-w").textContent = Math.round(C.watts) + " W";
    const rated = ((S.status || {}).ups || {}).rated_va || 900;
    $("#c-wsub").textContent = Math.round(100 * C.watts / rated) + `% of ${rated} W` + (C.mode === "replay" ? " · modeled" : C.mode === "dry" ? " · unchanged by a dry run" : "");
  }
  const dpr = devicePixelRatio || 1, W = cv.offsetWidth, H = cv.offsetHeight;
  if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const x = cv.getContext("2d"); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, W, H);
  const col = getComputedStyle($("#console")).getPropertyValue("--mode").trim() || "#f3b64b";
  const peak = Math.max(400, ...C.hist) * 1.05, n = 160, y = v => 12 + (1 - v / peak) * (H - 24);
  x.strokeStyle = "#1b2029"; x.lineWidth = 1;
  for (let k = 0; k <= 4; k++) { const yy = 12 + k * (H - 24) / 4; x.beginPath(); x.moveTo(0, yy); x.lineTo(W, yy); x.stroke(); }
  const h = C.hist.slice(-n); if (h.length < 2) return;
  const px = i => W - (h.length - 1 - i) * (W / (n - 1));
  const path = () => { x.beginPath(); h.forEach((v, i) => i ? x.lineTo(px(i), y(v)) : x.moveTo(px(i), y(v))); };
  path(); x.lineTo(W, H); x.lineTo(px(0), H); x.closePath();
  const grad = x.createLinearGradient(0, 0, 0, H); grad.addColorStop(0, col + "55"); grad.addColorStop(1, col + "00"); x.fillStyle = grad; x.fill();
  path(); x.strokeStyle = col; x.lineWidth = 1.8; x.shadowColor = col; x.shadowBlur = 10; x.stroke(); x.shadowBlur = 0;
  x.fillStyle = "#fff"; x.beginPath(); x.arc(W - 2, y(h[h.length - 1]), 3, 0, 7); x.fill();
}

function baseGuestsNow() {
  return (S.guests || []).filter(g => g.status === "running").map(g => {
    const key = g.type + " " + g.id; return { key, name: g.name || "", prot: S.protectedIds.has(key) };
  }).sort((a, b) => (a.prot - b.prot) || a.key.localeCompare(b.key, undefined, { numeric: true }));
}

function openConsole(mode, frames) {
  clearInterval(C.timer); clearInterval(C.drawT);
  Object.assign(C, { mode, open: true, parse: null, shown: 0, prevGuest: {}, hist: [], watts: null, low: Infinity, started: null, t0: Date.now() / 1000,
    done: false, frames: frames || null, fi: 0, msSeen: {}, waitKey: null, waitShown: false, counts: null, baseGuests: baseGuestsNow(), minimised: false });
  const con = $("#console");
  con.className = "console m-" + (mode === "replay" ? "real" : mode);
  $("#c-mode").textContent = MODE_LABEL[mode];
  $("#st-row").innerHTML = STAGES[mode].map(s => `<div class="st"><i></i><span>${s[0]}<small>${s[1]}</small></span></div>`).join("");
  $("#guests-g").innerHTML = ""; $("#c-log").innerHTML = ""; $("#c-ms").innerHTML = ""; $("#fin-sum").innerHTML = "";
  $("#log-meta").textContent = mode === "replay" ? "replay" : "live";
  $("#c-close").hidden = mode === "real" || mode === "outage"; $("#c-min").hidden = !(mode === "real" || mode === "outage");
  $("#c-abort").hidden = true;
  setTitle({ dry: "Engaging dry-run safety interlocks", real: "Real shutdown test starting", replay: "Replaying the last real run", outage: "Utility power lost" }[mode], "");
  ["byteme", "deadlock"].forEach(h => hostRow(h, ["on", "ON"])); hostRow("cap", ["none", "UNCAPPED"]);
  requestAnimationFrame(() => con.classList.add("open"));
  document.body.style.overflow = "hidden";
  if (mode === "real") showBar("real");
  C.drawT = setInterval(drawTrace, 250);
  const tick = { dry: pollDry, real: pollReal, replay: stepReplay, outage: pollOutage }[mode];
  C.timer = setInterval(tick, { dry: 700, real: 1000, replay: 800, outage: 2000 }[mode]);
  if (mode === "replay") { try { fetch("http://192.0.2.2:8788/replay", { cache: "no-store", mode: "no-cors" }).catch(() => {}); } catch (e) {} }
  tick();
}
function closeConsole() {
  const con = $("#console"); con.classList.remove("open"); document.body.style.overflow = "";
  C.open = false;
  if (C.done || C.mode === "dry" || C.mode === "replay") { clearInterval(C.timer); clearInterval(C.drawT); C.timer = null; }
  if (C.mode === "real" && C.done) hideBar();
}
function minimise() { $("#console").classList.add("mini"); $("#console").classList.remove("open"); document.body.style.overflow = ""; C.minimised = true; }
function restoreConsole() { const con = $("#console"); con.classList.remove("mini"); con.classList.add("open"); document.body.style.overflow = "hidden"; C.open = true; C.minimised = false; }
$("#c-close").addEventListener("click", closeConsole);
$("#c-min").addEventListener("click", minimise);
$("#ib-watch").addEventListener("click", restoreConsole);
document.addEventListener("keydown", e => {
  if (e.key !== "Escape" || !$("#console").classList.contains("open") || document.querySelector(".sheet-bg")) return;
  if (!$("#c-close").hidden) closeConsole(); else if (!$("#c-min").hidden) minimise();
});
$("#c-abort").addEventListener("click", async () => {
  if (!(await ask({ title: "Abort to recovery?", danger: true, ok: "Abort and recover",
    body: "Stops further shutdown steps and starts the restore once the power operations already issued reach a known state." }))) return;
  $("#c-abort").disabled = true;
  try { const d = await post("abort-realtest"); toast(d.message); } catch (e) { toast(e.message, true); $("#c-abort").disabled = false; }
});

async function pollDry() { try { renderConsole(await getJSON("/api/dryrun")); } catch (e) {} }
async function pollReal() { try { C.snap = await getJSON("/api/realtest"); renderConsole(C.snap); } catch (e) {} }
function stepReplay() {
  const f = C.frames; if (!f || !f.length) return;
  renderConsole(f[Math.min(C.fi, f.length - 1)]);
  try { fetch(`http://192.0.2.2:8788/replay/pos?i=${C.fi}&n=${f.length}`, { cache: "no-store", mode: "no-cors" }).catch(() => {}); } catch (e) {}
  if (C.fi < f.length - 1) C.fi++;
}
async function pollOutage() {
  try {
    const d = await getJSON(`/api/guardian/log?since=${Math.floor(C.since)}`);
    C.lines = d.lines || [];
    renderConsole({ lines: C.lines, running: true, started: C.since + 60 });
  } catch (e) {}
}

// ------------------------------------------------------------ incident mode
let incident = false, restoredAt = null;
function showBar(kind) {
  const b = document.body;
  b.classList.add("incident");
  $("#ib-dot").className = "dot pulse " + (kind === "real" ? "bad" : "warn");
  $("#ib-state").textContent = kind === "real" ? "Real outage test running" : "On battery";
  $("#ib-state").style.color = kind === "real" ? "var(--bad)" : "";
}
function hideBar() { document.body.classList.remove("incident", "restoring"); document.title = "byteme2 power"; }
function incidentCheck(u, g) {
  const onBatt = u.connected && !u.online;
  const rt = u.runtime_min != null ? Math.round(u.runtime_min * 60) : null;
  if (rt != null) $("#ib-rt").textContent = clockTime(rt);
  if (onBatt && !incident && !(C.mode === "real" && C.open && !C.done)) {
    incident = true; restoredAt = null;
    const b = document.body;
    if (!reduce) { b.classList.remove("dip"); void b.offsetWidth; b.classList.add("dip"); const sw = $("#sweep"); sw.classList.remove("go"); void sw.offsetWidth; sw.classList.add("go"); }
    scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
    setTimeout(() => { showBar("outage"); document.title = "⚡ On battery · byteme2 power"; }, 350);
    C.since = Date.now() / 1000 - 90;   // include the detection lines just before we noticed
    setTimeout(() => { if (!C.open || C.mode !== "outage") openConsole("outage"); }, 1300);
    loadEvents();
  }
  if (incident && !onBatt && u.connected) {
    if (!restoredAt) { restoredAt = Date.now(); $("#ib-state").textContent = "Utility restored"; $("#ib-dot").className = "dot ok pulse"; document.body.classList.add("restoring"); document.title = "Utility restored · byteme2 power"; }
    const P = C.parse, settled = (g.mode || "standby") === "standby";
    if (C.mode === "outage" && !C.done && settled && (P && (P.complete || P.disarmed || P.stage < 2) || Date.now() - restoredAt > 180000)) { C.done = false; finish(true, {}); }
  }
}
function endIncident() {
  incident = false; closeConsole(); hideBar();
  $("#ib-state").textContent = "On battery"; $("#ib-dot").className = "dot warn pulse";
}

// ---------------------------------------------------------------- replays
function demoFrames() {
  const started = Math.floor(Date.now() / 1000);
  const g = baseGuestsNow().filter(x => !x.prot).map(x => x.key);
  const guests = g.length ? g : ["VM 103", "VM 117", "VM 139", "CT 112", "CT 118"];
  const cts = guests.filter(k => k.startsWith("CT")), vms = guests.filter(k => k.startsWith("VM"));
  const L = [], TL = [{ ts: started, key: "requested", label: "Real recovery test requested" }, { ts: started, key: "preflight", label: "Preflight checks passed" }, { ts: started, key: "shutdown", label: "Real shutdown started" }];
  const frames = []; let off = 0;
  const add = s => L.push(s), ms = (k, l) => TL.push({ ts: started + off, key: k, label: l });
  const push = (phase, fin) => frames.push({ running: !fin, started, finished: fin ? started + off : null, exit_code: fin ? 0 : null, phase, lines: L.slice(), timeline: TL.slice() });
  add("--- SHUTDOWN PHASE ---"); push("shutdown");
  off = 1; add("UPS power failure detected (budget 240s)"); push("shutdown");
  off = 2; add("Remote power-off dispatched in background (pid 4242), not blocking local shutdown"); add("Sending iDRAC soft power-off to 192.0.2.4 via 192.0.2.7"); add("Sending soft power-off to deadlock via BMC 198.51.100.18"); ms("remote", "Remote-host power-off dispatched"); push("shutdown");
  off = 4; guests.forEach(k => add(`${k}: ${k.startsWith("VM") ? "agent responding, shutdown with 60s grace then force" : "shutdown with 45s grace then force"}`)); add(`Dispatched ${guests.length} guest shutdowns in parallel, 236s of budget left`); ms("guests_down", "Parallel guest shutdown dispatched"); push("shutdown");
  guests.forEach((k, i) => { off = 6 + i; add(`${k}: stopped`); if (i === 2) { add("192.0.2.7 confirmed 192.0.2.4 powered off"); add("deadlock confirmed powered off"); } push("shutdown"); });
  off += 1; add("Parallel guest shutdown finished, 208s of budget left"); add("Enabling local power cap at 120W via in-band iLO (hponcfg)"); push("shutdown");
  off += 1; add("Local power cap active"); ms("cap", "Host power cap active"); push("shutdown");
  off += 2; add("--- RESTORE PHASE ---"); add("Utility power restored"); add("Disabling local power cap"); ms("restore", "Automatic restoration started"); push("restore");
  off += 1; add("Local power cap deactivated"); add("Waiting 6s before powering 192.0.2.4 back on"); push("restore"); push("restore"); push("restore"); push("restore"); push("restore"); push("restore");
  off += 6; add("Powering on 192.0.2.4 via 192.0.2.7, attempt 1"); push("restore");
  off += 1; add("192.0.2.4 is powered on"); add("deadlock power-on dispatched in background (pid 4343)"); push("restore");
  [...cts, ...vms].forEach(k => { off += 1; add(`Starting ${k.startsWith("CT") ? "LXC" : "VM"} ${k.split(" ")[1]}`); push("restore"); });
  off += 1; add("deadlock is powered on"); add("Restore complete; cleared power-fail marker"); ms("restored", "Guardian restoration completed"); push("restore");
  off += 1; ms("complete", "Normal operation verified"); push("complete", true);
  return frames;
}
// Rebuild a progressive sequence from a finished real run (as the old UI did).
function framesFromRun(run) {
  const lines = run.lines || [], tl = run.timeline || [], started = run.started;
  if (!started || (!lines.length && !tl.length)) return null;
  const ready = { requested: () => true, preflight: () => true, shutdown: () => true,
    remote: t => t.includes("remote power-off dispatched"), guests_down: t => t.includes("dispatched") && t.includes("guest shutdown"),
    cap: t => t.includes("power cap active") || t.includes("could not activate local power cap") || t.includes("could not set local power cap"),
    restore: t => t.includes("restore phase") || t.includes("starting vm") || t.includes("starting lxc"),
    uncap: t => t.includes("power cap deactivated"), guests_up: t => t.includes("starting vm") || t.includes("starting lxc"), restored: t => t.includes("restore complete") };
  const delta = Math.floor(Date.now() / 1000) - started, steps = Math.min(Math.max(lines.length, tl.length, 1), 45), frames = [];
  for (let s = 0; s < steps; s++) {
    const k = Math.max(1, Math.ceil(lines.length * (s + 1) / steps)), revealed = lines.slice(0, k).map(x => x.replace(/Waiting \d+s before powering/i, "Waiting 6s before powering"));
    const low = revealed.join("\n").toLowerCase(), final = s === steps - 1;
    const phase = final ? (run.exit_code === 0 ? "complete" : "attention") : (ready.restore(low) ? "restore" : "shutdown");
    const timeline = tl.filter(e => (e.key === "complete" || e.key === "attention") ? final : (ready[e.key] ? ready[e.key](low) : true)).map(e => ({ ts: e.ts + delta, key: e.key, label: e.label }));
    frames.push({ running: !final, started: started + delta, finished: final ? ((run.finished || started) + delta) : null, exit_code: final ? run.exit_code : null, phase, lines: revealed, timeline });
    if (!final && low.includes("waiting 6s before powering") && !frames.some(f => f.hold)) for (let r = 0; r < 6; r++) frames.push({ ...frames[frames.length - 1], hold: true });
  }
  return frames;
}

// --------------------------------------------------------------------- boot
function pollStatus() { getJSON("/api/status").then(d => { if (d.ts) renderStatus(d); }).catch(() => { $("#live-dot").className = "dot bad"; $("#live-txt").textContent = "Telemetry interrupted"; }); }
renderLegend();
pollStatus(); loadEnergy(); loadHistory(); loadEvents(); loadSettings();
setInterval(() => { if (!document.hidden || incident) pollStatus(); }, 5000);
setInterval(() => { if (incident || (C.open && C.mode !== "replay")) pollStatus(); }, 2000);
setInterval(loadEnergy, 60000);
setInterval(() => { if (histSeconds === 300 || !document.hidden) loadHistory(); }, 30000);
setInterval(() => { if (histSeconds === 300) loadHistory(); }, 5000);
setInterval(loadEvents, 60000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) { pollStatus(); loadHistory(); } });
showView(location.hash === "#settings" ? "settings" : "dash");
moveInd();
// A run already in progress (another tab started it, or this page was reloaded) reopens its console.
getJSON("/api/realtest").then(d => { if (d.running) openConsole("real"); }).catch(() => {});
getJSON("/api/dryrun").then(d => { if (d.running && !(C.open && C.mode === "real")) openConsole("dry"); }).catch(() => {});
if (location.hash === "#replay" || /[?&]replay=1/.test(location.search)) setTimeout(() => $("#replay-btn").click(), 600);
})();
