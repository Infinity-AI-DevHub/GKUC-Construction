import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Eye, EyeOff, GripVertical, Move, PaintBucket, RotateCcw, Save, Type, Undo2, Redo2
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
  const [piece, setPiece] = useState(null);
  const [preview, setPreview] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /* The index being dragged is held in a ref as well as in state: state updates on the next
     render, and a quick drag can fire dragover before that lands — which drops the move. */
  const [dragging, setDragging] = useState(null);
  const draggingRef = useRef(null);

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

  /* The design as it stands, for handlers that run outside React's render. */
  const live = useRef(design);
  live.current = design;

  /* Every hook must run on every render, so this sits above the early return below. */
  const midDrag = useRef(false);

  /**
   * Makes the page itself the canvas: blocks are selected by clicking, and the pieces of the
   * letterhead are dragged and resized directly where they sit.
   *
   * The work happens against the frame's own document because the preview is same-origin,
   * so a drag can be followed at the pointer rather than guessed at from outside.
   */
  const onFrameLoad = event => {
    const frame = event.target.contentDocument;
    if (!frame) return;

    for (const node of frame.querySelectorAll('[data-block]')) {
      node.style.cursor = 'pointer';
      node.addEventListener('click', clicked => {
        if (clicked.target.closest('[data-piece]')) return;
        clicked.stopPropagation();
        setSelected(node.getAttribute('data-block'));
        setPiece(null);
      });
    }

    const band = frame.querySelector('.head');

    for (const node of frame.querySelectorAll('[data-piece]')) {
      const id = node.getAttribute('data-piece');
      node.style.cursor = 'move';

      /* A handle on the trailing edge widens or narrows the piece. */
      const handle = frame.createElement('i');
      handle.className = 'piece-handle';
      node.appendChild(handle);

      const start = down => {
        down.preventDefault();
        down.stopPropagation();
        setSelected(null);
        setPiece(id);

        const resizing = down.target === handle;
        const bandBox = band.getBoundingClientRect();
        /* Where the pointer started, and where the piece started — kept apart, because one
           is measured in screen pixels and the other in percent across the band. */
        const grabbedAt = { x: down.clientX, y: down.clientY };
        const from = { ...live.current.header.elements.find(item => item.id === id) };

        const moveTo = at => {
          const dx = ((at.clientX - grabbedAt.x) / bandBox.width) * 100;
          const dy = at.clientY - grabbedAt.y;
          if (resizing) {
            const width = Math.min(100 - from.x, Math.max(5, from.width + dx));
            /* Applied to the element as well as to the design: the page is redrawn a moment
               after the last adjustment, and the piece should not lag behind the pointer
               until then. */
            node.style.width = `${width}%`;
            setPieceValue(id, { width: Math.round(width * 10) / 10 });
          } else {
            const x = Math.min(100 - from.width, Math.max(0, from.x + dx));
            const y = Math.min(live.current.header.height - 12, Math.max(0, from.y + dy));
            node.style.left = `${x}%`;
            node.style.top = `${y}px`;
            setPieceValue(id, { x: Math.round(x * 10) / 10, y: Math.round(y) });
          }
        };

        const stop = () => {
          frame.removeEventListener('pointermove', moveTo);
          frame.removeEventListener('pointerup', stop);
          frame.removeEventListener('pointercancel', stop);
        };
        frame.addEventListener('pointermove', moveTo);
        frame.addEventListener('pointerup', stop);
        frame.addEventListener('pointercancel', stop);
      };

      node.addEventListener('pointerdown', start);
    }

    const style = frame.createElement('style');
    style.textContent = `
      [data-block]:hover{outline:2px dashed ${design.accent}55;outline-offset:3px}
      [data-block="${selected}"]{outline:2px solid ${design.accent};outline-offset:3px}
      [data-piece]{outline:1px dashed transparent;outline-offset:2px}
      [data-piece]:hover{outline-color:${design.accent}88}
      [data-piece="${piece}"]{outline:2px solid ${design.accent};outline-offset:2px}
      .piece-handle{position:absolute;right:-5px;top:50%;transform:translateY(-50%);
        width:10px;height:22px;border-radius:3px;background:${design.accent};
        opacity:0;cursor:ew-resize}
      [data-piece]:hover .piece-handle,[data-piece="${piece}"] .piece-handle{opacity:1}
      .head{outline:1px dashed ${design.accent}44;outline-offset:4px}`;
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

  /*
   * A drag produces a stream of changes; only the first is recorded so that one undo takes
   * back the whole movement rather than a single pixel of it.
   */
  const setPieceValue = (id, patch) => {
    const record = !midDrag.current;
    midDrag.current = true;
    clearTimeout(setPieceValue.timer);
    setPieceValue.timer = setTimeout(() => { midDrag.current = false; }, 400);
    change(current => ({
      ...current,
      header: {
        ...current.header,
        elements: current.header.elements.map(item => (item.id === id ? { ...item, ...patch } : item))
      }
    }), { record });
  };

  const addTextBox = () => change(current => ({
    ...current,
    header: {
      ...current.header,
      elements: [...current.header.elements, {
        id: `text:${Date.now()}`, custom: true, text: 'New text', show: true,
        x: 5, y: 10, width: 30, size: 12, colour: '#111111', weight: 400, align: 'left'
      }]
    }
  }));

  const selectedPiece = piece ? design.header.elements.find(item => item.id === piece) : null;
  const pieceLabel = id => (catalogue.pieces?.find(p => p.id === id)?.label
    || (String(id).startsWith('text:') ? 'Text box' : id));

  /* Placement belongs to the block, so it travels with it when the order changes. */
  const place = (id, key, value) => change(current => ({
    ...current,
    blocks: current.blocks.map(block => (block.id === id ? { ...block, [key]: value } : block))
  }));

  const placement = selected ? design.blocks.find(block => block.id === selected) : null;

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
            onDragStart={event => {
              draggingRef.current = index;
              setDragging(index);
              /* Firefox refuses to start a drag unless something is carried. */
              event.dataTransfer?.setData('text/plain', block.id);
              if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => { draggingRef.current = null; setDragging(null); }}
            onDragOver={event => {
              event.preventDefault();
              const from = draggingRef.current;
              if (from !== null && from !== index) {
                move(from, index);
                draggingRef.current = index;
                setDragging(index);
              }
            }}
            onDrop={event => { event.preventDefault(); draggingRef.current = null; setDragging(null); }}
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
        <h3>{piece ? pieceLabel(piece) : selected ? labels[selected] || selected : 'Page & palette'}</h3>

        {selectedPiece && <>
          <Slider label="Across" value={selectedPiece.x} min={0} max={100 - selectedPiece.width} step={0.5} suffix="%"
            onChange={value => setPieceValue(piece, { x: value })} />
          <Slider label="Down" value={selectedPiece.y} min={0} max={Math.max(0, design.header.height - 12)} suffix="px"
            onChange={value => setPieceValue(piece, { y: value })} />
          <Slider label="Width" value={selectedPiece.width} min={5} max={100 - selectedPiece.x} step={0.5} suffix="%"
            onChange={value => setPieceValue(piece, { width: value })} />
          <Slider label={selectedPiece.id === 'logo' ? 'Logo height' : 'Text size'} value={selectedPiece.size}
            min={6} max={90} suffix="px" onChange={value => setPieceValue(piece, { size: value })} />
          {selectedPiece.id !== 'logo' && <>
            <Colour label="Colour" value={selectedPiece.colour}
              onChange={value => setPieceValue(piece, { colour: value })} />
            <Choice label="Weight" value={String(selectedPiece.weight)}
              options={[['400', 'Regular'], ['600', 'Medium'], ['700', 'Bold'], ['800', 'Heavy']]}
              onChange={value => setPieceValue(piece, { weight: Number(value) })} />
          </>}
          <Choice label="Align" value={selectedPiece.align}
            options={[['left', 'Left'], ['centre', 'Centre'], ['right', 'Right']]}
            onChange={value => setPieceValue(piece, { align: value })} />
          {selectedPiece.custom && <label className="design-field">
            <span>Words</span>
            <input value={selectedPiece.text}
              onChange={event => setPieceValue(piece, { text: event.target.value })} />
          </label>}
          <Choice label="Shown" value={selectedPiece.show ? 'yes' : 'no'}
            options={[['yes', 'Shown'], ['no', 'Hidden']]}
            onChange={value => setPieceValue(piece, { show: value === 'yes' })} />
          <button className="status-button designer-clear" onClick={() => setPiece(null)}>
            <Type size={13} />Back to page &amp; palette
          </button>
        </>}

        {placement && <>
          <h4><Move size={13} /> Position</h4>
          <Slider label="Space above" value={placement.space} min={-20} max={80} suffix="px"
            onChange={value => place(selected, 'space', value)} />
          <Choice label="Align" value={placement.align}
            options={[['left', 'Left'], ['centre', 'Centre'], ['right', 'Right']]}
            onChange={value => place(selected, 'align', value)} />
        </>}

        {selected === 'letterhead' && <>
          <p className="designer-hint">
            Drag anything in the letterhead straight on the page; the handle on its edge
            changes its width.
          </p>
          <Slider label="Band height" value={design.header.height} min={60} max={320} suffix="px"
            onChange={value => set('header.height', value)} />
          <Choice label="Rule beneath" value={design.header.rule ? 'yes' : 'no'}
            options={[['yes', 'Shown'], ['no', 'Hidden']]}
            onChange={value => set('header.rule', value === 'yes')} />
          <Choice label="Show logo" value={design.logo.show ? 'yes' : 'no'}
            options={[['yes', 'Shown'], ['no', 'Hidden']]}
            onChange={value => set('logo.show', value === 'yes')} />
          <button className="status-button designer-clear" onClick={addTextBox}>
            <Type size={13} />Add a text box
          </button>
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

        {!selected && !piece && <>
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

          <h4><Move size={13} /> Page margins</h4>
          <Slider label="Top" value={design.page.margins.top} min={3} max={60} suffix="mm"
            onChange={value => set('page.margins.top', value)} />
          <Slider label="Bottom" value={design.page.margins.bottom} min={3} max={40} suffix="mm"
            onChange={value => set('page.margins.bottom', value)} />
          <Slider label="Left" value={design.page.margins.left} min={3} max={40} suffix="mm"
            onChange={value => set('page.margins.left', value)} />
          <Slider label="Right" value={design.page.margins.right} min={3} max={40} suffix="mm"
            onChange={value => set('page.margins.right', value)} />

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
