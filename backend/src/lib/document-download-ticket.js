/** Only generated commercial documents may use a temporary browser download ticket. */
const documentPaths = [
  /^\/qs\/quotations\/\d+\/document$/,
  /^\/boq\/\d+\/document$/,
  /^\/receivables\/invoices\/\d+\/document$/,
  /^\/receivables\/receipts\/\d+\/document$/,
  /^\/employees\/\d+\/letters\/(?:probation|one-year)\/document$/,
  /^\/qs\/tenders\/(?:\d+|blank)\/commitments\/document$/
];

export function canonicalDocumentDownloadPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.length > 700)
    return null;
  let parsed;
  try { parsed = new URL(value, 'https://siteops.invalid'); } catch { return null; }
  if (parsed.origin !== 'https://siteops.invalid' || parsed.hash || !documentPaths.some(pattern => pattern.test(parsed.pathname)))
    return null;
  const entries = [...parsed.searchParams.entries()];
  if (entries.some(([key]) => !['download', 'preview', 'companyId'].includes(key)) ||
      Number(parsed.searchParams.getAll('download').length === 1 && parsed.searchParams.get('download') === 'pdf') +
        Number(parsed.searchParams.getAll('preview').length === 1 && parsed.searchParams.get('preview') === 'pdf') !== 1 ||
      parsed.searchParams.getAll('companyId').length > 1 ||
      (parsed.searchParams.has('companyId') && !/^\d+$/.test(parsed.searchParams.get('companyId')))) return null;
  parsed.searchParams.sort();
  return `${parsed.pathname}?${parsed.searchParams.toString()}`;
}

export function pathFromTicketRequest(originalUrl) {
  const parsed = new URL(originalUrl, 'https://siteops.invalid');
  const ticket = parsed.searchParams.get('downloadTicket');
  if (parsed.searchParams.getAll('downloadTicket').length !== 1) return { ticket: null, path: null };
  parsed.searchParams.delete('downloadTicket');
  return { ticket, path: canonicalDocumentDownloadPath(parsed.pathname.replace(/^\/api/, '') + parsed.search) };
}
