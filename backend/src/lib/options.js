import { query, getOne } from '../db.js';

/*
 * The lists the company maintains itself.
 *
 * Kept in memory and refreshed when they change, because they are read on nearly every
 * write — validating a BOQ line, an expense, a leave request — and they change perhaps a
 * few times a year. Asking the database each time would be a query per field.
 */

let cache = null;

export async function allOptions() {
  if (cache) return cache;
  const lists = await query('SELECT list_key listKey,label,description,department FROM option_lists ORDER BY department,label');
  const values = await query(
    `SELECT list_key listKey,id,value,sort_order sortOrder,active,is_system isSystem,locked
     FROM option_values ORDER BY sort_order,value`);
  cache = lists.map(list => ({
    ...list,
    values: values.filter(value => value.listKey === list.listKey)
      .map(value => ({ ...value, active: Boolean(value.active), isSystem: Boolean(value.isSystem), locked: Boolean(value.locked) }))
  }));
  return cache;
}

export const forgetOptions = () => { cache = null; };

/** The choices currently offered for one list — retired ones are left out. */
export async function optionsFor(listKey) {
  const lists = await allOptions();
  const list = lists.find(entry => entry.listKey === listKey);
  return list ? list.values.filter(value => value.active).map(value => value.value) : [];
}

/**
 * Whether a value belongs to a list.
 *
 * A retired option still counts as valid on a record that already carries it, so this is
 * used to check what is being written, not what is being read back. Retiring "Cheque"
 * should stop it being chosen tomorrow, not invalidate every cheque received last year.
 */
export async function isValidOption(listKey, value) {
  if (value === null || value === undefined || value === '') return false;
  return (await optionsFor(listKey)).includes(String(value));
}

/**
 * Builds a Zod refinement that checks a value against a list at the moment of validation.
 *
 * A plain z.enum() would be fixed when the module loaded, which is exactly the problem
 * these lists exist to solve.
 */
export const optionSchema = (zod, listKey, message) => zod
  .refine(async value => isValidOption(listKey, value), {
    message: message || `Choose one of the options set up for this field`
  });

/** Adds a value to a list, or brings a retired one back. */
export async function addOption(listKey, value, userId) {
  const list = await getOne('SELECT list_key FROM option_lists WHERE list_key=?', [listKey]);
  if (!list) return { ok: false, error: 'That list does not exist' };

  const trimmed = String(value).trim();
  if (trimmed.length < 1 || trimmed.length > 120) return { ok: false, error: 'Type a name for the new option' };

  const existing = await getOne('SELECT id,active FROM option_values WHERE list_key=? AND value=?', [listKey, trimmed]);
  if (existing) {
    if (existing.active) return { ok: false, error: `"${trimmed}" is already on this list` };
    await query('UPDATE option_values SET active=1 WHERE id=?', [existing.id]);
    forgetOptions();
    return { ok: true, restored: true };
  }

  const [{ next }] = await query(
    'SELECT COALESCE(MAX(sort_order),0)+10 next FROM option_values WHERE list_key=?', [listKey]);
  await query('INSERT INTO option_values (list_key,value,sort_order,is_system,created_by) VALUES (?,?,?,0,?)',
    [listKey, trimmed, next, userId]);
  forgetOptions();
  return { ok: true };
}
