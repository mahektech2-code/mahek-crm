/*
 * THE DOCUMENTS WAITING TO BECOME PRICE LISTS — the Sales Dashboard's door.
 *
 * The same screen is mounted in the CRM under its own base path; what belongs
 * to the app is the path its links lead down and nothing else, so both pages
 * are a read and a render rather than two copies of a worklist.
 *
 * `view` defaults to what is WAITING rather than to everything: a document
 * that has become a price list or been rejected is finished work, and a list
 * that opens with three hundred finished rows on top of the four somebody has
 * to act on is a list people stop opening.
 */
import { requireUser } from "@/lib/auth";
import { canFor } from "@/lib/access-control";
import { listDocuments } from "@/lib/services/price-list-service";
import { PageHeader } from "@/components/ui/primitives";
import { PricingSubNav } from "@/components/pricing/sub-nav";
import { DocumentsPanel } from "@/components/pricing/documents-panel";

export const metadata = { title: "Price list documents — Accounts — MahekOne" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; import?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const view = params.view === "all" ? "all" : "waiting";

  const [canManage, documents] = await Promise.all([
    canFor(user, "pricelist.manage"),
    listDocuments({ view }),
  ]);

  return (
    <div className="p-6">
      <PageHeader
        title="Price lists"
        subtitle="A price list starts as a file somebody was sent. This is what has arrived and what is holding each one up."
      />
      <PricingSubNav basePath="/accounts/price-lists" current="documents" />
      <DocumentsPanel
        basePath="/accounts/price-lists"
        canManage={canManage}
        documents={documents}
        openImport={params.import === "1"}
      />
    </div>
  );
}
