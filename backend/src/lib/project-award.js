import { getOne } from '../db.js';

export async function projectAwardState(projectId) {
  const project = await getOne('SELECT id,active FROM projects WHERE id=?', [projectId]);
  if (!project || !project.active) return null;
  const formal = await getOne(`SELECT a.award_date awardDate,a.reference,a.notes,u.name recordedBy
    FROM project_awards a JOIN users u ON u.id=a.recorded_by WHERE a.project_id=?`, [projectId]);
  const accepted = await getOne(`SELECT id,reference,quote_date quoteDate FROM quotations_client
    WHERE project_id=? AND status='Accepted' ORDER BY id DESC LIMIT 1`, [projectId]);
  return { confirmed: Boolean(formal || accepted), formalAward: formal || null, acceptedQuotation: accepted || null };
}
