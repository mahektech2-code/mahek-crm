import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { sampleDesk } from "@/lib/services/lead-console-service";
import { SampleDeskScreen } from "./sample-desk-screen";

export const metadata = { title: "Sample desk — Sales Dashboard — MahekOne" };

/**
 * §15 §16 — the whole life of a sample, on one desk.
 *
 * The Samples screen beside this one answers the single question a manager asks
 * in passing — what has no feedback. This is the desk BEHIND it: approve the
 * request, record the dispatch and the docket, watch the delivery against what
 * the courier promised, read what the customer actually said. They are separate
 * screens rather than more columns because they are separate jobs at separate
 * hours, and a table wide enough for both is one nobody reads either half of.
 *
 * No layout of its own: it inherits the `sales.samples` module guard from the
 * folder above, which is right — somebody who may not see samples may not see
 * the desk that moves them either.
 */
export default async function Page() {
  const day = await today();
  const [rows, config] = await Promise.all([sampleDesk(day), getConfig()]);

  return (
    <SampleDeskScreen
      rows={rows}
      chaseDays={config["leads.sampleReviewChaseDays"]}
    />
  );
}
