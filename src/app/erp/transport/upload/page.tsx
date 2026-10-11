import Link from "next/link";
import { redirect } from "next/navigation";
import { erpContext } from "@/lib/erp/access";
import { shortDay } from "@/lib/erp/engines/logistics";
import { transporters, uploadedLrs } from "@/lib/erp/logistics";
import { today } from "@/lib/erp/screens/common";
import { Badge, Card } from "@/components/ui/primitives";
import { Page } from "../../_ui/page-head";
import { LrThumb } from "../parts/common";
import { LrUpload } from "../parts/lr-upload";

/**
 * Where the dispatch team uploads the LRs it collected from the transporters.
 * Open to the Logistics screen AND the Dispatch desk: collecting the LRs is the
 * dispatch team's job, attaching them to bills is logistics'. Below the form,
 * what has been uploaded lately and whether logistics has attached it yet.
 */
export const dynamic = "force-dynamic";

export default async function UploadLrsPage() {
  const ctx = await erpContext();
  if (!ctx.screens.has("transport") && !ctx.screens.has("dispatch")) redirect("/erp");
  const [recent, dir] = await Promise.all([uploadedLrs({ status: "all" }), transporters()]);
  return (
    <Page
      title="Upload LRs"
      sub="Photograph each lorry receipt collected from the transporters and type its number. Logistics attaches them to the bills and the customer is told."
      actions={
        <div className="flex gap-3 text-[13px]">
          {ctx.screens.has("transport") ? <Link href="/erp/transport?view=pendingLr">← LR desk</Link> : null}
          {ctx.screens.has("dispatch") ? <Link href="/erp/dispatch">Dispatch desk</Link> : null}
        </div>
      }
    >
      {ctx.viewingAs ? (
        <Card className="mb-4 px-4 py-3 text-sm text-muted">You are previewing the ERP, so nothing can be uploaded.</Card>
      ) : (
        <div className="max-w-[980px]">
          <LrUpload today={today()} transporters={dir.filter((t) => t.active).map((t) => t.name)} />
        </div>
      )}
      <h2 className="mt-8 mb-2 text-[15px] font-semibold text-ink">Uploaded lately</h2>
      <Card className="max-w-[980px] overflow-hidden">
        {recent.length ? (
          recent.slice(0, 40).map((l) => (
            <div key={l.id} className="flex items-center gap-3 border-b border-divider px-4 py-2 text-sm last:border-0">
              <LrThumb fileId={l.fileId} size={40} />
              <span className="w-[140px] font-mono font-medium">LR {l.lrNo}</span>
              <span className="min-w-0 flex-1 truncate text-body">{[l.transporter, l.destination].filter(Boolean).join(" · ") || "—"}</span>
              <span className="w-[90px] text-[13px] text-muted">{l.lrDate ? shortDay(l.lrDate) : "—"}</span>
              <span className="w-[140px] truncate text-[12px] text-muted">by {l.uploadedBy ?? "—"}</span>
              {l.status === "assigned" ? <Badge tone="success">Attached to {l.bills} bill{l.bills === 1 ? "" : "s"}</Badge> : <Badge tone="warn">Waiting for logistics</Badge>}
            </div>
          ))
        ) : (
          <div className="px-4 py-6 text-center text-sm text-muted">Nothing uploaded yet.</div>
        )}
      </Card>
    </Page>
  );
}
