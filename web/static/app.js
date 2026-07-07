const resources = ["pods","deployments","services","jobs","cronjobs","configmaps","secrets","events"];
let es = null;
let currentCluster = null;
let currentResource = null;

// store objects by uid for O(1) updates
const rowsByUid = new Map();
let rowsSorted = [];
let ageTicker = null;

async function fetchContexts(){
  const res = await fetch('/api/contexts');
  const data = await res.json();
  // normalize to array of {name, namespace}
  return data.map(d => ({name: d.name || d, namespace: d.namespace || 'default'}));
}

function formatAge(ts){
  if(!ts) return '-';
  const then = new Date(ts);
  const diff = Math.floor((Date.now()-then.getTime())/1000);
  if(diff < 60) return `${diff}s`;
  if(diff < 3600) return `${Math.floor(diff/60)}m`;
  return `${Math.floor(diff/3600)}h`;
}

function rebuildSorted(){
  rowsSorted = Array.from(rowsByUid.values()).sort((a,b)=>{
    const na = (a.metadata && a.metadata.namespace)||'';
    const nb = (b.metadata && b.metadata.namespace)||'';
    if(na < nb) return -1; if(na>nb) return 1;
    const aName = (a.metadata && a.metadata.name)||'';
    const bName = (b.metadata && b.metadata.name)||'';
    return aName.localeCompare(bName);
  });
}

function renderTable(){
  const container = document.getElementById('listview');
  if(rowsSorted.length===0){ container.innerHTML = '<p>(no objects yet)</p>'; return; }
  let html = '<table><thead><tr><th>Name</th><th>Namespace</th><th>Event</th><th>Age</th><th>Last Seen</th></tr></thead><tbody>';
  rowsSorted.forEach((it, idx)=>{
    const meta = it.metadata || {};
    const name = meta.name || '';
    const ns = meta.namespace || '';
    const ev = it._event || '';
    const last = it._lastSeen ? new Date(it._lastSeen).toLocaleTimeString() : '-';
    const age = formatAge(meta.creationTimestamp);
    html += `<tr data-uid="${meta.uid||idx}" class="event-${ev.toLowerCase()}"><td>${name}</td><td>${ns}</td><td>${ev}</td><td>${age}</td><td>${last}</td></tr>`;
  });
  html += '</tbody></table>';
  container.innerHTML = html;
  document.querySelectorAll('#listview tbody tr').forEach(tr=>{
    tr.addEventListener('click', ()=>{
      const uid = tr.getAttribute('data-uid');
      const obj = rowsByUid.get(uid);
      document.getElementById('details').textContent = JSON.stringify(obj, null, 2);
    });
  });
}

function notifyStatus(msg, level='info'){
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = level;
}

function handleEvent(data){
  if(data.error){
    notifyStatus(data.error, 'error');
    return;
  }
  if(data.info){
    notifyStatus(data.info, 'info');
    return;
  }
  const obj = data.object;
  if(!obj || !obj.metadata) return;
  const uid = obj.metadata.uid || (obj.metadata.name+"/"+(obj.metadata.namespace||''));
  const evType = (data.type||'MODIFIED');
  if(evType === 'DELETED'){
    if(rowsByUid.has(uid)){
      rowsByUid.delete(uid);
      rebuildSorted();
      renderTable();
    }
    return;
  }
  // ADDED or MODIFIED
  const stored = rowsByUid.get(uid) || {};
  obj._event = evType;
  obj._lastSeen = Date.now();
  rowsByUid.set(uid, obj);
  rebuildSorted();
  renderTable();
}

function connect(cluster, resource){
  if(es){ es.close(); es=null; }
  rowsByUid.clear();
  rowsSorted = [];
  notifyStatus('connecting...', 'info');
  const url = `/sse/${encodeURIComponent(cluster)}/${encodeURIComponent(resource)}`;
  es = new EventSource(url);

  es.onopen = ()=>{ notifyStatus('connected', 'ok'); };
  es.onmessage = (ev)=>{
    try{
      const data = JSON.parse(ev.data);
      handleEvent(data);
    }catch(e){
      console.error('invalid event', e, ev.data);
    }
  };
  es.onerror = (err)=>{
    console.error('sse error', err);
    notifyStatus('connection error — reconnecting', 'error');
  };

  // age ticker
  if(ageTicker) clearInterval(ageTicker);
  ageTicker = setInterval(()=>{ if(rowsSorted.length>0){ renderTable(); } }, 1000);
}

window.addEventListener('load', async ()=>{
  const ctxs = await fetchContexts();
  const clusterSel = document.getElementById('cluster');
  ctxs.forEach(c=>{ const opt = document.createElement('option'); opt.value = c.name; opt.textContent = `${c.name} (ns: ${c.namespace})`; opt.dataset.ns = c.namespace; clusterSel.appendChild(opt); });
  const resSel = document.getElementById('resource');
  resources.forEach(r=>{ const opt=document.createElement('option'); opt.value=r; opt.textContent=r; resSel.appendChild(opt); });
  // set defaults
  if(clusterSel.options.length>0) clusterSel.selectedIndex = 0;
  if(resSel.options.length>0) resSel.selectedIndex = 0;

  document.getElementById('open').addEventListener('click', ()=>{
    currentCluster = clusterSel.value;
    currentResource = resSel.value;
    connect(currentCluster, currentResource);
    document.getElementById('open').disabled = true;
    document.getElementById('close').disabled = false;
  });
  document.getElementById('close').addEventListener('click', ()=>{
    if(es){ es.close(); es=null; }
    if(ageTicker) clearInterval(ageTicker);
    document.getElementById('open').disabled = false;
    document.getElementById('close').disabled = true;
    notifyStatus('disconnected', 'info');
  });
});
