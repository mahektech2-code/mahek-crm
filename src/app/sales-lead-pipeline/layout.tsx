import { requireUser } from "@/lib/auth";
import { ToastProvider } from "@/components/ui/toast";
import { LeadPipelineProvider } from "@/components/sales-lead-pipeline/provider";
import { LeadModals } from "@/components/sales-lead-pipeline/modals";

/**
 * Sales Manager Lead Pipeline — implemented from the prototype at
 * https://claude.ai/artifact/55h5EhgTReQbiThhdhPxRU.
 *
 * SCOPE: Sales Manager only. Telecaller, Salesman, Team Manager, Back Office
 * and Management screens from the same prototype are deliberately not built
 * here.
 *
 * DATA: every lead, KPI and mutation on these screens is in-memory mock
 * state (`LeadPipelineProvider`) — nothing here reads or writes
 * `src/db/schema.ts`. `requireUser()` is the one real thing this layout does:
 * it is the existing, read-only session check every other app in the suite
 * uses, so this screen set still requires a signed-in user without adding
 * any new auth logic. It is deliberately NOT nested under `/sales/layout.tsx`
 * — that shell reads live database counts for its sidebar badges, which
 * would tie this mock feature's chrome to real data it has no business
 * reading yet, and would need this feature registered as a module in
 * `lib/modules.ts` — a decision for whoever wires this up to the real access
 * model, not this task.
 *
 * NO CHROME OF ITS OWN. This flow is exactly two screens — Dashboard and
 * Lead Record — and neither is a tab inside a larger app shell, so there is
 * no sidebar and no nav bar here to switch between them: the Dashboard links
 * straight into a Lead Record and the Lead Record links straight back. A
 * previous pass added a top nav strip (Dashboard / Pipeline / All Leads);
 * that read as CRM chrome this flow was never meant to have, so it is gone
 * — `children` is the whole page.
 */
export default async function SalesLeadPipelineLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireUser();

  return (
    <ToastProvider>
      <LeadPipelineProvider>
        <div className="min-h-screen bg-canvas">
          <div className="mx-auto w-full max-w-[1600px]">{children}</div>
        </div>
        <LeadModals />
      </LeadPipelineProvider>
    </ToastProvider>
  );
}
