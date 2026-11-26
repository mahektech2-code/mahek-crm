import type { Metadata } from "next";
import Link from "next/link";
import { requireHireScreen } from "@/lib/hire/access";
import { lockedWhy } from "@/lib/hire/roles";
import { listModules } from "@/lib/training/service";
import { CATEGORY_LABEL, type TrainingCategory } from "@/lib/training/types";
import { Empty, Locked, PageHead, Panel, Pill, fd } from "../../_ui/kit";
import { NewModule } from "./new-module";

export const metadata: Metadata = { title: "Modules" };
export const dynamic = "force-dynamic";

/** Every training module, with the version learners are on and whether a draft is waiting. */
export default async function ModulesPage() {
  const ctx = await requireHireScreen("modules");
  const rows = await listModules();
  const canAuthor = ctx.can("trainingAuthor");
  return (
    <>
      <PageHead
        title="Modules"
        sub="Training content and its test, one module at a time. Publishing freezes a version — the questions, the pass mark, the rules — so nobody is ever re-marked by an edit."
        actions={canAuthor ? null : <Locked why={lockedWhy("trainingAuthor")}>New module</Locked>}
      />
      <div className="grid grid-cols-[minmax(0,1fr)_320px] items-start gap-4">
        <Panel pad={false}>
          {!rows.length ? (
            <div className="p-5">
              <Empty title="No modules yet">{canAuthor ? "Create the first one on the right." : "A Trainer, Sales Head or HR Head writes them."}</Empty>
            </div>
          ) : (
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-divider text-left text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                  <th className="px-4 py-2.5">Module</th>
                  <th className="px-3 py-2.5">Category</th>
                  <th className="px-3 py-2.5">Live</th>
                  <th className="px-3 py-2.5">Draft</th>
                  <th className="px-3 py-2.5 text-right">Questions</th>
                  <th className="px-3 py-2.5 text-right">Learners</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const v = m.draft ?? m.published;
                  const qs = v?.definition.questions.filter((q) => q.active).length ?? 0;
                  return (
                    <tr key={m.id} className="border-b border-canvas hover:bg-canvas">
                      <td className="px-4 py-2.5">
                        <Link href={`/hire/train/modules/${m.id}`} className="font-medium text-heading no-underline hover:underline">
                          {m.title}
                        </Link>
                        <div className="text-xs text-muted">{m.key}{m.active ? "" : " · inactive"}</div>
                      </td>
                      <td className="px-3 py-2.5">
                        <Pill tone="info">{CATEGORY_LABEL[m.category as TrainingCategory] ?? m.category}</Pill>
                      </td>
                      <td className="px-3 py-2.5">{m.published ? <Pill tone="success">v{m.published.version} · {fd(m.published.publishedAt)}</Pill> : <Pill tone="muted">Not published</Pill>}</td>
                      <td className="px-3 py-2.5">{m.draft ? <Pill tone="neutral">v{m.draft.version}</Pill> : <span className="text-muted">—</span>}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{qs}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{m.learners}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>
        {canAuthor ? <NewModule /> : null}
      </div>
    </>
  );
}
