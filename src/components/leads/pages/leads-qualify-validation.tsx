import { type LeadWorkspace } from "@/lib/lead-workspace";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { validationCalls } from "@/lib/services/lead-qualify-service";
import { LeadTabs } from "@/components/leads/lead-tabs";
import { ValidationScreen } from "@/components/leads/qualify/validation/validation-screen";


/** The windows offered, in days. "Everything" is ten years rather than a
 *  special case in the query — a branch for "no window" is a branch nothing
 *  exercises, and a book that reaches back further than this has other
 *  problems. */
const WINDOWS: Record<string, number> = { "30": 30, "90": 90, "365": 365, all: 3650 };

/**
 * §8 — the record of the calls that were made.
 *
 * Not the queue: that is the Verification tab one along, and it answers "who
 * has nobody rung". This answers what the calls SAID, which is a question about
 * a book rather than about a lead — and the disagreements are only visible from
 * here. One salesman whose reports the shop contradicts on every third call is
 * invisible one record at a time.
 *
 * **This screen writes nothing, and there is no capability checked on it.** A
 * validation record is append-only by nature — a second call is a second row,
 * and the first is usually the one that matters — so there is nothing here that
 * could honestly be edited. What guards it is the module layout above, and the
 * scope the service resolves for itself.
 */
export async function Body({
  workspace,
  searchParams,
}: {
  workspace: LeadWorkspace;
  searchParams: Promise<{ window?: string; show?: string }>;
}) {
  const { window, show } = await searchParams;
  const key = window && window in WINDOWS ? window : "90";

  const day = await today();
  const [calls, config] = await Promise.all([
    validationCalls(day, { days: WINDOWS[key] }),
    getConfig(),
  ]);

  return (
    <div className="p-6">
      <LeadTabs workspace={workspace} />
      <ValidationScreen workspace={workspace}
        rows={calls.rows}
        total={calls.total}
        withDisagreement={calls.withDisagreement}
        windowKey={key}
        show={show === "disagreements" || show === "undecided" ? show : "all"}
        script={config["mbos.leads.validationScript"]}
      />
    </div>
  );
}
