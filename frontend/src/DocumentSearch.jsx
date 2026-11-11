import React, {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {Search, FileText, X, Loader2} from 'lucide-react';
import {api, openAttachment, rupeesExact, shortDate} from './api.js';

const types = {
  project:'Project', quotation:'Quotation', boq:'BOQ', invoice:'Invoice',
  retention:'Retention', claim:'Progress claim', supplierBill:'Supplier bill', operatingBill:'Operating bill',
  supplierPayment:'Supplier payment', clientPayment:'Client payment', officePayment:'Office payment', pettyPayment:'Petty cash payment',
  projectPayment:'Direct project payment', siteReport:'Site report',
  vehicle:'Vehicle', fuel:'Fuel record', maintenance:'Vehicle maintenance', vehicleDocument:'Vehicle compliance',
  vehicleRenewal:'Vehicle renewal', scan:'Scanned document'
};
const initialFilters = {type:'',companyId:'',project:'',status:'',from:'',to:''};
const empty = {records:[],scans:[],hasMore:false,page:1};

const getStored = (storage,key,fallback) => {
  try { return JSON.parse(storage.getItem(key)) ?? fallback; }
  catch { return fallback; }
};
const putStored = (storage,key,value) => {
  try { storage.setItem(key,JSON.stringify(value)); } catch {}
};

export default function DocumentSearch({open,onClose,companies=[],onEmployeeSearch,project,userId}) {
  const key='gkuc:search:'+userId+':'+(project?.id||'global');
  const recentKey='gkuc:search-recent:'+userId;
  const savedKey='gkuc:search-filters:'+userId;
  const restored=useRef(getStored(sessionStorage,key,{}));
  const [term,setTerm] = useState(restored.current.term||'');
  const [filters,setFilters] = useState(()=>({...initialFilters,...restored.current.filters}));
  const [saved,setSaved] = useState(()=>getStored(localStorage,savedKey,[]));
  const [saveName,setSaveName] = useState('');
  const [selectedSaved,setSelectedSaved] = useState('');
  const [recent,setRecent] = useState([]);
  const resultsPanel=useRef(null);
  const restorePage=useRef(Math.min(20,restored.current.page||1));
  const restoreScroll=useRef(restored.current.scroll||0);
  const [page,setPage] = useState(1);
  const [found,setFound] = useState(empty);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const input = useRef(null);
  const dialog = useRef(null);
  const text = term.trim();
  const scansOnly = filters.type==='scan';
  const minimum = scansOnly?3:2;
  const ready = text.length>=minimum || (!scansOnly && !text && Boolean(project||Object.values(filters).some(Boolean)));

  useEffect(() => {
    if (!open) return undefined;
    const trigger = document.activeElement;
    input.current?.focus();
    return () => trigger?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = event => {
      if (event.key==='Escape') close();
      if (event.key!=='Tab') return;
      const controls = [...dialog.current.querySelectorAll('button:not(:disabled),input,select')];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement===first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement===last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown',onKey);
    return () => window.removeEventListener('keydown',onKey);
  }, [open,onClose,term,filters,found]);

  useEffect(()=>{
    if (!open || project || !userId) return undefined;
    let active=true;
    const ids=getStored(localStorage,recentKey,[]);
    Promise.all(ids.map(({type,id})=>api(type==='scan'?
      '/uploads/search/documents?attachmentId='+id:'/search?'+new URLSearchParams({type,recordId:id}))
      .then(result=>result.results[0] ? {...result.results[0],type} : null).catch(()=>null)))
      .then(rows=>{if(active) setRecent(rows.filter(Boolean));});
    return ()=>{active=false;};
  },[open,project,userId,recentKey]);

  const remember = () => {
    if (!userId) return;
    const scroll=resultsPanel.current?.scrollTop||0;
    const loaded=found.page||1;
    putStored(sessionStorage,key,{term,filters,page:loaded,scroll});
    restorePage.current=Math.min(20,loaded);
    restoreScroll.current=scroll;
  };
  const close = () => { remember(); onClose(); };
  const resetResults = () => { restorePage.current=1;restoreScroll.current=0;setFound(empty);setPage(1);setError(''); };
  const saveFilter = () => {
    const name=saveName.trim();
    if (!name) return;
    const value={name,term,filters:{...filters,project:filters.project||project?.name||''}};
    const next=[value,...saved.filter(row=>row.name!==name)].slice(0,20);
    putStored(localStorage,savedKey,next);setSaved(next);setSaveName('');setSelectedSaved(name);
  };
  const selectSaved = name => {
    setSelectedSaved(name);
    const match=saved.find(row=>row.name===name);
    if (match) {resetResults();setTerm(match.term);setFilters(match.filters);}
  };
  const removeSaved = () => {
    const next=saved.filter(row=>row.name!==selectedSaved);
    putStored(localStorage,savedKey,next);setSaved(next);setSelectedSaved('');
  };
  const rememberRecent = (type,id) => {
    if (!userId) return;
    const ids=getStored(localStorage,recentKey,[]).filter(row=>row.id!==id||row.type!==type);
    putStored(localStorage,recentKey,[{type,id},...ids].slice(0,6));
  };
  useEffect(() => {
    if (!open) { setPage(1); setFound(empty); setBusy(false); return undefined; }
    if (!ready) { setBusy(false); return undefined; }
    let active = true;
    setBusy(true);
    setError('');
    const timer = setTimeout(async () => {
      const fields = Object.entries(filters).filter(([,value])=>value.trim());
      const params = new URLSearchParams([['q',text],['page',String(page)],...fields]);
      const through=page===1?restorePage.current:1;
      if (through>1) params.set('throughPage',String(through));
      if (project) params.set('projectId',String(project.id));
      const includeScans = text.length>=3 && (scansOnly || (!filters.type && !filters.status));
      const scanParams = new URLSearchParams(params);
      for (const key of ['page','throughPage','type','status']) scanParams.delete(key);
      const [records,scans] = await Promise.allSettled([
        scansOnly ? null : api('/search?' + params),
        includeScans && page===1 ? api('/uploads/search/documents?' + scanParams) : null
      ]);
      if (!active) return;
      setFound(previous => ({
        records:[...(page>1?previous.records:[]),...(records.value?.results||[])],
        scans:page>1?previous.scans:scans.value?.results||[],
        hasMore:Boolean(records.value?.hasMore),page:through>1?through:page
      }));
      setError([records,scans].filter(result=>result.status==='rejected').map(result=>result.reason.message).join(' '));
      setBusy(false);
      if (restoreScroll.current) requestAnimationFrame(()=>{
        if (active && resultsPanel.current) resultsPanel.current.scrollTop=restoreScroll.current;
        restoreScroll.current=0;
      });
      restorePage.current=1;
    },260);
    return () => { active=false; clearTimeout(timer); };
  }, [open,text,filters,page,scansOnly,ready,project]);

  if (!open) return null;
  const update = (key,value) => {
    resetResults();
    setFilters(current=>key==='type'&&value==='scan'?{...current,type:value,status:''}:{...current,[key]:value});
  };
  const openRecord = row => {
    remember();rememberRecent(row.type,row.id);
    history.replaceState({...history.state,siteOpsSearch:{userId,project:project?{id:project.id,name:project.name}:null}},'');
    const company = row.targetCompanyId || row.companyId;
    if (company) localStorage.setItem('gkuc:company-id',String(company));
    window.location.assign(row.path);
  };

  return createPortal(
    <div className="docsearch-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget) close();}}>
      <div ref={dialog} className="docsearch" role="dialog" aria-modal="true" aria-label="Search SiteOps">
        <div className="docsearch-field">
          <Search size={18} />
          <input ref={input} type="search" value={term} maxLength={120} aria-label="Search SiteOps"
            onChange={event=>{resetResults();setTerm(event.target.value);}}
            placeholder="Search by reference, project, client or keyword" />
          {busy && <Loader2 size={16} className="docsearch-spin" aria-label="Searching" />}
          <button type="button" onClick={close} aria-label="Close"><X size={17} /></button>
        </div>
        <div ref={resultsPanel} className="docsearch-results" aria-busy={busy}>
          {project && <p className="docsearch-hint">Records linked to <strong>{project.name}</strong></p>}
          <div className="docsearch-filters">
            <label>Record type<select value={filters.type} onChange={event=>update('type',event.target.value)}>
              <option value="">{project?'All linked records':'All records and scans'}</option>
              {Object.entries(types).filter(([key])=>!project||key!=='project').map(([key,label])=><option key={key} value={key}>{label}</option>)}
            </select></label>
            <>
              <label>Company<select value={filters.companyId} onChange={event=>update('companyId',event.target.value)}>
                <option value="">All companies</option>
                {companies.map(company=><option key={company.id} value={company.id}>{company.name}</option>)}
              </select></label>
              <label>Project<input value={filters.project} maxLength={180} onChange={event=>update('project',event.target.value)} /></label>
              {!scansOnly && <label>Status<input value={filters.status} maxLength={40} onChange={event=>update('status',event.target.value)} /></label>}
              <label>From<input type="date" value={filters.from} onChange={event=>update('from',event.target.value)} /></label>
              <label>To<input type="date" value={filters.to} onChange={event=>update('to',event.target.value)} /></label>
            </>
            {onEmployeeSearch && <button type="button" className="secondary" onClick={()=>{close();onEmployeeSearch();}}>Search employee register</button>}
          </div>
          {userId && <div className="docsearch-filters">
            <label>Saved filters<select value={selectedSaved} onChange={event=>selectSaved(event.target.value)}>
              <option value="">Choose saved filter</option>{saved.map(row=><option key={row.name}>{row.name}</option>)}
            </select></label>
            {selectedSaved && <button type="button" className="secondary" onClick={removeSaved}>Remove saved filter</button>}
            <label>Save this search as<input value={saveName} maxLength={60} onChange={event=>setSaveName(event.target.value)}/></label>
            <button type="button" className="secondary" disabled={!saveName.trim()||!ready} onClick={saveFilter}>Save filter</button>
          </div>}
          {!text && !project && !!recent.length && <section className="docsearch-recent">
            <h3>Recently opened</h3>
            {recent.map(row=><button key={row.type+'-'+row.id} type="button" className="docsearch-hit" onClick={()=>{
              if(row.type==='scan'){rememberRecent('scan',row.id);openAttachment(row.id);close();}
              else openRecord(row);
            }}>{row.reference||row.title||row.filename} · {types[row.type]}</button>)}
          </section>}
          {!ready && <p className="docsearch-hint">{scansOnly?'Enter at least three characters.':'Enter at least two characters or choose a filter.'}</p>}
          {error && <p className="docsearch-hint" role="alert">{error}</p>}
          {!busy && !error && ready && !found.records.length && !found.scans.length &&
            <p className="docsearch-hint">{text ? `No matches for “${text}”.` : 'No linked records found.'}</p>}
          {found.records.map(row=><button type="button" key={row.type+'-'+row.id} className="docsearch-hit" onClick={()=>openRecord(row)}>
            <span className="docsearch-icon"><FileText size={17} /></span>
            <span className="docsearch-body">
              <strong>{[row.reference,row.title!==row.reference&&row.title].filter(Boolean).join(' · ')}</strong>
              <small>{[types[row.type],row.version!=null&&'Version '+row.version,row.company,row.status,row.amount!=null&&rupeesExact(row.amount),row.recordDate&&shortDate(row.recordDate)].filter(Boolean).join(' · ')}</small>
              <small>{[row.project!==row.title&&row.project,row.client].filter(Boolean).join(' · ')}</small>
            </span>
          </button>)}
          {found.hasMore && <button type="button" className="secondary docsearch-more" disabled={busy}
            onClick={()=>setPage(found.page+1)}>Load more records</button>}
          {found.scans.map(row=><button type="button" key={'scan-'+row.id} className="docsearch-hit"
            onClick={()=>{rememberRecent('scan',row.id);openAttachment(row.id);close();}}>
            <span className="docsearch-icon"><FileText size={17} /></span>
            <span className="docsearch-body">
              <strong>{row.title||row.filename}</strong>
              <small>{['Scanned document',row.filename,row.company,row.project,row.recordDate&&shortDate(row.recordDate)].filter(Boolean).join(' · ')}</small>
              {row.excerpt && <em>…{row.excerpt.replace(/\s+/g,' ').trim()}…</em>}
            </span>
          </button>)}
        </div>
      </div>
    </div>, document.body
  );
}

export function DocumentSearchButton({onOpen}) {
  return <button type="button" className="icon-btn" onClick={onOpen} title="Search SiteOps" aria-label="Search SiteOps">
    <Search size={17} />
  </button>;
}
