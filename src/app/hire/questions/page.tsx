import type { Metadata } from "next";
import { requireHireScreen } from "@/lib/hire/access";
import { questionBank } from "@/lib/hire/services/blueprints";
import { PageHead } from "../_ui/kit";
import { QuestionTable } from "./question-table";

export const metadata: Metadata = { title: "Questions" };
export const dynamic = "force-dynamic";

export default async function QuestionsPage() {
  await requireHireScreen("questions");
  const rows = await questionBank();
  return (
    <>
      <PageHead title="Questions" sub="Every question in the latest version of every blueprint, with its competency, scoring mode and what the rubric critic found." />
      <QuestionTable rows={rows} />
    </>
  );
}
