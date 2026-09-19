import { readPdfText } from './boq-pdf.js';
import { extractText } from './ocr.js';

const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const amount = value => {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(String(value || '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
};
const dateValue = value => {
  const match = String(value || '').match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b|\b(\d{1,2})[/.\-](\d{1,2})[/.\-]((?:19|20)\d{2})\b/);
  if (!match) return null;
  const [, year, month, day, otherDay, otherMonth, otherYear] = match;
  const iso = `${otherYear || year}-${String(otherMonth || month).padStart(2, '0')}-${String(otherDay || day).padStart(2, '0')}`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
};
const findLabeled = (lines, labels) => {
  const regex = new RegExp(`^(?:${labels})\\s*(?:[:#-]|no\\.?\\s*[:#-]?)\\s*(.+)$`, 'i');
  return lines.map(clean).map(line => line.match(regex)?.[1]).find(Boolean) || '';
};
const linePattern = /^\s*(?:(\d+(?:\.\d+)?)\s{1,4})?(.+?)\s{2,}([A-Za-z][\w²³./-]{0,12})\s+([\d,]+(?:\.\d{1,3})?)\s+([\d,]+(?:\.\d{1,2})?)\s+([\d,]+(?:\.\d{1,2})?)\s*$/;
const loosePattern = /^\s*(?:(\d+(?:\.\d+)?)\s+)?(.+?)\s+([A-Za-z][\w²³./-]{0,12})\s+([\d,]+(?:\.\d{1,3})?)\s+([\d,]+(?:\.\d{1,2})?)\s+([\d,]+(?:\.\d{1,2})?)\s*$/;

export function parseSubcontractQuoteText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const meaningful = lines.map(clean).filter(Boolean);
  const warnings = [];
  const name = findLabeled(lines, 'from|subcontractor|supplier|contractor|company')
    || meaningful.find(line => !/quotation|estimate|invoice|date|reference|^to\b|^tel\b|^phone\b|^email\b|^item\b/i.test(line)) || '';
  const reference = findLabeled(lines, 'quotation\s*(?:no\.?|number|ref(?:erence)?)?|quote\s*(?:no\.?|number|ref(?:erence)?)?|ref(?:erence)?');
  const date = dateValue(findLabeled(lines, 'quotation\s*date|quote\s*date|dated|date')) || null;
  const validityRaw = findLabeled(lines, 'validity|valid\s*for|quotation\s*validity');
  const validityDays = Number(validityRaw.match(/\d+/)?.[0]) || 7;
  const phone = findLabeled(lines, 'phone|telephone|tel|mobile|contact\s*number');
  const email = meaningful.join(' ').match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0] || '';
  const address = findLabeled(lines, 'address|location|registered\s*office');
  const contact = findLabeled(lines, 'contact\s*person|attention|attn');
  const businessId = findLabeled(lines, 'registration\s*(?:no\.?|number)?|business\s*(?:id|registration)|brn|nic');
  const trade = findLabeled(lines, 'trade|specialty|speciality|work\s*type');
  const packageName = findLabeled(lines, 'subject|scope\s*of\s*work|work\s*package|project|description') || '';
  const siteAddress = findLabeled(lines, 'site\s*address|delivery\s*(?:address|location)|work\s*site');
  const statedTotal = amount((meaningful.find(line => /^(?:grand\s*)?total\s*(?:amount|price)?\s*[:\s]/i.test(line)) || '')
    .match(/([\d,]+(?:\.\d{2})?)\s*$/)?.[1]);
  const items = [];
  for (const line of lines) {
    if (/\b(subtotal|total|discount|vat|tax|balance)\b/i.test(line)) continue;
    const match = line.match(linePattern) || line.match(loosePattern);
    if (!match) continue;
    const [, referenceNo, description, unit, rawQuantity, rawRate, rawAmount] = match;
    if (/^(item|description|qty|quantity|rate|unit)$/i.test(clean(description))) continue;
    const quantity = amount(rawQuantity); const rate = amount(rawRate); const stated = amount(rawAmount);
    if (quantity === null || rate === null || stated === null || quantity <= 0 || rate < 0) continue;
    items.push({ description: clean(description).slice(0, 300), unit, quantity, rate, discount: 0,
      statedAmount: stated, sourceReference: referenceNo || '' });
    if (Math.abs(quantity * rate - stated) > 1) warnings.push(`Check ${clean(description)}: the PDF amount differs from quantity × rate.`);
  }
  if (!name) warnings.push('Subcontractor name was not found. Enter it before saving.');
  if (!date) warnings.push('Quotation date was not found. Check the date before saving.');
  if (!items.length) warnings.push('No priced rows could be identified. Add the items manually from the PDF before saving.');
  if (statedTotal !== null && items.length && Math.abs(items.reduce((sum, item) => sum + item.quantity * item.rate, 0) - statedTotal) > 1) {
    warnings.push('The PDF total differs from the extracted item total. Review missing lines, discounts and rates.');
  }
  return { subcontractor: { name, trade, phone, email, address, contact, businessId },
    quotation: { theirReference: reference, package: packageName, quoteDate: date, validityDays, siteAddress,
      contactPerson: contact, contactPhone: phone, notes: '' }, items, statedTotal, warnings };
}

const normalise = value => clean(value).toLowerCase().replace(/[^a-z0-9]/g, '');
export function suggestSubcontractors(parsed, existing) {
  const input = parsed.subcontractor;
  return existing.map(row => {
    const sameBusinessId = input.businessId && normalise(input.businessId) === normalise(row.businessId);
    const sameName = input.name && normalise(input.name) === normalise(row.name);
    const samePhone = input.phone && normalise(input.phone) === normalise(row.phone);
    const similarName = input.name && row.name && (normalise(input.name).includes(normalise(row.name)) || normalise(row.name).includes(normalise(input.name)));
    const score = (sameBusinessId ? 100 : 0) + (sameName ? 80 : 0) + (samePhone ? 50 : 0) + (similarName ? 20 : 0);
    return { id: row.id, name: row.name, trade: row.trade, phone: row.phone, businessId: row.businessId, score,
      reason: sameBusinessId ? 'Registration number matches' : sameName ? 'Name matches' : samePhone ? 'Phone matches' : 'Name looks similar' };
  }).filter(row => row.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
}

export async function parseSubcontractQuotePdf(filePath) {
  let text = '';
  let source = 'text-layer';
  try { text = await readPdfText(filePath); } catch { /* try OCR below */ }
  if (clean(text).length < 30) {
    try {
      const result = await extractText(filePath, 'application/pdf');
      text = result.text;
      source = result.source;
    } catch {
      throw Object.assign(new Error('This PDF has no readable text and scanned-document OCR is unavailable. Ask for a text PDF or enable OCR on the server.'), { status: 422 });
    }
  }
  if (clean(text).length < 30) throw Object.assign(new Error('No readable quotation text was found in this PDF.'), { status: 422 });
  return { ...parseSubcontractQuoteText(text), source };
}
