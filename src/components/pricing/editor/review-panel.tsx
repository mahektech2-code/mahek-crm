"use client";

/* ---------------------------------------------------------------------------
 * THE WHOLE DECISION, SAID BACK IN WORDS, before it is made.
 *
 * The publish-a-document modal learned this and the editor keeps it: a
 * review nobody reads is a review in name only, so this page does not list
 * the form again. It says what the paper will say, what has moved against the
 * list it started from, and what is wrong — each problem with a button that
 * goes to the cell or the step it is about.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { Badge, Button, cx } from "@/components/ui/primitives";
import { DELIVERY_BASIS_LABEL, FREIGHT_TERM_LABEL, SCOPE_KIND_LABEL } from "@/lib/price-list-labels";
import { groupRupees, printedDate, type PriceSheet, type SheetCheck, type SheetProduct } from "@/lib/price-sheet";
import { changeSummary, sheetStats, type EditorScope } from "@/components/pricing/editor/editor-state";

export type EditorStep = "start" | "details" | "rates" | "terms" | "scopes" | "review" | "preview";

const GO: Record<string, EditorStep> = {
  name: "details",
  date: "details",
  ref: "details",
  delivery: "details",
  freight: "details",
  sign: "details",
  empty: "rates",
  unpriced: "rates",
  zero: "rates",
  nosku: "rates",
  outlier: "rates",
  "per-litre": "rates",
  "row-empty": "rates",
  scopes: "scopes",
};

export function ReviewPanel({
  sheet,
  checks,
  scopes,
  baseline,
  baselineName,
  products,
  mode,
  onGo,
}: {
  sheet: PriceSheet;
  checks: SheetCheck[];
  scopes: EditorScope[];
  baseline: Record<string, number> | null;
  baselineName: string | null;
  products: SheetProduct[];
  mode: "create" | "update" | "version";
  onGo: (step: EditorStep) => void;
}) {
  const stats = sheetStats(sheet);
  const changes = changeSummary(sheet, baseline);
  const names = React.useMemo(() => new Map(products.map((p) => [p.id, p.name])), [products]);
  const blocks = checks.filter((c) => c.level === "block");
  const warns = checks.filter((c) => c.level === "warn");
  const infos = checks.filter((c) => c.level === "info");

  return (
    <div className="mx-auto max-w-[1000px] space-y-6">
      <div
        className={cx(
          "rounded-[8px] border px-5 py-4",
          blocks.length ? "border-danger bg-danger-soft" : warns.length ? "border-warn-line bg-warn-soft" : "border-success bg-success-soft",
        )}
      >
        <div className="text-[15px] font-semibold text-ink">
          {blocks.length
            ? `${blocks.length} thing${blocks.length === 1 ? "" : "s"} must be fixed before this can be put in force`
            : warns.length
              ? `Ready to publish, with ${warns.length} thing${warns.length === 1 ? "" : "s"} worth a look`
              : "Ready to publish. Nothing on this list needs a second look."}
        </div>
        <p className="mt-1 text-[13px] text-body">
          It can always be saved as a draft — a draft prices nothing and is a place to leave unfinished work.
        </p>
      </div>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-ink">What it will say</h3>
        <div className="rounded-[6px] border border-line bg-surface p-4 text-[14px] leading-[22px] text-body">
          <p>
            <span className="font-semibold text-ink">{sheet.name || "An unnamed list"}</span>
            {sheet.refNo ? `, reference ${sheet.refNo},` : ""} {mode === "version" ? "replaces the version before it" : "takes effect"} from{" "}
            <span className="font-medium text-ink">{printedDate(sheet.effectiveFrom)}</span>
            {sheet.validityDays ? ` and is valid for ${sheet.validityDays} days` : ""}.
          </p>
          <p className="mt-1">
            It prices <span className="font-medium text-ink">{stats.priced}</span> SKU{stats.priced === 1 ? "" : "s"} across {stats.rows} product line
            {stats.rows === 1 ? "" : "s"} and {stats.columns} pack size{stats.columns === 1 ? "" : "s"}, printed{" "}
            {sheet.taxBasis === "inclusive" ? `GST-inclusive at ${sheet.gstBp / 100}%` : `plus GST at ${sheet.gstBp / 100}%`}
            {sheet.deliveryBasis ? `, ${DELIVERY_BASIS_LABEL[sheet.deliveryBasis]}` : ""}
            {sheet.freightTerm !== "not_stated" ? `, transport ${FREIGHT_TERM_LABEL[sheet.freightTerm].toLowerCase()}` : ""}.
            {stats.notSold ? ` ${stats.notSold} pack${stats.notSold === 1 ? " is" : "s are"} marked not sold.` : ""}
            {stats.empty ? ` ${stats.empty} cell${stats.empty === 1 ? " is" : "s are"} still empty and will be left off.` : ""}
          </p>
          <p className="mt-1">
            {scopes.length ? (
              <>
                It applies to{" "}
                {scopes.map((s, i) => (
                  <React.Fragment key={s.key}>
                    {i ? (i === scopes.length - 1 ? " and " : ", ") : ""}
                    <span className="font-medium text-ink">{s.kind === "everybody" ? "every shop" : `${s.label} (${SCOPE_KIND_LABEL[s.kind].toLowerCase()})`}</span>
                  </React.Fragment>
                ))}
                .
              </>
            ) : (
              <span className="text-warn-ink">It names nobody yet, so it would price no shop.</span>
            )}
          </p>
          <p className="mt-1">
            {sheet.terms.length} clause{sheet.terms.length === 1 ? "" : "s"}
            {sheet.discounts.length ? ` and ${sheet.discounts.length} discount${sheet.discounts.length === 1 ? "" : "s"}` : ""}, signed{" "}
            {sheet.signatory ? <span className="font-medium text-ink">{sheet.signatory}</span> : <span className="text-warn-ink">by nobody</span>}.
          </p>
        </div>
      </section>

      {changes ? (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-ink">Against {baselineName ?? "the list it started from"}</h3>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Stat label="Went up" value={changes.up} tone="success" />
            <Stat label="Came down" value={changes.down} tone="danger" />
            <Stat label="Unchanged" value={changes.same} />
            <Stat label="New on this list" value={changes.added} />
            <Stat label="Taken off" value={changes.removed} tone={changes.removed ? "warn" : undefined} />
          </div>
          {changes.biggest.length ? (
            <div className="mt-3 overflow-hidden rounded-[6px] border border-line">
              <div className="bg-canvas px-3 py-1.5 text-xs font-medium tracking-[0.04em] text-muted uppercase">Biggest moves</div>
              {changes.biggest.map((m) => {
                const pct = ((m.after - m.before) / m.before) * 100;
                return (
                  <div key={m.productId} className="flex items-center justify-between border-t border-divider px-3 py-1.5 text-[13px]">
                    <span className="truncate text-body">{names.get(m.productId) ?? m.productId}</span>
                    <span className="flex-none tabular-nums">
                      <span className="text-muted">Rs.{groupRupees(m.before)}</span>
                      <span className="mx-1.5 text-muted">→</span>
                      <span className="font-medium text-ink">Rs.{groupRupees(m.after)}</span>
                      <span className={cx("ml-2", pct > 0 ? "text-success" : "text-danger")}>
                        {pct > 0 ? "+" : ""}
                        {pct.toFixed(1)}%
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          ) : null}
        </section>
      ) : null}

      {[
        { title: "Must be fixed to publish", items: blocks, tone: "danger" as const },
        { title: "Worth a look", items: warns, tone: "warn" as const },
        { title: "For information", items: infos, tone: "muted" as const },
      ].map((group) =>
        group.items.length ? (
          <section key={group.title}>
            <h3 className="mb-2 text-sm font-semibold text-ink">{group.title}</h3>
            <ul className="divide-y divide-divider rounded-[6px] border border-line">
              {group.items.map((c, i) => (
                <li key={`${c.code}:${i}`} className="flex items-center gap-3 px-3 py-2.5">
                  <Badge tone={group.tone}>{group.tone === "danger" ? "Fix" : group.tone === "warn" ? "Check" : "Note"}</Badge>
                  <span className="flex-1 text-[13px] text-body">{c.message}</span>
                  {GO[c.code] ? (
                    <Button size="sm" variant="ghost" onClick={() => onGo(GO[c.code])}>
                      Go there
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null,
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "success" | "danger" | "warn" }) {
  return (
    <div className="rounded-[6px] border border-line bg-surface px-3 py-2">
      <div className="text-[11px] tracking-[0.04em] text-muted uppercase">{label}</div>
      <div
        className={cx(
          "text-[20px] font-semibold tabular-nums",
          tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn-ink" : "text-ink",
        )}
      >
        {value}
      </div>
    </div>
  );
}
