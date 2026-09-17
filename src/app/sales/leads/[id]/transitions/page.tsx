import { notFound } from "next/navigation";
import {
  leadStream,
  parkedFrom,
  transitionsHead,
  type StreamCursor,
} from "@/lib/services/lead-board-service";
import { TransitionsScreen } from "./transitions-screen";

export const metadata = { title: "Stage transitions — Sales Dashboard — MahekOne" };

/**
 * The keyset, in a query string.
 *
 * `<iso instant>~<key>`, split on the FIRST tilde only: the key is
 * `<kind>:<row id>` and an id is not guaranteed to be free of anything, while
 * an ISO instant is. A malformed cursor is read as no cursor rather than
 * refused — somebody who has hand-edited a URL gets the newest page, which is
 * the page they would have got by deleting the parameter, and never an error
 * about a cursor they did not know they had.
 */
function parseCursor(raw: string | undefined): StreamCursor | undefined {
  if (!raw) return undefined;
  const cut = raw.indexOf("~");
  if (cut <= 0) return undefined;
  const at = raw.slice(0, cut);
  const key = raw.slice(cut + 1);
  if (!key || Number.isNaN(Date.parse(at))) return undefined;
  return { at, key };
}

/**
 * Screen 25 — §25's timeline at full depth.
 *
 * Every stage move this lead has ever made, joined to the manager's
 * verification calls, the samples, the orders and the receipts, in ONE
 * chronological stream. The joining is the point rather than a convenience: "a
 * sample was dispatched, and nine days later somebody moved the lead to Sample
 * received" is a sentence that can only be read if the two sit next to each
 * other, and it is the sentence that tells a manager whether a courier or a
 * customer is the problem.
 *
 * **APPEND-ONLY, AND THE SCREEN SAYS SO.** There is no edit control anywhere on
 * this page and there must never be one. A transition recorded wrongly is
 * corrected by a FURTHER transition, for the same reason `calls.next_step_*` is
 * never rebuilt: the row records what somebody decided on a day, and a rewrite
 * does not answer the question of what they decided — it destroys it. That is
 * what makes the override record worth anything at all.
 *
 * **The record page is where a lead is WORKED and this is where it is READ.**
 * The panel over there shows the newest hundred moves beside everything else a
 * manager needs in front of them; a lead worked for two years past a dozen
 * rungs, parked twice and reopened, is exactly the one somebody opens this for,
 * and a hundred rows with nothing saying so is a history that quietly ends.
 *
 * Scope is resolved by `transitionsHead`, which is also the header — one query,
 * because they are one question. A lead that does not exist and one in somebody
 * else's book answer identically, or the id in the URL becomes a way to find
 * out whose book an id belongs to.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /* The cursor is a URL parameter rather than component state, like every other
     paged read on this dashboard: a page of a history is a thing somebody
     sends, and the back button is what walks it the other way. */
  searchParams: Promise<{ after?: string }>;
}) {
  const [{ id }, { after }] = await Promise.all([params, searchParams]);

  const head = await transitionsHead(id);
  if (!head) notFound();

  const cursor = parseCursor(after);

  const [page, parked] = await Promise.all([leadStream(id, { cursor }), parkedFrom(id)]);

  return (
    <TransitionsScreen
      head={head}
      page={page}
      parked={parked}
      /* Whether this is the newest page, which is what decides the "back to the
         newest" link. It is asked of the cursor rather than of the rows: an
         empty page with no cursor is a lead with no history, and an empty page
         WITH one is somebody who has paged past the end. */
      onFirstPage={!cursor}
    />
  );
}
