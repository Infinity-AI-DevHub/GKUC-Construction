/** Only approved generated-document routes may use a temporary browser download ticket. */
const documentPaths = [
  /^\/finance\/expected-outflows\/worksheet\/document$/,
  /^\/purchasing\/orders\/\d+\/document$/,
  /^\/projects\/\d+\/extensions\/\d+\/letter$/,
  /^\/payroll\/\d+\/payslips\/\d+\/document$/,
  /^\/qs\/quotations\/\d+\/document$/,
  /^\/boq\/\d+\/document$/,
  /^\/progress-claims\/\d+\/document$/,
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
  const worksheet=parsed.pathname==='/finance/expected-outflows/worksheet/document';
  if(worksheet&&(['from','to'].some(key=>parsed.searchParams.getAll(key).length!==1||!/^\d{4}-\d{2}-\d{2}$/.test(parsed.searchParams.get(key)))))return null;
  const progress=/^\/progress-claims\/\d+\/document$/.test(parsed.pathname);
  if(parsed.searchParams.has('type')&&(!progress||parsed.searchParams.getAll('type').length!==1||!['application','letter','payment-request','certificate','invoice'].includes(parsed.searchParams.get('type'))))return null;
  if (entries.some(([key]) => !['download', 'preview', 'companyId',...(progress?['type']:[]),...(worksheet?['from','to']:[])].includes(key)) ||
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
