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

export const DEFAULT_DESIGN = {
  page: { size: 'A4', margin: 14, background: '#ffffff' },
  type: { font: 'sans', size: 12, colour: '#111111', headingColour: '#16305c' },
  accent: '#16305c',
  logo: { show: true, height: 52, align: 'left' },
  watermark: { text: '', colour: '#8fa3b5', size: 68, opacity: 0.1, rotate: -28 },
  table: {
    headerBackground: '#16305c', headerText: '#ffffff', border: '#ccd4dd',
    stripe: '#ffffff', fontSize: 10.5, padding: 6
  },
  totals: { barBackground: '#16305c', barText: '#ffffff' },
  blocks: BLOCKS.map(block => ({ id: block.id, show: true }))
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
    ordered.push({ id: block.id, show: block.fixed ? true : entry.show !== false });
  }
  for (const block of BLOCKS) {
    if (!ordered.some(item => item.id === block.id)) ordered.push({ id: block.id, show: true });
  }

  return {
    page: {
      size: design.page?.size === 'Letter' ? 'Letter' : 'A4',
      margin: clampNumber(design.page?.margin, 5, 30, base.page.margin),
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
