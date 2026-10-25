import {nextReference, transaction} from '../db.js';

export const documentTypes = {QUO:'quotations_client',INV:'client_invoices',RCPT:'client_receipts'};
export function formatDocumentNumber(format, sequence, padding, date = new Date()) {
  return format.replaceAll('{YYYY}', String(date.getFullYear())).replaceAll('{YY}', String(date.getFullYear()).slice(-2))
    .replaceAll('{MM}', String(date.getMonth()+1).padStart(2,'0')).replace('{N}', String(sequence).padStart(padding,'0'));
}

export async function documentNumber(type, companyId, manual) {
  if (manual) return manual;
  const configured = await transaction(async connection => {
    const [[setting]] = await connection.query('SELECT * FROM document_numbering WHERE company_id=? AND document_type=? FOR UPDATE',[companyId,type]);
    if (!setting) return null;
    let next = Number(setting.next_value);
    for (let attempt=0; attempt<1000; attempt++,next++) {
      const number = formatDocumentNumber(setting.format,next,setting.padding);
      const column = type==='RCPT'?'receipt_number':'reference';
      const [[exists]] = await connection.query(`SELECT id FROM ${documentTypes[type]} WHERE ${column}=? LIMIT 1`,[number]);
      if (exists) continue;
      await connection.query('UPDATE document_numbering SET next_value=? WHERE company_id=? AND document_type=?',[next+1,companyId,type]);
      return number;
    }
    throw Object.assign(new Error('Number sequence overlaps existing documents. Choose a later starting number.'),{status:409});
  });
  if (configured) return configured;
  if(type==='RCPT') return (await nextReference('RCPT','receipt_number_registry')).replace(/-(\d+)$/,(_,value)=>`-${value.padStart(5,'0')}`);
  return nextReference(type,documentTypes[type]);
}
