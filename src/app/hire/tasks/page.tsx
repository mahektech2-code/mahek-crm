import type { Metadata } from "next";
import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import { nowMs } from "@/lib/format";
import { requireHireScreen } from "@/lib/hire/access";
import { TASK_GROUP, tasksFor, type TaskKind } from "@/lib/hire/services/tasks";
import { Empty, hs, Icon, PageHead } from "../_ui/kit";
import { ScreenInButton } from "./screen-in-button";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Tasks" };

const ORDER: TaskKind[] = ["interview", "proposal", "gate", "review", "duplicate", "screen", "sla"];

/** What is waiting on this person, oldest first — derived from the records, never a list of its own. */
export default async function HireTasksPage() {
  const ctx = await requireHireScreen("tasks");
  const now = nowMs();
  const tasks = await tasksFor(ctx, now);
  const groups = ORDER.map((k) => ({ k, items: tasks.filter((t) => t.kind === k) })).filter((g) => g.items.length);
  return (
    <>
      <PageHead title="Tasks" sub="What is waiting on you, oldest first. Each one opens where the work is done." />
      {!groups.length ? (
        <Empty title="Nothing is waiting on you">Scores to confirm, decisions, duplicates and interviews appear here as they arrive.</Empty>
      ) : (
        <div className="flex max-w-[980px] flex-col gap-5">
          {groups.map((g) => (
            <section key={g.k}>
              <div className="mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">
                {TASK_GROUP[g.k]} · <span className="tabular-nums">{g.items.length}</span>
              </div>
              <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
                {g.items.map((t) => {
                  const age = (now - new Date(t.sinceIso).getTime()) / 3_600_000;
                  return (
                    <div key={t.key} className={cx("flex items-center gap-3 border-b border-divider px-4 py-3 last:border-b-0", t.overdue ? "shadow-[inset_3px_0_0_var(--color-danger)]" : "")}>
                      <Link href={t.href} className="min-w-0 flex-1 no-underline hover:no-underline">
                        <span className="block text-sm font-medium text-heading">{t.title}</span>
                        <span className="block truncate text-xs text-muted">{t.meta}</span>
                      </Link>
                      {t.kind === "screen" ? <ScreenInButton applicationId={t.applicationId} /> : null}
                      <span className={cx("flex-none text-xs tabular-nums", t.overdue ? "font-medium text-danger" : "text-muted")} title={t.overdue ? "Past its window" : "Waiting for"}>
                        {t.kind === "interview" ? "today" : age >= 0 ? hs(age) : "—"}
                      </span>
                      <Link href={t.href} aria-label="Open" className="flex-none text-line-strong no-underline">
                        <Icon n="chevron" s={16} />
                      </Link>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
