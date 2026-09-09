"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { money, parseRupees, shortDate } from "@/lib/format";
import { FIRST_ORDER_QUESTIONS } from "@/lib/lead-labels";
import { askForFirstOrder } from "@/lib/actions/leads";
import { Button } from "../parts";

/**
 * §18 — asking for the order, and "customer interested" is not an answer.
 *
 * The specification is explicit about it, and the eight questions are the whole
 * of the argument: a manager who records interest has recorded nothing, and the
 * lead sits for a fortnight while everybody assumes it is moving. Every one of
 * these has an answer a customer can give on a phone call, and the last four
 * are the four things that actually stop an order — price, credit, a
 * competitor, delivery. Naming which one it is turns "he is thinking about it"
 * into something somebody can go and fix.
 *
 * **The date is required and the value is not.** The date is what the gate to
 * `first_order` reads and what the nurture sequence fires from, so a call that
 * did not produce one has not asked the question. The value is an estimate: the
 * product master carries no prices, `canValueOrders()` answers no, and a
 * confident figure here would be a guess presented beside real order values.
 */
export function FirstOrderPanel({
  customerId,
  expectedOrderDate,
  expectedOrderValuePaise,
  countingOrderCount,
  disabled,
  disabledReason,
}: {
  customerId: string;
  expectedOrderDate: string | null;
  expectedOrderValuePaise: number | null;
  /** Once there is a real order the ask is history rather than a task. */
  countingOrderCount: number;
  disabled: boolean;
  disabledReason?: string;
}) {
  const router = useRouter();
  const toast = useToast();

  const [open, setOpen] = React.useState(false);
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [date, setDate] = React.useState(expectedOrderDate ?? "");
  const [value, setValue] = React.useState(
    expectedOrderValuePaise ? String(Math.round(expectedOrderValuePaise / 100)) : "",
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await askForFirstOrder(customerId, {
        answers,
        expectedDate: date,
        expectedValuePaise: parseRupees(value) ?? undefined,
      });
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpen(false);
    toast.push(result.message ?? "Recorded.");
    router.refresh();
  }

  return (
    <section className="rounded-[6px] border border-line bg-surface px-5 py-4">
      <div className="mb-1 flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Ask for the first order
          </div>
          <p className="mt-1 max-w-[520px] text-[12px] text-pretty text-muted">
            Eight questions with answers a customer can give on a call. &ldquo;Customer
            interested&rdquo; is not one of them.
          </p>
        </div>
        <Button
          size="sm"
          tone="primary"
          disabled={disabled}
          title={disabled ? disabledReason : undefined}
          onClick={() => setOpen(true)}
        >
          {expectedOrderDate ? "Ask again" : "Ask"}
        </Button>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-8 gap-y-2 text-[13px]">
        <Fact
          label="They said they will place it"
          value={expectedOrderDate ? shortDate(expectedOrderDate) : "Nobody has asked"}
        />
        <Fact
          label="Expected value"
          value={
            expectedOrderValuePaise ? money(expectedOrderValuePaise) : "Not estimated"
          }
        />
        <Fact
          label="Orders on the account"
          value={countingOrderCount ? String(countingOrderCount) : "None yet"}
        />
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="Ask for the first order" width={680}>
        <div className="grid max-h-[46vh] grid-cols-2 gap-x-4 gap-y-2.5 overflow-y-auto pr-1">
          {FIRST_ORDER_QUESTIONS.map((q) => (
            <label key={q.id} className="block">
              <span className="mb-1 block text-[13px] text-body">{q.ask}</span>
              <input
                value={answers[q.id] ?? ""}
                onChange={(e) =>
                  setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))
                }
                className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
              />
            </label>
          ))}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-4 border-t border-divider pt-3">
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink">
              Date they said · required
            </span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
            />
            <span className="mt-1 block text-[12px] text-muted">
              This is what the gate reads and what the follow-up fires from.
            </span>
          </label>
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink">
              Expected value (optional)
            </span>
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              inputMode="numeric"
              className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
            />
            <span className="mt-1 block text-[12px] text-muted">
              In rupees, and an estimate. Nothing in MahekOne can price an order yet.
            </span>
          </label>
        </div>

        {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button tone="quiet" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            tone="primary"
            disabled={busy || !date}
            title={!date ? "Ask when they will place it. That date is the whole answer." : undefined}
            onClick={() => void submit()}
          >
            {busy ? "Saving…" : "Record it"}
          </Button>
        </div>
      </Modal>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <span className="block">
      <span className="block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        {label}
      </span>
      <span className="block text-body">{value}</span>
    </span>
  );
}
