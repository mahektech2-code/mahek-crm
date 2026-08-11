import { all, newId, one, run } from '../db';
import { insertAndQueue, insertLocal, stamp, updateAndQueue } from './write';
import { getConfig } from './config';
import { leaveDays, overlaps, balanceAfter } from '../engines/leave';

/**
 * The things that need somebody's permission: expenses, leave, samples.
 *
 * All three go through ONE approval engine rather than three. An approval is a
 * record of its own, and the subject's state is derived from it — an expense is
 * approved because its approval says so, never because something set a flag on
 * the expense. Six kinds of approval with six sets of rules is how one of them
 * ends up more generous than the others without anybody deciding that.
 */

export type ApprovalType =
  | 'order_over_credit' | 'order_over_threshold' | 'expense_claim'
  | 'leave' | 'tour' | 'sample' | 'attendance_regularisation' | 'out_of_territory';

export async function raiseApproval(args: {
  type: ApprovalType;
  subjectType: string;
  subjectId: string;
  reason: string;
  deviceId: string;
}): Promise<string> {
  const id = newId('approval');
  await insertLocal('approvals', {
    id,
    type: args.type,
    subjectType: args.subjectType,
    subjectId: args.subjectId,
    reason: args.reason,
    requestedAt: Date.now(),
    state: 'pending',
    clientCreatedAt: Date.now(),
    deviceId: args.deviceId,
    syncState: 'queued',
  });
  return id;
}

/* ------------------------------------------------------------- expenses */

export type Expense = {
  id: string; spentOn: string; category: string; amountPaise: number;
  billPhotoId: string | null; remarks: string | null; state: string;
  approvedAmountPaise: number | null; rejectionReason: string | null; syncState: string;
};

export async function listExpenses(): Promise<Expense[]> {
  return all<Expense>('SELECT * FROM expenses ORDER BY spentOn DESC');
}

/**
 * Exceeding a category cap does NOT block the claim — it flags it. The
 * salesman spent the money; refusing to record it does not unspend it, it just
 * means nobody finds out.
 */
export async function claimExpense(args: {
  userId: string;
  spentOn: string;
  category: string;
  amountPaise: number;
  billPhotoId: string | null;
  remarks: string;
}): Promise<{ expenseId: string; overCap: boolean }> {
  const base = await stamp('expense');
  const caps = await getConfig<Record<string, number>>('mbos.expenses.categoryCapsPaise', {});
  const cap = caps[args.category];

  const spent = await one<{ total: number }>(
    `SELECT COALESCE(SUM(amountPaise), 0) AS total FROM expenses
      WHERE userId = ? AND category = ? AND substr(spentOn, 1, 7) = ?`,
    [args.userId, args.category, args.spentOn.slice(0, 7)],
  );
  const overCap = cap != null && (spent?.total ?? 0) + args.amountPaise > cap;

  const id = await insertAndQueue({
    table: 'expenses',
    entityType: 'expense',
    row: {
      ...base,
      userId: args.userId,
      spentOn: args.spentOn,
      category: args.category,
      amountPaise: args.amountPaise,
      billPhotoId: args.billPhotoId,
      remarks: args.remarks,
      state: 'Pending',
    },
    payloadExtras: { overCap },
  });

  if (args.billPhotoId) await run('UPDATE media_queue SET parentId = ? WHERE id = ?', [id, args.billPhotoId]);
  await raiseApproval({
    type: 'expense_claim',
    subjectType: 'expense',
    subjectId: id,
    reason: args.remarks,
    deviceId: base.deviceId,
  });

  return { expenseId: id, overCap };
}

/* ---------------------------------------------------------------- leave */

export type LeaveRequest = {
  id: string; kind: string; fromDate: string; toDate: string; halfDay: string | null;
  days: number; reason: string; state: string; lossOfPay: number; syncState: string;
};

export async function listLeave(): Promise<LeaveRequest[]> {
  return all<LeaveRequest>('SELECT * FROM leave_requests ORDER BY fromDate DESC');
}

export async function leaveBalances() {
  return all<{ kind: string; entitled: number; used: number; available: number }>('SELECT * FROM leave_balances');
}

/**
 * Applying for leave.
 *
 * Overlapping requests are BLOCKED, and checked against both pending and
 * approved — a second request for a day already asked for is not a second day
 * off, it is a mistake that quietly doubles a deduction.
 */
