import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, nextReference, pool, query, transaction } from '../db.js';
import { auth, permit, validate, wrap } from '../lib/http.js';
import { notify } from '../alerts.js';

const router = Router();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/* Suppliers */
router.get('/suppliers', auth, permit('store.view','store.manage','finance.pay'), wrap(async (_req, res) => res.json(await query(`SELECT s.id,s.name,s.contact_person contact,s.phone,s.email,s.address,
  (SELECT COUNT(*) FROM purchase_orders o WHERE o.supplier_id=s.id) orders,
  (SELECT COALESCE(SUM(i.amount-i.paid_amount),0) FROM supplier_invoices i WHERE i.supplier_id=s.id AND i.status<>'Paid') outstanding
  FROM suppliers s WHERE s.active=1 ORDER BY s.name`))));

router.post('/suppliers', auth, permit('store.manage', 'finance.pay'), validate(z.object({
  name: z.string().min(2).max(180),
  contact: z.string().max(120).optional(),
  phone: z.string().max(40).optional(),
  email: z.string().email().optional().or(z.literal('')),
  address: z.string().max(400).optional()
})), wrap(async (req, res) => {
  const body = req.body;
  const result = await query('INSERT INTO suppliers (name,contact_person,phone,email,address) VALUES (?,?,?,?,?)',
    [body.name, body.contact || null, body.phone || null, body.email || null, body.address || null]);
  const row = await getOne('SELECT * FROM suppliers WHERE id=?', [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'supplier', row.id, null, row, req.ip);
  res.status(201).json(row);
}));

/* Purchase requests */
const requestList = `SELECT r.id,r.reference,r.status,r.needed_by neededBy,r.notes,r.created_at createdAt,
  r.project_id projectId,p.name project,u.name requestedBy,
  (SELECT COUNT(*) FROM purchase_request_items i WHERE i.request_id=r.id) lineCount,
  (SELECT COALESCE(SUM(i.quantity*i.estimated_rate),0) FROM purchase_request_items i WHERE i.request_id=r.id) estimate
  FROM purchase_requests r JOIN projects p ON p.id=r.project_id JOIN users u ON u.id=r.requested_by`;

router.get('/requests', auth, permit('store.view','store.manage'), wrap(async (_req, res) => res.json(await query(`${requestList} ORDER BY r.id DESC`))));

router.get('/requests/:id', auth, permit('store.view','store.manage'), wrap(async (req, res) => {
  const request = await getOne(`${requestList} WHERE r.id=?`, [req.params.id]);
  if (!request) return res.status(404).json({ error: 'Purchase request not found' });
  const [items, quotes] = await Promise.all([
    query(`SELECT i.id,i.description,i.unit,i.quantity,i.estimated_rate estimatedRate,i.material_id materialId,m.name material
      FROM purchase_request_items i LEFT JOIN materials m ON m.id=i.material_id WHERE i.request_id=?`, [request.id]),
    query(`SELECT q.id,q.amount,q.lead_time_days leadTimeDays,q.notes,q.selected,s.name supplier,s.id supplierId
      FROM quotations q JOIN suppliers s ON s.id=q.supplier_id WHERE q.request_id=? ORDER BY q.amount`, [request.id])
  ]);
  res.json({ ...request, items, quotes });
}));

router.post('/requests', auth, permit('store.manage'), validate(z.object({
  projectId: z.number().int().positive(),
  neededBy: isoDate,
  notes: z.string().max(600).optional(),
  items: z.array(z.object({
    materialId: z.number().int().positive().optional(),
    description: z.string().min(2).max(300),
    unit: z.string().min(1).max(30),
    quantity: z.number().positive(),
    estimatedRate: z.number().nonnegative().default(0)
  })).min(1)
})), wrap(async (req, res) => {
  const body = req.body;
  const reference = await nextReference('PR', 'purchase_requests');
  const id = await transaction(async connection => {
    const [result] = await connection.execute('INSERT INTO purchase_requests (reference,project_id,needed_by,notes,requested_by) VALUES (?,?,?,?,?)',
      [reference, body.projectId, body.neededBy, body.notes || null, req.user.id]);
    for (const item of body.items) {
      await connection.execute('INSERT INTO purchase_request_items (request_id,material_id,description,unit,quantity,estimated_rate) VALUES (?,?,?,?,?,?)',
        [result.insertId, item.materialId || null, item.description, item.unit, item.quantity, item.estimatedRate]);
    }
    await audit(connection, req.user.id, 'CREATE', 'purchase_request', result.insertId, null, { reference, ...body }, req.ip);
    return result.insertId;
  });
  await notify({
    audience: 'store.manage',
    severity: 'Info',
    title: `Purchase request ${reference} needs approval`,
    message: `${req.user.name} raised ${reference} for ${body.items.length} line(s), needed by ${body.neededBy}.`,
    referenceType: 'purchase_request',
    referenceId: id
  });
  res.status(201).json(await getOne(`${requestList} WHERE r.id=?`, [id]));
}));

router.patch('/requests/:id', auth, permit('projects.manage'), validate(z.object({
  status: z.enum(['Pending', 'Approved', 'Rejected'])
})), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM purchase_requests WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Purchase request not found' });
  if (before.status === 'Ordered') return res.status(409).json({ error: 'This request has already been ordered' });
  await query('UPDATE purchase_requests SET status=?,decided_by=?,decided_at=UTC_TIMESTAMP() WHERE id=?', [req.body.status, req.user.id, req.params.id]);
  const after = await getOne(`${requestList} WHERE r.id=?`, [req.params.id]);
  await audit(pool, req.user.id, req.body.status.toUpperCase(), 'purchase_request', after.id, before, after, req.ip);
  res.json(after);
}));

