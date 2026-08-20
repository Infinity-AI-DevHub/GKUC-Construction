import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Eye, EyeOff, GripVertical, PaintBucket, RotateCcw, Save, Type, Undo2, Redo2
} from 'lucide-react';
import { api, token } from './api.js';

/**
 * A visual editor for the documents GKUC sends out.
 *
 * The page in the middle is the real renderer, not an impression of it — the same code that
 * produces the quotation a client receives. So what is arranged here is what arrives, and
 * there is no second layout to keep in step.
 *
 * Blocks are dragged into order and switched on and off; clicking one on the page selects
 * it. Free placement was deliberately not used: these documents paginate, and an element
 * pinned to a coordinate would sit in the wrong place the moment a bill ran onto a second
 * page. Order and styling survive that; absolute positions do not.
 */

const SWATCHES = ['#16305c', '#0f2f4f', '#8a1538', '#1f6f4a', '#7a4b12', '#3c3c46', '#111111', '#ffffff'];

/** A colour control: swatches for speed, a picker for anything else, hex for exactness. */
function Colour({ label, value, onChange }) {
  return <label className="design-field">
    <span>{label}</span>
    <div className="colour-row">
      <input type="color" value={value} onChange={event => onChange(event.target.value)} aria-label={label} />
      <input className="hex" value={value} spellCheck="false"
        onChange={event => {
          const next = event.target.value.trim();
          if (/^#[0-9a-fA-F]{0,6}$/.test(next)) onChange(next);
        }}
        onBlur={event => { if (!/^#[0-9a-fA-F]{6}$/.test(event.target.value)) onChange(value); }} />
    </div>
    <div className="swatches">
      {SWATCHES.map(swatch => (
        <button type="button" key={swatch} style={{ background: swatch }} title={swatch}
          className={swatch.toLowerCase() === String(value).toLowerCase() ? 'on' : ''}
          onClick={() => onChange(swatch)} />
      ))}
    </div>
  </label>;
}

function Slider({ label, value, min, max, step = 1, suffix = '', onChange }) {
  return <label className="design-field">
    <span>{label}<b>{value}{suffix}</b></span>
    <input type="range" min={min} max={max} step={step} value={value}
      onChange={event => onChange(Number(event.target.value))} />
  </label>;
}

function Choice({ label, value, options, onChange }) {
  return <label className="design-field">
    <span>{label}</span>
    <div className="choice">
      {options.map(option => {
        const [id, text] = Array.isArray(option) ? option : [option, option];
        return <button type="button" key={id} className={id === value ? 'on' : ''}
          onClick={() => onChange(id)}>{text}</button>;
      })}
    </div>
  </label>;
}

export default function DocumentDesigner({ can }) {
  const [design, setDesign] = useState(null);
  const [catalogue, setCatalogue] = useState({ blocks: [], fonts: [], defaults: null });
  const [selected, setSelected] = useState(null);
  const [preview, setPreview] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(null);

  /* Every change is kept so it can be walked back — a design is fiddled with, not filled in. */
  const history = useRef({ past: [], future: [] });

  useEffect(() => {
    api('/document-design')
      .then(body => { setDesign(body.design); setCatalogue(body); })
      .catch(failure => setError(failure.message));
  }, []);

  const change = useCallback((next, { record = true } = {}) => {
    setDesign(current => {
      if (record && current) { history.current.past.push(current); history.current.future = []; }
      return typeof next === 'function' ? next(current) : next;
    });
    setStatus('');
  }, []);

  const undo = () => {
    const { past, future } = history.current;
    if (!past.length) return;
    setDesign(current => { future.push(current); return past.pop(); });
  };
  const redo = () => {
    const { past, future } = history.current;
    if (!future.length) return;
    setDesign(current => { past.push(current); return future.pop(); });
  };

  /* The page is redrawn by the real renderer, a moment after the last adjustment. */
  useEffect(() => {
    if (!design) return undefined;
    const timer = setTimeout(async () => {
      try {
        const stored = token.get();
        const response = await fetch('/api/document-design/preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(stored ? { Authorization: `Bearer ${stored}` } : {}) },
          body: JSON.stringify({ design })
        });
        setPreview(await response.text());
      } catch (failure) { setError(failure.message); }
    }, 280);
    return () => clearTimeout(timer);
  }, [design]);

  /* Clicking a block on the page selects it, the way one would expect of a canvas. */
  const onFrameLoad = event => {
    const frame = event.target.contentDocument;
    if (!frame) return;
    for (const node of frame.querySelectorAll('[data-block]')) {
      node.style.cursor = 'pointer';
      node.addEventListener('click', clicked => {
        clicked.stopPropagation();
        setSelected(node.getAttribute('data-block'));
      });
    }
    const style = frame.createElement('style');
    style.textContent = `[data-block]:hover{outline:2px dashed ${design.accent}66;outline-offset:3px}
      [data-block="${selected}"]{outline:2px solid ${design.accent};outline-offset:3px}`;
    frame.head.appendChild(style);
  };

  const labels = useMemo(
    () => Object.fromEntries(catalogue.blocks.map(block => [block.id, block.label])), [catalogue.blocks]);
  const fixed = useMemo(
    () => new Set(catalogue.blocks.filter(block => block.fixed).map(block => block.id)), [catalogue.blocks]);

  if (!design) return <p className="empty-state">{error || 'Loading the designer…'}</p>;

  const move = (from, to) => change(current => {
    const blocks = [...current.blocks];
    const [lifted] = blocks.splice(from, 1);
    blocks.splice(to, 0, lifted);
    return { ...current, blocks };
  });

  const toggle = id => change(current => ({
    ...current,
    blocks: current.blocks.map(block => (block.id === id ? { ...block, show: !block.show } : block))
  }));

  const set = (path, value) => change(current => {
    const next = structuredClone(current);
    const keys = path.split('.');
    let target = next;
    while (keys.length > 1) target = target[keys.shift()];
    target[keys[0]] = value;
    return next;
  });

  const save = async () => {
    setBusy(true); setError(''); setStatus('');
    try {
      await api('/document-design', { method: 'PUT', body: JSON.stringify({ design }) });
      setStatus('Saved. Every document uses this design from here on.');
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  };

  const reset = () => { if (catalogue.defaults) change(structuredClone(catalogue.defaults)); };

  return <section className="designer">
    <header className="designer-bar">
      <div>
        <h2>Document designer</h2>
        <small>Arrange the page. What you see is what the client receives.</small>
      </div>
      <div className="designer-actions">
        <button className="status-button" onClick={undo} disabled={!history.current.past.length} title="Undo">
          <Undo2 size={14} />Undo
        </button>
        <button className="status-button" onClick={redo} disabled={!history.current.future.length} title="Redo">
          <Redo2 size={14} />Redo
        </button>
        <button className="status-button" onClick={reset}><RotateCcw size={14} />Reset</button>
        <button className="primary" onClick={save} disabled={busy || !can.manage}>
          <Save size={15} />{busy ? 'Saving…' : 'Save design'}
        </button>
      </div>
    </header>

    {error && <p className="form-error">{error}</p>}
    {status && <p className="form-success">{status}</p>}

    <div className="designer-body">
      <aside className="designer-blocks">
        <h3>Blocks</h3>
        <p className="designer-hint">Drag to reorder. Click one on the page to style it.</p>
        {design.blocks.map((block, index) => (
          <div
            key={block.id}
            className={`design-block${selected === block.id ? ' selected' : ''}${block.show ? '' : ' hidden'}${dragging === index ? ' dragging' : ''}`}
            draggable
            onDragStart={() => setDragging(index)}
            onDragEnd={() => setDragging(null)}
            onDragOver={event => {
              event.preventDefault();
              if (dragging !== null && dragging !== index) { move(dragging, index); setDragging(index); }
            }}
            onClick={() => setSelected(block.id)}
          >
            <GripVertical size={14} className="grip" />
            <span>{labels[block.id] || block.id}</span>
            <button type="button" className="eye" title={block.show ? 'Hide from the document' : 'Show on the document'}
              disabled={fixed.has(block.id)}
              onClick={event => { event.stopPropagation(); toggle(block.id); }}>
              {block.show ? <Eye size={14} /> : <EyeOff size={14} />}
            </button>
          </div>
        ))}
      </aside>

      <div className="designer-canvas">
        <iframe title="Document preview" srcDoc={preview} onLoad={onFrameLoad} />
      </div>

      <aside className="designer-properties">
        <h3>{selected ? labels[selected] || selected : 'Page & palette'}</h3>

        {selected === 'letterhead' && <>
          <Choice label="Logo position" value={design.logo.align}
            options={[['left', 'Left'], ['centre', 'Centre'], ['right', 'Right']]}
            onChange={value => set('logo.align', value)} />
          <Slider label="Logo size" value={design.logo.height} min={20} max={120} suffix="px"
            onChange={value => set('logo.height', value)} />
          <Choice label="Show logo" value={design.logo.show ? 'yes' : 'no'}
            options={[['yes', 'Shown'], ['no', 'Hidden']]}
            onChange={value => set('logo.show', value === 'yes')} />
          <Colour label="Heading colour" value={design.type.headingColour}
            onChange={value => set('type.headingColour', value)} />
        </>}

        {selected === 'table' && <>
          <Colour label="Header background" value={design.table.headerBackground}
            onChange={value => set('table.headerBackground', value)} />
          <Colour label="Header text" value={design.table.headerText}
            onChange={value => set('table.headerText', value)} />
          <Colour label="Grid lines" value={design.table.border}
            onChange={value => set('table.border', value)} />
          <Colour label="Alternate row" value={design.table.stripe}
            onChange={value => set('table.stripe', value)} />
          <Slider label="Text size" value={design.table.fontSize} min={7} max={14} step={0.5} suffix="px"
            onChange={value => set('table.fontSize', value)} />
          <Slider label="Cell padding" value={design.table.padding} min={2} max={14} suffix="px"
            onChange={value => set('table.padding', value)} />
        </>}

        {selected === 'totals' && <>
          <Colour label="Total bar" value={design.totals.barBackground}
            onChange={value => set('totals.barBackground', value)} />
          <Colour label="Total text" value={design.totals.barText}
            onChange={value => set('totals.barText', value)} />
        </>}

        {!['letterhead', 'table', 'totals'].includes(selected) && <>
          <Colour label="Accent" value={design.accent} onChange={value => set('accent', value)} />
          <Colour label="Body text" value={design.type.colour} onChange={value => set('type.colour', value)} />
          <Colour label="Headings" value={design.type.headingColour}
            onChange={value => set('type.headingColour', value)} />
          <Colour label="Paper" value={design.page.background} onChange={value => set('page.background', value)} />
          <Choice label="Typeface" value={design.type.font}
            options={catalogue.fonts.map(font => [font.id, font.label])}
            onChange={value => set('type.font', value)} />
          <Slider label="Base text size" value={design.type.size} min={8} max={16} step={0.5} suffix="px"
            onChange={value => set('type.size', value)} />
          <Choice label="Paper size" value={design.page.size} options={['A4', 'Letter']}
            onChange={value => set('page.size', value)} />
          <Slider label="Page margin" value={design.page.margin} min={5} max={30} suffix="mm"
            onChange={value => set('page.margin', value)} />

          <h4><PaintBucket size={13} /> Watermark</h4>
          <label className="design-field">
            <span>Text (leave blank for none)</span>
            <input value={design.watermark.text} placeholder="e.g. DRAFT"
              onChange={event => set('watermark.text', event.target.value)} />
          </label>
          {design.watermark.text && <>
            <Colour label="Watermark colour" value={design.watermark.colour}
              onChange={value => set('watermark.colour', value)} />
            <Slider label="Size" value={design.watermark.size} min={20} max={200} suffix="px"
              onChange={value => set('watermark.size', value)} />
            <Slider label="Opacity" value={design.watermark.opacity} min={0} max={0.6} step={0.02}
              onChange={value => set('watermark.opacity', value)} />
            <Slider label="Angle" value={design.watermark.rotate} min={-90} max={90} suffix="°"
              onChange={value => set('watermark.rotate', value)} />
          </>}
        </>}

        {selected && <button className="status-button designer-clear" onClick={() => setSelected(null)}>
          <Type size={13} />Back to page &amp; palette
        </button>}
      </aside>
    </div>
  </section>;
}
