"use client";

/* ---------------------------------------------------------------------------
 * TWO LISTS SIDE BY SIDE, PER SKU.
 *
 * The question is always one of two: what did the revision actually do, and is
 * this derived list still following the rule it claims to. Both are answered
 * by the same table — every product on either list, the two figures, and the
 * difference in rupees and percent.
 *
 * A RATE ON ONE LIST AND NOT THE OTHER IS NOT A CHANGE OF ZERO. `rateChange`
 * answers null from nothing rather than a percentage, and the row says "only
 * on this list" in words — a dash in a delta column reads as "no movement",
 * which is the opposite of what a missing price means.
 *
 * The inferred rule is the other half: where the differences all agree,
 * `inferDerivation` names the rule behind them, which is how somebody finds
 * out that a list they thought was freehand is really the Mumbai sheet plus
 * ten rupees a litre.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { Modal } from "@/components/ui/modal";
import { Badge, Button, Callout, MetricStrip, Select, Td, Th, Tr } from "@/components/ui/primitives";
import type { Comparison, PricingOptions } from "@/lib/price-list-views";
import { pctLabel } from "@/lib/engines/price-math";
import { money, signedMoney } from "@/lib/format";
import { derivationSentence } from "@/components/pricing/derivation";

export function CompareModal(props: {
  open: boolean;
  onClose: () => void;
  /** The list being compared FROM. */
  listId: string;
  listName: string;
  options: PricingOptions;
}) {
  if (!props.open) return null;
  return <CompareBody key={props.listId} {...props} />;
}

function CompareBody({
  onClose,
  listId,
  listName,
  options,
}: {
  onClose: () => void;
  listId: string;
  listName: string;
  options: PricingOptions;
}) {
  const [otherId, setOtherId] = React.useState("");
  const [answer, setAnswer] = React.useState<{ id: string; comparison: Comparison | null } | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    if (!otherId) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/price-lists/compare?a=${listId}&b=${otherId}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          setAnswer({ id: otherId, comparison: null });
          return;
        }
        setAnswer({ id: otherId, comparison: (await res.json()) as Comparison });
      } catch (e) {
        if ((e as Error)?.name !== "AbortError") setFailed(true);
      }
    })();
    return () => controller.abort();
  }, [listId, otherId]);

  const comparison = answer && answer.id === otherId ? answer.comparison : null;
  const loading = otherId !== "" && (answer === null || answer.id !== otherId);

  return (
    <Modal
      open
      onClose={onClose}
      width={840}
      title={`Compare ${listName} with…`}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="space-y-3.5">
        <Select value={otherId} onChange={(e) => setOtherId(e.target.value)} className="w-full">
          <option value="">Pick the other list</option>
          {options.lists
            .filter((l) => l.id !== listId)
            .map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
        </Select>

        {failed ? <Callout tone="danger">The comparison could not be read. Try again.</Callout> : null}
        {loading ? <p className="text-[13px] text-muted">Working it out…</p> : null}

        {comparison ? (
          <>
            <MetricStrip
              metrics={[
                { label: "Changed", value: String(comparison.summary.changed) },
                { label: "Up", value: String(comparison.summary.up) },
                { label: "Down", value: String(comparison.summary.down) },
                { label: `Only on ${comparison.a.name}`, value: String(comparison.summary.onlyInA) },
                { label: `Only on ${comparison.b.name}`, value: String(comparison.summary.onlyInB) },
                {
                  label: "Median move",
                  value:
                    comparison.summary.medianDeltaBp == null
                      ? "—"
                      : pctLabel(comparison.summary.medianDeltaBp),
                },
              ]}
            />

            {comparison.inferredDerivation ? (
              <Callout tone="brand">
                Every difference agrees on one rule: {comparison.b.name} is{" "}
                {comparison.a.name} {derivationSentence(comparison.inferredDerivation)}.
              </Callout>
            ) : null}

            <div className="max-h-[320px] overflow-auto rounded-[4px] border border-line">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <Th>Product</Th>
                    <Th align="right">{comparison.a.name}</Th>
                    <Th align="right">{comparison.b.name}</Th>
                    <Th align="right">Difference</Th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.rows.map((row) => (
                    <Tr key={row.productId}>
                      <Td className="max-w-[300px] truncate" title={row.productName}>
                        {row.productName}
                      </Td>
                      <Td align="right">
                        {row.aIncl == null ? <span className="text-muted">Not on it</span> : money(row.aIncl)}
                      </Td>
                      <Td align="right">
                        {row.bIncl == null ? <span className="text-muted">Not on it</span> : money(row.bIncl)}
                      </Td>
                      <Td align="right">
                        {row.deltaPaise == null ? (
                          <span className="text-muted">—</span>
                        ) : (
                          <Badge tone={row.deltaPaise > 0 ? "danger" : row.deltaPaise < 0 ? "success" : "muted"}>
                            {signedMoney(row.deltaPaise)}
                            {row.deltaBp == null ? "" : ` · ${pctLabel(row.deltaBp)}`}
                          </Badge>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  );
}
