import { requireUser } from "@/lib/auth";
import { canLead } from "@/lib/services/lead-console-service";
import {
  duplicateCandidates,
  duplicateNameThreshold,
} from "@/lib/services/lead-intake-service";
import { LeadTabs } from "../../lead-tabs";
import { DuplicatesScreen } from "./duplicates-screen";

export const metadata = { title: "Duplicates — Sales Dashboard — MahekOne" };

/**
 * Screen 7 — and it is a DELIBERATE, NAMED GAP.
 *
 * Two leads for one shop is the ordinary failure of a book fed by a website
 * form, a handset and a spreadsheet at once. This screen finds them. It cannot
 * merge them, and the reason is not that nobody has got round to writing the
 * function: merging two `customers` rows means deciding what becomes of two
 * sets of orders, bills, receipts, visits, tasks and timeline entries, and — the
 * one that is a business decision rather than a technical one — two append-only
 * `lead_stage_transitions` histories. That table is append-only BY DESIGN: a
 * transition recorded wrongly is corrected by a further transition, never by an
 * edit. There is no answer in this codebase to what two of them fused together
 * would mean, and inventing one inside a merge function would be deciding it by
 * accident.
 *
 * So the screen detects and reports, its only action is "these are two
 * different shops", and it names the three things it is missing ON ITSELF —
 * because a gap somebody has to read a specification to find out about is a
 * feature people assume is broken.
 *
 * The cap is real and the screen says what it is a slice of. Both sides of
 * every pair are narrowed by `managerScope` inside the service, so a regional
 * manager is not shown another region's telephone numbers by way of a pair.
 */
export default async function Page() {
  const user = await requireUser();

  const [report, canWork] = await Promise.all([
    duplicateCandidates({ limit: 100 }),
    canLead(user, "lead.work"),
  ]);

  return (
    <div className="p-6">
      <LeadTabs />
      <DuplicatesScreen
        pairs={report.pairs}
        total={report.total}
        dismissed={report.dismissed}
        nameThreshold={await duplicateNameThreshold()}
        canWork={canWork}
      />
    </div>
  );
}
