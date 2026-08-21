/**
 * The design of a generated document: its page, palette, type, and the order and styling of
 * every block on it.
 *
 * Kept as plain data rather than as CSS so that it can be edited visually, stored, compared
 * and reset. The renderer turns it into a stylesheet; the designer screen turns it into
 * controls. Neither knows about the other — this file is the contract between them.
 */

/** Every block a document can contain, in the order they appear by default. */
export const BLOCKS = [
  { id: 'letterhead', label: 'Letterhead', fixed: true },
  { id: 'parties', label: 'Client & details' },
  { id: 'subject', label: 'Subject line' },
  { id: 'table', label: 'Priced items', fixed: true },
  { id: 'totals', label: 'Totals' },
  { id: 'words', label: 'Amount in words' },
  { id: 'notes', label: 'Notes' },
  { id: 'terms', label: 'Terms & conditions' },
  { id: 'bank', label: 'Bank details' },
  { id: 'signatures', label: 'Signature lines' },
  { id: 'footer', label: 'Footer', fixed: true }
];

export const FONTS = [
  { id: 'sans', label: 'Helvetica / Arial', stack: '"Helvetica Neue",Arial,sans-serif' },
  { id: 'serif', label: 'Georgia / Times', stack: 'Georgia,"Times New Roman",serif' },
  { id: 'mono', label: 'Courier', stack: '"Courier New",Courier,monospace' },
  { id: 'system', label: 'System UI', stack: 'system-ui,-apple-system,"Segoe UI",sans-serif' }
];

/**
 * The pieces that make up the letterhead band.
 *
 * The band is a fixed area at the top of the page that appears once and never flows onto a
 * second page — which is what makes it safe to place things in it by coordinate. Each piece
 * carries its own position, size and styling, and can be dragged anywhere within the band.
 */
export const HEADER_PIECES = [
  { id: 'logo', label: 'Logo' },
  { id: 'companyName', label: 'Company name' },
  { id: 'companyDetails', label: 'Address & contact' },
  { id: 'docTitle', label: 'Document title' },
  { id: 'reference', label: 'Reference number' },
  { id: 'docDate', label: 'Date' }
];

const DEFAULT_HEADER = {
  height: 120,
  rule: true,
  elements: [
    { id: 'logo', show: true, x: 2, y: 6, width: 14, size: 56, colour: '#111111', weight: 700, align: 'left' },
    { id: 'companyName', show: true, x: 19, y: 10, width: 46, size: 17, colour: '#16305c', weight: 800, align: 'left' },
    { id: 'companyDetails', show: true, x: 19, y: 40, width: 46, size: 10, colour: '#333333', weight: 400, align: 'left' },
    { id: 'docTitle', show: true, x: 66, y: 8, width: 32, size: 20, colour: '#16305c', weight: 800, align: 'right' },
    { id: 'reference', show: true, x: 66, y: 46, width: 32, size: 11, colour: '#111111', weight: 400, align: 'right' },
    { id: 'docDate', show: true, x: 66, y: 66, width: 32, size: 11, colour: '#111111', weight: 400, align: 'right' }
  ]
};

export const DEFAULT_DESIGN = {
  header: DEFAULT_HEADER,
  /* Each edge is set on its own: a letterhead usually wants more room at the top than at
     the sides, and printers differ in what they can reach at the bottom. */
  page: { size: 'A4', margin: 14, margins: { top: 14, right: 15, bottom: 14, left: 15 }, background: '#ffffff' },
  type: { font: 'sans', size: 12, colour: '#111111', headingColour: '#16305c' },
  accent: '#16305c',
  logo: { show: true, height: 52, align: 'left' },
  watermark: { text: '', colour: '#8fa3b5', size: 68, opacity: 0.1, rotate: -28 },
  table: {
    headerBackground: '#16305c', headerText: '#ffffff', border: '#ccd4dd',
    stripe: '#ffffff', fontSize: 10.5, padding: 6
  },
  totals: { barBackground: '#16305c', barText: '#ffffff' },
  blocks: BLOCKS.map(block => ({ id: block.id, show: true, space: 0, align: 'left' }))
};

const clampNumber = (value, low, high, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(high, Math.max(low, number)) : fallback;
};

