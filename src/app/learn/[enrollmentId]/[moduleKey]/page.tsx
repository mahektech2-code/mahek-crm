import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { money, nowMs } from "@/lib/format";
import { moduleForLearner } from "@/lib/training/service";
import { CATEGORY_LABEL, type TrainingCategory } from "@/lib/training/types";
import { cx } from "@/components/ui/primitives";
import { directory } from "../../directory";
import { Section, StatePill } from "../../ui";
import { Reader } from "./reader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Module" };

/** One module as the learner reads it — content first, then the test. Never the questions’ answers. */
export default async function ModulePage({ params }: { params: Promise<{ enrollmentId: string; moduleKey: string }> }) {
  const { enrollmentId, moduleKey: raw } = await params;
  const moduleKey = decodeURIComponent(raw);
  const user = await requireUser();
  const now = nowMs();
  const m = await moduleForLearner(user.id, enrollmentId, moduleKey, now);
  if (!m) notFound();
  const p = m.progress;
  const locked = p.state === "locked";
  const dir = m.content.some((b) => b.kind === "directory") ? await directory() : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-2">
        <Link href="/learn" aria-label="Back to modules" className="-ml-2 flex size-11 flex-none items-center justify-center text-body">
          <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </Link>
        <div className="min-w-0 flex-1">
          <div className="text-[12px] text-muted">
            Module {m.view.modules.find((x) => x.moduleKey === moduleKey)?.n ?? ""} of {m.view.modules.length} · {CATEGORY_LABEL[m.category as TrainingCategory] ?? m.category}
          </div>
          <h1 className="m-0 text-[18px] leading-6 font-semibold text-heading">{m.title}</h1>
        </div>
        <StatePill state={p.state} score={p.bestScore} />
      </div>

      {p.state === "retraining_required" ? (
        <div className="rounded-[8px] bg-warn-soft px-3.5 py-3 text-[13px] leading-[19px] text-warn-ink">Read it again before your retake. {p.why}</div>
      ) : locked ? (
        <div className="rounded-[8px] bg-divider px-3.5 py-3 text-[13px] leading-[19px] text-body">
          <b>Locked.</b> {p.why} You can read ahead, but the test opens only then.
        </div>
      ) : null}

      <div className="flex flex-col gap-4">
        {m.content.map((b) => {
          if (b.kind === "text")
            return (
              <section key={b.key} className={cx(b.tone === "safety" ? "rounded-[8px] border border-danger-soft bg-surface p-3.5" : "")}>
                <h2 className={cx("m-0 mb-1.5 text-[16px] font-semibold", b.tone === "safety" ? "text-danger" : "text-heading")}>{b.title}</h2>
                <p className="m-0 text-sm leading-[22px] whitespace-pre-line text-heading">{b.body}</p>
              </section>
            );
          if (b.kind === "link")
            return (
              <a key={b.key} href={b.url} target="_blank" rel="noreferrer" className="flex min-h-12 items-center gap-3 rounded-[8px] border border-line bg-surface p-3 no-underline">
                <span className="flex size-9 flex-none items-center justify-center rounded-[6px] bg-info-soft text-[11px] font-bold text-info">LINK</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-heading">{b.title}</span>
                  {b.note ? <span className="block text-[12px] text-muted">{b.note}</span> : null}
                </span>
              </a>
            );
          if (b.kind === "product_facts") {
            const facts = m.facts[b.key] ?? [];
            return (
              <section key={b.key} className="rounded-[8px] border border-line bg-surface p-3">
                <div className="mb-1.5 flex items-baseline justify-between gap-2">
                  <h2 className="m-0 text-[15px] font-semibold text-heading">{b.title}</h2>
                  <span className="text-[11px] text-muted">today’s catalogue</span>
                </div>
                {facts.length ? (
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-[13px]">
                      <thead>
                        <tr className="text-left text-[11px] font-medium tracking-label text-muted uppercase">
                          <th className="border-b border-divider px-2 py-1.5">Pack</th>
                          <th className="border-b border-divider px-2 py-1.5 text-right">Price</th>
                          <th className="border-b border-divider px-2 py-1.5 text-right">Box</th>
                        </tr>
                      </thead>
                      <tbody>
                        {facts.map((f, i) => (
                          <tr key={i}>
                            <td className="border-b border-canvas px-2 py-1.5 text-heading">
                              {f.packSize ?? f.name}
                              {f.packing ? <span className="block text-[11px] text-muted">{f.packing}</span> : null}
                            </td>
                            <td className="border-b border-canvas px-2 py-1.5 text-right text-heading tabular-nums">{f.pricePaise != null ? money(f.pricePaise) : "—"}</td>
                            <td className="border-b border-canvas px-2 py-1.5 text-right tabular-nums">{f.cansPerBox > 1 ? f.cansPerBox : "single"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="m-0 text-[13px] text-muted">Nothing in the catalogue matches this module yet.</p>
                )}
              </section>
            );
          }
          return (
            <Section key={b.key} title={b.title}>
              {dir?.entries.length ? (
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {dir.entries.map((e, i) => (
                    <li key={i} className="rounded-[8px] border border-line bg-surface px-3 py-2 text-sm">
                      <span className="block text-[11px] font-medium tracking-label text-muted uppercase">{e.desk}</span>
                      <span className="text-heading">{e.name}</span>
                      {e.about ? <span className="block text-[12px] text-muted">{e.about}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="m-0 text-[13px] text-muted">The directory has not been filled in yet.</p>
              )}
            </Section>
          );
        })}
      </div>

      <Reader
        key={`${enrollmentId}:${moduleKey}:${p.state}:${p.attempts}`}
        enrollmentId={enrollmentId}
        moduleKey={moduleKey}
        state={p.state}
        studiedSeconds={p.studiedSeconds}
        minStudyMinutes={m.rules.minStudyMinutes}
        canStart={m.canStart.ok}
        why={m.canStart.ok ? null : m.canStart.why}
        rules={m.rules}
        attempts={p.attempts}
        trackDone={m.view.enrollment.status !== "active"}
      />
    </div>
  );
}
