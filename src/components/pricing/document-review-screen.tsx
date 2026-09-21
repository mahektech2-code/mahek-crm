"use client";

/* ---------------------------------------------------------------------------
 * READING BACK WHAT THE PARSER READ, before any of it becomes a price.
 *
 * The screen is deliberately shaped like the document it came from: the grid
 * on the left is the grid on the paper, one row per product and one column per
 * pack size, so a reviewer holding the PDF beside it is comparing two pictures
 * rather than a picture and a table. Every cell says three things at once —
 * the figure as printed, the figure we will store, and whether we know what
 * product it belongs to — because those are three separate ways for a price
 * list to be wrong and a single "62% confident" says nothing about which.
 *
 * Nothing here writes a price. The parsed rows are staging: a cell answered
 * on this screen changes what PUBLISHING would produce, and publishing is a
 * second, deliberate act with its own review. That is why the document header
 * is editable in place — it is the one part of a price list nobody can check
 * from the catalogue, and getting the effective date off the wrong line is the
 * mistake this screen exists to catch.
 *
 * While the file is still being read the whole screen is the animation, which
 * polls rather than waiting on a request: the parse call and this page are not
 * the same request, and a reviewer who followed a link from the import modal
 * has to see the same thing they were watching there.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Callout,
  Dot,
  Field,
  Input,
  PageHeader,
  Progress,
  Select,
  cx,
} from "@/components/ui/primitives";
import { ConfirmDialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import {
  DELIVERY_BASIS_LABEL,
  DOCUMENT_STATUS_LABEL,
  DOCUMENT_STATUS_TONE,
  FREIGHT_TERM_LABEL,
  MATCH_STATUS_LABEL,
  MATCH_STATUS_TONE,
  PARSE_STAGES,
  TAX_BASIS_LABEL,
  discountTermSentence,
} from "@/lib/price-list-labels";
import type { DocumentView, ParseGrid, ParseRowView, PricingOptions } from "@/lib/price-list-views";
import type { PriceDeliveryBasis, PriceFreightTerm, PriceParsedHeader } from "@/db/schema";
import { longDate, money, periodLabel, stamp } from "@/lib/format";
import { updateDocumentHeader, reparseDocument } from "@/lib/actions/price-lists";
import {
  ParseAnimation,
  isTerminalParseStatus,
  type DocumentStatusPoll,
} from "@/components/pricing/parse-animation";
import { ResolveProductModal } from "@/components/pricing/modals/resolve-product-modal";
import { ParsePriceModal } from "@/components/pricing/modals/parse-price-modal";
import { PublishDocumentModal } from "@/components/pricing/modals/publish-document-modal";
import { RejectDocumentModal } from "@/components/pricing/modals/reject-document-modal";

const DELIVERY_BASES: PriceDeliveryBasis[] = ["for_mumbai", "for_godown", "door_delivery", "ex_factory"];
const FREIGHT_TERMS: PriceFreightTerm[] = ["to_pay", "paid", "not_stated"];
const POLL_MS = 900;

export function DocumentReviewScreen({
  app,
  basePath,
  canManage,
  todayIso,
  document,
  rows,
  grid,
  options,
  lists,
}: {
  app: "crm" | "sales";
  basePath: string;
  canManage: boolean;
  todayIso: string;
  document: DocumentView;
  rows: ParseRowView[];
  grid: ParseGrid;
  options: PricingOptions;
  lists: PricingOptions["lists"];
}) {
  const router = useRouter();
  const { run } = useToast();

  const [resolving, setResolving] = React.useState<ParseRowView | null>(null);
  const [pricing, setPricing] = React.useState<ParseRowView | null>(null);
  const [publishing, setPublishing] = React.useState(false);
  const [rejecting, setRejecting] = React.useState(false);
  const [reparsing, setReparsing] = React.useState(false);

  const stillReading =
    document.parseStatus === "queued" ||
    (PARSE_STAGES as readonly string[]).includes(document.parseStatus);

  if (stillReading) {
    return (
      <>
        <PageHeader
          title={document.filename}
          subtitle="Reading the file. This stays here until it is done — you can leave the tab open."
        />
        <ReadingWatch documentId={document.id} filename={document.filename} onDone={() => router.refresh()} />
      </>
    );
  }

  const gstBp = document.header?.gstBp ?? 1800;
  const publishedAlready = document.parseStatus === "published";

  return (
    <div data-app={app}>
      <PageHeader
        title={document.filename}
        subtitle={
          <>
            <Link href={`${basePath}/documents`} className="text-brand hover:underline">
              Documents
            </Link>
            {" · uploaded by "}
            {document.uploadedByName ?? "somebody"} {stamp(document.createdAt)}
          </>
        }
        actions={
          <>
            {document.attachmentId ? (
              <a
                href={`/api/attachments/${document.attachmentId}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-9 items-center rounded-[4px] border border-line-strong bg-surface px-4 text-sm font-medium text-body hover:bg-canvas"
              >
                Open the file
              </a>
            ) : null}
            <Button
              variant="secondary"
              disabled={!canManage || publishedAlready}
              title={
                !canManage
                  ? "Only somebody who can manage price lists may reject a document."
                  : publishedAlready
                    ? "This one became a price list. Withdraw the list instead."
                    : undefined
              }
              onClick={() => setRejecting(true)}
            >
              Reject
            </Button>
            <Button
              variant="primary"
              disabled={!canManage || publishedAlready}
              title={
                !canManage
                  ? "Only somebody who can manage price lists may publish one."
                  : publishedAlready
                    ? "This one has already become a price list."
                    : undefined
              }
              onClick={() => setPublishing(true)}
            >
              Publish as a price list
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 desk:grid-cols-3">
        {/* ------------------------------------------------------- the grid */}
        <div className="space-y-4 desk:col-span-2">
          {document.problems.length ? (
            <Callout tone={document.parseStatus === "needs_review" ? "warn" : "brand"}>
              <div className="text-[13px]">
                <div className="font-medium">What the reading was unsure about</div>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {document.problems.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </div>
            </Callout>
          ) : null}

          <Card>
            <CardHeader
              title="What was read off the page"
              hint={`${rows.length} cells · ${document.matchedCount} matched · ${document.suggestedCount} worth checking · ${document.heldCount} held`}
              action={
                <Badge tone={DOCUMENT_STATUS_TONE[document.parseStatus]}>
                  {DOCUMENT_STATUS_LABEL[document.parseStatus]}
                </Badge>
              }
            />

            <div className="border-b border-divider px-5 py-3">
              <Legend />
            </div>

            {grid.rows.length === 0 ? (
              <div className="px-5 py-10 text-center text-[13px] text-muted">
                Nothing was read off this file. Re-parsing is the thing to try when the reading rule changed;
                otherwise the file itself is the problem.
              </div>
            ) : (
              <div className="overflow-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <th className="sticky top-0 left-0 z-20 border-b border-line bg-canvas px-3 py-2 text-left text-xs font-medium tracking-[0.04em] text-muted uppercase">
                        Product, as printed
                      </th>
                      {grid.columns.map((column) => (
                        <th
                          key={column.colIndex}
                          className="sticky top-0 z-10 border-b border-line bg-canvas px-2 py-2 text-left text-xs font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase"
                        >
                          {column.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {grid.rows.map((row) => (
                      <tr key={row.rowIndex} className="border-b border-divider last:border-0">
                        <td className="sticky left-0 z-10 max-w-[220px] border-r border-divider bg-surface px-3 py-2 align-top text-[13px] text-ink">
                          {row.rawProductText || <span className="text-muted">—</span>}
                        </td>
                        {grid.columns.map((column) => {
                          const cell = row.cells.find((c) => c.colIndex === column.colIndex) ?? null;
                          return (
                            <td key={column.colIndex} className="px-1.5 py-1.5 align-top">
                              {cell ? (
                                <CellCard
                                  cell={cell}
                                  gstBp={gstBp}
                                  canManage={canManage && !publishedAlready}
                                  onResolve={() => setResolving(cell)}
                                  onPrice={() => setPricing(cell)}
                                />
                              ) : (
                                <div className="h-[62px] rounded-[4px] border border-dashed border-divider" />
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-divider px-5 py-3 text-[13px] text-muted">
              <span>
                Confidence{" "}
                {document.confidence === null ? "not recorded" : `${Math.round(document.confidence * 100)}%`}
              </span>
              <span>
                Layout{" "}
                {document.layout === "grid"
                  ? "a grid of pack sizes"
                  : document.layout === "long"
                    ? "one price a line"
                    : "not worked out"}
              </span>
              <span>
                {document.pageCount ?? "?"} {document.pageCount === 1 ? "page" : "pages"}
              </span>
              {document.confidence !== null ? (
                <Progress
                  value={Math.round(document.confidence * 100)}
                  tone={document.confidence >= 0.8 ? "success" : document.confidence >= 0.55 ? "warn" : "danger"}
                  className="w-[120px]"
                />
              ) : null}
            </div>
          </Card>

          {document.header?.termsText ? (
            <details className="rounded-[6px] border border-line bg-surface">
              <summary className="cursor-pointer px-5 py-3 text-sm font-medium text-ink">
                The terms block, as printed
              </summary>
              <pre className="max-h-[320px] overflow-auto border-t border-divider px-5 py-3 font-mono text-[12px] leading-[18px] whitespace-pre-wrap text-body">
                {document.header.termsText}
              </pre>
            </details>
          ) : null}
        </div>

        {/* ----------------------------------------------------- the header */}
        <div className="space-y-4">
          <HeaderCard
            documentId={document.id}
            header={document.header}
            canManage={canManage && !publishedAlready}
          />

          <Card className="p-5">
            <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              What the filename suggests
            </div>
            <div className="mt-1.5 text-sm text-ink">{hintSentence(document)}</div>
            {document.filenameHints?.tokens?.length ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {document.filenameHints.tokens.slice(0, 8).map((token) => (
                  <Badge key={token} tone="muted">
                    {token}
                  </Badge>
                ))}
              </div>
            ) : null}

            <div className="mt-4 border-t border-divider pt-3">
              <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                Discount terms on the document
              </div>
              {document.header?.discountTerms?.length ? (
                <ul className="mt-1.5 space-y-1 text-[13px] text-body">
                  {document.header.discountTerms.map((term, i) => (
                    <li key={i}>{discountTermSentence(term)}</li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1.5 text-[13px] text-muted">None were read off this one.</p>
              )}
            </div>
          </Card>

          <Card className="p-5">
            <div className="text-sm font-medium text-ink">Not what you expected?</div>
            <p className="mt-1 text-[13px] text-muted">
              Re-parsing reads the file again and keeps every answer somebody has already given. It is the
              thing to run when the reading rule changed rather than the file.
            </p>
            <Button
              className="mt-3"
              variant="secondary"
              disabled={!canManage || publishedAlready}
              title={
                !canManage
                  ? "Only somebody who can manage price lists may read a file again."
                  : publishedAlready
                    ? "This one already became a price list; re-reading it would change nothing."
                    : undefined
              }
              onClick={() => setReparsing(true)}
            >
              Re-parse
            </Button>
          </Card>
        </div>
      </div>

      <ResolveProductModal
        open={resolving !== null}
        cell={resolving}
        products={options.products}
        onClose={() => setResolving(null)}
      />

      <ParsePriceModal
        open={pricing !== null}
        cell={pricing}
        gstBp={gstBp}
        onClose={() => setPricing(null)}
      />

      {publishing ? (
        <PublishDocumentModal
          open
          basePath={basePath}
          document={document}
          options={{ ...options, lists }}
          todayIso={todayIso}
          onClose={() => setPublishing(false)}
        />
      ) : null}

      <RejectDocumentModal
        open={rejecting}
        documentId={document.id}
        filename={document.filename}
        onClose={() => setRejecting(false)}
      />

      <ConfirmDialog
        open={reparsing}
        title="Read this file again?"
        body="Everything somebody has already answered stands; the rest is read from scratch."
        confirmLabel="Re-parse"
        onClose={() => setReparsing(false)}
        onConfirm={async () => {
          await run(reparseDocument(document.id));
          setReparsing(false);
          router.refresh();
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------ the waiting */

function ReadingWatch({
  documentId,
  filename,
  onDone,
}: {
  documentId: string;
  filename: string;
  onDone: () => void;
}) {
  const [status, setStatus] = React.useState<DocumentStatusPoll | null>(null);

  React.useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const response = await fetch(`/api/price-lists/documents/${documentId}/status`, { cache: "no-store" });
        if (response.ok) {
          const next = (await response.json()) as DocumentStatusPoll;
          if (!live) return;
          setStatus(next);
          if (isTerminalParseStatus(next.parseStatus)) {
            onDone();
            return;
          }
        }
      } catch {
        /* A poll that could not be made is a poll that happens next time. */
      }
      if (live) timer = setTimeout(() => void tick(), POLL_MS);
    };

    void tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [documentId, onDone]);

  return <ParseAnimation status={status} filename={filename} />;
}

/* --------------------------------------------------------------- the grid */

function Legend() {
  const entries: Array<{ tone: "success" | "warn" | "danger" | "muted"; label: string; sentence: string }> = [
    { tone: "success", label: "Matched", sentence: "the parser knows the SKU" },
    { tone: "warn", label: "Suggested", sentence: "its best guess, not an answer" },
    { tone: "danger", label: "Held", sentence: "nothing it would stand behind" },
    { tone: "muted", label: "Skipped", sentence: "somebody said this is nothing we sell" },
  ];
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-[11px] text-muted">
      {entries.map((entry) => (
        <span key={entry.label} className="inline-flex items-center gap-1.5">
          <Dot tone={entry.tone} />
          <span className="text-body">{entry.label}</span>
          <span>— {entry.sentence}</span>
        </span>
      ))}
    </div>
  );
}

function CellCard({
  cell,
  gstBp,
  canManage,
  onResolve,
  onPrice,
}: {
  cell: ParseRowView;
  gstBp: number;
  canManage: boolean;
  onResolve: () => void;
  onPrice: () => void;
}) {
  const tone = MATCH_STATUS_TONE[cell.matchStatus];
  const productName =
    cell.matchedProductName ?? cell.candidates[0]?.name ?? (cell.offered ? "Nothing matched" : "Not offered");

  return (
    <div
      className={cx(
        "w-[152px] rounded-[4px] border bg-surface",
        cell.matchStatus === "held"
          ? "border-danger-soft"
          : cell.matchStatus === "suggested"
            ? "border-warn-line"
            : "border-line",
      )}
    >
      <button
        type="button"
        disabled={!canManage}
        title={canManage ? "Correct the price on this cell" : "Read only."}
        onClick={onPrice}
        className={cx(
          "block w-full px-2 pt-1.5 text-left",
          canManage ? "cursor-pointer hover:bg-canvas" : "cursor-default",
        )}
      >
        {cell.offered && cell.rateInclGstPaise !== null ? (
          <>
            <span className="block text-sm font-medium text-ink">{money(cell.rateInclGstPaise)}</span>
            <span className="block text-[10px] text-muted">
              {money(exOf(cell, gstBp))} ex GST
              {cell.rawPriceText ? ` · "${cell.rawPriceText}"` : null}
            </span>
          </>
        ) : (
          <>
            <span className="block text-sm text-muted">{cell.offered ? "No figure" : "Not offered"}</span>
            <span className="block text-[10px] text-muted">
              {cell.rawPriceText ? `"${cell.rawPriceText}"` : "nothing legible"}
            </span>
          </>
        )}
      </button>

      <button
        type="button"
        disabled={!canManage}
        title={canManage ? "Say which SKU this cell means" : "Read only."}
        onClick={onResolve}
        className={cx(
          "mt-1 flex w-full items-center gap-1.5 border-t border-divider px-2 py-1 text-left",
          canManage ? "cursor-pointer hover:bg-canvas" : "cursor-default",
        )}
      >
        <Dot tone={tone} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11px] text-body" title={productName}>
            {productName}
          </span>
          <span className="block text-[10px] text-muted">{MATCH_STATUS_LABEL[cell.matchStatus]}</span>
        </span>
      </button>
    </div>
  );
}

function exOf(cell: ParseRowView, gstBp: number): number {
  if (cell.rateExGstPaise !== null) return cell.rateExGstPaise;
  if (cell.rateInclGstPaise === null) return 0;
  return Math.round((cell.rateInclGstPaise * 10000) / (10000 + gstBp));
}

/* ------------------------------------------------------------- the header */

function HeaderCard({
  documentId,
  header,
  canManage,
}: {
  documentId: string;
  header: PriceParsedHeader | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [refNo, setRefNo] = React.useState(header?.refNo ?? "");
  const [effectiveFrom, setEffectiveFrom] = React.useState(header?.effectiveFrom ?? "");
  const [taxBasis, setTaxBasis] = React.useState<string>(header?.taxBasis ?? "");
  const [gstBp, setGstBp] = React.useState(
    header?.gstBp !== null && header?.gstBp !== undefined ? String(header.gstBp) : "",
  );
  const [deliveryBasis, setDeliveryBasis] = React.useState<string>(header?.deliveryBasis ?? "");
  const [freightTerm, setFreightTerm] = React.useState<PriceFreightTerm>(header?.freightTerm ?? "not_stated");
  const [validityDays, setValidityDays] = React.useState(
    header?.validityDays !== null && header?.validityDays !== undefined ? String(header.validityDays) : "",
  );
  const [signatory, setSignatory] = React.useState(header?.signatory ?? "");
  const [busy, setBusy] = React.useState(false);

  async function save() {
    setBusy(true);
    try {
      const result = await run(
        updateDocumentHeader(documentId, {
          refNo: refNo.trim() || null,
          effectiveFrom: effectiveFrom || null,
          taxBasis: (taxBasis || null) as "inclusive" | "exclusive" | null,
          gstBp: gstBp.trim() ? Number(gstBp) : null,
          deliveryBasis: (deliveryBasis || null) as PriceDeliveryBasis | null,
          freightTerm,
          validityDays: validityDays.trim() ? Number(validityDays) : null,
          signatory: signatory.trim() || null,
        }),
      );
      if (result.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="What the document says" hint="The half of a price list nothing else can check." />
      <div className="space-y-3 p-5">
        <Field label="Ref no">
          <Input value={refNo} disabled={!canManage} onChange={(e) => setRefNo(e.target.value)} />
        </Field>
        <Field label="Effective from">
          <input
            type="date"
            value={effectiveFrom}
            disabled={!canManage}
            onChange={(e) => setEffectiveFrom(e.target.value)}
            className="h-8.5 w-full rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Tax basis">
            <Select value={taxBasis} disabled={!canManage} onChange={(e) => setTaxBasis(e.target.value)}>
              <option value="">Not stated</option>
              <option value="inclusive">{TAX_BASIS_LABEL.inclusive}</option>
              <option value="exclusive">{TAX_BASIS_LABEL.exclusive}</option>
            </Select>
          </Field>
          <Field label="GST basis points" hint="1800 is 18%.">
            <Input
              value={gstBp}
              inputMode="numeric"
              disabled={!canManage}
              onChange={(e) => setGstBp(e.target.value.replace(/[^\d]/g, ""))}
            />
          </Field>
        </div>
        <Field label="Delivery basis">
          <Select value={deliveryBasis} disabled={!canManage} onChange={(e) => setDeliveryBasis(e.target.value)}>
            <option value="">Not stated</option>
            {DELIVERY_BASES.map((b) => (
              <option key={b} value={b}>
                {DELIVERY_BASIS_LABEL[b]}
              </option>
            ))}
          </Select>
        </Field>
        <div>
          <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
            Who pays the transport
          </span>
          <div className="flex flex-wrap gap-3">
            {FREIGHT_TERMS.map((term) => (
              <label key={term} className="flex cursor-pointer items-center gap-2 text-sm text-body">
                <input
                  type="radio"
                  name="header-freight"
                  className="h-[15px] w-[15px] accent-[#6835FB]"
                  checked={freightTerm === term}
                  disabled={!canManage}
                  onChange={() => setFreightTerm(term)}
                />
                {FREIGHT_TERM_LABEL[term]}
              </label>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Validity in days">
            <Input
              value={validityDays}
              inputMode="numeric"
              disabled={!canManage}
              onChange={(e) => setValidityDays(e.target.value.replace(/[^\d]/g, ""))}
            />
          </Field>
          <Field label="Signatory">
            <Input value={signatory} disabled={!canManage} onChange={(e) => setSignatory(e.target.value)} />
          </Field>
        </div>
        <Button
          variant="secondary"
          disabled={!canManage || busy}
          title={canManage ? undefined : "Read only."}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save what the document says"}
        </Button>
      </div>
    </Card>
  );
}

/** "Looks like: Odisha · To Pay · August 2026" — and says so where it can say nothing. */
function hintSentence(document: DocumentView): string {
  const hints = document.filenameHints;
  const parts = [
    hints?.region ?? null,
    hints?.customer ?? null,
    hints?.freightTerm && hints.freightTerm !== "not_stated" ? FREIGHT_TERM_LABEL[hints.freightTerm] : null,
    hints?.monthIso ? periodLabel(hints.monthIso) : null,
  ].filter((p): p is string => !!p);
  if (!parts.length) {
    return document.header?.effectiveFrom
      ? `The filename said nothing. The document itself is dated ${longDate(document.header.effectiveFrom)}.`
      : "The filename said nothing about where or when this list applies.";
  }
  return `Looks like: ${parts.join(" · ")}`;
}
