import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Bell, CheckCircle2, X, Volume2, VolumeX } from 'lucide-react';
import { playChime, soundMuted, setSoundMuted } from './chime.js';

/*
 * Banner notifications.
 *
 * Rendered through a portal onto the body. The workspace has blurred, stacking surfaces —
 * a backdrop-filter creates a containing block, so a fixed-position banner rendered inside
 * one would be positioned against that panel instead of the window, which is exactly how
 * the gallery lightbox first went wrong.
 */

const ICONS = { Critical: AlertTriangle, Warning: Bell, Info: CheckCircle2 };

/* Long enough to read a two-line message; critical ones stay until dismissed. */
const DWELL_MS = 8000;

export default function Banners({ items, onDismiss, onOpen }) {
  return createPortal(
    <div className="banner-stack" role="region" aria-label="Notifications">
      {items.map(item => <Banner key={item.key} item={item} onDismiss={onDismiss} onOpen={onOpen} />)}
    </div>,
    document.body
  );
}

function Banner({ item, onDismiss, onOpen }) {
  const [leaving, setLeaving] = useState(false);
  const Icon = ICONS[item.severity] || Bell;

  const close = () => {
    setLeaving(true);
    /* Let the exit finish before the node goes, or it vanishes mid-animation. */
    setTimeout(() => onDismiss(item.key), 200);
  };

  useEffect(() => {
    /* Something critical waits for a person; anything else clears itself. */
    if (item.severity === 'Critical') return undefined;
    const timer = setTimeout(close, DWELL_MS);
    return () => clearTimeout(timer);
  }, [item.key, item.severity]);

  return (
    <div className={`banner banner-${(item.severity || 'Info').toLowerCase()}${leaving ? ' banner-leaving' : ''}`}
      role={item.severity === 'Critical' ? 'alert' : 'status'}>
      <span className="banner-icon"><Icon size={19} /></span>
      <div className="banner-body">
        <strong>{item.title}</strong>
        {item.message ? <p>{item.message}</p> : null}
        {onOpen ? <button type="button" className="banner-link" onClick={() => { onOpen(); close(); }}>
          Open the notification centre
        </button> : null}
      </div>
      <button type="button" className="banner-close" onClick={close} aria-label="Dismiss">
        <X size={16} />
      </button>
    </div>
  );
}

/**
 * Holds the banners on screen and rings for them.
 *
 * Capped at four: a burst from the deadline scan could otherwise stack a dozen and bury
 * the screen underneath them. The oldest give way to the newest, and the notification
 * centre keeps all of them regardless.
 */
export function useBanners() {
  const [items, setItems] = useState([]);

  const show = notification => {
    const key = `${notification.id || 'x'}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setItems(current => [...current, { ...notification, key }].slice(-4));
    playChime(notification.severity);
  };

  const dismiss = key => setItems(current => current.filter(item => item.key !== key));
  return { items, show, dismiss };
}

/** The mute control, kept beside the bell so it is where a person looks for it. */
export function SoundToggle() {
  const [muted, setMuted] = useState(soundMuted());
  const toggle = () => {
    const next = !muted;
    setSoundMuted(next);
    setMuted(next);
    if (!next) playChime('Info');   /* confirm it is back on, audibly */
  };
  return (
    <button type="button" className="icon-btn sound-toggle" onClick={toggle}
      title={muted ? 'Alert sound is off' : 'Alert sound is on'}
      aria-label={muted ? 'Turn alert sound on' : 'Turn alert sound off'}>
      {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
    </button>
  );
}