export async function applyForLeave(args: {
  userId: string;
  kind: string;
  span: 'half' | 'one' | 'many';
  fromDate: string;
  toDate: string | null;
  half: 'Morning' | 'Afternoon' | null;
  reason: string;
}): Promise<{ ok: true; id: string; unpaidSentence: string | null } | { ok: false; message: string }> {
  const existing = await all<LeaveRequest>(
    `SELECT * FROM leave_requests WHERE state IN ('Pending','Approved')`,
  );

  const span = {
    span: args.span === 'many' ? ('range' as const) : ('single' as const),
    from: args.fromDate,
    to: args.toDate ?? args.fromDate,
    half: args.half ? (args.half === 'Morning' ? ('first_half' as const) : ('second_half' as const)) : null,
  };

  const { days } = leaveDays(span);

  /* Pending counts as well as approved — two requests for the same week sit in
     the same inbox and get approved separately by somebody reading them one at
     a time. */
  const clash = overlaps(
    span,
    existing.map((e) => ({ id: e.id, from: e.fromDate, to: e.toDate, status: e.state })),
    ['Pending', 'Approved'],
  );
  if (clash.blocked) {
    return { ok: false, message: clash.sentence };
  }

  const balances = await leaveBalances();
  const entitlement = balances.find((b) => b.kind.toLowerCase() === args.kind.toLowerCase());
  const after = balanceAfter(days, { balanceDays: entitlement?.available ?? 0, kind: args.kind });

  const base = await stamp('leave');
  const id = await insertAndQueue({
    table: 'leave_requests',
    entityType: 'leave',
    row: {
      ...base,
      userId: args.userId,
      kind: args.kind,
      fromDate: args.fromDate,
      toDate: args.toDate ?? args.fromDate,
      halfDay: args.half,
      days,
      reason: args.reason,
      state: 'Pending',
      lossOfPay: after.unpaidDays > 0,
      /* What the balance was when it was asked for, so a later recompute
         cannot rewrite what the person was told at the time. */
      balanceSnapshot: entitlement ?? null,
    },
  });

  await raiseApproval({ type: 'leave', subjectType: 'leave', subjectId: id, reason: args.reason, deviceId: base.deviceId });
  return { ok: true, id, unpaidSentence: after.unpaidSentence || null };
}

export async function withdrawLeave(id: string): Promise<void> {
  await updateAndQueue({ table: 'leave_requests', entityType: 'leave', id, patch: { state: 'Withdrawn' } });
}

/* ----------------------------------------------------------- complaints */

/**
 * What the customer said, in his words, going to the desk team today.
 *
 * A complaint needs nobody's permission — it is a fact about an order that has
 * already gone wrong, and routing it through an approval would delay the one
 * thing that has to move fast. Photographs bind to it the way every other
 * attachment does: taken before the record existed, claimed when it does.
 */
export async function logComplaint(args: {
  customerId: string;
  category: string;
  description: string;
  photoIds?: string[];
  visitId?: string | null;
}): Promise<string> {
  const base = await stamp('complaint');
  const id = await insertAndQueue({
    table: 'complaints',
    entityType: 'complaint',
    row: {
      ...base,
      customerId: args.customerId,
      visitId: args.visitId ?? null,
      category: args.category,
      description: args.description,
      photoIds: args.photoIds ?? [],
      status: 'open',
    },
    dependsOn: args.visitId ? [args.visitId] : [],
  });

  for (const mediaId of args.photoIds ?? []) {
    await run('UPDATE media_queue SET parentId = ? WHERE id = ?', [id, mediaId]);
  }
  return id;
}

/* -------------------------------------------------------------- samples */

export type Sample = {
  id: string; customerId: string; productName: string | null; state: string;
  requestedAt: number; followUpDate: string | null; trialOutcome: string | null; syncState: string;
};

export async function listSamples(): Promise<Sample[]> {
  return all<Sample>('SELECT * FROM samples ORDER BY requestedAt DESC');
}

export async function requestSample(args: {
  customerId: string;
  productId: string | null;
  productName: string;
  cans: number;
  reason: string;
  followUpDate: string;
  visitId?: string | null;
}): Promise<string> {
  const base = await stamp('sample');
  const id = await insertAndQueue({
    table: 'samples',
    entityType: 'sample',
    row: {
      ...base,
      customerId: args.customerId,
      productId: args.productId,
      productName: args.productName,
      cans: args.cans,
      reason: args.reason,
      requestedAt: Date.now(),
      state: 'Requested',
      followUpDate: args.followUpDate,
    },
    dependsOn: args.visitId ? [args.visitId] : [],
  });

  await raiseApproval({ type: 'sample', subjectType: 'sample', subjectId: id, reason: args.reason, deviceId: base.deviceId });
  return id;
}

/**
 * Feedback still pending past its follow-up date is flagged. A sample nobody
 * chased is a sample that was given away.
 */
export async function overdueSamples(today: string): Promise<Sample[]> {
  return all<Sample>(
    `SELECT * FROM samples WHERE state NOT IN ('Converted','Rejected') AND followUpDate IS NOT NULL AND followUpDate < ?`,
    [today],
  );
}
