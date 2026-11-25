import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireHireScreen } from "@/lib/hire/access";
import { lockedWhy } from "@/lib/hire/roles";
import { moduleDetail, productFacts, type ProductFact } from "@/lib/training/service";
import { ModuleEditor } from "./module-editor";

export const metadata: Metadata = { title: "Module" };
export const dynamic = "force-dynamic";

export default async function ModulePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireHireScreen("modules");
  const { id } = await params;
  const d = await moduleDetail(id);
  if (!d) notFound();
  const editing = d.versions.find((v) => v.status === "draft") ?? d.versions.find((v) => v.status === "published") ?? d.versions[0];
  const published = d.versions.find((v) => v.status === "published") ?? null;
  /* The live catalogue behind each product-facts block, read now — what a learner would see today. */
  const facts: Record<string, ProductFact[]> = {};
  for (const b of editing?.definition.content ?? []) if (b.kind === "product_facts") facts[b.match] = await productFacts(b.match);
  /* A price that moved after publishing makes a question that quotes it stale. */
  const priceChanged = Boolean(published?.publishedAt && editing?.definition.content.some((b) => b.kind === "product_facts"));
  return (
    <ModuleEditor
      key={`${editing?.id}:${editing?.updatedAt.toISOString()}`}
      module={{ id: d.module.id, key: d.module.key, title: d.module.title, category: d.module.category }}
      editing={editing ? { id: editing.id, version: editing.version, status: editing.status, definition: editing.definition } : null}
      versions={d.versions.map((v) => ({ id: v.id, version: v.version, status: v.status, at: (v.publishedAt ?? v.createdAt).toISOString(), by: d.people[v.publishedById ?? v.createdById ?? ""] ?? null, passMark: v.definition.passMarkPercent, questions: v.definition.questions.filter((q) => q.active).length }))}
      tracks={d.tracks}
      facts={facts}
      pricesLive={priceChanged}
      canAuthor={ctx.can("trainingAuthor")}
      lockedWhy={lockedWhy("trainingAuthor")}
    />
  );
}
