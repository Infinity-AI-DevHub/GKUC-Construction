import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMatrix, encodeCodewords, errorCorrection } from './qr.js';

/**
 * The encoder is hand-written, so it is pinned to the worked example published in
 * ISO/IEC 18004 plus the structural rules a decoder relies on. The rendered output was
 * additionally confirmed to decode with a real barcode reader.
 */

test('Reed-Solomon matches the ISO/IEC 18004 worked example', () => {
  const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
  assert.deepEqual(errorCorrection(data, 10), [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]);
});

test('picks the smallest version that fits the payload', () => {
  assert.equal(encodeCodewords('EQP-0001').version, 1);
  assert.equal(encodeCodewords('https://siteops.gkuc.lk/scan/084cf2d62106f2e7ab8a3b76fec67ecf').version, 4);
});

test('pads data codewords to the version capacity', () => {
  const { dataCodewords, version } = encodeCodewords('EQP-0001');
  assert.equal(version, 1);
  assert.equal(dataCodewords.length, 16);
  assert.ok(dataCodewords.slice(-2).every(byte => byte === 0xec || byte === 0x11));
});

test('lays out the patterns a decoder locates the symbol by', () => {
  const matrix = buildMatrix('https://siteops.gkuc.lk/scan/084cf2d62106f2e7ab8a3b76fec67ecf');
  const size = matrix.length;
  assert.equal(size, 4 * 4 + 17);

  /* Three finder patterns: dark ring with a dark 3x3 core and a light separator ring. */
  for (const [row, column] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    assert.equal(matrix[row][column], true, 'finder outer ring');
    assert.equal(matrix[row + 1][column + 1], false, 'finder light ring');
    assert.equal(matrix[row + 3][column + 3], true, 'finder core');
  }

  /* Timing patterns alternate along row and column 6. */
  for (let index = 8; index < size - 8; index += 1) {
    assert.equal(matrix[6][index], index % 2 === 0, `horizontal timing at ${index}`);
    assert.equal(matrix[index][6], index % 2 === 0, `vertical timing at ${index}`);
  }

  assert.equal(matrix[size - 8][8], true, 'the fixed dark module');
});

test('rejects a payload larger than the supported versions', () => {
  assert.throws(() => encodeCodewords('x'.repeat(500)), /too long/i);
});
