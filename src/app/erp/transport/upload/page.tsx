import { redirect } from "next/navigation";
import { erpContext } from "@/lib/erp/access";
import { erpLink } from "@/lib/erp/registry";

/**
 * Upload LRs is a modal on the Logistics screen and the Dispatch desk now, not
 * a page. This address is kept for bookmarks and old links: it opens whichever
 * desk the person holds with the modal already up.
 */
export const dynamic = "force-dynamic";

export default async function UploadLrsPage() {
  const ctx = await erpContext();
  if (ctx.screens.has("transport")) redirect(erpLink("pendingLr", { upload: "1" }));
  if (ctx.screens.has("dispatch")) redirect(erpLink("dispatch", { upload: "1" }));
  redirect("/erp");
}
