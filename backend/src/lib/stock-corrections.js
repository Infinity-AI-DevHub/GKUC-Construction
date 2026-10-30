export const stockEffect = movement => (['Receipt','Return'].includes(movement.type || movement.movement_type) ? 1 : -1) * Number(movement.quantity);

/** Preserve the opening balance and replay the corrected movement in its original order. */
export function correctedStock(currentStock, history, movementId, replacement) {
  let balance = Number(currentStock) - history.reduce((sum,row)=>sum+stockEffect(row),0);
  for (const row of history) {
    balance += stockEffect(Number(row.id) === Number(movementId) ? replacement : row);
    if (balance < -0.0001) throw Object.assign(new Error('This correction would leave insufficient stock at this point in the movement history.'),{status:409});
  }
  return Math.round(balance*1000)/1000;
}
