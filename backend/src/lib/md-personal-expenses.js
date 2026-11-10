import {audit} from '../db.js';
import {fail} from './http.js';

/** Link metadata to the original payment; never create a second expense or cash movement. */
export async function linkMdPersonal(connection,user,source,paymentId,category,notes,ip,paidBy){
 const petty=source==='Petty cash';
 const [[payment]]=await connection.query(petty?`SELECT e.*,f.account_type FROM petty_cash_entries e JOIN petty_cash_floats f ON f.id=e.float_id WHERE e.id=? FOR UPDATE`:'SELECT * FROM office_expense_payments WHERE id=? FOR UPDATE',[paymentId]);
 if(!payment)throw fail(404,'Payment not found.');
 if(petty){
  if(payment.kind!=='Spend'||Number(payment.amount)>=0||payment.account_type!=='Office expenses'||payment.project_id||payment.employee_id||payment.fuel_record_id)throw fail(400,'MD personal expenses require an office petty-cash spend without a project, salary advance or vehicle fuel link.');
  const [[supplier]]=await connection.query('SELECT id FROM supplier_payments WHERE petty_cash_entry_id=? LIMIT 1',[paymentId]);
  const [[cost]]=await connection.query("SELECT id FROM expenses WHERE origin_type='petty_cash' AND origin_id=? LIMIT 1",[String(paymentId)]);
  if(supplier||cost)throw fail(409,'This payment already settles a supplier or project cost. It cannot also become an MD personal expense.');
 }
 try{
  const [saved]=await connection.query('INSERT INTO md_personal_expenses(petty_cash_entry_id,office_payment_id,category,notes,created_by,paid_by) VALUES (?,?,?,?,?,?)',[petty?paymentId:null,petty?null:paymentId,category,notes||null,user.id,paidBy||null]);
  await audit(connection,user.id,'CREATE','md_personal_expense',saved.insertId,null,{beneficiary:'Mr. Gihan',source,paymentId,category,notes:notes||null,paidBy:paidBy||null},ip);
  return saved.insertId;
 }catch(error){if(error.code==='ER_DUP_ENTRY')throw fail(409,'This payment is already in the MD Personal Expenses register.');throw error;}
}
