import React from 'react';
const QUOTATION_IDENTITY_FIELDS = {
  company: [
    ['logo', 'GKUC logo'], ['name', 'Operating company name'], ['address', 'Address'],
    ['telephone', 'Telephone'], ['email', 'Email'], ['registrationNumber', 'Business registration number'], ['tin', 'TIN'],
    ['vatNumber', 'VAT registration'], ['svatNumber', 'SVAT registration'],
    ['bankDetails', 'Bank details']
  ],
  client: [
    ['name', 'Client name'], ['registrationNumber', 'Registration number'],
    ['tin', 'TIN'], ['vatNumber', 'VAT registration'], ['billingAddress', 'Billing address'],
    ['siteAddress', 'Site / delivery location'], ['contactPerson', 'Contact person'],
    ['phone', 'Telephone'], ['alternatePhone', 'Alternate telephone'], ['email', 'Email'],
    ['city', 'City'], ['district', 'District'], ['province', 'Province'], ['country', 'Country'],
    ['project', 'Project name']
  ]
};

export const defaultQuotationVisibility = () => Object.fromEntries(Object.entries(QUOTATION_IDENTITY_FIELDS)
  .map(([party, fields]) => [party, Object.fromEntries(fields.map(([key]) => [key, true]))]));

export default function QuotationIdentityChoices({ identity, visibility, onChange, projectName, bankName, documentLabel = 'quotation' }) {
  if (!identity) return <p className="wide quotation-identity-hint">Choose a client to review which client and GKUC details will print on this {documentLabel}.</p>;
  return <fieldset className="quotation-identity wide">
    <legend>Information to show on this {documentLabel}</legend>
    <p>Choose for this {documentLabel}. The PDF keeps these choices and the saved details as they are now.</p>
    <div className="quotation-identity-columns">{Object.entries(QUOTATION_IDENTITY_FIELDS).map(([party, fields]) =>
      <div key={party}><h3>{party === 'company' ? 'GKUC information' : 'Client information'}</h3>
        {fields.map(([key, label]) => {
          const value = key === 'logo' ? 'GKUC brand mark'
            : key === 'project' ? projectName
              : key === 'bankDetails' ? bankName || identity.company.bankDetails
                : identity[party]?.[key];
          return <label className="quotation-identity-option" key={key}>
            <input type="checkbox" checked={Boolean(value) && visibility[party][key]} disabled={!value}
              onChange={event => onChange(current => ({ ...current,
                [party]: { ...current[party], [key]: event.target.checked } }))} />
            <span><strong>{label}</strong><small>{value || 'Not saved in the profile'}</small></span>
          </label>;
        })}
      </div>)}</div>
  </fieldset>;
}

