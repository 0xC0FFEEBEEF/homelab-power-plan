/* Guardian disarm switch: POST /api/settings/disarm {minutes}; state from /api/status guardian.disarmed_until. */
(function(){
  var card=document.getElementById('guardianMode'); if(!card) return; card=card.closest('.card');
  var box=document.createElement('div'); box.className='disarm';
  box.innerHTML='<label class="dz-switch"><input type="checkbox" id="dzToggle"><i></i></label>'+
    '<div class="dz-text"><b id="dzTitle">Armed</b><span id="dzSub">A power failure will shut guests down</span></div>'+
    '<select id="dzMins" title="Disarm window"><option value="10">10 min</option><option value="20">20 min</option><option value="30" selected>30 min</option><option value="60">60 min</option></select>';
  card.querySelector('.section-head').insertAdjacentElement('afterend',box);
  var tog=box.querySelector('#dzToggle'), title=box.querySelector('#dzTitle'), sub=box.querySelector('#dzSub'), mins=box.querySelector('#dzMins');
  var until=null, busy=false;
  function fmt(s){s=Math.max(0,s|0); return Math.floor(s/60)+':'+('0'+s%60).slice(-2);}
  function paint(){
    var left=until?until-Date.now()/1000:0, off=left>0;
    box.classList.toggle('off',off); tog.checked=off; mins.disabled=off;
    title.textContent=off?'Disarmed · re-arms in '+fmt(left):'Armed';
    sub.textContent=off?'Power failures are ignored (low battery still shuts down)':'A power failure will shut guests down';
  }
  function post(m){
    busy=true; var token=''; try{token=sessionStorage.getItem('upsAdminToken')||'';}catch(e){}
    fetch('/api/settings/disarm',{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Token':token},body:JSON.stringify({minutes:m})})
      .then(function(r){return r.json();}).then(function(d){ if(d.error){alertBox(d.error);} else {until=m?Date.now()/1000+m*60:null;} })
      .catch(function(){alertBox('Request failed');}).then(function(){busy=false; paint(); tick();});
  }
  function alertBox(msg){ sub.textContent=msg; }
  tog.addEventListener('change',function(){ post(tog.checked?parseInt(mins.value,10):0); });
  function tick(){ if(busy) return; fetch('/api/status',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){ until=(d.guardian||{}).disarmed_until||null; paint(); }).catch(function(){}); }
  tick(); setInterval(tick,5000); setInterval(paint,1000);
})();
