import { readPdfText } from './boq-pdf.js';
import { extractText } from './ocr.js';

const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const number = value => {
  const match = String(value || '').match(/[\d,]+(?:\.\d{1,2})?/);
  return match ? Number(match[0].replace(/,/g, '')) : 0;
};
const date = value => {
  const match = String(value || '').match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b|\b(\d{1,2})[./-](\d{1,2})[./-]((?:19|20)\d{2})\b/);
  if (!match) return '';
  const [, year, month, day, otherDay, otherMonth, otherYear] = match;
  const result = `${otherYear || year}-${String(otherMonth || month).padStart(2, '0')}-${String(otherDay || day).padStart(2, '0')}`;
  const parsed = new Date(`${result}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result ? '' : result;
};
const labeled = (lines, labels) => {
  const pattern = new RegExp(`^(?:${labels})\\s*[:–-]\\s*(.+)$`, 'i');
  return lines.map(clean).map(line => line.match(pattern)?.[1]).find(Boolean) || '';
};

export function parseTenderText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const meaningful = lines.map(clean).filter(Boolean);
  const title = labeled(lines, 'name of (?:work|contract)|title|project|work(?:s)?')
    || meaningful.find(line => /(?:construction|improvement|rehabilitation|resurfacing|supply of)/i.test(line)) || '';
  const clientName = labeled(lines, 'employer|client|procuring entity|inviting authority|purchaser')
    || meaningful.find(line => /(?:road development authority|department of|municipal council|provincial council)/i.test(line)) || '';
  const contractNo = labeled(lines, 'contract (?:no\.?|number)|bid (?:no\.?|number)|tender (?:no\.?|number)|reference (?:no\.?|number)');
  const closingLine = labeled(lines, 'bid(?:ding)? closing(?: date| deadline)?|deadline(?: for submission)?|closing date|submission deadline')
    || meaningful.find(line => /(?:bids? (?:shall )?(?:close|be submitted)|deadline for submission)/i.test(line)) || '';
  const docsFrom = date(labeled(lines, 'documents? (?:available|on sale) from|sale starts'));
  const docsUntil = date(labeled(lines, 'documents? (?:available|on sale) (?:until|to)|sale ends'));
  const closingDate = date(closingLine);
  const timeMatch = closingLine.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*(a\.?m\.?|p\.?m\.?)?/i);
  let hour = timeMatch ? Number(timeMatch[1]) : 10;
  if (timeMatch?.[3]) { if (/p/i.test(timeMatch[3]) && hour < 12) hour += 12; if (/a/i.test(timeMatch[3]) && hour === 12) hour = 0; }
  const closingTime = `${String(hour).padStart(2, '0')}:${timeMatch?.[2] || '00'}`;
  const validityDays = number(labeled(lines, 'bid validity|validity of bid|valid for')) || 91;
  const securityLine = labeled(lines, 'bid security(?: amount)?|security amount');
  const securityAmount = number(securityLine);
  const securityForm = /insurance/i.test(securityLine) ? 'Insurance bond' : /cash/i.test(securityLine) ? 'Cash deposit'
    : /not required|not applicable|none/i.test(securityLine) ? 'Not required' : 'Bank guarantee';
  const procurementLine = labeled(lines, 'procurement method|method of procurement');
  const procurementMethod = /international/i.test(procurementLine) ? 'International Competitive Bidding'
    : /shopping/i.test(procurementLine) ? 'Shopping' : /direct/i.test(procurementLine) ? 'Direct' : 'National Competitive Bidding';
  const specialtyLine = `${title} ${labeled(lines, 'specialty|speciality|category')}`;
  const specialty = /bridge/i.test(specialtyLine) ? 'Bridges' : /building/i.test(specialtyLine) ? 'Buildings'
    : /irrigation/i.test(specialtyLine) ? 'Irrigation' : /water supply/i.test(specialtyLine) ? 'Water Supply'
      : /road|highway|resurfacing/i.test(specialtyLine) ? 'Highways' : 'Other';
  const grade = labeled(lines, 'cida grade|grade required|registration grade');
  const warnings = [];
  if (!title) warnings.push('Works title was not found. Enter it from the bidding document.');
  if (!clientName) warnings.push('Employer was not identified. Select or create the correct client.');
  if (!closingDate) warnings.push('Closing date was not identified. Enter it before saving.');
  if (!contractNo) warnings.push('Check the employer’s contract number before saving.');
  return { clientName, fields: { title, contractNo, source: '', biddingEntity: '', procurementMethod,
    specialty, cidaGrade: grade, employerOffice: labeled(lines, 'issuing office|employer office|office'),
    employerContact: labeled(lines, 'contact person|contact|telephone|phone'),
    maxContractValue: number(labeled(lines, 'maximum contract value|contract ceiling|estimated contract value')),
    documentFee: number(labeled(lines, 'document fee|bidding document fee|non-refundable fee')),
    docsFrom, docsUntil, closingDate, closingTime, validityDays,
    securityAmount, securityForm, securityInFavourOf: labeled(lines, 'security in favour of|in favour of'),
    securityValidUntil: date(labeled(lines, 'security valid until|bid security validity')),
    estimatedValue: number(labeled(lines, 'engineer estimate|estimated value')),
    documentsNote: '' }, warnings };
}

export async function parseTenderPdf(filePath) {
  let text = '';
  let source = 'text-layer';
  try { text = await readPdfText(filePath); } catch { /* OCR may recover a scanned PDF. */ }
  if (clean(text).length < 30) {
    try { const result = await extractText(filePath, 'application/pdf'); text = result.text; source = result.source; }
    catch { throw Object.assign(new Error('This PDF has no readable text and scanned-document OCR is unavailable. Ask for a text PDF or enable OCR on the server.'), { status: 422 }); }
  }
  if (clean(text).length < 30) throw Object.assign(new Error('No readable tender text was found in this PDF.'), { status: 422 });
  return { ...parseTenderText(text), source };
}
