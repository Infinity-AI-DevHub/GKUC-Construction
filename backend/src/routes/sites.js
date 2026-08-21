import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, query, today, transaction } from '../db.js';
import { auth, permit, validate, wrap } from '../lib/http.js';
import { notify } from '../alerts.js';

const router = Router();

/**
 * PID v3 §3.5 and §4.3 — the Resource Availability View and the two-site scheduling problem.
 *
 * GKUC runs up to two sites at a time. When weather stops Site A, someone has to work out
 * who and what can move, and everyone affected has to be told. Today that is a series of
 * phone calls held together by the Coordinator's memory. Here, changing one site's status
 * is what carries the decision out: the people assigned to it are known, so they can be
 * notified, and deliveries booked to that site are flagged rather than arriving at an empty
 * plot.
 */

/** Everyone and everything currently committed to a site. */
async function assignedTo(projectId) {
  const [labour, vehicles, equipment] = await Promise.all([
    query(`SELECT e.id,e.name,e.designation,e.phone,t.project_role projectRole
      FROM project_team t JOIN employees e ON e.id=t.employee_id
      WHERE t.project_id=? AND t.released_at IS NULL ORDER BY e.name`, [projectId]),
    query(`SELECT f.id,f.vehicle,f.registration,f.driver,f.driver_employee_id driverEmployeeId
      FROM fleet f WHERE f.project_id=? ORDER BY f.vehicle`, [projectId]),
    query(`SELECT e.id,e.code,e.name,a.assigned_to assignedTo,a.id assignmentId
      FROM equipment_assignments a JOIN equipment e ON e.id=a.equipment_id
      WHERE a.project_id=? AND a.returned_at IS NULL ORDER BY e.code`, [projectId])
  ]);
  return { labour, vehicles, equipment };
}

/**
 * The whole picture in one call: every resource, where it is, and whether it is free.
 * "Committed" means assigned to a site that is still Active; a resource sitting on a
 * rescheduled site is available to move, which is exactly the decision being made.
 */
router.get('/resources/availability', auth, permit('resources.view'), wrap(async (_req, res) => {
  const [projects, labour, vehicles, equipment] = await Promise.all([
    query(`SELECT id,name,site,site_status siteStatus,status_reason statusReason
      FROM projects WHERE active=1 ORDER BY FIELD(site_status,'Active','On hold','Rescheduled','Completed'), id`),
    query(`SELECT e.id,e.code,e.name,e.designation,e.phone,e.status,
        t.project_id projectId,p.name project,p.site_status siteStatus,t.project_role projectRole
      FROM employees e
      LEFT JOIN project_team t ON t.employee_id=e.id AND t.released_at IS NULL
      LEFT JOIN projects p ON p.id=t.project_id
      WHERE e.status <> 'Left' ORDER BY e.name`),
    query(`SELECT f.id,f.vehicle,f.registration,f.status,f.driver,f.project_id projectId,
        p.name project,p.site_status siteStatus,e.name driverName
      FROM fleet f LEFT JOIN projects p ON p.id=f.project_id
      LEFT JOIN employees e ON e.id=f.driver_employee_id ORDER BY f.vehicle`),
    query(`SELECT eq.id,eq.code,eq.name,eq.category,eq.status,
        a.project_id projectId,p.name project,p.site_status siteStatus,a.assigned_to assignedTo
      FROM equipment eq
      LEFT JOIN equipment_assignments a ON a.equipment_id=eq.id AND a.returned_at IS NULL
      LEFT JOIN projects p ON p.id=a.project_id
      WHERE eq.status <> 'Retired' ORDER BY eq.code`)
  ]);

  /* A resource is committed only while the site holding it is genuinely running. */
  const state = row => {
    if (!row.projectId) return 'Free';
    return row.siteStatus === 'Active' ? 'Committed' : 'Available to move';
  };

  res.json({
    sites: projects,
    labour: labour.map(row => ({ ...row, availability: row.status === 'On leave' ? 'On leave' : state(row) })),
    drivers: vehicles.filter(row => row.driverName || row.driver)
      .map(row => ({ id: row.id, name: row.driverName || row.driver, vehicle: row.vehicle,
        registration: row.registration, projectId: row.projectId, project: row.project,
        availability: state(row) })),
    vehicles: vehicles.map(row => ({ ...row, availability: row.status === 'Repair' ? 'In repair' : state(row) })),
    equipment: equipment.map(row => ({ ...row, availability: row.status === 'Maintenance' ? 'In maintenance' : state(row) })),
    summary: {
      labourFree: labour.filter(row => !row.projectId && row.status !== 'On leave').length,
      vehiclesFree: vehicles.filter(row => !row.projectId && row.status !== 'Repair').length,
      equipmentFree: equipment.filter(row => !row.projectId && row.status !== 'Maintenance').length
    }
  });
}));

