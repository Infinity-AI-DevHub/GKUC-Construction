/*
 * What a client actually owes on a certificate.
 *
 * Kept in one function because it is the part everybody gets wrong, and getting it wrong
 * means invoicing a client confidently for a figure that is not right. The order matters:
 * retention and the advance recovery come out of the work, and the tax is charged on the
 * work — not on the reduced figure, because the tax is on what was done, not on what is
 * being paid this month.
 */
export function certificate({
  gross = 0,
  taxTreatment = 'Standard',
  vatRate = 0,
  retentionPercent = 0,
  advanceRecovery = 0,
  otherDeductions = 0
}) {
  const work = round(Number(gross) || 0);

  const retention = round(work * (Number(retentionPercent) || 0) / 100);
  const advance = round(Number(advanceRecovery) || 0);
  const other = round(Number(otherDeductions) || 0);

  /*
   * Tax on the work, not on the balance. Under SVAT the amount is worked out and shown but
   * no money moves for it — a credit voucher passes instead — so it is calculated either
   * way and only added to what is payable when it is genuinely being collected.
   */
  const rate = taxTreatment === 'Exempt' ? 0 : (Number(vatRate) || 0);
  const vat = round(work * rate / 100);
  const vatCollected = taxTreatment === 'Standard' ? vat : 0;

  const net = round(work + vatCollected - retention - advance - other);

  return {
    gross: work,
    vatRate: rate,
    vatAmount: vat,
    vatCollected,
    retentionAmount: retention,
    advanceRecovery: advance,
    otherDeductions: other,
    netPayable: net,
    /* Spelled out so an invoice can show its own working rather than a single total. */
    workings: [
      { label: 'Work certified', amount: work },
      ...(rate ? [{
        label: taxTreatment === 'SVAT'
          ? `VAT at ${rate}% — suspended under SVAT, settled by credit voucher`
          : `VAT at ${rate}%`,
        amount: vat,
        collected: taxTreatment === 'Standard'
      }] : []),
      ...(retention ? [{ label: `Retention at ${retentionPercent}%`, amount: -retention }] : []),
      ...(advance ? [{ label: 'Advance recovered', amount: -advance }] : []),
      ...(other ? [{ label: 'Other deductions', amount: -other }] : [])
    ]
  };
}

/* Money to two places, rounded once at the end rather than accumulating drift. */
const round = value => Math.round((Number(value) || 0) * 100) / 100;
