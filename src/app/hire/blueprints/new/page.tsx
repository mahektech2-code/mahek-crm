import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireHireScreen } from "@/lib/hire/access";
import { aiState } from "@/lib/hire/ai/orchestrator";
import { publishedForCopy } from "@/lib/hire/services/blueprints";
import { PageHead } from "../../_ui/kit";
import { NewRole } from "./new-role";

export const metadata: Metadata = { title: "New role blueprint" };
export const dynamic = "force-dynamic";

export default async function NewBlueprintPage() {
  const ctx = await requireHireScreen("blueprints");
  if (!ctx.can("editBp") && !ctx.can("proposeBp")) redirect("/hire/blueprints");
  const [published, ai] = await Promise.all([publishedForCopy(), aiState()]);
  return (
    <>
      <PageHead
        back={{ href: "/hire/blueprints", label: "Blueprints" }}
        title="New role blueprint"
        sub="Describe the role. The AI drafts the whole hiring process; a person approves every element before anything is published."
      />
      <NewRole published={published} aiDown={ai.on ? null : ai.reason} />
    </>
  );
}
