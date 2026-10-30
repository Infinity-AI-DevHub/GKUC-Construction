/** Completion is an explicit stage, never inferred from progress alone. */
export function projectCompletion(body, before = {}) {
  const stage = body.stage ?? before.stage;
  if (stage === 'Completed') return { ...body, stage: 'Completed', health: 'Completed', progress: 100, site_status: 'Completed' };
  if (body.health === 'Completed') throw Object.assign(new Error('Mark the project stage Completed to use Completed health.'), { status: 400 });
  if (before.stage === 'Completed' && body.stage && body.stage !== 'Completed') {
    return { ...body, health: body.health || 'On track', site_status: 'Active' };
  }
  return body;
}
