/* Server PSU card: reads /api/status "servers" (iLO / iDRAC via psu-telemetry), independent of app.js. */
(function(){
  var host=document.getElementById('servers'); if(!host) return;
  var last={}, SURGE={};
  var BMC={byteme2:"https://ilo/",byteme:"https://idrac/",deadlock:"http://DCMI001E67D74FF0/"};
  function el(t,c,x){var n=document.createElement(t); if(c) n.className=c; if(x!=null) n.textContent=x; return n;}
  function w(v){return v==null?'—':Math.round(v)+' W';}
  function set(node,key,text){ if(last[key]!==undefined&&last[key]!==text){node.classList.remove('bump');void node.offsetWidth;node.classList.add('bump');} last[key]=text; node.textContent=text; }
  function ago(sec){ return sec<90?sec+' s':sec<5400?Math.round(sec/60)+' min':sec<172800?Math.round(sec/3600)+' h':Math.round(sec/86400)+' d'; }
  function shortDate(s){ if(!s) return ''; var m=s.match(/^(\d\d)\/(\d\d)\/(\d{4})/); return m?(m[3]+'-'+m[1]+'-'+m[2]):s; }
  function card(sv){
    var d=sv.data||{}, age=sv.fetched?Math.round(Date.now()/1000-sv.fetched):null;
    var c=el('article','srv'+((!sv.ok||age>90)?' stale':''));
    var head=el('div','srv-head'); var h=el('h4',null,sv.name); var m=el('small',null,d.model||'');
    // Three states, never inferred from stale data: BMC silent, host powered off (BMC on standby), or running.
    var off=sv.ok&&(sv.chassis||d.chassis)==='off', red, chip;
    if(!sv.ok){ red='BMC unreachable'; chip=el('span','chip bad','BMC UNREACHABLE'); }
    else if(off){ red='powered off'; chip=el('span','chip warn','POWERED OFF'); }
    else { red=d.redundancy||''; chip=el('span','chip'+(/fully/i.test(red)?'':' warn'),(red||'—').toUpperCase()); }
    if(off) c.classList.add('off');
    var left=el('div'); left.appendChild(h); left.appendChild(document.createTextNode(' ')); left.appendChild(m); head.appendChild(left); var right=el("div","srv-right"); if(BMC[sv.name]){var l=el("a","srv-link","BMC console \u2197"); l.href=BMC[sv.name]; l.target="_blank"; l.rel="noopener"; right.appendChild(l);} right.appendChild(chip); head.appendChild(right); c.appendChild(head);
    var p=d.power||{}; var tot=el('div','srv-total'); var big=el('strong'); set(big,sv.name+'now',w(p.now_w)); tot.appendChild(big);
    tot.appendChild(el('span',null,!sv.ok?'last known':off?'standby draw':'drawing now')); c.appendChild(tot);
    if(!sv.ok) c.appendChild(el('div','srv-state bad','No answer from the BMC'+(age!=null?' · last reading '+ago(age)+' ago':' · never read')+' — figures below are from then'));
    else if(off) c.appendChild(el('div','srv-state warn','Host powered off · BMC on standby'));
    c.appendChild(el('div','srv-sub','BMC window: min '+w(p.min_w)+' · avg '+w(p.avg_w)+' · max '+w(p.max_w)+(age!=null&&sv.ok?' · read '+age+'s ago':'')+(sv.error?' · '+sv.error:'')));
    var psus=d.psus||[], sum=psus.reduce(function(a,x){return a+(x.watts||0);},0)||1;
    psus.forEach(function(x){
      var row=el('div','psu'); var standby=(x.watts||0)<15;
      var nb=el('b',null,x.name), sp=SURGE[sv.name]; if(sp){ var bat=sp!==x.name; nb.appendChild(el('span','psu-role '+(bat?'bat':'surge'),bat?'BATTERY':'SURGE')); } row.appendChild(nb);
      var bar=el('div','psu-bar'+(standby?' standby':'')); var fill=el('i'); fill.style.width=Math.max(2,Math.round(100*(x.watts||0)/sum))+'%'; bar.appendChild(fill); row.appendChild(bar);
      var val=el('span','val'); var vw=el('span'); set(vw,sv.name+x.name,w(x.watts)); val.appendChild(vw);
      var extra=[]; if(x.amps!=null) extra.push(x.amps.toFixed(1)+' A'); if(x.volts!=null) extra.push(Math.round(x.volts)+' V'); if(x.load_pct!=null) extra.push(Math.round(x.load_pct)+' % load'); if(x.temp_c!=null) extra.push(Math.round(x.temp_c)+' \u00b0C'); if((standby&&!x.amps)||x.state==='standby') extra.push('standby'); if(!x.ok&&sv.ok) extra.push('FAULT');
      if(extra.length) val.appendChild(el('small',null,extra.join(' · '))); row.appendChild(val); c.appendChild(row);
    });
    var e=d.energy;
    if(e){ var g=el('div','srv-energy');
      [['ENERGY',(e.kwh!=null?e.kwh.toFixed(1)+' kWh':'—'),'since '+shortDate(e.since)],['PEAK POWER',w(e.peak_w),shortDate(e.peak_w_at)],['PEAK CURRENT',(e.peak_a!=null?e.peak_a.toFixed(1)+' A':'—'),shortDate(e.peak_a_at)]].forEach(function(f){
        var b=el('div'); b.appendChild(el('span',null,f[0])); var s=el('strong'); set(s,sv.name+f[0],f[1]); b.appendChild(s); b.appendChild(el('small',null,f[2])); g.appendChild(b); });
      c.appendChild(g); }
    return c;
  }
  function draw(list){
    var order={byteme2:0,byteme:1,deadlock:2}; list.sort(function(a,b){return (a.name in order?order[a.name]:9)-(b.name in order?order[b.name]:9);});
    var frag=document.createDocumentFragment(); list.forEach(function(s){frag.appendChild(card(s));});
    var first=!host.firstChild; host.innerHTML=''; host.appendChild(frag);
    if(!first) Array.prototype.forEach.call(host.children,function(n){n.style.animation='none';});
    if(!list.length) host.appendChild(el('div','srv-sub','Waiting for the first BMC reading (every 15 s)…'));
  }
  function tick(){ fetch('/api/status',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){SURGE=d.surge_psus||{}; draw(d.servers||[]);}).catch(function(){}); }
  tick(); setInterval(tick,5000);
})();
