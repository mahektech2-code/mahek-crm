import type { Metadata } from "next";
import { requireHireScreen } from "@/lib/hire/access";
import { lockedWhy } from "@/lib/hire/roles";
import { listModules, questionRates } from "@/lib/training/service";
import { PageHead } from "../../_ui/kit";
import { QuestionBank } from "./question-bank";

export const metadata: Metadata = { title: "Question bank" };
export const dynamic = "force-dynamic";

/** Every module's questions in one place. An edit lands in that module's draft; learners keep what they were tested on. */
export default async function QuestionBankPage() {
  const ctx = await requireHireScreen("bank");
  const [mods, rates] = await Promise.all([listModules(), questionRates()]);
  const modules = mods
    .map((m) => {
      const v = m.draft ?? m.published;
      return v ? { id: m.id, key: m.key, title: m.title, version: v.version, draft: Boolean(m.draft), learners: m.learners, definition: v.definition } : null;
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x));
  return (
    <>
      <PageHead title="Question bank" sub="Multiple-choice questions for every module. Edits land in the module’s draft version — learners keep the questions they were tested on, and their attempts never change." />
      <QuestionBank modules={modules} rates={rates} canAuthor={ctx.can("trainingAuthor")} lockedWhy={lockedWhy("trainingAuthor")} />
    </>
  );
}
