import Link from "next/link";
import { redirect } from "next/navigation";
import { erpContext } from "@/lib/erp/access";
import { erpLink } from "@/lib/erp/registry";
import { recentEmptyDrums, scrapSummary } from "@/lib/erp/scrap";
import { getConfig } from "@/lib/config/store";
import { Page } from "../_ui/page-head";
import { EmptyDrumScale } from "./scale";

/**
 * EMPTY DRUM ENTRY. The page the person at the scale keeps open, on a phone
 * or a tablet: scan the drum's GRN lot label (a hand scanner types it in, or
 * type it), see which lot, supplier and material it is, weigh the drum and
 * save. Everything else is read from the GRN.
 */
export const dynamic = "force-dynamic";

export default async function EmptyDrumEntry() {
  const ctx = await erpContext();
  if (!ctx.screens.has("emptyDrums")) redirect("/erp");
  const [recent, summary, config] = await Promise.all([recentEmptyDrums(ctx.user.id), scrapSummary(), getConfig()]);
  return (
    <Page
      title="Empty drum entry"
      sub="Scan the drum's lot label while it can still be read, weigh the empty drum and save. The GRN, supplier, material and lot come from the label — nothing else to type."
      actions={
        <div className="flex gap-3 text-[13px]">
          <Link href={erpLink("emptyDrums")}>All empty drums</Link>
          <Link href={erpLink("drumStock")}>Mahek stock</Link>
        </div>
      }
    >
      <EmptyDrumScale
        recent={recent}
        canOverride={ctx.powers.has("scrapControl")}
        previewing={!!ctx.viewingAs}
        limits={{ min: config["erp.scrap.drumWeightMinKg"], max: config["erp.scrap.drumWeightMaxKg"] }}
        stock={{ mahek: summary.mahekAvailable, vendor: summary.vendorPending, review: summary.review }}
      />
    </Page>
  );
}
