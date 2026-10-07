import type { HireContext } from "@/lib/hire/access";
import { lockedWhy } from "@/lib/hire/roles";
import { getApplication } from "@/lib/hire/services/core";
import { documentRows, documentsReadiness, VAULTED } from "@/lib/hire/services/onboarding";
import { vaultAvailable, vaultKeyLine } from "@/lib/hire/services/vault";
import { Callout, Icon } from "../_ui/kit";
import { DocumentsBoard, type DocView } from "./documents-board";

/**
 * One candidate's documents — drawn on the Documents screen AND on the
 * candidate record's Documents tab, so the two are one thing. Identity and
 * bank numbers are masked; unmasking is an explicit, logged act.
 */
export async function CandidateDocuments({ ctx, applicationId }: { ctx: HireContext; applicationId: string }) {
  const b = await getApplication(ctx, applicationId);
  if (!b) return <div className="text-sm text-muted">This candidate is not on your list.</div>;
  const rows = await documentRows(b);
  const readiness = await documentsReadiness(b, rows);
  const docStage = b.def.stages.findIndex((s) => s.type === "document_collection");
  const at = b.def.stages.findIndex((s) => s.key === b.app.stageKey);
  const reached = b.app.status === "hired" || (docStage >= 0 && at >= docStage);

  const views: DocView[] = rows.map((r) => ({
    key: r.req.key,
    label: r.req.label,
    kind: r.req.kind,
    mandatory: r.req.mandatory,
    verify: r.req.verify,
    pii: r.req.pii,
    vaulted: VAULTED.has(r.req.kind),
    docId: r.doc?.id ?? null,
    status: r.doc?.verificationStatus ?? null,
    notes: r.doc?.verificationNotes ?? null,
    verifiedBy: r.verifiedBy,
    verifiedAt: r.doc?.verifiedAt?.toISOString() ?? null,
    uploadedAt: r.doc?.createdAt.toISOString() ?? null,
    file: r.file ? { id: r.file.id, filename: r.file.filename, contentType: r.file.contentType, sizeKb: Math.max(1, Math.round(r.file.sizeBytes / 1024)) } : null,
    masked: r.masked,
    vaultId: r.vaultId,
    extraction: r.doc?.extraction ? { fields: r.doc.extraction.fields, signals: r.doc.extraction.signals, quality: r.doc.extraction.quality, ai: Boolean(r.doc.extraction.aiTaskId) } : null,
    confidence: r.doc?.extractionConfidence ?? null,
  }));
  const done = rows.filter((r) => r.doc?.verificationStatus === "verified" || r.doc?.verificationStatus === "waived").length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 rounded-[6px] border border-line bg-surface px-4 py-2.5 text-[13px] text-body">
        <Icon n="shield" s={16} className="text-muted" />
        <span className="flex-1">
          {done} of {rows.length} verified. Identity and bank numbers are masked by default; unmasking is logged with your name. {vaultKeyLine()}
        </span>
      </div>
      {!reached ? <Callout tone="neutral">Documents are collected after the decision gate. {b.candidate.fullName} is at {b.stage?.name ?? "—"}.</Callout> : null}
      {reached && b.app.status === "in_progress"
        ? readiness.map((w) => (
            <Callout key={w} tone={/mandatory/.test(w) ? "danger" : "warn"}>
              {w}
            </Callout>
          ))
        : null}
      <DocumentsBoard
        applicationId={b.app.id}
        docs={views}
        canDocuments={ctx.can("documents")}
        canUnmask={ctx.can("unmask")}
        vaultReady={vaultAvailable()}
        lockedDocuments={lockedWhy("documents")}
        lockedUnmask={lockedWhy("unmask")}
        open={reached && (b.app.status === "in_progress" || b.app.status === "on_hold")}
      />
      <div className="text-xs text-muted">
        Hire never decides a document is forged. What the AI notices is listed for a person to judge; low confidence goes to manual review instead of a guess.
      </div>
    </div>
  );
}
