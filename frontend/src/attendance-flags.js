export function missingCheckout(row){
  return Boolean(row.in&&!row.out&&!['Absent','On leave','Business trip'].includes(row.state));
}
