fetch('/api/selfclaw/v1/stats').then(r=>r.json()).then(d=>{
  var count = d.tokensDeployed||0;
  if(count>=1){
    document.querySelectorAll('[data-gate]').forEach(el=>{el.style.display=''});
  }
  if(count>=3){
    document.querySelectorAll('[data-gate-footer]').forEach(el=>{el.style.display=''});
  }
}).catch(()=>{});
