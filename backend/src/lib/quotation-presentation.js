import {z} from 'zod';
import {getOne} from '../db.js';
import {documentContext} from './documents.js';

export const quotationVisibility = z.object({
  company: z.object({
    logo: z.boolean(), name: z.boolean(), address: z.boolean(), telephone: z.boolean(),
    email: z.boolean(), registrationNumber: z.boolean().optional(), tin: z.boolean(), vatNumber: z.boolean(), svatNumber: z.boolean(),
    bankDetails: z.boolean()
  }).strict(),
  client: z.object({
    name: z.boolean(), billingAddress: z.boolean(), siteAddress: z.boolean(),
    contactPerson: z.boolean(), phone: z.boolean(), alternatePhone: z.boolean(), email: z.boolean(),
    city: z.boolean(), district: z.boolean(), province: z.boolean(), country: z.boolean(),
    registrationNumber: z.boolean(), tin: z.boolean(), vatNumber: z.boolean(), project: z.boolean()
  }).strict()
}).strict();

export const parsePresentation = value => {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
};

export async function quotationIdentity(companyId, clientId, fallbackName = '') {
  const [{ company }, client] = await Promise.all([
    documentContext(getOne, companyId),
    clientId ? getOne(`SELECT name,billing_address billingAddress,site_address siteAddress,
      contact_person contactPerson,phone,alternate_phone alternatePhone,email,city,district,province,country,
      registration_number registrationNumber,
      COALESCE(NULLIF(tin,''),tax_number) tin,vat_number vatNumber
      FROM clients WHERE id=? AND active=1`, [clientId]) : null
  ]);
  if (!company) return null;
  return {
    company: { name: company.name, address: company.address, telephone: company.telephone,
      registrationNumber: company.registrationNumber,
      email: company.email, tin: company.tin, vatNumber: company.vatNumber, svatNumber: company.svatNumber,
      bankDetails: company.bankDetails },
    client: client || { name: fallbackName }
  };
}

export async function quotationPresentation(companyId, clientId, projectName, bankAccountId, visibility, fallbackName = '') {
  const identity = await quotationIdentity(companyId, clientId, fallbackName);
  if (!identity) return null;
  const bank = bankAccountId ? await getOne(`SELECT label,bank_name bankName,branch,
    account_name accountName,account_number accountNumber,swift_code swiftCode
    FROM company_bank_accounts WHERE id=? AND company_id=? AND active=1`, [bankAccountId, companyId]) : null;
  return JSON.stringify({ show: visibility, company: identity.company,
    client: { ...identity.client, project: projectName || null }, bank });
}

