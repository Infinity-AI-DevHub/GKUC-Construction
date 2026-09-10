/**
 * PID v3 §2.2 — the access system is something the MD shapes, not something fixed in code.
 *
 * This file defines the *catalogue* of things that can be permitted. Which roles hold which
 * of them lives in the database and is edited by the MD at runtime, so adding a role or
 * moving an authority never requires a code change.
 */

/*
 * The permissions that confer control over the system itself, rather than over one
 * department's work.
 *
 * Taking over an account that holds one of these is how a limited administrator becomes an
 * unlimited one: reset the Managing Director's password, sign in as them, and every other
 * permission follows. Resetting an ordinary colleague's password is help desk work and
 * stays possible; reaching an account that can rewrite the rules is not.
 */
export const PRIVILEGED_KEYS = [
  'admin.users', 'admin.roles', 'admin.audit', 'admin.notifications',
  'finance.pay', 'finance.invoice', 'hr.payroll',
  'messages.send', 'qs.boqAmend', 'admin.lists'
];

export const DEPARTMENTS = [
  'Company', 'Finance', 'Human Resources', 'Quantity Surveying',
  'Transport', 'Construction & Coordination', 'Stores', 'Administration'
];

/**
 * Every permission the product enforces. `key` is what routes check; `label` is what the
 * MD sees on the toggle screen. Keep keys stable — they are stored against roles.
 */
export const PERMISSIONS = [
  /* Construction & Coordination */
  { key: 'projects.view', department: 'Construction & Coordination', label: 'View projects and sites' },
  { key: 'projects.manage', department: 'Construction & Coordination', label: 'Create and edit projects' },
  /* Separate from projects.manage on purpose: the site record is evidence of how a plot
     looked before work started and at every stage after, so who may add to it and who may
     withdraw a photo from it is the MD's decision, not a side effect of managing projects. */
  { key: 'gallery.manage', department: 'Construction & Coordination', label: 'Manage the project photo gallery' },
  { key: 'projects.schedule', department: 'Construction & Coordination', label: 'Reschedule a site (Site A / Site B)' },
  { key: 'resources.view', department: 'Construction & Coordination', label: 'See resource availability' },
  { key: 'resources.reassign', department: 'Construction & Coordination', label: 'Reassign people, vehicles and tools between sites' },
  { key: 'enquiries.manage', department: 'Construction & Coordination', label: 'Log and progress customer enquiries' },
  { key: 'subcontractors.manage', department: 'Construction & Coordination', label: 'Manage subcontractor records and bills' },

  /* Site operations */
  { key: 'site.reports', department: 'Construction & Coordination', label: 'Submit daily site reports' },
  { key: 'site.tasks', department: 'Construction & Coordination', label: 'Assign and update site tasks' },
  { key: 'site.attendance', department: 'Construction & Coordination', label: 'Record and correct attendance on site' },

  /* Quantity Surveying */
  { key: 'qs.view', department: 'Quantity Surveying', label: 'View BOQs, quotations and tenders' },
  { key: 'qs.boq', department: 'Quantity Surveying', label: 'Prepare bills of quantities' },
  { key: 'qs.quotation', department: 'Quantity Surveying', label: 'Create client quotations' },
  { key: 'qs.tender', department: 'Quantity Surveying', label: 'File and track tender submissions' },
  { key: 'qs.approve', department: 'Quantity Surveying', label: 'Approve a BOQ or variation (sets the budget)' },
  { key: 'qs.retention', department: 'Quantity Surveying', label: 'Manage retention amounts and release dates' },

  /* Finance */
  { key: 'finance.view', department: 'Finance', label: 'View financial position' },
  { key: 'finance.manage', department: 'Finance', label: 'Record expenses and income' },
  { key: 'finance.invoice', department: 'Finance', label: 'Raise customer invoices and mark them received' },
  { key: 'finance.pay', department: 'Finance', label: 'Record supplier invoices and payments' },

  /* Human Resources */
  { key: 'hr.view', department: 'Human Resources', label: 'View employee records' },
  { key: 'hr.manage', department: 'Human Resources', label: 'Manage employees, departments and documents' },
  { key: 'hr.attendance', department: 'Human Resources', label: 'Import biometric attendance' },
  { key: 'hr.leave', department: 'Human Resources', label: 'Approve leave and overtime' },
  { key: 'hr.payroll', department: 'Human Resources', label: 'Run and approve payroll' },

  /* Transport */
  { key: 'transport.view', department: 'Transport', label: 'View vehicles and fuel' },
  { key: 'transport.manage', department: 'Transport', label: 'Manage vehicles, renewals, fuel and service' },

  /* Stores */
  { key: 'store.view', department: 'Stores', label: 'View stock and lending' },
  { key: 'store.manage', department: 'Stores', label: 'Record stock movements and purchases' },
  { key: 'store.lending', department: 'Stores', label: 'Lend tools and materials to workers and mark returns' },

  /* Administration */
  { key: 'admin.users', department: 'Administration', label: 'Create and deactivate user accounts' },
  { key: 'admin.roles', department: 'Administration', label: 'Create roles and change what each role can do' },
  { key: 'admin.audit', department: 'Administration', label: 'Read the audit trail' },
  { key: 'admin.notifications', department: 'Administration', label: 'Run the deadline scan and manage alerts' },
  /* Sending to a person's phone is a different act from reading an alert on screen: it
     reaches them wherever they are, it costs money per message, and it goes out under the
     company's name. Who may do it is the MD's decision, held separately from everything else. */
  { key: 'messages.send', department: 'Administration', label: 'Send WhatsApp messages to selected people' },
  /* Separate from qs.approve, which signs off a bill the first time. This is the authority
     to let an already-approved bill be changed — the figures quotations and invoices were
     built on — and the MD holds it unless they hand it to somebody. */
  { key: 'qs.boqAmend', department: 'Quantity Surveying', label: 'Approve changes to an approved BOQ' },
  /* The choices every form offers. Adding a cost type or a leave type is an ordinary
     business decision; letting anyone do it would leave ten spellings of the same thing. */
  { key: 'admin.lists', department: 'Administration', label: 'Manage the dropdown lists used across the system' },
  /* Held by everybody by default. It exists so the MD can take it away from somebody, not
     so it has to be handed out — an internal system where colleagues cannot talk to each
     other simply pushes the conversation onto personal phones, where there is no record. */
  { key: 'chat.use', department: 'General', label: 'Use the staff messaging' },
  /* Held by everybody by default, like the messaging. What a person can reach inside the
     drive is decided by who shared it with them, not by this. */
  { key: 'drive.use', department: 'General', label: 'Use the document drive' },
  /* Who gets the evening summary on WhatsApp. The MD by default; named as a permission so
     it can be given to a second person without a code change. */
  { key: 'reports.daily-summary', department: 'Administration', label: 'Receive the evening summary on WhatsApp' }
];

