import { readWorkbook, serialToDate } from './xlsx.js';

const text = value => String(value ?? '').trim();
const amount = value => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number * 100) / 100 : null;
};
const dateValue = value => {
  if (typeof value === 'number') return serialToDate(value);
  const valueText = text(value);
  if (!valueText) return null;
  const parsed = new Date(valueText);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString().slice(0, 10);
};

function headerRow(rows) {
  /* The lightweight reader keeps Excel's A column at index 1. */
  return rows.findIndex(row => text(row?.[1]).toLowerCase() === 'date'
    && text(row?.[2]).toLowerCase().includes('work'));
}

/**
 * Reads GKUC's existing project-cost workbooks.
 *
 * These sheets are laid out as four parallel ledgers rather than a conventional table:
 * vehicle/equipment (C:G), additional costs (H:I), labour (J:K), and materials (L:N).
 * A date appears once at the start of each daily block. Columns O/P are daily and running
 * totals, while R:W describe valued work; neither is imported as a cost line because doing
 * so would count the same day twice.
 */
export function parseDailyCostWorkbook(buffer) {
  const workbook = readWorkbook(buffer);
  const results = [];
  const warnings = [];

  for (const sheetName of workbook.names) {
    const sheet = workbook.sheet(sheetName);
    const start = headerRow(sheet?.rows || []);
    if (start < 0) continue;
    const lastDateRow = sheet.rows.reduce((last,row,index) => dateValue(row?.[1]) ? index : last,start);
    const end = sheet.rows.findIndex((row,index) => index >= lastDateRow
      && amount(row?.[15]) && amount(row?.[16]));
    let currentDate = null;
    let currentWork = '';

    for (let index = start + 2; index < (end >= 0 ? end : sheet.rows.length); index++) {
      const row = sheet.rows[index] || [];
      const rowDate = dateValue(row[1]);
      if (rowDate) currentDate = rowDate;
      if (text(row[2])) currentWork = text(row[2]);
      if (!currentDate) continue;
      const sourceRow = index;
      const reference = `${sheetName} row ${sourceRow}`;
      const push = entry => results.push({
        workDate: currentDate,
        workTask: currentWork || `Imported work on ${currentDate}`,
        costType: 'Expected',
        quantity: null,
        unit: null,
        unitRate: null,
        reference,
        sourceSheet: sheetName,
        sourceRow,
        ...entry
      });

      const equipmentTotal = amount(row[7]);
      const equipmentName = text(row[3]);
      if (equipmentName && equipmentTotal) push({
        source: 'Equipment', description: equipmentName,
        quantity: amount(row[4]), unit: amount(row[4]) ? 'hour' : null,
        unitRate: amount(row[4]) ? Math.round(equipmentTotal / Number(row[4]) * 100) / 100 : null,
        amount: equipmentTotal
      });

      const additionalAmount = amount(row[9]);
      if (text(row[8]) && additionalAmount) push({
        source: 'Other', description: text(row[8]), amount: additionalAmount
      });

      const labourAmount = amount(row[11]);
      if (text(row[10]) && labourAmount) push({
        source: 'Labour', description: `Labour — ${text(row[10])}`, amount: labourAmount
      });

      const materialAmount = amount(row[14]);
      if (text(row[12]) && materialAmount) push({
        source: 'Material', description: text(row[12]), quantity: amount(row[13]),
        unit: amount(row[13]) ? 'unit' : null,
        unitRate: amount(row[13]) ? Math.round(materialAmount / Number(row[13]) * 100) / 100 : null,
        amount: materialAmount
      });
    }
  }

  if (!results.length) warnings.push('No dated vehicle, additional, labour or material cost lines were found.');
  return { sheets: workbook.names, rows: results, warnings };
}
