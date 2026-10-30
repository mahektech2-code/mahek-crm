/* ---------------------------------------------------------------------------
 * TWO REVISIONS (or two books) SIDE BY SIDE — which prices differ, by how
 * much, and in which direction. Read-only and server-rendered.
 * ------------------------------------------------------------------------- */

import Link from "next/link";
import { Badge, Card, CardHeader, MetricStrip, Td, Th, Tr, cx } from "@/components/ui/primitives";
import type { Comparison } from "@/lib/price-list-views";
import { longDate, money } from "@/lib/format";
import { packWords, pctWords } from "@/components/pricing/books/stage-labels";

export function RevisionCompare({
  basePath,
  comparison,
  sameBook,
  bookId,
}: {
  basePath: string;
  comparison: Comparison;
  sameBook: boolean;
  bookId: string | null;
}) {
  const { a, b, rows, summary } = comparison;
  const changed = rows.filter((r) => r.deltaPaise !== 0 || r.aEx == null || r.bEx == null);
  return (
    <div>
      <div className="mb-4">
        <div className="text-[13px] text-muted">
          <Link href={bookId ? `${basePath}/books/${bookId}` : `${basePath}/books`} className="hover:text-brand">
            {sameBook ? "Back to the book" : "Price books"}
          </Link>
        </div>
        <h1 className="text-[24px] leading-tight font-semibold text-ink">
          {sameBook ? `${b.name}: revision ${a.version} → ${b.version}` : `${a.name} vs ${b.name}`}
        </h1>
        <p className="mt-1 text-[13px] text-muted">
          {a.name} v{a.version} from {longDate(a.effectiveFrom)} · {b.name} v{b.version} from {longDate(b.effectiveFrom)}
        </p>
      </div>
      <MetricStrip
        metrics={[
          { label: "Prices changed", value: String(summary.changed) },
          { label: "Up", value: String(summary.up) },
          { label: "Down", value: String(summary.down), tone: summary.down ? "danger" : "ink" },
          { label: `Only in ${sameBook ? `rev ${a.version}` : a.name}`, value: String(summary.onlyInA) },
          { label: `Only in ${sameBook ? `rev ${b.version}` : b.name}`, value: String(summary.onlyInB) },
          { label: "Median move", value: pctWords(summary.medianDeltaBp) },
        ]}
      />
      <Card>
        <CardHeader title="What differs" hint="With GST, per can. Only products that changed or exist on one side are listed." />
        {changed.length ? (
          <table className="w-full table-fixed">
            <colgroup>
              <col />
              <col style={{ width: 90 }} />
              <col style={{ width: 130 }} />
              <col style={{ width: 130 }} />
              <col style={{ width: 120 }} />
              <col style={{ width: 90 }} />
            </colgroup>
            <thead>
              <tr>
                <Th>Product</Th>
                <Th>Pack</Th>
                <Th align="right">{sameBook ? `Rev ${a.version}` : a.name}</Th>
                <Th align="right">{sameBook ? `Rev ${b.version}` : b.name}</Th>
                <Th align="right">Difference</Th>
                <Th align="right">%</Th>
              </tr>
            </thead>
            <tbody>
              {changed.map((r) => (
                <Tr key={r.productId}>
                  <Td className="truncate" title={r.productName}>
                    {r.productName}
                  </Td>
                  <Td>{packWords(r.millilitresPerCan)}</Td>
                  <Td align="right">{r.aIncl != null ? money(r.aIncl) : <Badge tone="muted">not on it</Badge>}</Td>
                  <Td align="right" className="font-medium text-ink">
                    {r.bIncl != null ? money(r.bIncl) : <Badge tone="muted">not on it</Badge>}
                  </Td>
                  <Td align="right" className={cx(r.deltaPaise == null ? "text-muted" : r.deltaPaise > 0 ? "text-warn-ink" : "text-success")}>
                    {r.aIncl != null && r.bIncl != null ? `${r.bIncl - r.aIncl > 0 ? "+" : "−"}${money(Math.abs(r.bIncl - r.aIncl))}` : "—"}
                  </Td>
                  <Td align="right">{pctWords(r.deltaBp)}</Td>
                </Tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="px-5 py-4 text-[13px] text-muted">Every price is the same.</p>
        )}
      </Card>
    </div>
  );
}
