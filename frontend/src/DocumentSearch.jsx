import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, FileText, X, Loader2 } from 'lucide-react';
import { api, openAttachment } from './api.js';

/*
 * Searching the contents of uploaded documents.
 *
 * Scanned quotations, tenders and site records are read after upload, so what is searched
 * here is the text inside them, not their filenames. Somebody who remembers a supplier's
 * name but not which of forty scans it appeared in can find it.
 *
 * The results the server returns are already limited to what the person is allowed to see,
 * so nothing here needs to filter further.
 */

const WHERE = {
  project: 'Project', task: 'Task', employee: 'Employee',
  report: 'Daily report', vehicle: 'Vehicle', equipment: 'Equipment'
};

export default function DocumentSearch({ open, onClose }) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState([]);
  const [state, setState] = useState('idle');
  const [note, setNote] = useState('');
  const input = useRef(null);

  useEffect(() => { if (open) input.current?.focus(); }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = event => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  /* Searching on every keystroke would ask the database a question per letter typed. */
  useEffect(() => {
    if (!open) return undefined;
    if (term.trim().length < 3) { setResults([]); setNote(''); setState('idle'); return undefined; }
    setState('searching');
    const timer = setTimeout(async () => {
      try {
        const found = await api(`/uploads/search/documents?q=${encodeURIComponent(term.trim())}`);
        setResults(found.results || []);
        setNote(found.note || '');
        setState('done');
      } catch (error) {
        setNote(error.message);
        setState('done');
      }
    }, 280);
    return () => clearTimeout(timer);
  }, [term, open]);

  if (!open) return null;

  return createPortal(
    <div className="docsearch-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="docsearch" role="dialog" aria-label="Search inside documents">
        <div className="docsearch-field">
          <Search size={18} />
          <input ref={input} value={term} onChange={event => setTerm(event.target.value)}
            placeholder="Search inside scanned documents — a supplier, a reference, an amount" />
          {state === 'searching' && <Loader2 size={16} className="docsearch-spin" />}
          <button type="button" onClick={onClose} aria-label="Close"><X size={17} /></button>
        </div>

        <div className="docsearch-results">
          {term.trim().length < 3 && (
            <p className="docsearch-hint">
              Type at least three characters. This looks inside the documents themselves —
              scanned quotations, tenders and photographs of paperwork — not just their names.
            </p>
          )}
          {state === 'done' && !results.length && term.trim().length >= 3 && (
            <p className="docsearch-hint">{note || `Nothing found for “${term.trim()}”.`}</p>
          )}
          {results.map(row => (
            <button type="button" key={row.id} className="docsearch-hit"
              onClick={() => { openAttachment(row.id).catch(() => {}); onClose(); }}>
              <span className="docsearch-icon"><FileText size={17} /></span>
              <span className="docsearch-body">
                <strong>{row.title || row.filename}</strong>
                <small>{WHERE[row.ownerType] || row.ownerType} · {row.filename}
                  {row.pages ? ` · ${row.pages} page${row.pages === 1 ? '' : 's'}` : ''}
                  {row.source === 'ocr' ? ' · read from a scan' : ''}</small>
                <em>…{row.excerpt?.replace(/\s+/g, ' ').trim()}…</em>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}

/** The control that opens it, sat beside the notification bell. */
export function DocumentSearchButton({ onOpen }) {
  return (
    <button type="button" className="icon-btn" onClick={onOpen}
      title="Search inside documents" aria-label="Search inside documents">
      <Search size={17} />
    </button>
  );
}