router.post('/requests/:id/quotations', auth, permit('store.manage', 'finance.pay'), validate(z.object({
  supplierId: z.number().int().positive(),
  amount: z.number().positive(),
  leadTimeDays: z.number().int().nonnegative().default(0),
  notes: z.string().max(600).optional()
})), wrap(async (req, res) => {
  const body = req.body;
  try {
    const result = await query('INSERT INTO quotations (request_id,supplier_id,amount,lead_time_days,notes) VALUES (?,?,?,?,?)',
      [req.params.id, body.supplierId, body.amount, body.leadTimeDays, body.notes || null]);
    const row = await getOne('SELECT * FROM quotations WHERE id=?', [result.insertId]);
    await audit(pool, req.user.id, 'CREATE', 'quotation', row.id, null, row, req.ip);
    res.status(201).json(row);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That supplier has already quoted for this request' });
    throw error;
  }
}));

/* Purchase orders */
const orderList = `SELECT o.id,o.reference,o.status,o.order_date orderDate,o.total,o.project_id projectId,
  p.name project,s.name supplier,s.id supplierId,u.name issuedBy,o.request_id requestId
  FROM purchase_orders o JOIN projects p ON p.id=o.project_id JOIN suppliers s ON s.id=o.supplier_id JOIN users u ON u.id=o.issued_by`;

router.get('/orders', auth, permit('store.view','store.manage','finance.pay'), wrap(async (_req, res) => res.json(await query(`${orderList} ORDER BY o.id DESC`))));

router.get('/orders/:id', auth, permit('store.view','store.manage','finance.pay'), wrap(async (req, res) => {
  const order = await getOne(`${orderList} WHERE o.id=?`, [req.params.id]);
  if (!order) return res.status(404).json({ error: 'Purchase order not found' });
  const [items, invoices] = await Promise.all([
    query(`SELECT i.id,i.description,i.unit,i.quantity,i.rate,i.received_quantity receivedQuantity,i.material_id materialId
      FROM purchase_order_items i WHERE i.order_id=?`, [order.id]),
    query('SELECT id,invoice_no invoiceNo,amount,paid_amount paidAmount,invoice_date invoiceDate,due_date dueDate,status FROM supplier_invoices WHERE order_id=?', [order.id])
  ]);
  res.json({ ...order, items, invoices });
}));

