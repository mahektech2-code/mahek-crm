import { CardGrid } from "@/components/ui/card-grid";
import { policyInWords, STANDARD_POLICY_TITLE, type PolicySection } from "@/lib/expense-policy-standard";

/* ---------------------------------------------------------------------------
 * An expense policy, as one page anybody can read.
 *
 * Rendered on the Admin Console (the editor's Preview, live over unsaved
 * changes) and on the Sales Dashboard from `policyInWords()`, which is built
 * from the rules the engine prices with — so what this page says and what a
 * claim is paid can never disagree.
 *
 * No hooks: it renders in a server page and inside the client editor alike.
 * ------------------------------------------------------------------------- */

export function PolicyView({
  sections = policyInWords(),
  title = STANDARD_POLICY_TITLE,
  intro = "one policy for every salesman who is not on another. The handset works each day out with these figures, and the manager decides what is logged.",
  guidelines = [],
}: {
  sections?: PolicySection[];
  title?: string;
  intro?: string | null;
  /** The policy's own written lines, drawn above the figures. */
  guidelines?: readonly string[];
}) {
  return (
    <div className="space-y-4">
      {intro !== null ? (
        <div className="rounded-[8px] border border-line bg-canvas px-4 py-3 text-[13px] text-body">
          <span className="font-medium text-ink">{title}</span> — {intro}
        </div>
      ) : null}

      {guidelines.length ? (
        <section className="rounded-[8px] border border-line bg-surface">
          <h2 className="border-b border-line px-4 py-2.5 text-[14px] font-semibold text-ink">Guidelines</h2>
          <ol className="list-decimal space-y-1.5 py-3 pr-4 pl-9 text-[13px] text-body">
            {guidelines.map((g, i) => (
              <li key={`${i}-${g}`}>{g}</li>
            ))}
          </ol>
        </section>
      ) : null}

      {sections.length === 0 ? (
        <div className="rounded-[8px] border border-line bg-surface px-4 py-6 text-center text-[13px] text-muted">
          This policy has no rules yet, so it pays nothing.
        </div>
      ) : (
        <CardGrid min="broad">
          {sections.map((s) => (
            <section key={s.key} className="rounded-[8px] border border-line bg-surface">
              <h2 className="border-b border-line px-4 py-2.5 text-[14px] font-semibold text-ink">{s.title}</h2>
              <dl className="divide-y divide-line">
                {s.lines.map((l, i) => (
                  <div key={`${l.label}-${i}`} className="flex items-baseline justify-between gap-4 px-4 py-2.5">
                    <dt className="text-[13px] text-body">
                      {l.label}
                      {l.note ? <span className="block text-[12px] text-muted">{l.note}</span> : null}
                    </dt>
                    <dd className="shrink-0 text-right text-[13px] font-semibold text-ink">{l.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </CardGrid>
      )}
    </div>
  );
}
