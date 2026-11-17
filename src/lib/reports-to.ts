/* ---------------------------------------------------------------------------
 * WHO SOMEBODY REPORTS TO — the rules for changing it, pure and client-safe.
 *
 * `users.reports_to_id` is one line on the account and it carries more than
 * it looks: a CRM manager's team scope is the people pointing at them
 * (`scopeForUser`), a sales manager's managed salesmen start from it, and the
 * handset tells this person's manager about their day — falling back to EVERY
 * manager when the line is empty. For years nothing but the seed wrote it, so
 * the Admin Console now does, through `setReportsTo`.
 *
 * The checks live here rather than in the action so the person page can say
 * the same refusal before anything is posted, and so the loop check is tested
 * without a database. A loop is the one that matters: A reporting to B who
 * reports to A puts each in the other's team, and every walk up the chain —
 * the handset's notification, a scope resolver that one day goes past one
 * level — would go round for ever.
 * ------------------------------------------------------------------------- */

/**
 * The chain above `managerId`, walked up through `managerOf`, stopping as
 * soon as it reaches `userId`. Returns that path (manager first, `userId`
 * last) where giving `userId` this manager would close a loop, otherwise
 * null.
 *
 * A chain that ALREADY loops somewhere above — written by hand, or before
 * this check existed — is stopped by the visited set rather than followed for
 * ever; it is not this person's loop, so it is not a reason to refuse them.
 */
export function loopThrough(
  userId: string,
  managerId: string,
  managerOf: (id: string) => string | null | undefined,
): string[] | null {
  const path: string[] = [];
  const seen = new Set<string>();
  let at: string | null | undefined = managerId;
  while (at && !seen.has(at)) {
    path.push(at);
    if (at === userId) return path;
    seen.add(at);
    at = managerOf(at);
  }
  return null;
}

export type ReportsToPerson = { id: string; name: string; active: boolean; reportsToId: string | null };

/**
 * Why `userId` may not be given `managerId` as their manager, in words, or
 * null where they may. Null `managerId` is "reports to nobody", which is
 * always allowed. `people` is everybody, so the loop can be walked.
 */
export function reportsToRefusal(
  userId: string,
  managerId: string | null,
  people: readonly ReportsToPerson[],
): string | null {
  if (managerId === null) return null;
  if (managerId === userId) return "Nobody reports to themselves.";
  const byId = new Map(people.map((p) => [p.id, p]));
  const manager = byId.get(managerId);
  if (!manager) return "That account no longer exists.";
  /* A deactivated manager can open nothing, so a team pointed at them is a
     team nobody sees — and the handset would notify nobody. */
  if (!manager.active) return `${manager.name}'s account is deactivated, so they cannot be anybody's manager.`;
  const loop = loopThrough(userId, managerId, (id) => byId.get(id)?.reportsToId ?? null);
  if (loop) {
    const me = byId.get(userId)?.name ?? "This person";
    /* The chain said in names — "Asha reports to Ravi, who reports to …" —
       because "that would make a loop" alone does not say which line to move. */
    const names = loop.slice(0, -1).map((id) => byId.get(id)?.name ?? "somebody");
    return `${manager.name} already reports up to ${me} (${[...names, me].join(" → ")}), so this would make a loop. Move ${manager.name} first.`;
  }
  return null;
}
