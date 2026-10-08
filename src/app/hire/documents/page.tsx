import { and, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { hireDocuments } from "@/db/schema";
import { requireHireScreen } from "@/lib/hire/access";
import { loadBlueprint } from "@/lib/hire/services/core";
import { onboardList } from "@/lib/hire/services/onboarding";
import { CandidateHead, OnboardFrame } from "../_onboard/frame";
import type { PaneRow } from "../_onboard/list-pane";
import { CandidateDocuments } from "./candidate-documents";

export const dynamic = "force-dynamic";
export const metadata = { title: "Documents" };

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<{ app?: string }> }) {
  const ctx = await requireHireScreen("documents");
  const sp = await searchParams;
  const list = await onboardList(ctx, "documents");
  const docs = list.length
    ? await db
        .select({ app: hireDocuments.applicationId, key: hireDocuments.requirementKey, st: hireDocuments.verificationStatus })
        .from(hireDocuments)
        .where(and(inArray(hireDocuments.applicationId, list.map((r) => r.id)), isNull(hireDocuments.supersededById)))
    : [];
  const rows: PaneRow[] = [];
  for (const r of list) {
    const bp = await loadBlueprint(r.blueprintId);
    const mandatory = bp?.definition.documents.filter((d) => d.mandatory) ?? [];
    const mine = docs.filter((d) => d.app === r.id);
    const okCount = mandatory.filter((m) => mine.some((d) => d.key === m.key && (d.st === "verified" || d.st === "waived"))).length;
    const review = mine.some((d) => d.st === "manual_review" || d.st === "pending");
    rows.push({
      id: r.id,
      name: r.name,
      meta: `${r.blueprintTitle} · ${r.location ?? "—"} · ${r.stageName}`,
      badge: okCount === mandatory.length ? { l: "Complete", tone: "success" } : review ? { l: "To verify", tone: "warn" } : { l: `${mandatory.length - okCount} missing`, tone: "danger" },
    });
  }
  const selected = sp.app ?? rows[0]?.id ?? null;
  const row = list.find((r) => r.id === selected);
  return (
    <OnboardFrame
      title="Documents"
      sub="What has been collected and verified. Identity and bank numbers stay masked unless someone with the right role unmasks them — and that is logged."
      listLabel={`Collecting documents · ${rows.length}`}
      rows={rows}
      selected={selected}
      basePath="/hire/documents"
      emptyList="Nobody is collecting documents yet — that starts after a decision gate."
    >
      {selected ? (
        <>
          {row ? <CandidateHead id={row.id} name={row.name} meta={`${row.code} · ${row.blueprintTitle} v${row.version} · ${row.location ?? "—"} · ${row.stageName}`} /> : null}
          <CandidateDocuments ctx={ctx} applicationId={selected} />
        </>
      ) : null}
    </OnboardFrame>
  );
}
