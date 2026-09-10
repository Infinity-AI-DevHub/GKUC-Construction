import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeWorkbook, STYLE } from './src/lib/xlsx-write.js';

/*
 * The spreadsheets the BOQ suites read.
 *
 * They used to be built by hand into /tmp, which meant the three suites that use them
 * stopped running the moment the machine cleared its temporary files — and a suite that
 * cannot run is a suite that is not protecting anything. They are generated here instead,
 * into the repository, from the same writer the product uses.
 *
 *   node fixtures.mjs
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(here, 'fixtures');

const cell = value => ({ value, style: STYLE.CELL });
const head = value => ({ value, style: STYLE.HEADER });
const plain = value => ({ value, style: STYLE.PLAIN });

/*
 * Our own template, filled in the way a real one comes back: three lines that cannot be
 * imported as they stand, and one that can but should be questioned.
 *
 * The row numbers matter — boqtest.mjs corrects rows 13, 14 and 17 by number and leaves 15
 * alone deliberately — so the heading block is exactly the eight rows the template ships
 * with and the nine priced lines run from row 9 to row 17.
 */
function filledTemplate() {
  const rows = [
    [plain('Road Development Authority — Bill of Quantities')],
    [cell('Prepared by the consultant, priced by us.')],
    [cell('BOQ title'), cell('Peradeniya Road Resurfacing — Phase 2')],
    [cell('Client'), cell('Road Development Authority')],
    [],
    [cell('Every row below needs a Category, Description, Unit, Quantity and Rate.')],
    ['Category', 'Description of work', 'Unit', 'Quantity', 'Rate (LKR)',
      'Amount (LKR)', 'Method statement', 'Notes'].map(head),

    /* 9  */ [cell('Material'), cell('Supply and lay 20mm aggregate base course'), cell('m3'),
      cell(250), cell(8750), cell(''), cell('Laid in two layers, compacted to 95% MDD.'), cell('')],
    /* 10 */ [cell('Labour'), cell('Excavation for road widening'), cell('m3'),
      cell(180), cell(1450), cell(''), cell('Machine excavation, spoil carted away.'), cell('')],
    /* 11 */ [cell('Material'), cell('Asphalt concrete wearing course, 40mm'), cell('m2'),
      cell(4200), cell(1980), cell(''), cell(''), cell('')],
    /* 12 */ [cell('Equipment'), cell('Vibrating roller hire, 10 tonne'), cell('day'),
      cell(14), cell(42000), cell(''), cell(''), cell('')],
    /* 13 — no category at all */
    [cell(''), cell('Bitumen emulsion tack coat'), cell('litre'),
      cell(2600), cell(310), cell(''), cell(''), cell('')],
    /* 14 — a quantity nobody can multiply */
    [cell('Material'), cell('Precast kerb stones, 300 x 150'), cell('nos'),
      cell('as required'), cell(1150), cell(''), cell(''), cell('')],
    /* 15 — priced fine, but the stated amount disagrees: advisory, not a blocker */
    [cell('Subcontract'), cell('Road marking, thermoplastic'), cell('m'),
      cell(3100), cell(420), cell(1250000), cell(''), cell('Amount taken from their bill')],
    /* 16 */ [cell('Overhead'), cell('Traffic management and signage'), cell('item'),
      cell(1), cell(875000), cell(''), cell(''), cell('')],
    /* 17 — a rate that is not a number */
    [cell('Material'), cell('Geotextile separation layer'), cell('m2'),
      cell(4200), cell('per schedule'), cell(''), cell(''), cell('')]
  ];
  return writeWorkbook([{ name: 'BOQ', rows, columns: [15, 48, 10, 12, 14, 16, 40, 28], freeze: 8 }]);
}

/*
 * Four bills on somebody else's template.
 *
 * Between them they cover what actually turns up: a title block of a different depth each
 * time, headings under names nobody else uses, section rows and subtotals mixed in with the
 * priced lines, and a bill that gives an amount but no rate.
 */

/* a — a government bill: section headings and a subtotal among the lines. Five priced. */
function foreignA() {
  const rows = [
    [plain('ROAD DEVELOPMENT AUTHORITY')],
    [plain('Contract RDA/CP/2026/114 — Rehabilitation of Gampola–Nawalapitiya Road')],
    [],
    ['Item No', 'Particulars', 'Unit', 'Qty', 'Rate (Rs.)', 'Amount (Rs.)'].map(head),
    [cell(''), cell('BILL No. 1 — SITE CLEARANCE'), cell(''), cell(''), cell(''), cell('')],
    [cell('1.1'), cell('Clearing and grubbing including disposal'), cell('m2'), cell(12500), cell(95), cell(1187500)],
    [cell('1.2'), cell('Removal of existing bituminous surface'), cell('m2'), cell(8900), cell(240), cell(2136000)],
    [cell(''), cell('Sub-total Bill No. 1'), cell(''), cell(''), cell(''), cell(3323500)],
    [cell(''), cell('BILL No. 2 — EARTHWORKS'), cell(''), cell(''), cell(''), cell('')],
    [cell('2.1'), cell('Excavation in ordinary soil'), cell('m3'), cell(6400), cell(1150), cell(7360000)],
    [cell('2.2'), cell('Formation of embankment in 200mm layers'), cell('m3'), cell(5100), cell(1420), cell(7242000)],
    [cell('2.3'), cell('Supply and place 12mm graded aggregate'), cell('m3'), cell(2300), cell(9600), cell(22080000)],
    [cell(''), cell('Sub-total Bill No. 2'), cell(''), cell(''), cell(''), cell(36682000)],
    [cell(''), cell('TOTAL CARRIED TO SUMMARY'), cell(''), cell(''), cell(''), cell(40005500)]
  ];
  return writeWorkbook([{ name: 'BOQ', rows, columns: [10, 50, 10, 12, 14, 18] }]);
}