/**
 * Changing a site's status. This is the single action that carries out a reschedule: it
 * records why, tells everyone assigned where to go instead, and flags anything already
 * booked to arrive.
 */
router.post('/projects/:id/reschedule', auth, permit('projects.schedule'), validate(z.object({
  status: z.enum(['Active', 'Rescheduled', 'On hold', 'Completed']),
  reason: z.string().min(3).max(500),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  moveToProjectId: z.number().int().positive().optional()
})), wrap(async (req, res) => {
  const project = await getOne('SELECT * FROM projects WHERE id=?', [req.params.id]);
  if (!project) return res.status(404).json({ error: 'Site not found' });

  const destination = req.body.moveToProjectId
    ? await getOne('SELECT id,name FROM projects WHERE id=?', [req.body.moveToProjectId])
    : null;
  if (req.body.moveToProjectId && !destination) return res.status(404).json({ error: 'The destination site does not exist' });
  if (destination && destination.id === project.id) {
    return res.status(400).json({ error: 'A site cannot be rescheduled onto itself' });
  }

  const effectiveDate = req.body.effectiveDate || today();
  const affected = await assignedTo(project.id);

  const logId = await transaction(async connection => {
    await connection.execute(
      'UPDATE projects SET site_status=?, status_reason=?, status_changed_at=UTC_TIMESTAMP() WHERE id=?',
      [req.body.status, req.body.reason, project.id]);
    /* The site being moved to becomes the one that is running. */
    if (destination) await connection.execute("UPDATE projects SET site_status='Active' WHERE id=?", [destination.id]);

    const headcount = affected.labour.length + affected.vehicles.length + affected.equipment.length;
    const [log] = await connection.execute(
      `INSERT INTO site_status_log (project_id,from_status,to_status,reason,effective_date,notified,changed_by)
       VALUES (?,?,?,?,?,?,?)`,
      [project.id, project.site_status, req.body.status, req.body.reason, effectiveDate, headcount, req.user.id]);

    /*
     * Move what was on the site, and write down that it moved.
     *
     * The notices below tell the crew to report to the other site and the transport officer
     * that a lorry has been reassigned. Those messages were going out while the records
     * still showed everything sitting on the site that had just stopped — so the movement
     * history stayed empty and the destination never showed the people who had been sent
     * there. Saying it and doing it are now the same step.
     */
    if (destination) {
      const record = (type, id, name, reason) => connection.execute(
        `INSERT INTO resource_reassignments (resource_type,resource_id,resource_name,from_project_id,to_project_id,reason,moved_by)
         VALUES (?,?,?,?,?,?,?)`,
        [type, id, name, project.id, destination.id, reason, req.user.id]);

      const because = `${project.name} is ${req.body.status.toLowerCase()}: ${req.body.reason}`;

      for (const person of affected.labour) {
        await connection.execute('UPDATE project_team SET released_at=CURDATE() WHERE project_id=? AND employee_id=? AND released_at IS NULL',
          [project.id, person.id]);
        await connection.execute(
          `INSERT INTO project_team (project_id,employee_id,project_role) VALUES (?,?,?)
           ON DUPLICATE KEY UPDATE released_at=NULL`,
          [destination.id, person.id, person.projectRole || person.designation]);
        await connection.execute('UPDATE employees SET current_project_id=? WHERE id=?', [destination.id, person.id]);
        await record('Labour', person.id, person.name, because);
      }

      for (const vehicle of affected.vehicles) {
        await connection.execute("UPDATE fleet SET project_id=?, status='Assigned' WHERE id=?", [destination.id, vehicle.id]);
        await record('Vehicle', vehicle.id, `${vehicle.vehicle} (${vehicle.registration})`, because);
      }

      for (const item of affected.equipment) {
        await connection.execute('UPDATE equipment_assignments SET returned_at=CURDATE() WHERE id=?', [item.assignmentId]);
        await connection.execute(
          `INSERT INTO equipment_assignments (equipment_id,project_id,assigned_to,assigned_at,created_by)
           VALUES (?,?,?,CURDATE(),?)`, [item.id, destination.id, item.assignedTo || 'Site team', req.user.id]);
        await record('Equipment', item.id, `${item.code} ${item.name}`, because);
      }
    }

    await audit(connection, req.user.id, 'RESCHEDULE', 'project', project.id,
      { siteStatus: project.site_status }, { siteStatus: req.body.status, reason: req.body.reason }, req.ip);
    return log.insertId;
  });

  const where = destination ? ` Report to ${destination.name} instead.` : '';
  const notices = [];

  /*
   * The site itself changed, so say so.
   *
   * The notices below reach whoever is rostered to the site — but a site with nobody
   * assigned yet would change status in silence, and that is exactly when the supervisors
   * and the coordinator need telling. This one is about the site, not about a person.
   */
  if (req.body.status !== 'Active') {
    notices.push(notify({
      audience: 'site.reports',
      severity: 'Warning',
      title: `${project.name} is ${req.body.status.toLowerCase()}`,
      message: `${req.body.reason}.${where} Effective ${effectiveDate}.`,
      referenceType: 'site_status',
      referenceId: logId,
      key: `site-move:${logId}:site`
    }));
    notices.push(notify({
      audience: 'projects.manage',
      severity: 'Warning',
      title: `${project.name} is ${req.body.status.toLowerCase()}`,
      message: `${req.body.reason}.${where} Effective ${effectiveDate}.`,
      referenceType: 'site_status',
      referenceId: logId,
      key: `site-move:${logId}:management`
    }));
  }

  /* Then everyone assigned. Nobody has to be called individually. */
  if (req.body.status !== 'Active') {
    for (const person of affected.labour) {
      notices.push(notify({
        audience: 'site.reports',
        severity: 'Warning',
        title: `${project.name} is ${req.body.status.toLowerCase()} — ${person.name}`,
        message: `${req.body.reason}.${where} Effective ${effectiveDate}.`,
        referenceType: 'site_status',
        referenceId: logId,
        key: `site-move:${logId}:labour:${person.id}`
      }));
    }
    for (const vehicle of affected.vehicles) {
      notices.push(notify({
        audience: 'transport.manage',
        severity: 'Warning',
        title: `${vehicle.vehicle} (${vehicle.registration}) reassigned from ${project.name}`,
        message: `${project.name} is ${req.body.status.toLowerCase()}: ${req.body.reason}.${where}`,
        referenceType: 'site_status',
        referenceId: logId,
        key: `site-move:${logId}:vehicle:${vehicle.id}`
      }));
    }
  }

  /* Deliveries already booked to this site would otherwise arrive at an empty plot. */
  const deliveries = await query(
    `SELECT o.id,o.reference,s.name supplier FROM purchase_orders o JOIN suppliers s ON s.id=o.supplier_id
     WHERE o.project_id=? AND o.status IN ('Issued','Partially received')`, [project.id]);
  for (const delivery of deliveries) {
    notices.push(notify({
      audience: 'store.manage',
      severity: 'Warning',
      title: `Redirect delivery ${delivery.reference}`,
      message: `${delivery.supplier} is delivering to ${project.name}, which is now ${req.body.status.toLowerCase()}.${where}`,
      referenceType: 'purchase_order',
      referenceId: delivery.id,
      key: `site-move:${logId}:delivery:${delivery.id}`
    }));
  }
  await Promise.all(notices);

  res.json({
    project: await getOne('SELECT id,name,site,site_status siteStatus,status_reason statusReason FROM projects WHERE id=?', [project.id]),
    movedTo: destination,
    affected: {
      labour: affected.labour.length,
      vehicles: affected.vehicles.length,
      equipment: affected.equipment.length,
      deliveriesFlagged: deliveries.length
    },
    notified: notices.length
  });
}));

