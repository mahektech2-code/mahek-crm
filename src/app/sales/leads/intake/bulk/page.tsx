import { requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { canLead } from "@/lib/services/lead-console-service";
import { nextActionOwners } from "@/lib/services/lead-intake-service";
import { LeadTabs } from "../../lead-tabs";
import { BulkScreen } from "./bulk-screen";

export const metadata = { title: "Bulk intake — Sales Dashboard — MahekOne" };

/**
 * Screen 34 — a file of leads, validated and previewed before anything is
 * written.
 *
 * Modelled on `/crm/customers/import`, which is the shape this company already
 * knows: the columns are listed before the file box, the first rows are shown
 * as the importer reads them, and what was left out is reported by row number
 * so the sheet can be fixed and offered again.
 *
 * What it does NOT share with that screen is the owner dropdown. The CRM's
 * import asks for "the owner for rows with no telecaller named" and defaults
 * every unowned row to it; this one offers the same control with the opposite
 * default, because a lead's owner IS its scope and a thousand rows carrying the
 * name of whoever ran the import reads as one person's book on every scoped
 * list in the product. Unassigned is said in words; a false owner is not said
 * at all.
 */
export default async function Page() {
  const user = await requireUser();

  const [owners, config, day, canWork] = await Promise.all([
    nextActionOwners(),
    getConfig(),
    today(),
    canLead(user, "lead.work"),
  ]);

  return (
    <div className="p-6">
      <LeadTabs />
      <BulkScreen
        owners={owners}
        today={day}
        requireNextAction={config["leads.requireNextAction"]}
        canWork={canWork}
      />
    </div>
  );
}
