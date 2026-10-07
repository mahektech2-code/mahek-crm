import { CardGrid } from "@/components/ui/card-grid";
import { policyInWords, STANDARD_POLICY_TITLE } from "@/lib/expense-policy-standard";

/* ---------------------------------------------------------------------------
 * The expense policy, as one page anybody can read.
 *
 * Rendered on the Admin Console and on the Sales Dashboard from the same
 * `policyInWords()`, which is built from the rules the engine prices with —
 * so what this page says and what a claim is paid can never disagree.
 * ------------------------------------------------------------------------- */

export function PolicyView() {
  const sections = policyInWords();
  return (
    <div className="space-y-4">
      <div className="rounded-[8px] border border-line bg-canvas px-4 py-3 text-[13px] text-body">
        <span className="font-medium text-ink">{STANDARD_POLICY_TITLE}</span> — one policy for every
        salesman, every city and every day. The handset works each day out with these figures, and the
        manager approves what is left.
      </div>

      <CardGrid min="broad">
        {sections.map((s) => (
          <section key={s.key} className="rounded-[8px] border border-line bg-surface">
            <h2 className="border-b border-line px-4 py-2.5 text-[14px] font-semibold text-ink">
              {s.title}
            </h2>
            <dl className="divide-y divide-line">
              {s.lines.map((l) => (
                <div key={l.label} className="flex items-baseline justify-between gap-4 px-4 py-2.5">
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
    </div>
  );
}
