import { type LeadWorkspace } from "@/lib/lead-workspace";
import { requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { canLead } from "@/lib/services/lead-console-service";
import {
  leadSourceOptions,
  nextActionOwners,
} from "@/lib/services/lead-intake-service";
import { distributorCandidates } from "@/lib/services/distributor-service";
import { LeadTabs } from "@/components/leads/lead-tabs";
import { IntakeForm } from "@/components/leads/intake/intake-form";


/**
 * Screen 5 — the office's own lead-raising form.
 *
 * Every other way a lead reaches MahekOne has somebody standing in a shop or a
 * spreadsheet behind it. This is the telephone call: a shop rings, or a website
 * form arrives in somebody's inbox, and until this existed the only places to
 * put it were a notebook and a colleague's memory.
 *
 * **The module is guarded by the folder's layout**, which is the pattern
 * everywhere under `leads/` except the book itself — nine separately
 * grantable modules live under one path, so a guard on the parent would refuse
 * somebody holding Intake on the strength of a module they were deliberately
 * not given.
 *
 * What is read is a real answer rather than a list typed into a screen: the
 * sources already in use (so screen 6 does not inherit a fourth spelling of
 * "Website"), who a lead's Owner may be, and — for the third-party ladder only
 * — the direct customers `crm/distributor-picker.tsx` already offers as who
 * may bill a shop, which is what "Under" asks for at capture.
 */
export async function Body({
  workspace,
}: {
  workspace: LeadWorkspace;
}) {
  const user = await requireUser();

  const [sources, owners, config, canWork, distributors] = await Promise.all([
    leadSourceOptions(),
    nextActionOwners(),
    getConfig(),
    canLead(user, "lead.work"),
    /*
     * §23's "Under" picker — the same eligibility rule `crm/distributor-picker.tsx`
     * and `convertToThirdParty` already enforce: a direct customer, not itself
     * marked third-party. Fetched wide rather than search-as-you-type, because
     * this is a plain select and not a typeahead — see the field's own note in
     * `intake-form.tsx`.
     */
    distributorCandidates("", { limit: 500 }),
  ]);

  return (
    <div className="p-6">
      <LeadTabs workspace={workspace} />
      <IntakeForm workspace={workspace}
        sources={sources}
        sourceOptions={config["leads.sources"]}
        owners={owners}
        canWork={canWork}
        distributors={distributors.hits}
      />
    </div>
  );
}
