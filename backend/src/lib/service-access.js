import { getOne } from '../db.js';

export const PAYMENT_OVERDUE_CODE = 'PAYMENT_OVERDUE';
export const DEFAULT_PAYMENT_MESSAGE = 'Access to GKUC SiteOps has been temporarily suspended because the outstanding service payment has not been received. Please complete the payment to continue with the services.';

let cached = null;
let cachedAt = 0;
const CACHE_MS = 2000;

export async function getServiceAccessState({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cachedAt < CACHE_MS) return cached;
  const row = await getOne(`SELECT status,message,changed_at changedAt
    FROM system_access_state WHERE id=1`);
  cached = {
    status: row?.status === 'payment_overdue' ? 'payment_overdue' : 'active',
    message: row?.message || DEFAULT_PAYMENT_MESSAGE,
    changedAt: row?.changedAt || null
  };
  cachedAt = Date.now();
  return cached;
}

export async function serviceAccessMiddleware(req, res, next) {
  try {
    const state = await getServiceAccessState();
    if (state.status !== 'payment_overdue') return next();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(423).json({
      error: state.message,
      code: PAYMENT_OVERDUE_CODE,
      serviceAccess: state
    });
  } catch (error) {
    return next(error);
  }
}
