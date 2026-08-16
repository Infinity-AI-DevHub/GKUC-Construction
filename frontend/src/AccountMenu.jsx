import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, LogOut, ShieldCheck, UserRound } from 'lucide-react';
import { Avatar } from './ui.jsx';

/**
 * The account cluster at the end of the bar.
 *
 * The chevron used to promise a menu that did not exist, and signing out sat in the open
 * as a bare icon beside the alert bell — one tap from being hit by accident. Both now
 * resolve into a single control: the whole cluster is the button, and the menu it opens is
 * where the account actions live, with signing out last and set apart.
 */
export default function AccountMenu({ user, onAccount, onLogout }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = event => { if (!wrap.current?.contains(event.target)) setOpen(false); };
    const onKey = event => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = action => { setOpen(false); action(); };

  return <div className={`account${open ? ' open' : ''}`} ref={wrap}>
    <button type="button" className="account-trigger" aria-expanded={open} aria-haspopup="menu"
      title={`${user.name} — ${user.role}`} onClick={() => setOpen(current => !current)}>
      <Avatar name={user.name} />
      <span className="account-identity">
        <strong>{user.name}</strong>
        <small>{user.role}</small>
      </span>
      <ChevronDown size={15} className="account-chevron" />
    </button>

    {open && (
      <div className="account-menu" role="menu">
        <div className="account-card">
          <Avatar name={user.name} />
          <div>
            <strong>{user.name}</strong>
            <span>{user.email}</span>
            <em><ShieldCheck size={11} />{user.role}</em>
          </div>
        </div>

        <button type="button" role="menuitem" onClick={() => choose(onAccount)}>
          <UserRound size={15} />My account
          <small>Change your password</small>
        </button>

        <button type="button" role="menuitem" className="account-signout" onClick={() => choose(onLogout)}>
          <LogOut size={15} />Sign out
        </button>
      </div>
    )}
  </div>;
}
