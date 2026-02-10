fetch('/api/selfclaw/v1/stats').then(r=>r.json()).then(d=>{
  if((d.tokensDeployed||0)>=1){
    document.querySelectorAll('[data-gate]').forEach(el=>{el.style.display=''});
  }
}).catch(()=>{});
