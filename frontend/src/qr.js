/**
 * A small QR encoder, just large enough for the asset-label URLs the equipment module
 * prints. Byte mode, error correction level M, versions 1–10 — written here rather than
 * pulled in as a dependency so the workspace lockfile stays untouched.
 *
 * Validated against the ISO/IEC 18004 worked example (see qr.test.js).
 */

/* Total data codewords and error-correction blocks per version at EC level M. */
const VERSIONS = [
  { version: 1, dataCodewords: 16, ecPerBlock: 10, group1: 1, block1: 16, group2: 0, block2: 0 },
  { version: 2, dataCodewords: 28, ecPerBlock: 16, group1: 1, block1: 28, group2: 0, block2: 0 },
  { version: 3, dataCodewords: 44, ecPerBlock: 26, group1: 1, block1: 44, group2: 0, block2: 0 },
  { version: 4, dataCodewords: 64, ecPerBlock: 18, group1: 2, block1: 32, group2: 0, block2: 0 },
  { version: 5, dataCodewords: 86, ecPerBlock: 24, group1: 2, block1: 43, group2: 0, block2: 0 },
  { version: 6, dataCodewords: 108, ecPerBlock: 16, group1: 4, block1: 27, group2: 0, block2: 0 },
  { version: 7, dataCodewords: 124, ecPerBlock: 18, group1: 4, block1: 31, group2: 0, block2: 0 },
  { version: 8, dataCodewords: 154, ecPerBlock: 22, group1: 2, block1: 38, group2: 2, block2: 39 },
  { version: 9, dataCodewords: 182, ecPerBlock: 22, group1: 3, block1: 36, group2: 2, block2: 37 },
  { version: 10, dataCodewords: 216, ecPerBlock: 26, group1: 4, block1: 43, group2: 1, block2: 44 }
];

const ALIGNMENT = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
};

/* GF(256) tables for Reed–Solomon, generated with the QR primitive polynomial 0x11d. */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    EXP[index] = value;
    LOG[value] = index;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let index = 255; index < 512; index += 1) EXP[index] = EXP[index - 255];
})();

const multiply = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Generator polynomial for `degree` error-correction codewords. */
function generatorPoly(degree) {
  let poly = [1];
  for (let index = 0; index < degree; index += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let position = 0; position < poly.length; position += 1) {
      next[position] ^= poly[position];
      next[position + 1] ^= multiply(poly[position], EXP[index]);
    }
    poly = next;
  }
  return poly;
}

export function errorCorrection(data, count) {
  const generator = generatorPoly(count);
  const remainder = new Array(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    for (let index = 0; index < count; index += 1) {
      remainder[index] ^= multiply(generator[index + 1], factor);
    }
  }
  return remainder;
}

/** Encodes the payload into the full codeword stream (data + interleaved EC). */
export function encodeCodewords(text) {
  const bytes = new TextEncoder().encode(text);
  const spec = VERSIONS.find(candidate => {
    const headerBits = 4 + (candidate.version < 10 ? 8 : 16);
    return Math.ceil((headerBits + bytes.length * 8) / 8) <= candidate.dataCodewords;
  });
  if (!spec) throw new Error('Payload is too long for this QR encoder');

  const bits = [];
  const push = (value, length) => {
    for (let index = length - 1; index >= 0; index -= 1) bits.push((value >> index) & 1);
  };

  push(0b0100, 4);                                        /* byte mode */
  push(bytes.length, spec.version < 10 ? 8 : 16);         /* character count */
  for (const byte of bytes) push(byte, 8);

  const capacity = spec.dataCodewords * 8;
  push(0, Math.min(4, capacity - bits.length));           /* terminator */
  while (bits.length % 8) bits.push(0);

  const data = [];
  for (let index = 0; index < bits.length; index += 8) {
    data.push(parseInt(bits.slice(index, index + 8).join(''), 2));
  }
  /* Pad with the alternating bytes the specification mandates. */
  const padding = [0xec, 0x11];
  let padIndex = 0;
  while (data.length < spec.dataCodewords) data.push(padding[padIndex++ % 2]);

  /* Split into blocks, compute EC per block, then interleave both. */
  const blocks = [];
  let offset = 0;
  for (let index = 0; index < spec.group1; index += 1) {
    blocks.push(data.slice(offset, offset + spec.block1));
    offset += spec.block1;
  }
  for (let index = 0; index < spec.group2; index += 1) {
    blocks.push(data.slice(offset, offset + spec.block2));
    offset += spec.block2;
  }
  const ecBlocks = blocks.map(block => errorCorrection(block, spec.ecPerBlock));

  const result = [];
  const longest = Math.max(...blocks.map(block => block.length));
  for (let index = 0; index < longest; index += 1) {
    for (const block of blocks) if (index < block.length) result.push(block[index]);
  }
  for (let index = 0; index < spec.ecPerBlock; index += 1) {
    for (const block of ecBlocks) result.push(block[index]);
  }
  return { codewords: result, version: spec.version, dataCodewords: data };
}