router.post('/orders', auth, permit('store.manage', 'finance.pay'), validate(z.object({
  requestId: z.number().int().positive().optional(),
  supplierId: z.number().int().positive(),
  projectId: z.number().int().positive(),
  orderDate: isoDate,
  items: z.array(z.object({
    materialId: z.number().int().positive().optional(),
    description: z.string().min(2).max(300),
    unit: z.string().min(1).max(30),
    quantity: z.number().positive(),
    rate: z.number().nonnegative()
  })).min(1)
})), wrap(async (req, res) => {
  const body = req.body;
  const reference = await nextReference('PO', 'purchase_orders');
  const total = body.items.reduce((sum, item) => sum + item.quantity * item.rate, 0);
  const id = await transaction(async connection => {
    const [result] = await connection.execute(`INSERT INTO purchase_orders (reference,request_id,supplier_id,project_id,order_date,total,issued_by)
      VALUES (?,?,?,?,?,?,?)`, [reference, body.requestId || null, body.supplierId, body.projectId, body.orderDate, total, req.user.id]);
    for (const item of body.items) {
      await connection.execute('INSERT INTO purchase_order_items (order_id,material_id,description,unit,quantity,rate) VALUES (?,?,?,?,?,?)',
        [result.insertId, item.materialId || null, item.description, item.unit, item.quantity, item.rate]);
    }
    if (body.requestId) await connection.execute("UPDATE purchase_requests SET status='Ordered' WHERE id=?", [body.requestId]);
    await audit(connection, req.user.id, 'CREATE', 'purchase_order', result.insertId, null, { reference, total, ...body }, req.ip);
    return result.insertId;
  });
  res.status(201).json(await getOne(`${orderList} WHERE o.id=?`, [id]));
}));

/**
 * Goods received: stock rises, the order line records what actually arrived and the
 * project is charged — the three steps that used to be done separately, or not at all.
 */
router.post('/orders/:id/receive', auth, permit('store.manage'), validate(z.object({
  lines: z.array(z.object({ itemId: z.number().int().positive(), quantity: z.number().positive() })).min(1),
  notes: z.string().max(500).optional()
})), wrap(async (req, res) => {
  try {
    const order = await transaction(async connection => {
      const [orders] = await connection.execute('SELECT * FROM purchase_orders WHERE id=? FOR UPDATE', [req.params.id]);
      const current = orders[0];
      if (!current) throw Object.assign(new Error('Purchase order not found'), { status: 404 });
      if (current.status === 'Cancelled') throw Object.assign(new Error('This order was cancelled'), { status: 409 });

      let receivedValue = 0;
      for (const line of req.body.lines) {
        const [items] = await connection.execute('SELECT * FROM purchase_order_items WHERE id=? AND order_id=? FOR UPDATE', [line.itemId, current.id]);
        const item = items[0];
        if (!item) throw Object.assign(new Error('Order line not found'), { status: 404 });
        const outstanding = Number(item.quantity) - Number(item.received_quantity);
        if (line.quantity > outstanding) throw Object.assign(new Error(`Cannot receive more than the ${outstanding} ${item.unit} outstanding on "${item.description}"`), { status: 409 });
        await connection.execute('UPDATE purchase_order_items SET received_quantity=received_quantity+? WHERE id=?', [line.quantity, item.id]);
        receivedValue += line.quantity * Number(item.rate);
        if (item.material_id) {
          await connection.execute('UPDATE materials SET stock=stock+?, unit_cost=? WHERE id=?', [line.quantity, item.rate, item.material_id]);
          await connection.execute(`INSERT INTO stock_movements (material_id,movement_type,quantity,reference,notes,project_id,user_id)
            VALUES (?,'Receipt',?,?,?,?,?)`, [item.material_id, line.quantity, current.reference, req.body.notes || 'Goods received', current.project_id, req.user.id]);
        }
      }

      const [remaining] = await connection.execute('SELECT SUM(quantity-received_quantity) outstanding FROM purchase_order_items WHERE order_id=?', [current.id]);
      const status = Number(remaining[0].outstanding) <= 0 ? 'Received' : 'Partially received';
      await connection.execute('UPDATE purchase_orders SET status=? WHERE id=?', [status, current.id]);
      await connection.execute('INSERT INTO goods_receipts (order_id,received_by,notes) VALUES (?,?,?)', [current.id, req.user.id, req.body.notes || null]);
      if (receivedValue > 0) {
        await connection.execute(`INSERT INTO expenses (project_id,source,description,amount,expense_date,reference,origin_type,origin_id,created_by)
          VALUES (?,'Material',?,?,CURDATE(),?, 'purchase_order', ?, ?)`,
        [current.project_id, `Goods received against ${current.reference}`, receivedValue, current.reference, String(current.id), req.user.id]);
      }
      await audit(connection, req.user.id, 'GOODS_RECEIVED', 'purchase_order', current.id, current, { status, receivedValue }, req.ip);
      return { ...current, status };
    });
    res.json(await getOne(`${orderList} WHERE o.id=?`, [order.id]));
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    throw error;
  }
}));

