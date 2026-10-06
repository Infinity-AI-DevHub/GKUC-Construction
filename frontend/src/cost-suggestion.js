/** A convenience only: the recorded cost remains whatever the user explicitly chooses. */
export function suggestedCost(quantity, unitRate) {
  if (quantity === '' || quantity === null || quantity === undefined
    || unitRate === '' || unitRate === null || unitRate === undefined) return null;
  const quantityNumber = Number(quantity);
  const rateNumber = Number(unitRate);
  if (!Number.isFinite(quantityNumber) || !Number.isFinite(rateNumber)
    || quantityNumber < 0 || rateNumber < 0) return null;
  return Math.round((quantityNumber * rateNumber + Number.EPSILON) * 100) / 100;
}
