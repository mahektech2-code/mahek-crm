import { all, run } from '../db';
import { enqueue } from '../sync/queue';
import { stamp } from './write';
import { getConfig } from './config';

/**
 * §E — the Prospect validation call.
 *
 * The office rings the shop the working day after a lead is qualified and asks
 * what the salesman's visit was actually like. The answers are kept on their
 * own row and never written over the lead's: `requirement` is what the salesman
 * was told standing in the shop, `confirmedRequirement` is what the office was
 * told on the phone, and the two disagreeing is the single most useful thing
 * this call produces.
 *
 * It is on the handset as well as in the console because on a nine-person team
 * the Lead Manager is as likely to make this call from a car as from a desk,
 * and a screen that only exists at a desk is a call that gets made and never
 * written down.
 */

export type ValidationScript = { heading: string; lines: string[] }[];

/**
 * What the caller reads out.
 *
 * Configuration, not code: the wording will be argued about, improved after a
 * bad call, and eventually translated, and none of that should need a new APK.
 * It arrives with every other `mbos.*` key on the pull.
 */
export async function validationScript(): Promise<ValidationScript> {
  const cfg = await getConfig<{ sections: ValidationScript }>('mbos.leads.validationScript');
  return cfg?.sections ?? [];
}

export type ValidationAnswers = {
  customerId: string;
  reached: boolean;
  productFeedback?: string | null;
  qualityFeedback?: string | null;
  dispatchFeedback?: string | null;
  salesmanFeedback?: string | null;
  confirmedRequirement?: string | null;
  confirmedMonthlyVolumeLitres?: number | null;
  confirmedCompetitor?: string | null;
  confirmedPotentialPaise?: number | null;
  verdict?: 'pending' | 'confirmed' | 'not_qualified' | 'on_hold';
  verdictReason?: string | null;
  notes?: string | null;
  /** The task that asked for this call, closed in the same write. */
  taskId?: string | null;
};

/** Why this cannot be saved, or null. Mirrors the server's own check. */
export function validationRefusal(a: ValidationAnswers): string | null {
  if ((a.verdict === 'not_qualified' || a.verdict === 'on_hold') && !String(a.verdictReason ?? '').trim()) {
    return 'Say what was wrong — the salesman who raised it will raise the next one just like it otherwise.';
  }
  return null;
}

export async function recordValidation(a: ValidationAnswers): Promise<{ ok: boolean; message?: string }> {
  const refusal = validationRefusal(a);
  if (refusal) return { ok: false, message: refusal };

  const base = await stamp('lead_validation');
  const calledAt = Date.now();

  await run(
    `INSERT INTO lead_validations (
       id, customerId, calledAt, reached,
       productFeedback, qualityFeedback, dispatchFeedback, salesmanFeedback,
       confirmedRequirement, confirmedMonthlyVolumeLitres, confirmedCompetitor,
       confirmedPotentialPaise, verdict, verdictReason, notes, taskId,
       clientCreatedAt, deviceId, syncState
     ) VALUES (?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?,?,?, ?,?,'queued')`,
    [
      base.id, a.customerId, calledAt, a.reached ? 1 : 0,
      a.productFeedback ?? null, a.qualityFeedback ?? null,
      a.dispatchFeedback ?? null, a.salesmanFeedback ?? null,
      a.confirmedRequirement ?? null, a.confirmedMonthlyVolumeLitres ?? null,
      a.confirmedCompetitor ?? null, a.confirmedPotentialPaise ?? null,
      a.verdict ?? 'pending', a.verdictReason ?? null, a.notes ?? null, a.taskId ?? null,
      base.clientCreatedAt, base.deviceId,
    ],
  );

  /*
   * Closed locally so the task list is right before the sync lands. The server
   * closes its own copy from the same payload — two writes for one act is how
   * the call reaches the office and the task stays open on somebody's list.
   *
   * The status is the LOCAL spelling and the column list is the local one:
   * this table has `status` and `completionNote` and no `completedAt` at all,
   * which the schema-usage test caught the first time this was written the
   * other way round. SQL in a template string is invisible to tsc.
   */
  if (a.taskId) {
    await run(`UPDATE tasks SET status = 'done', completionNote = ? WHERE id = ?`, [
      a.verdictReason ?? a.notes ?? null,
      a.taskId,
    ]);
  }

  await enqueue({
    entityType: 'lead_validation',
    entityId: base.id,
    op: 'create',
    /* Spelled out rather than spread — PROTOCOL.md §4.1. The handset's own
       column names and the wire's happen to agree here, and writing them out
       is what keeps that true the day one of them changes. */
    payload: {
      customerId: a.customerId,
      calledAt,
      reached: a.reached,
      productFeedback: a.productFeedback ?? undefined,
      qualityFeedback: a.qualityFeedback ?? undefined,
      dispatchFeedback: a.dispatchFeedback ?? undefined,
      salesmanFeedback: a.salesmanFeedback ?? undefined,
      confirmedRequirement: a.confirmedRequirement ?? undefined,
      confirmedMonthlyVolumeLitres: a.confirmedMonthlyVolumeLitres ?? undefined,
      confirmedCompetitor: a.confirmedCompetitor ?? undefined,
      confirmedPotentialPaise: a.confirmedPotentialPaise ?? undefined,
      verdict: a.verdict ?? 'pending',
      verdictReason: a.verdictReason ?? undefined,
      notes: a.notes ?? undefined,
      taskId: a.taskId ?? undefined,
      clientCreatedAt: base.clientCreatedAt,
      deviceId: base.deviceId,
    },
  });

  return { ok: true };
}

/** This lead's calls, newest first. Two is common and the first is the one that matters. */
export async function validationsFor(customerId: string) {
  return all<{
    id: string;
    calledAt: number;
    reached: number;
    verdict: string;
    verdictReason: string | null;
    confirmedRequirement: string | null;
    syncState: string;
  }>(
    `SELECT id, calledAt, reached, verdict, verdictReason, confirmedRequirement, syncState
       FROM lead_validations WHERE customerId = ? ORDER BY calledAt DESC`,
    [customerId],
  );
}
