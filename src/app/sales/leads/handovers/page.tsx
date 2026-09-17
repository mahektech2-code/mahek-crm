import { requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { canLead, handoverCandidates } from "@/lib/services/lead-console-service";
import { outstandingHandovers } from "@/lib/services/lead-oversight-service";
import { LeadTabs } from "../lead-tabs";
import { HandoversScreen } from "./handovers-screen";

export const metadata = { title: "Handovers — Sales Dashboard — MahekOne" };

/**
 * §Q — converted, and still nobody named to run it.
 *
 * The brief asks for the account to become a customer on the second order and
 * for the relationship to pass to a customer manager in the same breath. That
 * is two sentences joined by an "and" that hides the fact they are
 * independent: `kind` answers what the account IS and flips on the first
 * order, `relationship_owner_id` answers who RUNS it, and nothing derives one
 * from the other. This screen is the gap between them, asked of the book
 * rather than kept in a column.
 *
 * `customer.handOver` is checked in `handOverRelationships` itself, which is
 * the enforcement. What is passed down here decides whether the control is
 * drawn live or drawn disabled with the reason on it — a courtesy on top,
 * because a server action is a URL and a hidden button is not a permission.
 */
export default async function Page() {
  const user = await requireUser();

  const [list, candidates, config, canWork, canHandOver] = await Promise.all([
    outstandingHandovers(),
    handoverCandidates(),
    getConfig(),
    canLead(user, "lead.work"),
    canLead(user, "customer.handOver"),
  ]);

  return (
    <>
      {/* Handovers is one tab, so the strip draws nothing — by design, since a
          strip of one is a control that cannot be used and reads as a broken
          screen. It is rendered anyway rather than left out, so the day a
          second tab is added here the page does not have to be found. */}
      <LeadTabs />
      <HandoversScreen
        rows={list.rows}
        total={list.total}
        candidates={candidates}
        /* The reason list is configuration, read on the server and passed
           down: the panel is a client component and a second copy of a list
           somebody can reword without a deploy is the copy that stops
           resolving. */
        reasonCodes={config["people.amChangeReasons"]}
        canWork={canWork}
        canHandOver={canHandOver}
      />
    </>
  );
}