/* Supplier invoices and payments */
router.get('/invoices', auth, permit('finance.view','finance.pay'), wrap(async (_req, res) => res.json(await query(`SELECT i.id,i.invoice_no invoiceNo,i.amount,i.paid_amount paidAmount,
  i.invoice_date invoiceDate,i.due_date dueDate,i.status,s.name supplier,o.reference orderReference
  FROM supplier_invoices i JOIN suppliers s ON s.id=i.supplier_id LEFT JOIN purchase_orders o ON o.id=i.order_id ORDER BY i.id DESC`))));

router.post('/invoices', auth, permit('finance.pay'), validate(z.object({
  orderId: z.number().int().positive().optional(),
  supplierId: z.number().int().positive(),
  invoiceNo: z.string().min(1).max(80),
  amount: z.number().positive(),
  invoiceDate: isoDate,
  dueDate: isoDate.optional()
})), wrap(async (req, res) => {
  const body = req.body;
  try {
    const result = await query('INSERT INTO supplier_invoices (order_id,supplier_id,invoice_no,amount,invoice_date,due_date,recorded_by) VALUES (?,?,?,?,?,?,?)',
      [body.orderId || null, body.supplierId, body.invoiceNo, body.amount, body.invoiceDate, body.dueDate || null, req.user.id]);
    const row = await getOne('SELECT * FROM supplier_invoices WHERE id=?', [result.insertId]);
    await audit(pool, req.user.id, 'CREATE', 'supplier_invoice', row.id, null, row, req.ip);
    res.status(201).json(row);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That invoice number is already recorded for this supplier' });
    throw error;
  }
}));

router.post('/invoices/:id/payments', auth, permit('finance.pay'), validate(z.object({
  amount: z.number().positive(),
  paidDate: isoDate,
  method: z.enum(['Cash', 'Cheque', 'Bank transfer', 'Card']).default('Bank transfer'),
  reference: z.string().max(120).optional()
})), wrap(async (req, res) => {
  try {
    const invoice = await transaction(async connection => {
      const [rows] = await connection.execute('SELECT * FROM supplier_invoices WHERE id=? FOR UPDATE', [req.params.id]);
      const current = rows[0];
      if (!current) throw Object.assign(new Error('Invoice not found'), { status: 404 });
      const paid = Number(current.paid_amount) + req.body.amount;
      if (paid > Number(current.amount) + 0.001) throw Object.assign(new Error('Payment exceeds the invoice balance'), { status: 409 });
      const status = paid >= Number(current.amount) - 0.001 ? 'Paid' : 'Partially paid';
      await connection.execute('UPDATE supplier_invoices SET paid_amount=?,status=? WHERE id=?', [paid, status, current.id]);
      await connection.execute('INSERT INTO supplier_payments (invoice_id,amount,paid_date,method,reference,created_by) VALUES (?,?,?,?,?,?)',
        [current.id, req.body.amount, req.body.paidDate, req.body.method, req.body.reference || null, req.user.id]);
      await audit(connection, req.user.id, 'PAYMENT', 'supplier_invoice', current.id, current, { paid, status }, req.ip);
      return { ...current, paid_amount: paid, status };
    });
    res.status(201).json(invoice);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    throw error;
  }
}));

export default router;
