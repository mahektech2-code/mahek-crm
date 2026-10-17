import type { Metadata } from "next";
import { requireHireScreen } from "@/lib/hire/access";
import { listBlueprints } from "@/lib/hire/services/blueprints";
import { BtnLink, Locked, PageHead } from "../_ui/kit";
import { BlueprintList } from "./blueprint-list";

export const metadata: Metadata = { title: "Blueprints" };
export const dynamic = "force-dynamic";

export default async function BlueprintsPage() {
  const ctx = await requireHireScreen("blueprints");
  const rows = await listBlueprints();
  const canEdit = ctx.can("editBp") || ctx.can("proposeBp");
  return (
    <>
      <PageHead
        title="Blueprints"
        sub="Every role’s hiring process — competencies, stages, questions, rubrics, thresholds, offer and onboarding — versioned. A candidate is scored under the version they entered on, for their whole journey."
        actions={canEdit ? <BtnLink href="/hire/blueprints/new" kind="primary">New role blueprint</BtnLink> : <Locked why="Needs a Hiring Manager, HR Head or Admin.">New role blueprint</Locked>}
      />
      <BlueprintList rows={rows} />
    </>
  );
}