const hex = (value, fallback) => (/^#[0-9a-fA-F]{6}$/.test(String(value || '')) ? value : fallback);

/**
 * Brings a stored or submitted design back to something safe to render.
 *
 * Anything unrecognised is replaced by its default rather than refused: a design is edited
 * visually and stored as one document, so a single unknown value should not cost somebody
 * the rest of their layout — and nothing here may reach the stylesheet unchecked.
 */
/** Keeps a dragged piece inside the band, whatever the browser sent. */
function normaliseHeader(given) {
  const header = given && typeof given === 'object' ? given : {};
  const height = clampNumber(header.height, 60, 320, DEFAULT_HEADER.height);
  const known = new Map(HEADER_PIECES.map(piece => [piece.id, piece]));
  const submitted = Array.isArray(header.elements) ? header.elements : [];

  const elements = [];
  for (const piece of HEADER_PIECES) {
    const entry = submitted.find(item => item?.id === piece.id) || {};
    const fallback = DEFAULT_HEADER.elements.find(item => item.id === piece.id);
    const width = clampNumber(entry.width, 5, 100, fallback.width);
    elements.push({
      id: piece.id,
      show: entry.show !== false,
      /* Position is a percentage across and pixels down, so the band keeps its proportions
         at any paper size while heights stay predictable. */
      x: clampNumber(entry.x, 0, 100 - width, fallback.x),
      y: clampNumber(entry.y, 0, Math.max(0, height - 12), fallback.y),
      width,
      size: clampNumber(entry.size, 6, 90, fallback.size),
      colour: hex(entry.colour, fallback.colour),
      weight: [400, 600, 700, 800].includes(Number(entry.weight)) ? Number(entry.weight) : fallback.weight,
      align: ['left', 'centre', 'right'].includes(entry.align) ? entry.align : fallback.align
    });
  }

  /* Text boxes somebody added themselves, which carry their own words. */
  for (const entry of submitted) {
    if (known.has(entry?.id) || !String(entry?.id || '').startsWith('text:')) continue;
    const width = clampNumber(entry.width, 5, 100, 30);
    elements.push({
      id: String(entry.id).slice(0, 60),
      custom: true,
      text: String(entry.text || '').slice(0, 200),
      show: entry.show !== false,
      x: clampNumber(entry.x, 0, 100 - width, 5),
      y: clampNumber(entry.y, 0, Math.max(0, height - 12), 10),
      width,
      size: clampNumber(entry.size, 6, 90, 12),
      colour: hex(entry.colour, '#111111'),
      weight: [400, 600, 700, 800].includes(Number(entry.weight)) ? Number(entry.weight) : 400,
      align: ['left', 'centre', 'right'].includes(entry.align) ? entry.align : 'left'
    });
  }

  return { height, rule: header.rule !== false, elements };
}

export function normaliseDesign(given) {
  const design = given && typeof given === 'object' ? given : {};
  const base = DEFAULT_DESIGN;

  const submitted = Array.isArray(design.blocks) ? design.blocks : [];
  const known = new Map(BLOCKS.map(block => [block.id, block]));
  const ordered = [];
  for (const entry of submitted) {
    const block = known.get(entry?.id);
    if (!block || ordered.some(item => item.id === block.id)) continue;
    /* A block the document cannot do without stays visible whatever was submitted. */
    ordered.push({
      id: block.id,
      show: block.fixed ? true : entry.show !== false,
      /* Extra room above this block, on top of whatever the layout already gives it. */
      space: clampNumber(entry.space, -20, 80, 0),
      align: ['left', 'centre', 'right'].includes(entry.align) ? entry.align : 'left'
    });
  }
  for (const block of BLOCKS) {
    if (!ordered.some(item => item.id === block.id)) {
      ordered.push({ id: block.id, show: true, space: 0, align: 'left' });
    }
  }

  return {
    header: normaliseHeader(design.header),
    page: {
      size: design.page?.size === 'Letter' ? 'Letter' : 'A4',
      /* A design saved before the edges were separable carries a single margin; it seeds
         all four so nothing shifts underneath an existing layout. */
      margin: clampNumber(design.page?.margin, 3, 40, base.page.margin),
      margins: {
        top: clampNumber(design.page?.margins?.top ?? design.page?.margin, 3, 60, base.page.margins.top),
        right: clampNumber(design.page?.margins?.right ?? design.page?.margin, 3, 40, base.page.margins.right),
        bottom: clampNumber(design.page?.margins?.bottom ?? design.page?.margin, 3, 40, base.page.margins.bottom),
        left: clampNumber(design.page?.margins?.left ?? design.page?.margin, 3, 40, base.page.margins.left)
      },
      background: hex(design.page?.background, base.page.background)
    },
    type: {
      font: FONTS.some(font => font.id === design.type?.font) ? design.type.font : base.type.font,
      size: clampNumber(design.type?.size, 8, 16, base.type.size),
      colour: hex(design.type?.colour, base.type.colour),
      headingColour: hex(design.type?.headingColour, base.type.headingColour)
    },
    accent: hex(design.accent, base.accent),
    logo: {
      show: design.logo?.show !== false,
      height: clampNumber(design.logo?.height, 20, 120, base.logo.height),
      align: ['left', 'centre', 'right'].includes(design.logo?.align) ? design.logo.align : base.logo.align
    },
    watermark: {
      text: String(design.watermark?.text || '').slice(0, 40),
      colour: hex(design.watermark?.colour, base.watermark.colour),
      size: clampNumber(design.watermark?.size, 20, 200, base.watermark.size),
      opacity: clampNumber(design.watermark?.opacity, 0, 0.6, base.watermark.opacity),
      rotate: clampNumber(design.watermark?.rotate, -90, 90, base.watermark.rotate)
    },
    table: {
      headerBackground: hex(design.table?.headerBackground, base.table.headerBackground),
      headerText: hex(design.table?.headerText, base.table.headerText),
      border: hex(design.table?.border, base.table.border),
      stripe: hex(design.table?.stripe, base.table.stripe),
      fontSize: clampNumber(design.table?.fontSize, 7, 14, base.table.fontSize),
      padding: clampNumber(design.table?.padding, 2, 14, base.table.padding)
    },
    totals: {
      barBackground: hex(design.totals?.barBackground, base.totals.barBackground),
      barText: hex(design.totals?.barText, base.totals.barText)
    },
    blocks: ordered
  };
}

/** True when the design says this block should be drawn. */
export const shows = (design, id) => design.blocks.find(block => block.id === id)?.show !== false;

/** The blocks to draw, in the order the designer put them. */
export const orderedBlocks = design => design.blocks.filter(block => block.show);

export const fontStack = id => (FONTS.find(font => font.id === id) || FONTS[0]).stack;
