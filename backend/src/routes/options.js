import { Router } from 'express';
import { z } from 'zod';
import { pool, query, getOne, audit } from '../db.js';
import { auth, permit, validate, fail } from '../lib/http.js';
import { allOptions, forgetOptions, addOption } from '../lib/options.js';
import { publishChange } from '../lib/realtime.js';

const router = Router();

/*
 * Every list, for building the dropdowns.
 *
 * Readable by anybody signed in: these are the choices the interface offers, and a person
 * who cannot see them cannot fill in a form. Changing them is a different matter and needs
 * the permission below.
 */
router.get('/options', auth, async (_req, res, next) => {
  try {
    res.json(await allOptions());
  } catch (error) { next(error); }
});

const nameSchema = z.object({ value: z.string().trim().min(1).max(120) });

/** Adds a choice to a list. */
router.post('/options/:listKey', auth, permit('admin.lists'), validate(nameSchema),
  async (req, res, next) => {
    try {
      const result = await addOption(req.params.listKey, req.body.value, req.user.id);
      if (!result.ok) throw fail(400, result.error);
      await audit(pool, req.user.id, result.restored ? 'RESTORE' : 'CREATE', 'option_value',
        `${req.params.listKey}:${req.body.value}`, null, { list: req.params.listKey, value: req.body.value }, req.ip);
      publishChange('options', { list: req.params.listKey });
      res.status(201).json(await allOptions());
    } catch (error) { next(error); }
  });

/**
 * Renames an option, or takes it out of use.
 *
 * Renaming updates the records that carry it, so a report on last year still reads
 * correctly rather than showing a name nobody recognises any more.
 */
const editSchema = z.object({
  value: z.string().trim().min(1).max(120).optional(),
  active: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(9999).optional()
});

/* Which column each list feeds, so a rename can carry through to the records using it. */
const BACKING = {
  'boq.category': ['boq_items', 'category'],
  'expense.source': ['expenses', 'source'],
  'income.method': ['incomes', 'method'],
  'leave.type': ['leave_requests', 'leave_type'],
  'vehicle.document': ['vehicle_documents', 'doc_type'],
  'vehicle.maintenance': ['vehicle_maintenance', 'maintenance_type'],
  'client.channel': ['client_communications', 'channel']
};

router.patch('/options/:listKey/:id', auth, permit('admin.lists'), validate(editSchema),
  async (req, res, next) => {
    try {
      const option = await getOne('SELECT * FROM option_values WHERE id=? AND list_key=?',
        [req.params.id, req.params.listKey]);
      if (!option) throw fail(404, 'That option was not found');

      if (option.locked && (req.body.value !== undefined || req.body.active === false)) {
        throw fail(409, `The system reads "${option.value}" by name to decide what to do — payroll and `
          + 'similar work depend on it. It can be reordered, but not renamed or turned off.');
      }

      const renamed = req.body.value !== undefined && req.body.value !== option.value;
      if (renamed) {
        const clash = await getOne('SELECT id FROM option_values WHERE list_key=? AND value=? AND id<>?',
          [req.params.listKey, req.body.value, option.id]);
        if (clash) throw fail(409, `"${req.body.value}" is already on this list`);
      }

      await query('UPDATE option_values SET value=?, active=?, sort_order=? WHERE id=?', [
        req.body.value ?? option.value,
        req.body.active === undefined ? option.active : (req.body.active ? 1 : 0),
        req.body.sortOrder ?? option.sort_order,
        option.id
      ]);

      /* Carry the new name onto the records that already use the old one. */
      if (renamed && BACKING[req.params.listKey]) {
        const [table, column] = BACKING[req.params.listKey];
        await query(`UPDATE ${table} SET ${column}=? WHERE ${column}=?`, [req.body.value, option.value]);
      }

      forgetOptions();
      await audit(pool, req.user.id, 'UPDATE', 'option_value', option.id,
        { value: option.value, active: Boolean(option.active) },
        { value: req.body.value ?? option.value, active: req.body.active }, req.ip);
      publishChange('options', { list: req.params.listKey });
      res.json(await allOptions());
    } catch (error) { next(error); }
  });

/**
 * Removes an option the company added.
 *
 * Only if nothing uses it, and never one that came with the system: a value already on
 * records cannot be taken away without leaving those records referring to nothing. Retire
 * it instead, which stops it being offered while leaving history intact.
 */
router.delete('/options/:listKey/:id', auth, permit('admin.lists'), async (req, res, next) => {
  try {
    const option = await getOne('SELECT * FROM option_values WHERE id=? AND list_key=?',
      [req.params.id, req.params.listKey]);
    if (!option) throw fail(404, 'That option was not found');
    if (option.is_system) {
      throw fail(409, 'This option came with the system. Turn it off instead of deleting it, '
        + 'so records that already use it still read correctly.');
    }

    const backing = BACKING[req.params.listKey];
    if (backing) {
      const [table, column] = backing;
      const [{ used }] = await query(`SELECT COUNT(*) used FROM ${table} WHERE ${column}=?`, [option.value]);
      if (used) {
        throw fail(409, `${used} record${used === 1 ? '' : 's'} already use "${option.value}". `
          + 'Turn it off instead, so those records still read correctly.');
      }
    }

    await query('DELETE FROM option_values WHERE id=?', [option.id]);
    forgetOptions();
    await audit(pool, req.user.id, 'DELETE', 'option_value', option.id,
      { list: req.params.listKey, value: option.value }, null, req.ip);
    publishChange('options', { list: req.params.listKey });
    res.status(204).end();
  } catch (error) { next(error); }
});

export default router;