/* b — a consultant's bill, headings ten rows down, on a sheet named their way. Four priced. */
function foreignB() {
  const rows = [
    [plain('DESIGN CONSORTIUM (PVT) LTD')],
    [plain('Chartered Quantity Surveyors')],
    [], [],
    [plain('PROJECT: Proposed 6-Storey Office Building, Rajagiriya')],
    [plain('EMPLOYER: Horizon Properties (Pvt) Ltd')],
    [plain('SECTION 4 — CONCRETE WORK')],
    [], [],
    ['Ref', 'Description of Works', 'Unit of Measure', 'Quantity', 'Unit Price', 'Extension'].map(head),
    [cell('C1'), cell('Grade 25 concrete to foundation footings'), cell('m3'), cell(340), cell(38500), cell(13090000)],
    [cell('C2'), cell('Grade 30 concrete to columns and shear walls'), cell('m3'), cell(210), cell(41200), cell(8652000)],
    [cell('C3'), cell('High yield reinforcement, 12mm and 16mm bars'), cell('kg'), cell(48000), cell(285), cell(13680000)],
    [cell('C4'), cell('Sawn formwork to soffits, propped'), cell('m2'), cell(2650), cell(1850), cell(4902500)],
    [cell(''), cell('Total for Section 4'), cell(''), cell(''), cell(''), cell(40324500)]
  ];
  return writeWorkbook([{ name: 'Priced BOQ', rows, columns: [10, 52, 14, 12, 14, 18] }]);
}

/* c — a small contractor's list, no title block, the default sheet name. Three priced. */
function foreignC() {
  const rows = [
    ['Desc', 'Units', 'Nos', 'Price'].map(head),
    [cell('Brickwork in cement mortar 1:5'), cell('m2'), cell(420), cell(4250)],
    [cell('Internal plastering, 12mm thick'), cell('m2'), cell(1180), cell(1150)],
    [cell('Emulsion paint, two coats to walls'), cell('m2'), cell(1180), cell(620)]
  ];
  return writeWorkbook([{ name: 'Sheet1', rows, columns: [46, 10, 12, 14] }]);
}

/*
 * d — a bill that gives the money but not the rate.
 *
 * The rate has to be worked back from the amount, and the reviewer is told so on each line.
 * Four priced lines under a heading row that names its columns unusually.
 */
function foreignD() {
  const rows = [
    [plain('Lanka Steel Structures — Quotation Annexure')],
    [],
    ['Sl.No', 'Scope of Work', 'UOM', 'Quantum', 'Total Value'].map(head),
    [cell(1), cell('Fabrication of structural steel trusses'), cell('kg'), cell(26500), cell(11925000)],
    [cell(2), cell('Erection of trusses including cranage'), cell('kg'), cell(26500), cell(2385000)],
    [cell(3), cell('Supply and fix colour-coated roofing sheets'), cell('m2'), cell(3800), cell(6650000)],
    [cell(4), cell('Ridge, flashing and gutter work'), cell('m'), cell(640), cell(1216000)],
    [cell(''), cell('Grand Total'), cell(''), cell(''), cell(22176000)]
  ];
  return writeWorkbook([{ name: 'Detail', rows, columns: [8, 50, 10, 12, 18] }]);
}

const files = {
  'boq-filled.xlsx': filledTemplate,
  'foreign-a.xlsx': foreignA,
  'foreign-b.xlsx': foreignB,
  'foreign-c.xlsx': foreignC,
  'foreign-d.xlsx': foreignD
};

/** Writes any fixture that is not already there, and returns the directory. */
export function ensureFixtures() {
  fs.mkdirSync(FIXTURES, { recursive: true });
  for (const [name, build] of Object.entries(files)) {
    const target = path.join(FIXTURES, name);
    if (!fs.existsSync(target)) fs.writeFileSync(target, build());
  }
  return FIXTURES;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fs.mkdirSync(FIXTURES, { recursive: true });
  for (const [name, build] of Object.entries(files)) {
    const bytes = build();
    fs.writeFileSync(path.join(FIXTURES, name), bytes);
    console.log(`${name.padEnd(18)} ${bytes.length} bytes`);
  }
}
