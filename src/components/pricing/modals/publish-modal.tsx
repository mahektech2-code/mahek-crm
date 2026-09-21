"use client";

/* ---------------------------------------------------------------------------
 * PUTTING A LIST INTO FORCE — the checklist, then the button.
 *
 * Publishing is the moment a draft starts pricing real orders, and the two
 * things that go wrong are both invisible on the draft itself: a list with no
 * rates, which the action refuses outright, and a list nobody is named on,
 * which prices nothing and looks exactly like a list that is working. So the
 * counts are read out in words BEFORE the button, and the second one is a
 * warning rather than a refusal — a list published today and scoped tomorrow
 * is a legitimate order of work.
 *
 * THE WARNINGS COME BACK FROM THE ACTION AND ARE SHOWN BEFORE THE MODAL
 * CLOSES. `publishPriceList` checks a derived list against its own rule and
 * says where the rates no longer follow it; a toast that flashes past is not
 * where somebody reads six lines about prices that have drifted.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { Button, Callout, Field, Select } from "@/components/ui/primitives";
import type { PriceListDetail, PricingOptions } from "@/lib/price-list-views";
import { publishPriceList } from "@/lib/actions/price-lists";
import { longDate } from "@/lib/format";

const DATE_CLASS =
  "h-8.5 rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand";

export function PublishModal(props: {
  open: boolean;
  onClose: () => void;
  detail: PriceListDetail;
  options: PricingOptions;
}) {
  if (!props.open) return null;
  return <PublishBody key={props.detail.list.id} {...props} />;
}

function PublishBody({
  onClose,
  detail,
  options,
}: {
  onClose: () => void;
  detail: PriceListDetail;
  options: PricingOptions;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [busy, setBusy] = React.useState(false);
  const [effectiveFrom, setEffectiveFrom] = React.useState(detail.list.effectiveFrom);
  const [supersedesId, setSupersedesId] = React.useState(detail.list.supersedesId ?? "");
  const [warnings, setWarnings] = React.useState<string[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const rates = detail.rates.length;
  const scopes = detail.scopes.length;
  const published = options.lists.filter((l) => l.status === "published" && l.id !== detail.list.id);

  async function publish() {
    setBusy(true);
    setError(null);
    try {
      const r = await run(
        publishPriceList(detail.list.id, {
          supersedesId: supersedesId || null,
          effectiveFrom,
        }),
      );
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
      if (r.data.warnings.length) setWarnings(r.data.warnings);
      else onClose();
    } finally {
      setBusy(false);
    }
  }

  /* Published, with something to read. The modal stays open on purpose. */
  if (warnings) {
    return (
      <Modal
        open
        onClose={onClose}
        title={`${detail.list.name} is in force`}
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <Callout tone="warn">Worth reading before anybody quotes from it.</Callout>
        <ul className="ml-4 list-disc space-y-1 text-[13px] text-body">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title={`Publish ${detail.list.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || !rates}
            title={!rates ? "A list with no prices is not a list." : busy ? "Publishing…" : undefined}
            onClick={publish}
          >
            {busy ? "Publishing…" : "Publish it"}
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        {error ? <Callout tone="danger">{error}</Callout> : null}

        <ul className="space-y-1.5 text-sm text-body">
          <li>
            <Tick ok={rates > 0} />
            {rates
              ? `${rates} price${rates === 1 ? "" : "s"} on the list.`
              : "No prices on the list. A list with no prices is not a list."}
          </li>
          <li>
            <Tick ok={scopes > 0} />
            {scopes
              ? `${scopes} rule${scopes === 1 ? "" : "s"} saying who it applies to.`
              : "Nobody is named on this list yet, so no shop will be priced from it. You can publish anyway and add them after."}
          </li>
          <li>
            <Tick ok />
            In force from {longDate(effectiveFrom)}.
          </li>
        </ul>

        <Field label="Effective from">
          <input
            type="date"
            className={DATE_CLASS}
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
          />
        </Field>

        <Field
          label="Supersedes"
          hint="The list this one replaces. It is ended on the day this one starts."
        >
          <Select value={supersedesId} onChange={(e) => setSupersedesId(e.target.value)}>
            <option value="">Nothing — this list stands beside the others</option>
            {published.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

function Tick({ ok }: { ok: boolean }) {
  return (
    <span className={ok ? "mr-2 text-success" : "mr-2 text-warn"}>{ok ? "✓" : "!"}</span>
  );
}
