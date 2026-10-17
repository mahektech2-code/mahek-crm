import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { requireHireScreen } from "@/lib/hire/access";
import { getBlueprintRow, inFlightOn, previousVersion } from "@/lib/hire/services/blueprints";
import { PageHead, fd } from "../../_ui/kit";
import { Editor } from "./editor";

export const metadata: Metadata = { title: "Blueprint" };
export const dynamic = "force-dynamic";

export default async function BlueprintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireHireScreen("blueprints");
  const b = await getBlueprintRow(id);
  if (!b) notFound();
  const [inFlight, prev] = await Promise.all([inFlightOn(b.id), previousVersion(b)]);
  return (
    <>
      <PageHead
        back={{ href: "/hire/blueprints", label: "Blueprints" }}
        title={`${b.title} · v${b.version}`}
        sub={`${b.family} · ${b.department} · ${b.status === "draft" ? "Draft — nothing here reaches a candidate until it is published." : b.status === "published" ? "Published." : "Retired."}`}
      />
      <Suspense>
        <Editor
          key={b.updatedAt.toISOString()}
          id={b.id}
          version={b.version}
          status={b.status}
          identity={{ title: b.title, family: b.family, department: b.department, level: b.level, employmentType: b.employmentType, locations: b.locations, headcount: b.headcount, retentionMonths: b.retentionMonths }}
          descriptionSource={b.descriptionSource}
          aiGenerated={b.aiGenerated}
          definition={b.definition}
          critic={b.critic ?? []}
          canEdit={ctx.can("editBp") || ctx.can("proposeBp")}
          canPublish={ctx.can("publish")}
          inFlight={inFlight}
          hasPrevious={Boolean(prev)}
          publishedLine={b.publishedAt ? `published ${fd(b.publishedAt)}` : ""}
        />
      </Suspense>
    </>
  );
}
