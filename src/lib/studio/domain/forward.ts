/* ---------------------------------------------------------------------------
 * UPLOAD & BULK FORWARD — the rules, pure.
 *
 * A finished poster goes, unchanged, to many people. MahekOne cannot put a
 * picture into somebody's WhatsApp chat — a web page can only open the chat —
 * so a forward is a list a person works through, and every status is what that
 * person said, never a delivery. Nothing here claims otherwise.
 * ------------------------------------------------------------------------- */

export const FORWARD_MAX = 200;
export const CAPTION_MAX = 1000;
export const TITLE_MAX = 80;

export const FORWARD_STATUSES = ["pending", "opened", "sent", "skipped"] as const;
export type ForwardStatus = (typeof FORWARD_STATUSES)[number];

export const STATUS_LABEL: Record<ForwardStatus, string> = {
  pending: "Not done yet",
  opened: "Chat opened",
  sent: "Marked sent by you",
  skipped: "Skipped",
};

export function titleProblem(raw: string): string | null {
  const t = raw.trim();
  if (!t) return "needs a name";
  if (t.length > TITLE_MAX) return `must be ${TITLE_MAX} characters or fewer`;
  return null;
}

export function captionProblem(raw: string): string | null {
  return raw.length > CAPTION_MAX ? `The message can be at most ${CAPTION_MAX} characters.` : null;
}

/** One entry each, in the order given, order of first appearance kept. */
export function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = String(raw ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export type RecipientCheck = { ok: true; ids: string[] } | { ok: false; error: string };

/** What may be asked of a forward: at least one, at most FORWARD_MAX, no repeats counted twice. */
export function checkRecipientIds(ids: readonly string[]): RecipientCheck {
  const unique = uniqueIds(ids);
  if (!unique.length) return { ok: false, error: "Choose at least one recipient." };
  if (unique.length > FORWARD_MAX) return { ok: false, error: `At most ${FORWARD_MAX} recipients at a time — you chose ${unique.length}.` };
  return { ok: true, ids: unique };
}

/** Which of the chosen recipients already had this very picture forwarded by this person. */
export function alreadyForwarded(chosen: readonly string[], earlier: ReadonlySet<string>): { fresh: string[]; repeats: string[] } {
  const fresh: string[] = [];
  const repeats: string[] = [];
  for (const id of chosen) (earlier.has(id) ? repeats : fresh).push(id);
  return { fresh, repeats };
}

/**
 * Whether a person may move a recipient from one status to another. Going back
 * to pending is allowed (a mistaken tap); nothing here ever becomes "delivered".
 */
export function canMove(from: ForwardStatus, to: ForwardStatus): boolean {
  if (from === to) return false;
  return (FORWARD_STATUSES as readonly string[]).includes(to);
}

export type Tally = Record<ForwardStatus, number> & { total: number };

export function tally(statuses: readonly ForwardStatus[]): Tally {
  const t: Tally = { pending: 0, opened: 0, sent: 0, skipped: 0, total: statuses.length };
  for (const s of statuses) t[s] += 1;
  return t;
}
