import { useEffect, useState } from 'react';
import { api, onDataChanged } from './api.js';

/*
 * The dropdown choices the company maintains.
 *
 * Fetched once and shared, rather than each form asking for itself: nearly every screen
 * needs one list or another, and they change a few times a year. When somebody edits a
 * list the change is announced, so every open form picks it up without a reload.
 */

let cache = null;
let inFlight = null;
const listeners = new Set();

async function load(force) {
  if (cache && !force) return cache;
  if (!inFlight) {
    inFlight = api('/options')
      .then(lists => { cache = lists; return lists; })
      .catch(() => (cache = []))
      .finally(() => { inFlight = null; });
  }
  const lists = await inFlight;
  for (const listener of [...listeners]) listener(lists);
  return lists;
}

export const refreshOptions = () => load(true);
export const clearOptions = () => { cache = null; };

/**
 * The values currently offered for one list, e.g. `useOptions('boq.category')`.
 * Retired values are left out, so a form never offers something no longer in use.
 */
export function useOptions(listKey) {
  const [values, setValues] = useState(() => pick(cache, listKey));

  useEffect(() => {
    let alive = true;
    const update = lists => { if (alive) setValues(pick(lists, listKey)); };
    listeners.add(update);
    load().then(update);
    /* A list edited anywhere else in the system arrives as a data change. */
    const off = onDataChanged(() => load(true));
    return () => { alive = false; listeners.delete(update); off(); };
  }, [listKey]);

  return values;
}

const pick = (lists, listKey) => (lists || [])
  .find(list => list.listKey === listKey)?.values
  .filter(value => value.active)
  .map(value => value.value) || [];

/** Every list, for the screen that manages them. */
export function useOptionLists() {
  const [lists, setLists] = useState(cache || []);
  useEffect(() => {
    let alive = true;
    const update = next => { if (alive) setLists(next); };
    listeners.add(update);
    load().then(update);
    return () => { alive = false; listeners.delete(update); };
  }, []);
  return [lists, () => load(true)];
}
