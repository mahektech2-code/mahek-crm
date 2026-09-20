/* ---------------------------------------------------------------------------
 * §8.5 — WHO DID THIS, said in a colour as well as in a name.
 *
 * The timeline is the one screen on this record built for READING what
 * happened, and on an account with two hundred entries a salesman's visit, a
 * manager's call, an order the office raised and a nurture task nothing human
 * touched were drawn identically: one neutral pill carrying the event kind, and
 * the actor as plain muted text at the end of a line nobody scans. §8.5 asks
 * for the entries to be colour-coded by ACTOR KIND, which is the more useful
 * cut than event kind — the event kind is already on the pill and already has
 * its own filter, while "who did this" is the question somebody skimming a
 * history is actually separating.
 *
 * THE ACTOR KIND IS NOT ON THE ROW, so two thirds of this is a PROXY and says
 * so. `timeline_events` carries `actor_user_id` and nothing else about the
 * person: no role, no app, no seat. A role would be the wrong thing to store
 * anyway — `users.role` is the widest LEVEL somebody holds TODAY, and an entry
 * written in March records what happened in March, so a person promoted since
 * would silently repaint their own history. What the row DOES carry is two
 * facts, and they answer different halves of the question:
 *
 *   `actorName` null      nothing human is behind this entry. EXACT, not a
 *                         proxy: the name comes from a left join on
 *                         `actor_user_id`, so an absent name is an absent
 *                         actor, which is a projection or a nightly job.
 *   `sourceApp`           `mbos` or `crm` — WHICH APP the record came out of.
 *                         AGENTS.md's own rule is that a role is a level and
 *                         the app is the job, so the app is the best statement
 *                         of what kind of person this was that exists anywhere
 *                         on the row. It is a proxy because the CRM is worked
 *                         by a telecaller and by their manager alike, and
 *                         nothing here can tell those two apart.
 *
 * SYSTEM AGAINST PERSON IS THE DISTINCTION WORTH BUYING, and it is the exact
 * one rather than the proxy. "The office rang them" and "a job raised a task
 * because nobody had" are different facts about a quiet lead, and read as one
 * they make a lead nobody has touched look worked.
 *
 * THE COLOURS ARE CATEGORIES AND NEVER VERDICTS, which is why `success`,
 * `warn` and `danger` are not among them. All three mean something on this same
 * screen — a gate that is shut, a stage overridden, a lead lost — and borrowing
 * one to mean "a salesman did this" would have a manager reading a green visit
 * as a good visit. What is left is the brand, two greys, and the WORD, which is
 * drawn every time: the colour is a scanning aid and never the only thing
 * carrying the answer.
 *
 * PURE and client-safe, like `customer-health`, `account-types` and
 * `seat-labels` before it. It lives beside the screen that reads it because
 * nothing else asks this question yet; the moment a second screen does, it
 * moves to `lib/` rather than being typed out again.
 * ------------------------------------------------------------------------- */

export type TimelineActorKind = "system" | "field" | "office";

export type TimelineActorView = {
  kind: TimelineActorKind;
  /** The actor's own name, or what to say where there is not one. */
  name: string;
  /**
   * What kind of hand this was, in words. Always drawn, because the colour is
   * an aid to scanning and a reader who has not learned it must still be able
   * to read the row.
   */
  what: string;
};

/**
 * What the row carries, and nothing more — the two columns above.
 *
 * Deliberately a structural parameter rather than `TimelineRow`: the type comes
 * out of a `server-only` service, and this file is read by a client component.
 */
export function timelineActor(row: {
  actorName: string | null;
  sourceApp: string;
}): TimelineActorView {
  if (!row.actorName) {
    return {
      kind: "system",
      name: "MahekOne itself",
      what: "raised automatically — nobody pressed anything",
    };
  }
  if (row.sourceApp === "mbos") {
    return { kind: "field", name: row.actorName, what: "in the field, on the handset" };
  }
  return { kind: "office", name: row.actorName, what: "at a desk, in MahekOne" };
}