/** What happened to this site, and why — so weather patterns become visible over time. */
router.get('/projects/:id/status-history', auth, permit('projects.view'), wrap(async (req, res) => {
  res.json(await query(`SELECT l.id,l.from_status fromStatus,l.to_status toStatus,l.reason,l.effective_date effectiveDate,
    l.notified,l.created_at createdAt,u.name changedBy FROM site_status_log l JOIN users u ON u.id=l.changed_by
    WHERE l.project_id=? ORDER BY l.id DESC`, [req.params.id]));
}));

/**
 * Moving one resource between sites. Both sites' records update together, so neither ends
 * up double-booked, and the person affected is told.
 */
router.post('/resources/reassign', auth, permit('resources.reassign'), validate(z.object({
  resourceType: z.enum(['Labour', 'Vehicle', 'Equipment']),
  resourceId: z.number().int().positive(),
  toProjectId: z.number().int().positive().nullable(),
  reason: z.string().max(500).optional()
})), wrap(async (req, res) => {
  const { resourceType, resourceId, toProjectId } = req.body;
  const destination = toProjectId ? await getOne('SELECT id,name FROM projects WHERE id=?', [toProjectId]) : null;
  if (toProjectId && !destination) return res.status(404).json({ error: 'Destination site not found' });

  const moved = await transaction(async connection => {
    let name = '';
    let fromProjectId = null;

    if (resourceType === 'Labour') {
      const [rows] = await connection.execute('SELECT * FROM employees WHERE id=?', [resourceId]);
      if (!rows[0]) throw Object.assign(new Error('Employee not found'), { status: 404 });
      name = rows[0].name;
      const [current] = await connection.execute(
        'SELECT project_id FROM project_team WHERE employee_id=? AND released_at IS NULL', [resourceId]);
      fromProjectId = current[0]?.project_id || null;
      await connection.execute('UPDATE project_team SET released_at=CURDATE() WHERE employee_id=? AND released_at IS NULL', [resourceId]);
      if (destination) {
        await connection.execute(
          `INSERT INTO project_team (project_id,employee_id,project_role) VALUES (?,?,?)
           ON DUPLICATE KEY UPDATE released_at=NULL`,
          [destination.id, resourceId, rows[0].designation]);
      }
      await connection.execute('UPDATE employees SET current_project_id=? WHERE id=?', [destination?.id || null, resourceId]);
    }

    if (resourceType === 'Vehicle') {
      const [rows] = await connection.execute('SELECT * FROM fleet WHERE id=?', [resourceId]);
      if (!rows[0]) throw Object.assign(new Error('Vehicle not found'), { status: 404 });
      name = `${rows[0].vehicle} (${rows[0].registration})`;
      fromProjectId = rows[0].project_id;
      await connection.execute('UPDATE fleet SET project_id=?, status=? WHERE id=?',
        [destination?.id || null, destination ? 'Assigned' : 'Available', resourceId]);
    }

    if (resourceType === 'Equipment') {
      const [rows] = await connection.execute('SELECT * FROM equipment WHERE id=?', [resourceId]);
      if (!rows[0]) throw Object.assign(new Error('Equipment not found'), { status: 404 });
      name = `${rows[0].code} ${rows[0].name}`;
      const [open] = await connection.execute(
        'SELECT * FROM equipment_assignments WHERE equipment_id=? AND returned_at IS NULL ORDER BY id DESC LIMIT 1', [resourceId]);
      fromProjectId = open[0]?.project_id || null;
      if (open[0]) await connection.execute('UPDATE equipment_assignments SET returned_at=CURDATE() WHERE id=?', [open[0].id]);
      if (destination) {
        await connection.execute(
          `INSERT INTO equipment_assignments (equipment_id,project_id,assigned_to,assigned_at,created_by)
           VALUES (?,?,?,CURDATE(),?)`, [resourceId, destination.id, open[0]?.assigned_to || 'Site team', req.user.id]);
      }
      await connection.execute('UPDATE equipment SET status=? WHERE id=?', [destination ? 'Assigned' : 'Available', resourceId]);
    }

    const [record] = await connection.execute(
      `INSERT INTO resource_reassignments (resource_type,resource_id,resource_name,from_project_id,to_project_id,reason,moved_by)
       VALUES (?,?,?,?,?,?,?)`,
      [resourceType, resourceId, name, fromProjectId, destination?.id || null, req.body.reason || null, req.user.id]);
    await audit(connection, req.user.id, 'REASSIGN', resourceType.toLowerCase(), resourceId,
      { projectId: fromProjectId }, { projectId: destination?.id || null }, req.ip);
    return { id: record.insertId, name, fromProjectId };
  }).catch(error => {
    if (error.status) { res.status(error.status).json({ error: error.message }); return null; }
    throw error;
  });
  if (!moved) return undefined;

  await notify({
    audience: resourceType === 'Vehicle' ? 'transport.manage' : 'site.reports',
    severity: 'Info',
    title: `${moved.name} reassigned`,
    message: destination
      ? `Now assigned to ${destination.name}.${req.body.reason ? ` ${req.body.reason}` : ''}`
      : `Released back to the yard.${req.body.reason ? ` ${req.body.reason}` : ''}`,
    referenceType: 'reassignment',
    referenceId: moved.id
  });

  return res.status(201).json({ moved: moved.name, to: destination?.name || 'Unassigned' });
}));

