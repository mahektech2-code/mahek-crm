import { requireUser } from "@/lib/auth";
import { today } from "@/lib/recompute";
import { canLead, handoverCandidates } from "@/lib/services/lead-console-service";
import {
  COMMITMENT_VIEWS,
  commitments,
  type CommitmentView,
} from "@/lib/services/lead-commercial-service";
import { CommitmentsScreen } from "./commitments-screen";

export const metadata = { title: "Commitments & forecast — Sales Dashboard — MahekOne" };

/**
 * 17 — what customers have PROMISED, which is not what they have bought.
 *
 * Four views rather than four routes, because they are one list asked four
 * questions — and a view is a filter, so each carries its own URL and can be
 * sent to somebody.
 *
 * An unrecognised `view` falls back to Open rather than throwing: a stale
 * bookmark is not an error, and a blank screen with a stack trace behind it is
 * a worse answer than the first tab.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  const current: CommitmentView =
    (COMMITMENT_VIEWS.find((v) => v.key === view)?.key as CommitmentView | undefined) ?? "open";

  const day = await today();
  const [user, board, people] = await Promise.all([
    requireUser(),
    commitments(day, current),
    handoverCandidates(),
  ]);

  return (
    <CommitmentsScreen
      view={current}
      rows={board.rows}
      counts={board.counts}
      forecastValuePaise={board.forecastValuePaise}
      unvalued={board.unvalued}
      day={day}
      people={people}
      canWork={await canLead(user, "lead.work")}
    />
  );
}
