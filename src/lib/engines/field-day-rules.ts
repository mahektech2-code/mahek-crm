/**
 * TWO SMALL RULES ABOUT A FIELD DAY, kept PURE so they can be tested without a
 * database — the same reason `lib/engines/` exists at all.
 *
 * Both sit behind sync handlers in `actions/mbos.ts`, and both fail silently
 * in the field when they go wrong: a skip that overwrote a visit would erase
 * the one record the journey screen is read for, and a reassignment grace that
 * let a stranger's work in would be a hole in the scope boundary that nothing
 * on any screen would ever show.
 */

/* ══════════════════════════════════════════════════ skipping a planned stop */

export type StopSkipVerdict =
  | { kind: "skip"; reason: string }
  /** Nothing to change, and nothing wrong — accepted as it stands. */
  | { kind: "noop"; why: "already_skipped" | "already_visited" }
  | { kind: "refuse"; message: string };

/**
 * What a skip sent from the phone does to a stop in this state.
 *
 * **A VISIT WINS.** A stop already visited is never moved to skipped: the
 * visit is real work with a check-in behind it, and the skip is a phone that
 * had not yet heard about it (or a second phone). Accepted, not refused —
 * there is nothing he can correct, and a refusal would sit in /rejections for
 * ever over a day that went better than the skip said.
 *
 * **A second skip changes nothing**, including the reason. The first answer is
 * the one his manager may already have read; a resend from the outbox is the
 * same answer arriving twice, not a new one.
 *
 * **The reason is required**, because a skip with no reason is
 * indistinguishable from a stop nobody bothered to visit, and that is the
 * question the manager is going to ask.
 */
export function stopSkipVerdict(status: string, reason: string | null | undefined): StopSkipVerdict {
  if (status === "visited") return { kind: "noop", why: "already_visited" };
  if (status === "skipped") return { kind: "noop", why: "already_skipped" };
  const said = (reason ?? "").trim();
  if (!said) {
    return {
      kind: "refuse",
      message: "Say why you are skipping this shop. Your manager reads it, and without it the stop reads as missed.",
    };
  }
  return { kind: "skip", reason: said };
}

/* ═════════════════════════════════════ work done before the shop moved away */

/**
 * Whether work on a shop that has LEFT his book is still his to have done.
 *
 * `scopedCustomer` asks whose book a shop is in NOW. A shop reassigned at
 * 2 pm, visited by him at 11 am, synced at 6 pm, was refused for ever — the
 * visit, the order and the receipt taken in it all went to Not accepted over a
 * decision made at a desk hours after the work. That is real work, and the
 * cash in the receipt is in his pocket either way.
 *
 * The boundary this keeps is the one that matters: a shop that was NEVER his
 * stays refused. Only a recorded move away from him — a seat change naming
 * him as the one it moved from, or a tombstone written to his handset — opens
 * this door, and only for work dated before the move, plus a grace that
 * covers a phone that had not yet pulled the news (`movedAt` is the office's
 * clock; `workedAt` the handset's, which is why the grace is configuration
 * rather than zero).
 *
 * `movedAt` null means no record of it ever being his, and is always no.
 */
export function workPredatesMove(
  workedAt: number | null | undefined,
  movedAt: number | null | undefined,
  graceHours: number,
): boolean {
  if (movedAt == null || !Number.isFinite(movedAt)) return false;
  if (workedAt == null || !Number.isFinite(workedAt)) return false;
  const grace = Math.max(0, graceHours) * 3_600_000;
  return workedAt <= movedAt + grace;
}
