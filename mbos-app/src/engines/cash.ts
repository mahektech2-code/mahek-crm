/**
 * Cash the salesman is carrying.
 *
 * Money collected in notes is the company's money in somebody's pocket, and the
 * only thing that changes that is a deposit slip. This engine answers the two
 * questions that matter about that: how much, and how long has the oldest of it
 * been there.
 *
 * The SLA is on **each collection**, not on the total, and that is the whole
 * point. A salesman who banks every Friday has an average age of three days and
 * a note from Monday that has been in his bag for five — averaging it away is
 * how the one that matters disappears. So every collection carries its own
 * deadline and the ones past it are listed by name.
 *
 * Cheque and UPI collections are not here: a cheque is already an instrument
 * with somebody's name on it and a UPI receipt was in the company's account
 * before the salesman left the shop. Only cash goes missing.
 *
 * Pure — `now` is an argument, never `Date.now()`, so a screen can be tested
 * at any point in the SLA window without waiting for it.
 */

export type Collection = {
  id: string;
  customerName: string;
  amountPaise: number;
  /** Epoch ms. */
  collectedAt: number;
  mode: 'cash' | 'cheque' | 'upi' | 'neft' | 'other';
  /** Epoch ms the deposit was recorded, or null while it is still being carried. */
  depositedAt: number | null;
};

export type CarriedCollection = Collection & {
  /** Epoch ms by which this one has to be banked. */
  dueAt: number;
  ageHours: number;
  hoursRemaining: number;
  pastSla: boolean;
};

export type CashPosition = {
  totalPaise: number;
  /** The collection that has been carried longest, or null when nothing is. */
  oldest: CarriedCollection | null;
  /** Past the SLA, oldest first. Named individually — see the note above. */
  pastSla: CarriedCollection[];
  /** The soonest deadline not yet missed, epoch ms, or null. */
  nextDeadline: number | null;
  /** Every undeposited cash collection, oldest first. */
  carried: CarriedCollection[];
  sentence: string;
};

const MS_PER_HOUR = 3_600_000;

export function cashPosition(
  collections: readonly Collection[],
  slaHours: number,
  now: number,
): CashPosition {
  const carried: CarriedCollection[] = collections
    .filter((c) => c.mode === 'cash' && c.depositedAt == null)
    .map((c) => {
      const dueAt = c.collectedAt + slaHours * MS_PER_HOUR;
      return {
        ...c,
        dueAt,
        ageHours: (now - c.collectedAt) / MS_PER_HOUR,
        hoursRemaining: (dueAt - now) / MS_PER_HOUR,
        pastSla: dueAt <= now,
      };
    })
    .sort((a, b) => a.collectedAt - b.collectedAt);

  const totalPaise = carried.reduce((sum, c) => sum + c.amountPaise, 0);
  const pastSla = carried.filter((c) => c.pastSla);
  const upcoming = carried.filter((c) => !c.pastSla);
  const nextDeadline = upcoming.length
    ? Math.min(...upcoming.map((c) => c.dueAt))
    : null;
  const oldest = carried[0] ?? null;

  return {
    totalPaise,
    oldest,
    pastSla,
    nextDeadline,
    carried,
    sentence:
      carried.length === 0
        ? 'No cash on you.'
        : pastSla.length > 0
          ? `${pastSla.length} collection${pastSla.length === 1 ? '' : 's'} past the deposit deadline — bank them today.`
          : `Carrying cash from ${carried.length} collection${carried.length === 1 ? '' : 's'}.`,
  };
}
