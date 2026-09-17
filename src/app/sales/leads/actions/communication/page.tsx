import { requireUser } from "@/lib/auth";
import { today } from "@/lib/recompute";
import { canLead, publishedDocuments } from "@/lib/services/lead-console-service";
import {
  communicableLeads,
  communicationActors,
  communicationLog,
  communicationTally,
  nextActionsDue,
  nextActionsOverdue,
} from "@/lib/services/lead-actions-service";
import { LeadTabs } from "../../lead-tabs";
import { CommunicationScreen } from "../communication-screen";

export const metadata = { title: "Communication log — Sales Dashboard — MahekOne" };

/**
 * §14 — the eleven, across the book.
 *
 * `publishedDocuments()` is read here rather than guessed at on the screen: the
 * whole point of a send button is that nobody hunts for the current price list,
 * so the category resolves to the newest published document of it, and a
 * category with nothing behind it comes back ABSENT so the tile can be turned
 * off with the reason on it. A tile that offers a brochure nobody has published
 * is a tap that does nothing.
 *
 * The tab counts are the two next-action windows rather than this screen's own
 * total: a communication log is a record, not a queue, and a number beside a
 * record reads as work waiting. `limit: 1` on both buys the count and one row.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ actor?: string; cursor?: string }>;
}) {
  const [user, params, day] = await Promise.all([requireUser(), searchParams, today()]);

  const [log, tally, actors, documents, leads, due, overdue, canWork] = await Promise.all([
    communicationLog({ actorId: params.actor, cursor: params.cursor }),
    communicationTally(),
    communicationActors(),
    publishedDocuments(),
    communicableLeads(),
    nextActionsDue(day, { limit: 1 }),
    nextActionsOverdue(day, { limit: 1 }),
    canLead(user, "lead.work"),
  ]);

  return (
    <div className="p-6">
      <LeadTabs
        counts={{
          "/sales/leads/actions": due.total,
          "/sales/leads/actions/overdue": overdue.total,
        }}
      />
      <CommunicationScreen
        tally={tally.known}
        unknown={tally.unknown}
        documents={documents}
        rows={log.rows}
        total={log.total}
        actors={actors}
        actorId={params.actor}
        cursor={params.cursor}
        nextCursor={log.nextCursor}
        leads={leads.rows}
        leadTotal={leads.total}
        canWork={canWork}
      />
    </div>
  );
}
