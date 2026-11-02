/* Energy & cost card: reads /api/energy (energy.py), settings via POST /api/settings/energy. Independent of app.js. */
(function(){
  var anchor=document.querySelector('.servers-card'); if(!anchor) return;
  var card=document.createElement('section'); card.className='card energy-card';
  card.innerHTML='<div class="section-head"><div><span class="eyebrow">ENERGY &amp; COST</span><h3>Billing cycle</h3></div>'+
    '<div class="en-head-right"><span class="pill neutral" id="enRate">—</span><button class="text-btn" id="enEdit">Settings</button></div></div>'+
    '<form class="en-form" id="enForm" hidden></form><div class="en-tiles" id="enTiles"></div>'+
    '<div class="en-bars-wrap"><div class="en-bars" id="enBars"></div><div class="en-axis" id="enAxis"></div><div class="en-tip" id="enTip"></div></div>'+
    '<div class="en-servers" id="enServers"></div><div class="en-notes" id="enNotes"></div>'+
    '<details class="en-hist"><summary>All cycles</summary><table id="enHist"></table></details>';
  anchor.parentNode.insertBefore(card,anchor);
  var $=function(id){return card.querySelector('#'+id);}, data=null, last={};
  var MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function d(s){var p=s.split('-');return MON[+p[1]-1]+' '+(+p[2]);}
  function money(v){return v==null?'—':'$'+v.toFixed(2);}
  function kwh(v){return v==null?'—':(v>=100?v.toFixed(0):v.toFixed(1))+' kWh';}
  function el(t,c,x){var n=document.createElement(t); if(c) n.className=c; if(x!=null) n.textContent=x; return n;}
  function bump(node,key,text){ if(last[key]!==undefined&&last[key]!==text){node.classList.remove('kpi-bump');void node.offsetWidth;node.classList.add('kpi-bump');} last[key]=text; node.textContent=text; }
  function tile(key,label,big,lines,extra){
    var t=el('article','en-tile'+(extra?' '+extra:'')); t.appendChild(el('span','en-label',label));
    var b=el('strong'); bump(b,key,big); t.appendChild(b); lines.forEach(function(l){ if(l) t.appendChild(typeof l==='string'?el('small',null,l):l); }); return t;
  }
  function draw(){
    var e=data, cf=e.config, cur=e.cycles[0], prev=e.cycles[1];
    $('enRate').textContent='$'+cf.rate.toFixed(4)+'/kWh · resets on the '+cf.cycle_day+ordinal(cf.cycle_day);
    var tiles=$('enTiles'), first=!tiles.firstChild; tiles.innerHTML='';
    var prog=el('div','en-prog'); var fill=el('i'); fill.style.width=Math.min(100,100*cur.elapsed_days/cur.days)+'%'; prog.appendChild(fill);
    tiles.appendChild(tile('cur','THIS CYCLE · '+d(cur.start)+' – '+d(cur.end),money(cur.cost),
      [kwh(cur.kwh)+' so far · avg '+(cur.avg_w||'—')+' W', prog, 'Day '+cur.elapsed_days+' of '+cur.days+' · projected '+money(cur.projected_cost)+' ('+kwh(cur.projected_kwh)+')'],'en-now'));
    if(prev){ var partial=prev.measured_days<prev.days-0.5;
      tiles.appendChild(tile('prev','LAST CYCLE · '+d(prev.start)+' – '+d(prev.end),partial?money(prev.projected_cost):money(prev.cost),
        [partial?'Estimated full cycle: measured '+prev.measured_days+' of '+prev.days+' days ('+money(prev.cost)+', '+kwh(prev.kwh)+')':kwh(prev.kwh)+' · avg '+(prev.avg_w||'—')+' W',
         partial?'avg '+(prev.avg_w||'—')+' W → '+kwh(prev.projected_kwh):null, prev.est?'Load read as % before Sep 20 (±5 W)':null])); }
    var td=e.today;
    tiles.appendChild(tile('today','TODAY · '+td.hours_elapsed+' h in',money(td.cost),
      [kwh(td.kwh)+' · avg '+(td.avg_w||'—')+' W', 'Full day at this rate '+money(td.projected_cost)+' · cycle average '+money(cur.cost/Math.max(1,cur.measured_days))+'/day']));
    if(!first) Array.prototype.forEach.call(tiles.children,function(n){n.style.animation='none';});
    // daily bars
    var bars=$('enBars'), axis=$('enAxis'); bars.innerHTML=''; axis.innerHTML='';
    var max=Math.max.apply(null,e.daily.map(function(x){return x.kwh||0;}).concat([0.1]));
    e.daily.forEach(function(x,i){
      var c=el('div','en-bar'+(x.cycle?' '+x.cycle:'')+(x.est?' est':'')+(i===e.daily.length-1?' today':''));
      var f=el('i'); f.style.height=(x.kwh?Math.max(2,100*x.kwh/max):0)+'%'; if(first) f.style.animationDelay=(i*12)+'ms'; c.appendChild(f);
      if(i>0&&x.cycle!==e.daily[i-1].cycle&&x.cycle) c.classList.add('edge');
      c.dataset.tip=d(x.day)+': '+(x.kwh==null?'no data':kwh(x.kwh)+' · '+money(x.kwh*cf.rate)+(x.hours<23.5&&x.kwh!=null?' · '+x.hours+' h measured':'')+(x.est?' · from %':''));
      bars.appendChild(c);
      axis.appendChild(el('span',null,(i%7===0||i===e.daily.length-1)?d(x.day):''));
    });
    // servers this cycle
    var sv=$('enServers'); sv.innerHTML='';
    if(e.servers.length){ sv.appendChild(el('span','en-label','SERVER BMCS THIS CYCLE (BOTH PSUS, SINCE '+(e.psu_from?d(e.psu_from).toUpperCase():'—')+')'));
      var row=el('div','en-srv-row'); e.servers.forEach(function(s){ var v=cur.servers[s]||0; var b=el('div','en-srv'); b.appendChild(el('b',null,s)); var st=el('span'); bump(st,'srv'+s,kwh(v)+' · '+money(v*cf.rate)); b.appendChild(st); row.appendChild(b);}); sv.appendChild(row); }
    // notes
    var n=$('enNotes'); n.innerHTML='';
    var unmapped=e.servers.filter(function(s){return e.surge_mapped.indexOf(s)<0;});
    if(unmapped.length) n.appendChild(el('p','warn','Surge-side PSU not known yet for '+unmapped.join(', ')+', so their surge-outlet draw is not in the total. It is learned automatically the next time the UPS runs on battery, or set it under Settings.'));
    var lr=e.config.surge_learned||{}, ls=Object.keys(lr).filter(function(k){return e.config.surge_psus[k];});
    if(ls.length) n.appendChild(el('p',null,'Surge-side PSUs learned while the UPS was on battery: '+ls.map(function(k){return k+' '+e.config.surge_psus[k]+' ('+new Date(lr[k]*1000).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+')';}).join(', ')+'.'));
    if(e.psu_from) n.appendChild(el('p',null,'Totals are UPS output plus each server\'s surge-side PSU. Before '+d(e.psu_from)+' only the UPS outlets were metered.'));
    // history
    var h=$('enHist'); h.innerHTML='<tr><th>Cycle</th><th>kWh</th><th>Cost</th><th>Avg W</th><th>Measured</th></tr>';
    e.cycles.forEach(function(c){ var r=el('tr'); [d(c.start)+' – '+d(c.end),kwh(c.kwh),money(c.cost),c.avg_w||'—',c.measured_days+' / '+c.days+' d'].forEach(function(v){r.appendChild(el('td',null,String(v)));}); h.appendChild(r); });
  }
  function ordinal(n){return (n%10===1&&n!==11)?'st':(n%10===2&&n!==12)?'nd':(n%10===3&&n!==13)?'rd':'th';}
  function form(){
    var cf=data.config, f=$('enForm'); f.innerHTML='';
    function field(label,input){var l=el('label'); l.appendChild(el('span',null,label)); l.appendChild(input); f.appendChild(l); return input;}
    var rate=field('Rate $/kWh',el('input')); rate.type='number'; rate.step='0.0001'; rate.value=cf.rate;
    var day=field('Cycle starts on day',el('input')); day.type='number'; day.min=1; day.max=28; day.value=cf.cycle_day;
    var sel={}; data.servers.forEach(function(s){ var x=el('select'); x.appendChild(new Option('unknown','')); (cf.psus[s]||[]).forEach(function(p){x.appendChild(new Option(p,p));}); x.value=cf.surge_psus[s]||''; sel[s]=field(s+' surge-side PSU',x); });
    var save=el('button','text-btn','Save'); save.type='submit'; f.appendChild(save); var msg=el('span','en-msg'); f.appendChild(msg);
    f.onsubmit=function(ev){ ev.preventDefault(); var m={}; Object.keys(sel).forEach(function(s){ if(sel[s].value) m[s]=sel[s].value; });
      var token=''; try{token=sessionStorage.getItem('upsAdminToken')||'';}catch(e){}
      fetch('/api/settings/energy',{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Token':token},body:JSON.stringify({rate:parseFloat(rate.value),cycle_day:parseInt(day.value,10),surge_psus:m})})
        .then(function(r){return r.json();}).then(function(r){ msg.textContent=r.error||'Saved'; if(!r.error) load(); }).catch(function(){msg.textContent='Request failed';}); };
  }
  $('enEdit').onclick=function(){ var f=$('enForm'); f.hidden=!f.hidden; if(!f.hidden&&data) form(); };
  var tip=$('enTip');
  $('enBars').addEventListener('mousemove',function(ev){ var b=ev.target.closest('.en-bar'); if(!b){tip.style.opacity=0;return;} tip.textContent=b.dataset.tip; tip.style.opacity=1;
    var r=this.getBoundingClientRect(); tip.style.left=Math.min(r.width-180,Math.max(0,ev.clientX-r.left-90))+'px'; });
  $('enBars').addEventListener('mouseleave',function(){tip.style.opacity=0;});
  function load(){ fetch('/api/energy',{cache:'no-store'}).then(function(r){return r.json();}).then(function(e){data=e; draw();}).catch(function(){}); }
  load(); setInterval(load,60000);
})();
