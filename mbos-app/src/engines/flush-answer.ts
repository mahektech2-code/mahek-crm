/**
 * WHAT TO DO WITH A BATCH, GIVEN WHAT THE SERVER SAID ABOUT IT.
 *
 * `flush()` reads the OLDEST five hundred fixes every pass and, until now, had
 * two answers: delivered, in which case it deleted the lot, or `no-session-yet`,
 * in which case it kept them and stopped. A batch the server could only PARTLY
 * file came back looking delivered, so the handset deleted rows the office
 * never stored — a salesman's fixes destroyed on his own phone by a successful
 * upload, which is the worst shape a data-loss bug takes, because everything
 * reports success all the way down.
 *
 * ANSWERING `no-session-yet` FOR A MIXED BATCH WOULD HAVE BEEN WORSE, and it
 * is the obvious fix. The queue is drained oldest-first, so ONE permanently
 * unfileable fix sitting in the oldest five hundred holds up everything behind
 * it until `queueRetentionDays` ages it out — seven days by default — and the
 * phones with an unfileable tail are exactly the phones in this incident. That
 * is head-of-line blocking, and it turns a handful of lost fixes into a week of
 * lost days.
 *
 * So the server gained a third word. `partial` names the ids IT IS FINISHED
 * WITH, the handset deletes those and keeps the rest, AND CARRIES ON to the
 * next batch — returning early there would be the head-of-line bug arriving by
 * the back door.
 *
 * THE SHAPE IS IDS-THAT-LANDED, NOT IDS-TO-KEEP, and the asymmetry is the whole
 * safety argument. An id the server forgets to name is re-sent next pass and
 * costs one round trip; under the opposite shape a forgotten id would be
 * deleted and cost the fix. Everything below preserves that direction: anything
 * unrecognised, unparseable or absent falls towards KEEPING a row, except the
 * one case that has always meant delivered.
 *
 * AN UNKNOWN WORD STILL MEANS DELIVERED. That is not an oversight, it is what
 * lets the server ship a fourth word before any handset can be updated — an APK
 * cannot be recalled, and a phone that refused to drain on a word it had never
 * heard of would wedge its queue until somebody sideloaded a new build.
 *
 * PURE, and an engine rather than four branches inside `sync/trail.ts`, for the
 * reason every file beside it gives: that file imports expo-location and
 * TaskManager at module scope, so nothing in it can be exercised without a
 * device. The cadence bug lived three days in the field for exactly that
 * reason, and `flush()` is where two production data-loss bugs have now been.
 */

/** The answer, as loosely as it can honestly be typed — it came off a wire. */
export type PositionsAnswer = {
  ok?: boolean;
  stored?: number;
  dropped?: number;
  tracking?: string;
  filed?: unknown;
};

export type FlushDecision = {
  /**
   * Ids to delete from `positions`. Empty is a real answer and the common one
   * on everything but a delivery.
   */
  remove: string[];
  /** Does the loop go round for another batch? */
  carryOn: boolean;
  /** How many of them to count as sent, for the caller's own return value. */
  sent: number;
  /**
   * Work only the caller can do, because it touches more than this batch.
   *
   * `stop-tracking` is the office switching it off: stop taking fixes and drop
   * the whole table, which is why it is not expressible as a list of ids.
   * `age-out` is `no-session-yet`: keep everything, but let go of anything so
   * old that no check-in is ever coming for it.
   */
  effect: 'none' | 'stop-tracking' | 'age-out';
};

/**
 * Only the ids that were actually sent, and only strings.
 *
 * `filed` arrives from a server this handset does not control and may hold an
 * id from a batch that is no longer the oldest five hundred, a duplicate, or
 * something that is not a string at all. Intersecting with what was sent is
 * what keeps this from deleting a row this call never offered — the only way
 * `filed` could otherwise reach a fix the server has not seen.
 */
function landed(filed: unknown, sentIds: readonly string[]): string[] {
  if (!Array.isArray(filed)) return [];
  const sent = new Set(sentIds);
  const out = new Set<string>();
  for (const id of filed) {
    if (typeof id === 'string' && sent.has(id)) out.add(id);
  }
  return [...out];
}

export function decideFlush(answer: PositionsAnswer | null, sentIds: readonly string[]): FlushDecision {
  /* Not an answer at all — a refusal, a torn connection, a body that would not
     parse. Nothing is deleted and the pass ends. */
  if (!answer?.ok) return { remove: [], carryOn: false, sent: 0, effect: 'none' };

  if (answer.tracking === 'off') {
    return { remove: [], carryOn: false, sent: 0, effect: 'stop-tracking' };
  }

  if (answer.tracking === 'no-session-yet') {
    return { remove: [], carryOn: false, sent: 0, effect: 'age-out' };
  }

  if (answer.tracking === 'partial') {
    const remove = landed(answer.filed, sentIds);
    return {
      remove,
      /*
       * CARRY ON — that is the point of the word — BUT ONLY IF SOMETHING
       * MOVED.
       *
       * The loop re-reads the oldest five hundred every pass, so carrying on
       * having deleted nothing re-reads the identical rows and posts them
       * again, up to `MAX_PASSES` times, for the same answer. That is not the
       * head-of-line bug this word exists to avoid — the rows are kept either
       * way and the next `flush()` tries again — it is fifty pointless round
       * trips on a 2G connection, paid by the handset that is already having
       * the worst day. Progress is what licenses another pass.
       */
      carryOn: remove.length > 0,
      sent: remove.length,
      effect: 'none',
    };
  }

  /*
   * DELIVERED — no `tracking` key, or a word this build has never heard of.
   *
   * The second half of that sentence is deliberate and is what makes a server
   * deploy safe ahead of an APK. See the header.
   */
  return { remove: [...sentIds], carryOn: true, sent: sentIds.length, effect: 'none' };
}
