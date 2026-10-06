import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestedCost } from '../../frontend/src/cost-suggestion.js';

test('daily cost suggestion calculates quantity by rate without inventing missing values', () => {
  assert.equal(suggestedCost('34', '1000'), 34000);
  assert.equal(suggestedCost('1.25', '100.10'), 125.13);
  assert.equal(suggestedCost('', '1000'), null);
  assert.equal(suggestedCost('34', ''), null);
  assert.equal(suggestedCost('not a number', '1000'), null);
});