const FORMAT_BITS = {
  /* Pre-computed format information for EC level M with each mask pattern. */
  0: 0x5412, 1: 0x5125, 2: 0x5e7c, 3: 0x5b4b, 4: 0x45f9, 5: 0x40ce, 6: 0x4f97, 7: 0x4aa0
};

/** Builds the module matrix: true means a dark module. */
export function buildMatrix(text, mask = 0) {
  const { codewords, version } = encodeCodewords(text);
  const size = version * 4 + 17;
  const matrix = Array.from({ length: size }, () => new Array(size).fill(null));

  const placeFinder = (row, column) => {
    for (let y = -1; y <= 7; y += 1) {
      for (let x = -1; x <= 7; x += 1) {
        const targetY = row + y;
        const targetX = column + x;
        if (targetY < 0 || targetY >= size || targetX < 0 || targetX >= size) continue;
        const inRing = (y >= 0 && y <= 6 && (x === 0 || x === 6)) || (x >= 0 && x <= 6 && (y === 0 || y === 6));
        const inCore = y >= 2 && y <= 4 && x >= 2 && x <= 4;
        matrix[targetY][targetX] = inRing || inCore;
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  for (let index = 8; index < size - 8; index += 1) {
    const dark = index % 2 === 0;
    matrix[6][index] = dark;
    matrix[index][6] = dark;
  }

  for (const row of ALIGNMENT[version]) {
    for (const column of ALIGNMENT[version]) {
      if (matrix[row][column] !== null) continue;
      for (let y = -2; y <= 2; y += 1) {
        for (let x = -2; x <= 2; x += 1) {
          matrix[row + y][column + x] = Math.max(Math.abs(y), Math.abs(x)) !== 1;
        }
      }
    }
  }

  matrix[size - 8][8] = true;                              /* fixed dark module */

  /* Reserve the format areas so data placement skips them. */
  const reserved = [];
  for (let index = 0; index <= 8; index += 1) {
    if (matrix[8][index] === null) { matrix[8][index] = false; reserved.push([8, index]); }
    if (matrix[index][8] === null) { matrix[index][8] = false; reserved.push([index, 8]); }
  }
  for (let index = 0; index < 8; index += 1) {
    if (matrix[8][size - 1 - index] === null) { matrix[8][size - 1 - index] = false; reserved.push([8, size - 1 - index]); }
    if (matrix[size - 1 - index][8] === null) { matrix[size - 1 - index][8] = false; reserved.push([size - 1 - index, 8]); }
  }
  const isReserved = (row, column) => reserved.some(([y, x]) => y === row && x === column);

  /* Zig-zag data placement, right to left, skipping the vertical timing column. */
  const bits = [];
  for (const codeword of codewords) {
    for (let index = 7; index >= 0; index -= 1) bits.push((codeword >> index) & 1);
  }
  let bitIndex = 0;
  let upward = true;
  for (let column = size - 1; column > 0; column -= 2) {
    if (column === 6) column -= 1;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const offset of [0, 1]) {
        const target = column - offset;
        if (matrix[row][target] !== null || isReserved(row, target)) continue;
        const bit = bitIndex < bits.length ? bits[bitIndex++] : 0;
        const maskOn = maskAt(mask, row, target);
        matrix[row][target] = (bit === 1) !== maskOn ? true : false;
      }
    }
    upward = !upward;
  }

  /* Write the format information over the reserved areas. */
  const format = FORMAT_BITS[mask];
  for (let index = 0; index <= 5; index += 1) matrix[8][index] = ((format >> (14 - index)) & 1) === 1;
  matrix[8][7] = ((format >> 8) & 1) === 1;
  matrix[8][8] = ((format >> 7) & 1) === 1;
  matrix[7][8] = ((format >> 6) & 1) === 1;
  for (let index = 9; index <= 14; index += 1) matrix[14 - index][8] = ((format >> (14 - index)) & 1) === 1;
  for (let index = 0; index <= 7; index += 1) matrix[size - 1 - index][8] = ((format >> index) & 1) === 1;
  for (let index = 8; index <= 14; index += 1) matrix[8][size - 15 + index] = ((format >> index) & 1) === 1;
  matrix[size - 8][8] = true;

  return matrix.map(row => row.map(cell => cell === true));
}

function maskAt(mask, row, column) {
  switch (mask) {
    case 0: return (row + column) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return column % 3 === 0;
    case 3: return (row + column) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0;
    case 5: return ((row * column) % 2) + ((row * column) % 3) === 0;
    case 6: return (((row * column) % 2) + ((row * column) % 3)) % 2 === 0;
    default: return (((row + column) % 2) + ((row * column) % 3)) % 2 === 0;
  }
}

/** Renders the payload as an SVG path string, sized in modules with a quiet zone. */
export function toSvg(text, { scale = 4, quiet = 4 } = {}) {
  const matrix = buildMatrix(text);
  const size = matrix.length;
  const total = (size + quiet * 2) * scale;
  let path = '';
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (!matrix[row][column]) continue;
      path += `M${(column + quiet) * scale} ${(row + quiet) * scale}h${scale}v${scale}h-${scale}z`;
    }
  }
  return { path, total };
}
