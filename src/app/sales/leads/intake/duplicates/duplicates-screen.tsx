"use client";

import * as React from "react";
import Link from "next/link";
import { Card, Input, cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { stageLabel, salesTypeLabel } from "@/lib/lead-labels";
import { dismissDuplicatePair } from "@/lib/actions/lead-intake";
import type {
  DuplicatePair,
  DuplicateReason,
  DuplicateSide,
} from "@/lib/services/lead-intake-service";
import { Banner, Button, Empty, MetricRow, Pill, ScreenHeader } from "../../../parts";
import { plural } from "../../../words";

/* ---------------------------------------------------------------------------
 * Screen 7.
 *
 * **The gap is on the screen, in words, above the list.** Not in a tooltip and
 * not in the specification: somebody who opens this looking for a Merge button
 * and does not find one concludes the screen is half built, and the next thing
 * they do is merge two shops by hand — deleting one and retyping its orders
 * somewhere else, which is the outcome the missing button exists to prevent.
 *
 * **Every pair shows its EVIDENCE rather than a verdict.** "Possible
 * duplicate" is not something anybody can act on; "the same ten digits, and
 * one of them has taken four orders" is. The three rules are drawn as separate
 * marks because they are wildly different amounts of proof — a shared GSTIN is
 * two records of one registered business, and a name that scores 0.61 in the
 * same town is two shops that might both be called Sharma Paints.
 *
 * **The order count is on both sides, and it is the number that decides.** If
 * one side has the whole trading history and the other has nothing, whoever
 * eventually merges these knows which way round it goes. If BOTH have orders,
 * that is exactly the pair no merge function should ever have been allowed to
 * touch unsupervised, and the screen says so.
 * ------------------------------------------------------------------------- */

const REASON_TEXT: Record<DuplicateReason, { label: string; tone: "danger" | "warn" | "neutral"; why: string }> = {
  phone: {
    label: "Same number",
    tone: "danger",
    why: "The last ten digits agree. This is the commonest real duplicate — a website form and a handset both reaching one shop.",
  },
  gstin: {
    label: "Same GSTIN",
    tone: "danger",
    why: "One registered business, twice. Rare on this book: the 5,292 shops out of the EMP 2.0 master carry no GSTIN between them.",
  },
  name: {
    label: "Close name, same town",
    tone: "warn",
    why: "Trigram similarity inside one town. It is the weakest of the three and the one that finds pairs nobody else would.",
  },
};

export function DuplicatesScreen({
  pairs,
  total,
  dismissed,
  nameThreshold,
  canWork,
}: {
  pairs: DuplicatePair[];
  /** Before the cap. A capped list has to say what it is a slice of. */
  total: number;
  dismissed: number;
  nameThreshold: number;
  canWork: boolean;
}) {
  const { push } = useToast();
  const [answering, setAnswering] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  /* Pairs answered in this sitting. The server has them too — the next render
     will not include them — but the row has to leave the screen now. */
  const [gone, setGone] = React.useState<string[]>([]);

  const shown = pairs.filter((p) => !gone.includes(p.key));
  const bothTrading = shown.filter((p) => p.left.orders > 0 && p.right.orders > 0);

  async function dismiss(pair: DuplicatePair) {
    setBusy(true);
    try {
      const result = await dismissDuplicatePair(pair.left.id, pair.right.id, reason);
      if (result.ok) {
        setGone((g) => [...g, pair.key]);
        setAnswering(null);
        setReason("");
        if (result.message) push(result.message);
      } else {
        push(result.error, "error");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <ScreenHeader
        title="Duplicates"
        subtitle="Two records for one shop, found three ways. This screen can find them and cannot join them — which is stated below rather than left to be discovered."
      />

      {/* ─────────────────────────────── the gap, named, above everything else */}
      <Card className="mb-4 border-l-[3px] border-l-warn p-5">
        <h2 className="text-base font-semibold text-ink">
          There is no merge in MahekOne, and this screen will not pretend there is
        </h2>
        <p className="mt-1.5 max-w-[820px] text-[13px] leading-[19px] text-pretty text-body">
          Joining two <code className="font-mono text-[12px]">customers</code> rows means
          deciding what becomes of two sets of orders, bills, receipts, visits,
          tasks and timeline entries — and one of those answers is a business
          decision rather than a technical one:{" "}
          <strong className="font-medium text-ink">
            a merged lead&rsquo;s stage history is two histories
          </strong>
          , and <code className="font-mono text-[12px]">lead_stage_transitions</code> is
          append-only by design. A transition recorded wrongly is corrected by a
          further transition, never by an edit. Nothing here has an answer to what
          two of them fused together would mean, and a merge function would be
          deciding that by accident.
        </p>

        <div className="mt-4 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          What it needs before it can merge
        </div>
        <ol className="mt-2 max-w-[820px] list-decimal space-y-1.5 pl-5 text-[13px] text-body">
          <li>
            <strong className="font-medium text-ink">
              A <code className="font-mono text-[12px]">customer_merges</code> table.
            </strong>{" "}
            Which record won, which lost, who decided and when — so a balance
            somebody queries next year can be traced back through the join.
          </li>
          <li>
            <strong className="font-medium text-ink">A decision on history.</strong>{" "}
            Whether the losing row&rsquo;s stage transitions are carried over,
            kept where they are and pointed at the survivor, or left behind with
            the merge row as the only link. Somebody at Mahek answers this, not a
            function.
          </li>
          <li>
            <strong className="font-medium text-ink">
              A <code className="font-mono text-[12px]">mergeCustomers</code> action.
            </strong>{" "}
            One write, audited, with its own capability — the same shape every
            other irreversible decision in this product has.
          </li>
        </ol>

        <p className="mt-3 max-w-[820px] text-[13px] text-pretty text-muted">
          Until those exist the only thing offered here is &ldquo;these are two
          different shops&rdquo;, which takes a pair off the list. That answer is
          recorded in the audit log, with the person and the reason, because there
          is no table for it either — when{" "}
          <code className="font-mono text-[12px]">customer_merges</code> lands it
          should move there.
        </p>
      </Card>

      <MetricRow
        metrics={[
          { label: "Pairs waiting", value: String(total) },
          {
            label: "Both have orders",
            value: String(bothTrading.length),
            tone: bothTrading.length ? "warn" : undefined,
          },
          { label: "Answered already", value: String(dismissed) },
        ]}
      />

      {total > pairs.length ? (
        <Banner
          tone="info"
          title={`Showing the strongest ${pairs.length} of ${total}`}
          body="Same number first, then same GSTIN, then closest name. The rest are on the same three rules and are reached by working these down."
        />
      ) : null}

      {bothTrading.length ? (
        <Banner
          tone="warn"
          title={`${plural(bothTrading.length, "pair")} where both records have ordered`}
          body="These are the ones no automatic merge should ever have been allowed near: two trading histories, two sets of bills, and a real possibility that they are two counters of one business rather than one record written twice."
        />
      ) : null}

      {!shown.length ? (
        <Empty
          title={total ? "Nothing left on this page" : "No likely duplicates"}
          body={
            total
              ? "Everything shown has been answered. Reload to see the next of them."
              : `Nothing on the book shares a telephone number or a GSTIN, and no two names in one town score above ${nameThreshold} on similarity. That is the good answer, and it is worth being able to see.`
          }
        />
      ) : (
        <div className="space-y-3">
          {shown.map((pair) => (
            <Card key={pair.key} className="overflow-hidden">
              <div className="flex flex-wrap items-center gap-2 border-b border-divider bg-canvas px-5 py-3">
                {pair.reasons.map((r) => (
                  <span key={r} title={REASON_TEXT[r].why}>
                    <Pill tone={REASON_TEXT[r].tone === "neutral" ? "neutral" : REASON_TEXT[r].tone}>
                      {REASON_TEXT[r].label}
                    </Pill>
                  </span>
                ))}
                {pair.nameScore != null ? (
                  <span className="text-[12px] tabular-nums text-muted">
                    name similarity {pair.nameScore.toFixed(2)}
                  </span>
                ) : null}
                <span className="flex-1" />
                {pair.left.orders > 0 && pair.right.orders > 0 ? (
                  <span className="text-[12px] font-medium text-warn-ink">
                    Both have ordered
                  </span>
                ) : null}
              </div>

              <div className="grid gap-px bg-divider sm:grid-cols-2">
                <Side side={pair.left} />
                <Side side={pair.right} />
              </div>

              <div className="border-t border-divider px-5 py-3">
                {answering === pair.key ? (
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="min-w-[280px] flex-1">
                      <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                        Why are they different?
                      </span>
                      <Input
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Two counters of one family, separate proprietors"
                      />
                    </label>
                    <Button
                      tone="primary"
                      disabled={busy || reason.trim().length < 3}
                      title={
                        reason.trim().length < 3
                          ? "Say why. The next person to see this pair reads it."
                          : undefined
                      }
                      onClick={() => dismiss(pair)}
                    >
                      {busy ? "Saving…" : "Save it"}
                    </Button>
                    <Button
                      onClick={() => {
                        setAnswering(null);
                        setReason("");
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      disabled={!canWork}
                      title={
                        canWork
                          ? undefined
                          : "Answering a pair takes the lead.work capability."
                      }
                      onClick={() => {
                        setAnswering(pair.key);
                        setReason("");
                      }}
                    >
                      Not a duplicate
                    </Button>
                    <span className="text-[13px] text-muted">
                      There is nothing else to offer here — see the note above.
                      Whichever record is the one being worked, the other stays
                      exactly where it is.
                    </span>
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/** One half of a pair. Both sides are drawn identically — neither is the winner. */
function Side({ side }: { side: DuplicateSide }) {
  return (
    <div className="bg-surface px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={
              side.kind === "lead"
                ? `/sales/leads/${side.id}`
                : `/crm/customers/${side.id}`
            }
            className="text-sm font-semibold text-ink no-underline hover:underline"
          >
            {side.name}
          </Link>
          {side.companyName && side.companyName !== side.name ? (
            <div className="text-[13px] text-muted">{side.companyName}</div>
          ) : null}
        </div>
        <Pill tone={side.kind === "lead" ? "brand" : "success"}>
          {side.kind === "lead" ? "Lead" : "Customer"}
        </Pill>
      </div>

      <dl className="mt-3 grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-[13px]">
        <Line label="Town" value={side.city} />
        <Line label="Phone" value={side.phone} mono />
        <Line label="GSTIN" value={side.gstin} mono />
        <Line
          label="Rung"
          value={side.stage ? stageLabel(side.stage) : null}
          /* A customer has no rung, and an empty cell there is the right answer
             rather than a missing one — the funnel is not where it lives. */
        />
        <Line
          label="Ladder"
          value={side.salesType ? salesTypeLabel(side.salesType) : null}
        />
        <Line label="Source" value={side.source} />
        <Line label="Owner" value={side.ownerName} emptyWord="Unassigned" />
        <Line label="Raised" value={side.createdOn} />
        <div className="text-muted">Orders</div>
        <div className={cx("tabular-nums", side.orders ? "font-medium text-ink" : "text-muted")}>
          {side.orders}
        </div>
      </dl>
    </div>
  );
}

function Line({
  label,
  value,
  mono,
  emptyWord = "—",
}: {
  label: string;
  value: string | null;
  mono?: boolean;
  /** What absence is CALLED. A blank cell reads as data nobody loaded. */
  emptyWord?: string;
}) {
  return (
    <>
      <div className="text-muted">{label}</div>
      <div className={cx(mono && value ? "font-mono text-[12px]" : "", value ? "text-body" : "text-muted")}>
        {value || emptyWord}
      </div>
    </>
  );
}
