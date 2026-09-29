export function requestSteps(request) {
  const orders = request.orders || [];
  const approved = ['Approved', 'Ordered'].includes(request.status);
  const ordered = orders.some(order => order.status !== 'Cancelled');
  const received = orders.some(order => order.status === 'Received');
  const invoiced = orders.some(order => Number(order.invoiceCount) > 0);
  const verified = invoiced && orders.every(order => Number(order.invoiceCount) === Number(order.verifiedInvoiceCount));
  const settled = invoiced && orders.every(order => Number(order.unpaidInvoiceCount) === 0);
  return [
    { label: 'Purchase request', owner: 'Store', done: true, detail: `${request.reference} recorded` },
    { label: 'Approval', owner: 'Project management', done: approved, detail: approved ? 'Request approved' : request.status === 'Rejected' ? 'Returned or rejected; revise the request' : 'Awaiting a decision' },
    { label: 'Supplier quotations', owner: 'Purchasing', done: (request.quotes || []).length > 0, skipped: ordered && !(request.quotes || []).length, detail: `${(request.quotes || []).length} supplier offer${(request.quotes || []).length === 1 ? '' : 's'} recorded` },
    { label: 'Purchase order', owner: 'Purchasing', done: ordered, detail: ordered ? orders[0].reference : 'Create an order from the approved request', href: '/materials/orders', action: 'Create order' },
    { label: 'Goods received', owner: 'Store', done: received, detail: received?'Ordered quantities received':'Record actual delivery against the order', href: orders[0] ? `/materials/orders?record=${orders[0].id}` : undefined },
    { label: 'Invoice verified', owner: 'Finance', done: verified, detail: verified ? 'All linked invoices independently matched to receipts' : invoiced ? 'Linked invoice awaits independent three-way verification' : 'Match supplier invoice to the order and receipt', href: '/finance/supplier-invoices' },
    { label: 'Payment', owner: 'Finance', done: settled, detail: settled?'Supplier invoices paid':'Pay the matched supplier invoice', href: '/finance/supplier-invoices' }
  ];
}

export function orderSteps(order) {
  const invoices = order.invoices || [];
  const received = (order.receipts || []).length > 0;
  const fullyReceived = order.status === 'Received';
  const paid = invoices.length > 0 && invoices.every(invoice => invoice.status === 'Paid');
  const verified = invoices.length > 0 && invoices.every(invoice => Boolean(invoice.verifiedAt));
  return [
    { label: 'Purchase request', owner: 'Store', done: Boolean(order.requestId), skipped: !order.requestId, detail: order.requestId ? 'Linked to a request' : 'Direct purchase — no request linked' },
    { label: 'Approval', owner: 'Project management', done: order.status !== 'Pending approval', detail: order.status === 'Pending approval' ? 'Independent approval is required' : 'Order authorised' },
    { label: 'Supplier quotations', owner: 'Purchasing', done: Boolean(order.requestId), skipped: !order.requestId, detail: order.requestId ? 'See the linked request for supplier offers' : 'No supplier quotation was linked' },
    { label: 'Purchase order', owner: 'Purchasing', done: order.status !== 'Pending approval', detail: order.reference },
    { label: 'Goods received', owner: 'Store', done: received && fullyReceived, detail: fullyReceived ? 'All ordered quantities received' : received ? 'Partially received — record the rest' : 'No goods receipt recorded' },
    { label: 'Invoice verified', owner: 'Finance', done: verified, detail: verified ? `${invoices.length} supplier invoice${invoices.length === 1 ? '' : 's'} independently verified` : invoices.length ? 'Verify each linked invoice against the order and goods receipt' : 'Match invoice, order and goods receipt', href: '/finance/supplier-invoices', action: 'Verify invoice' },
    { label: 'Payment', owner: 'Finance', done: paid, detail: paid ? 'Supplier invoices paid' : 'Pay only after invoice verification', href: '/finance/supplier-invoices', action: 'Open payables' }
  ];
}