router.get('/resources/reassignments', auth, permit('resources.view'), wrap(async (_req, res) =>
  res.json(await query(`SELECT r.id,r.resource_type resourceType,r.resource_name resourceName,r.reason,r.created_at createdAt,
    f.name fromProject,t.name toProject,u.name movedBy
    FROM resource_reassignments r LEFT JOIN projects f ON f.id=r.from_project_id
    LEFT JOIN projects t ON t.id=r.to_project_id JOIN users u ON u.id=r.moved_by
    ORDER BY r.id DESC LIMIT 100`))));

/**
 * PID v3 §3.5 — the Project Coordinator's live view of both active sites: who is there,
 * what is on site, what was reported today and what needs deciding.
 */
router.get('/coordination', auth, permit('projects.view'), wrap(async (_req, res) => {
  const sites = await query(`SELECT id,name,site,site_status siteStatus,status_reason statusReason,
    stage,progress,manager,end_date endDate FROM projects
    WHERE active=1 AND site_status <> 'Completed' ORDER BY FIELD(site_status,'Active','On hold','Rescheduled'), id`);

  const detailed = await Promise.all(sites.map(async site => {
    const [resources, report, openTasks, milestone] = await Promise.all([
      assignedTo(site.id),
      getOne(`SELECT report_date reportDate,workforce,work_completed work,issue,delay_hours delayHours
        FROM daily_reports WHERE project_id=? ORDER BY report_date DESC LIMIT 1`, [site.id]),
      getOne(`SELECT COUNT(*) count FROM tasks WHERE project_id=? AND status NOT IN ('Completed','Approved')`, [site.id]),
      getOne(`SELECT title,due_date dueDate FROM project_milestones
        WHERE project_id=? AND status <> 'Completed' ORDER BY due_date LIMIT 1`, [site.id])
    ]);
    return {
      ...site,
      team: resources.labour,
      vehicles: resources.vehicles,
      equipment: resources.equipment,
      headcount: resources.labour.length,
      latestReport: report || null,
      openTasks: Number(openTasks.count),
      nextMilestone: milestone || null,
      reportedToday: Boolean(report && String(report.reportDate).slice(0, 10) === today())
    };
  }));

  res.json({ sites: detailed, activeCount: detailed.filter(site => site.siteStatus === 'Active').length });
}));

export default router;
