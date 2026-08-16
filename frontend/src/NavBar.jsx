import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';

/**
 * The main navigation, which keeps itself inside the space it is given.
 *
 * Fixed breakpoints cannot do this job here: how many links there are depends on the
 * person's permissions, not on the window. The Managing Director sees twelve, a Store
 * Keeper sees seven, and a role the MD invents tomorrow could see any number in between —
 * so the width at which the bar runs out of room is not knowable in advance. Instead the
 * links are measured against the room actually available, and whatever does not fit moves
 * into a "More" menu.
 *
 * Measuring needs every link laid out, but the overflowing ones are hidden. So a
 * measurement pass reveals them all, reads their widths, and hides them again — all inside
 * one layout effect, before the browser paints, so nothing flickers on screen.
 */
export default function NavBar({ items, activePage, openTasks, onSelect }) {
  const navRef = useRef(null);
  const moreRef = useRef(null);
  const [visibleCount, setVisibleCount] = useState(items.length);
  const [menuOpen, setMenuOpen] = useState(false);

  const measure = useCallback(() => {
    const nav = navRef.current;
    if (!nav) return;

    /* Reveal everything for the duration of the measurement. */
    nav.classList.add('measuring');

    const buttons = [...nav.querySelectorAll('[data-nav-item]')];
    const style = getComputedStyle(nav);
    const gap = parseFloat(style.columnGap || style.gap) || 0;
    const available = nav.clientWidth;

    const widths = buttons.map(button => button.offsetWidth);
    const moreWidth = moreRef.current?.offsetWidth || 0;

    nav.classList.remove('measuring');

    const totalWithGaps = widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, widths.length - 1);
    if (totalWithGaps <= available) { setVisibleCount(items.length); return; }

    /* Something has to move into the menu, so the menu's own width has to fit too. */
    let used = moreWidth + gap;
    let fits = 0;
    for (const width of widths) {
      const next = used + width + (fits ? gap : 0);
      if (next > available) break;
      used = next;
      fits += 1;
    }
    setVisibleCount(Math.max(1, fits));
  }, [items.length]);

  useLayoutEffect(() => {
    measure();
    const nav = navRef.current;
    if (!nav || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    if (nav.parentElement) observer.observe(nav.parentElement);
    return () => observer.disconnect();
  }, [measure, items]);

  /* Fonts land after first paint and change how wide the links are. */
  useEffect(() => {
    if (!document.fonts?.ready) return undefined;
    let live = true;
    document.fonts.ready.then(() => { if (live) measure(); });
    return () => { live = false; };
  }, [measure]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointer = event => { if (!moreRef.current?.contains(event.target)) setMenuOpen(false); };
    const onKey = event => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const overflow = items.slice(visibleCount);
  const activeIsHidden = overflow.some(([name]) => name === activePage);

  useEffect(() => { if (!overflow.length) setMenuOpen(false); }, [overflow.length]);

  const badge = name => (name === 'Tasks' && openTasks > 0 ? <b>{openTasks}</b> : null);

  const choose = name => { onSelect(name); setMenuOpen(false); };

  return <nav ref={navRef}>
    {items.map(([name, Icon], index) => (
      <button
        type="button"
        data-nav-item
        className={`${activePage === name ? 'active' : ''}${index >= visibleCount ? ' nav-overflowed' : ''}`}
        key={name}
        tabIndex={index >= visibleCount ? -1 : undefined}
        aria-hidden={index >= visibleCount || undefined}
        onClick={() => choose(name)}
      >
        <Icon size={18} /><span>{name}</span>{badge(name)}
      </button>
    ))}

    <div className={`nav-more${overflow.length ? '' : ' nav-overflowed'}`} ref={moreRef}>
      <button
        type="button"
        className={`nav-more-button${activeIsHidden ? ' active' : ''}`}
        aria-expanded={menuOpen}
        aria-label={`${overflow.length} more sections`}
        title="More sections"
        onClick={() => setMenuOpen(open => !open)}
      >
        <MoreHorizontal size={18} /><span>More</span>
        {overflow.some(([name]) => name === 'Tasks') && openTasks > 0 && <b>{openTasks}</b>}
      </button>

      {menuOpen && (
        <div className="nav-more-menu" role="menu">
          {overflow.map(([name, Icon]) => (
            <button type="button" role="menuitem" className={activePage === name ? 'active' : ''} key={name}
              onClick={() => choose(name)}>
              <Icon size={16} /><span>{name}</span>{badge(name)}
            </button>
          ))}
        </div>
      )}
    </div>
  </nav>;
}
