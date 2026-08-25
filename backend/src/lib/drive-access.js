import { query, getOne } from '../db.js';

/*
 * Who may do what with an item in the drive.
 *
 * Access accumulates up the tree: sharing a folder shares what is inside it, which is what
 * everybody expects and what makes the feature usable at all. An item's own grants are
 * added to whatever its ancestors give, and the most generous of them wins.
 *
 * The public link is deliberately outside that rule. A file does not become public because
 * somebody once made a grandparent folder public — making something public is always a
 * decision taken about that thing, recorded against the person who took it. The cost of
 * that choice is having to share twice occasionally; the cost of the other choice is a
 * payslip reachable by anyone with a URL.
 */

const RANK = { None: 0, View: 1, Edit: 2, Owner: 3 };
export const atLeast = (have, needed) => RANK[have] >= RANK[needed];

/** An item and every folder above it, nearest first. */
export async function ancestry(itemId) {
  const chain = [];
  let current = await getOne(
    'SELECT id,parent_id parentId,kind,name,owner_id ownerId,visibility,org_role orgRole,trashed_at trashedAt FROM drive_items WHERE id=?',
    [itemId]);
  /* A depth stop, because a cycle would otherwise be an infinite loop rather than a bug
     somebody notices. Folders cannot legitimately nest this deep. */
  let guard = 0;
  while (current && guard++ < 64) {
    chain.push(current);
    if (!current.parentId) break;
    current = await getOne(
      'SELECT id,parent_id parentId,kind,name,owner_id ownerId,visibility,org_role orgRole,trashed_at trashedAt FROM drive_items WHERE id=?',
      [current.parentId]);
  }
  return chain;
}

/**
 * What this person may do with this item: 'Owner', 'Edit', 'View' or 'None'.
 *
 * Every source of access is considered and the strongest is returned, rather than stopping
 * at the first hit — somebody may be a named viewer on a file that sits in a folder shared
 * with the whole company as editable, and answering "View" there would be wrong.
 */
export async function accessFor(itemId, user) {
  const chain = await ancestry(itemId);
  if (!chain.length) return { role: 'None', reason: 'not found' };

  const item = chain[0];
  /* Something in the bin is reachable only by whoever put it there, and by the owner. */
  const binned = chain.find(one => one.trashedAt);

  let best = 'None';
  let reason = null;
  const consider = (role, why) => {
    if (RANK[role] > RANK[best]) { best = role; reason = why; }
  };

  const ids = chain.map(one => one.id);
  const shares = await query(
    `SELECT item_id itemId, role FROM drive_shares
      WHERE user_id=? AND item_id IN (${ids.map(() => '?').join(',')})`, [user.id, ...ids]);

  for (const link of chain) {
    if (link.ownerId === user.id) consider('Owner', link.id === item.id ? 'you own this' : 'you own the folder it is in');
    if (link.visibility === 'Organisation') {
      consider(link.orgRole, link.id === item.id
        ? 'shared with everybody in the company' : 'inside a folder shared with everybody');
    }
    const share = shares.find(one => one.itemId === link.id);
    if (share) consider(share.role, link.id === item.id ? 'shared with you' : 'you have access to the folder it is in');
  }

  /*
   * Anybody who may see the whole audit trail may see what is in the drive. Not to be
   * generous — it is so that an investigation is not blocked by whoever set the sharing,
   * which is exactly the situation where that would matter. It is read-only, and every
   * such view is recorded.
   */
  if (best === 'None' && user.permissions?.includes('admin.audit')) {
    consider('View', 'you can see the audit trail');
  }

  if (binned && best !== 'Owner') return { role: 'None', reason: 'it is in the bin' };
  return { role: best, reason };
}

/** The public link, if this exact item carries a live one. Never inherited. */
export async function publicLinkFor(itemId) {
  const item = await getOne(
    `SELECT id,name,kind,storage_key storageKey,mime,size_bytes sizeBytes,
            public_token publicToken,public_expires_at publicExpiresAt,trashed_at trashedAt
       FROM drive_items WHERE id=?`, [itemId]);
  if (!item?.publicToken) return null;
  if (item.trashedAt) return null;
  if (item.publicExpiresAt && new Date(item.publicExpiresAt) < new Date()) return null;
  return item;
}

/**
 * Everything directly inside a folder that this person may see.
 *
 * Resolved per child rather than assumed from the parent: a folder somebody can open may
 * hold one file shared only with the owner, and that file must not appear in the listing.
 */
export async function visibleChildren(parentId, user) {
  const rows = await query(`
    SELECT d.id,d.parent_id parentId,d.kind,d.name,d.owner_id ownerId,u.name owner,
           d.size_bytes sizeBytes,d.mime,d.visibility,d.org_role orgRole,
           d.public_token IS NOT NULL AND d.trashed_at IS NULL public,
           d.created_at createdAt,d.updated_at updatedAt,d.project_id projectId,p.name project,
           (SELECT COUNT(*) FROM drive_shares s WHERE s.item_id=d.id) sharedWith,
           (SELECT COUNT(*) FROM drive_items c WHERE c.parent_id=d.id AND c.trashed_at IS NULL) children
      FROM drive_items d
      JOIN users u ON u.id=d.owner_id
      LEFT JOIN projects p ON p.id=d.project_id
     WHERE ${parentId ? 'd.parent_id=?' : 'd.parent_id IS NULL'} AND d.trashed_at IS NULL
     ORDER BY d.kind='File', d.name`, parentId ? [parentId] : []);

  const visible = [];
  for (const row of rows) {
    const { role } = await accessFor(row.id, user);
    if (role === 'None') continue;
    visible.push({ ...row, myRole: role, public: Boolean(row.public) });
  }
  return visible;
}