export const PERMISSION_KEYS = PERMISSIONS.map(permission => permission.key);
export const isPermission = key => PERMISSION_KEYS.includes(key);

const all = () => PERMISSION_KEYS;
const none = [];

/**
 * The roles GKUC described on the site visit (PID v3 §2.1), with a sensible starting set of
 * permissions. These are only defaults written once on first run — from then on the MD owns
 * them, and nothing here overwrites a change made in the product.
 */
export const DEFAULT_ROLES = [
  {
    name: 'Managing Director',
    description: 'Full visibility across the business. Owns the access system itself.',
    system: true,
    permissions: all
  },
  {
    name: 'Assistant to the MD',
    description: 'Access level set directly by the MD — broad or narrow, at the MD’s discretion.',
    permissions: () => ['projects.view', 'resources.view', 'qs.view', 'finance.view', 'hr.view', 'transport.view', 'store.view']
  },
  {
    name: 'Project Coordinator',
    description: 'Cross-department visibility to coordinate active projects, resourcing and scheduling.',
    permissions: () => [
      'projects.view', 'projects.manage', 'projects.schedule', 'resources.view', 'resources.reassign',
      'enquiries.manage', 'subcontractors.manage', 'site.reports', 'site.tasks', 'site.attendance',
      'gallery.manage', 'qs.view', 'finance.view', 'hr.view', 'transport.view', 'store.view'
    ]
  },
  {
    name: 'Finance Department Head',
    description: 'Full access within Finance.',
    permissions: () => ['finance.view', 'finance.manage', 'finance.invoice', 'finance.pay', 'projects.view', 'qs.view', 'qs.retention', 'store.view']
  },
  {
    name: 'HR Department Head',
    description: 'Full access within Human Resources.',
    permissions: () => ['hr.view', 'hr.manage', 'hr.attendance', 'hr.leave', 'hr.payroll', 'projects.view']
  },
  {
    name: 'QS Department Head',
    description: 'Full access within Quantity Surveying.',
    permissions: () => ['qs.view', 'qs.boq', 'qs.quotation', 'qs.tender', 'qs.retention', 'projects.view', 'finance.view', 'subcontractors.manage']
  },
  {
    name: 'Transport Department Head',
    description: 'Full access within Transport.',
    permissions: () => ['transport.view', 'transport.manage', 'projects.view', 'resources.view']
  },
  {
    name: 'Construction & Coordination Head',
    description: 'Full access within Construction & Coordination.',
    permissions: () => [
      'projects.view', 'projects.manage', 'projects.schedule', 'resources.view', 'resources.reassign',
      'enquiries.manage', 'subcontractors.manage', 'site.reports', 'site.tasks', 'site.attendance', 'qs.view', 'store.view'
    ]
  },
  {
    name: 'Site Supervisor',
    description: 'Records daily site activity, attendance context, tasks and issues.',
    permissions: () => ['projects.view', 'site.reports', 'site.tasks', 'site.attendance', 'gallery.manage', 'store.view', 'resources.view']
  },
  {
    name: 'Store Keeper',
    description: 'Logs tools and materials lent to workers, and marks them returned.',
    permissions: () => ['store.view', 'store.manage', 'store.lending', 'projects.view']
  },
  {
    name: 'Read-Only Viewer',
    description: 'Can see, but change nothing.',
    permissions: () => ['projects.view', 'qs.view', 'finance.view', 'hr.view', 'transport.view', 'store.view', 'resources.view']
  }
];

/** Roles carried over from the previous build so existing accounts keep working. */
export const LEGACY_ROLE_MAP = {
  'Owner / Director': 'Managing Director',
  Administrator: 'Managing Director',
  'Project Manager': 'Project Coordinator',
  'Site Supervisor': 'Site Supervisor',
  Storekeeper: 'Store Keeper',
  'Finance / Accounts': 'Finance Department Head',
  HR: 'HR Department Head',
  'QS / Estimator': 'QS Department Head',
  'Transport Officer': 'Transport Department Head',
  Employee: 'Read-Only Viewer',
  'Read-Only Viewer': 'Read-Only Viewer'
};

export { none };
