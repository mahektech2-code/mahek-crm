import type { HireContext } from "@/lib/hire/access";

/**
 * STUB — replaced by the onboarding build. The candidate record's Documents
 * tab renders this, so the record and the Documents screen draw one thing.
 */
export async function CandidateDocuments({ ctx, applicationId }: { ctx: HireContext; applicationId: string }) {
  void ctx;
  void applicationId;
  return <div className="text-sm text-muted">Documents are being built.</div>;
}
