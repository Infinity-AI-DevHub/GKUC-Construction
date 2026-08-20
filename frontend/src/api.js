const TOKEN_KEY = 'gkuc-token';

export const token = {
  get: () => sessionStorage.getItem(TOKEN_KEY),
  set: value => sessionStorage.setItem(TOKEN_KEY, value),
  clear: () => sessionStorage.removeItem(TOKEN_KEY)
};

export const api = async (path, options = {}) => {
  const stored = token.get();
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(stored ? { Authorization: `Bearer ${stored}` } : {}),
      ...options.headers
    }
  });
  if (response.status === 204) return null;
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Request failed');
  return body;
};

export const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
export const patch = (path, body) => api(path, { method: 'PATCH', body: JSON.stringify(body) });

/* Formatting shared across every module so figures read the same way everywhere. */
export const money = value => `LKR ${(Number(value || 0) / 1000000).toFixed(1)}M`;
export const rupees = value => `LKR ${Number(value || 0).toLocaleString('en-LK', { maximumFractionDigits: 0 })}`;
export const initials = name => (name || '?').split(' ').map(part => part[0]).slice(0, 2).join('');
export const shortDate = value => (value ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
/* A date read back from the API arrives as UTC midnight, so it formats in UTC. */
export const inputDate = value => (value ? new Date(value).toISOString().slice(0, 10) : '');

/**
 * "Today" is the user's local calendar day, matching what the server stores. Using
 * toISOString() here would send the UTC day and record work against the wrong date
 * for anyone east of Greenwich during their morning.
 */
const pad = value => String(value).padStart(2, '0');
export const localDate = (date = new Date()) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
export const todayInput = () => localDate();
export const slug = value => String(value || '').toLowerCase().replaceAll(' ', '-').replaceAll('/', '-');

/** Days until a date, used for renewal and deadline copy. */
export const daysUntil = value => Math.ceil((new Date(value) - new Date(todayInput())) / 86400000);
export const dueLabel = value => {
  const remaining = daysUntil(value);
  return remaining < 0 ? `Overdue ${Math.abs(remaining)} days` : `${remaining} days`;
};

/**
 * Uploads a file against a record. Multipart, so the browser sets its own boundary —
 * the JSON content-type header used everywhere else must not be applied here.
 */
export const upload = async (ownerType, ownerId, file, meta = {}) => {
  const form = new FormData();
  form.append('file', file);
  for (const [key, value] of Object.entries(meta)) if (value) form.append(key, value);
  const stored = token.get();
  const response = await fetch(`/api/uploads/${ownerType}/${ownerId}`, {
    method: 'POST',
    headers: stored ? { Authorization: `Bearer ${stored}` } : {},
    body: form
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Upload failed');
  return body;
};

export const del = path => api(path, { method: 'DELETE' });

export const fileSize = bytes => (bytes >= 1048576
  ? `${(bytes / 1048576).toFixed(1)} MB`
  : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * Opens a server-rendered document (a quotation, an invoice) in its own tab, ready to print
 * or save as a PDF.
 *
 * The document endpoint needs the session token, which a plain link cannot carry — so the
 * page is fetched here and handed to the new tab. The tab is opened first, on the click
 * itself, because a browser only trusts a window opened directly from a person's action;
 * opening it after the fetch returns would be blocked as a popup.
 */
export const openDocument = async path => {
  const tab = window.open('', '_blank');
  if (tab) tab.document.write('<p style="font:14px sans-serif;padding:20px">Preparing the document…</p>');
  try {
    const stored = token.get();
    const response = await fetch(`/api${path}`, {
      headers: stored ? { Authorization: `Bearer ${stored}` } : {}
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'That document could not be produced');
    }
    const html = await response.text();
    if (!tab) throw new Error('Allow pop-ups for this site to open the document');
    tab.document.open();
    tab.document.write(html);
    tab.document.close();
  } catch (failure) {
    tab?.close();
    throw failure;
  }
};


/**
 * A note that something in the data has changed.
 *
 * Screens are built from two sources: the bootstrap payload the workspace holds, and lists
 * each panel fetches for itself. A form that creates something refreshes the first, but had
 * no way to tell the second — so a new quotation, tender or retention was saved and then
 * simply did not appear until the page was reloaded. This lets the refresh reach both.
 */
const dataListeners = new Set();

export const onDataChanged = listener => {
  dataListeners.add(listener);
  return () => dataListeners.delete(listener);
};

export const announceDataChanged = () => {
  for (const listener of [...dataListeners]) listener();
};
