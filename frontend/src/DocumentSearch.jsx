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

export default function DocumentSearch({open,onClose,companies=[],onEmployeeSearch,project}) {
  const [term,setTerm] = useState('');
  const [filters,setFilters] = useState(initialFilters);
  const [page,setPage] = useState(1);
  const [found,setFound] = useState(empty);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const input = useRef(null);
  const dialog = useRef(null);
  const text = term.trim();
  const scansOnly = filters.type==='scan';
  const minimum = scansOnly?3:2;
  const ready = text.length>=minimum || (!scansOnly && Boolean(project) && !text);

  useEffect(() => {
    if (!open) return undefined;
    const trigger = document.activeElement;
    input.current?.focus();
    return () => trigger?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = event => {
      if (event.key==='Escape') onClose();
      if (event.key!=='Tab') return;
      const controls = [...dialog.current.querySelectorAll('button:not(:disabled),input,select')];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement===first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement===last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown',onKey);
    return () => window.removeEventListener('keydown',onKey);
  }, [open,onClose]);

  useEffect(() => {
    if (!open) { setPage(1); setFound(empty); setBusy(false); return undefined; }
    if (!ready) { setBusy(false); return undefined; }
    let active = true;
    setBusy(true);
    setError('');
    const timer = setTimeout(async () => {
      const fields = Object.entries(filters).filter(([,value])=>value.trim());
      const params = new URLSearchParams([['q',text],['page',String(page)],...fields]);
      if (project) params.set('projectId',String(project.id));
      const includeScans = text.length>=3 && (scansOnly || (!filters.type && !filters.status));
      const scanParams = new URLSearchParams(params);
      for (const key of ['page','type','status']) scanParams.delete(key);
      const [records,scans] = await Promise.allSettled([
        scansOnly ? null : api('/search?' + params),
        includeScans && page===1 ? api('/uploads/search/documents?' + scanParams) : null
      ]);
      if (!active) return;
      setFound(previous => ({
        records:[...(page>1?previous.records:[]),...(records.value?.results||[])],
        scans:page>1?previous.scans:scans.value?.results||[],
        hasMore:Boolean(records.value?.hasMore),page
      }));
      setError([records,scans].filter(result=>result.status==='rejected').map(result=>result.reason.message).join(' '));
      setBusy(false);
    },260);
    return () => { active=false; clearTimeout(timer); };
  }, [open,text,filters,page,scansOnly,ready,project]);

  if (!open) return null;
  const update = (key,value) => {
    setFound(empty); setPage(1); setError('');
    setFilters(current=>key==='type'&&value==='scan'?{...current,type:value,status:''}:{...current,[key]:value});
  };
  const openRecord = row => {
    const company = row.targetCompanyId || row.companyId;
    if (company) localStorage.setItem('gkuc:company-id',String(company));
    window.location.assign(row.path);
  };

  return createPortal(
    <div className="docsearch-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget) onClose();}}>
      <div ref={dialog} className="docsearch" role="dialog" aria-modal="true" aria-label="Search SiteOps">
        <div className="docsearch-field">
          <Search size={18} />
          <input ref={input} type="search" value={term} maxLength={120} aria-label="Search SiteOps"
            onChange={event=>{setFound(empty);setPage(1);setError('');setTerm(event.target.value);}}
            placeholder="Search by reference, project, client or keyword" />
          {busy && <Loader2 size={16} className="docsearch-spin" aria-label="Searching" />}
          <button type="button" onClick={onClose} aria-label="Close"><X size={17} /></button>
        </div>
        <div className="docsearch-results" aria-busy={busy}>
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
            {onEmployeeSearch && <button type="button" className="secondary" onClick={()=>{onClose();onEmployeeSearch();}}>Search employee register</button>}
          </div>
          {!ready && <p className="docsearch-hint">Enter at least {minimum} characters.</p>}
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
            onClick={()=>{openAttachment(row.id);onClose();}}>
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
