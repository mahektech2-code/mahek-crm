"use client";

/* ---------------------------------------------------------------------------
 * THREE READERS OF ONE PDF — the text layer, OpenAI and Claude.
 *
 * "Read again with two AI models" hands the file to both models; what each
 * transcribed is compared with the text reader's cell by cell. A cell all
 * readers agree on says so; one they disagree on lists the three figures,
 * each with "use this value", which writes it through the ordinary correction
 * (`setParseRowPrice`). Nothing a model says reaches a cell unless a person
 * presses that button. On the read-only door the results are shown and no
 * button is drawn.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { money } from "@/lib/format";
import { crossReadDocument } from "@/lib/actions/price-imports";
import { setParseRowPrice } from "@/lib/actions/price-lists";
import type { CellComparison } from "@/lib/engines/price-cross-read";
import type { ImportFacts } from "@/lib/price-import-views";
import type { ParseRowView } from "@/lib/price-list-views";

const fig = (v: number | null | undefined) => (v === undefined ? "not found" : v === null ? "—" : money(v));

/** The one-line badge a cell carries once the models have read the file. */
export function CellReading({ reading }: { reading: CellComparison | undefined }) {
  if (!reading) return null;
  if (reading.verdict === "agree") {
    return (
      <span className="block px-2 pb-1 text-[10px] text-success" title="The text reader and every model print this figure.">
        {reading.readers} agree
      </span>
    );
  }
  const said = `text ${fig(reading.text)}, GPT ${fig(reading.openai)}, Claude ${fig(reading.anthropic)}`;
  return (
    <span className={reading.verdict === "disagree" ? "block px-2 pb-1 text-[10px] text-danger" : "block px-2 pb-1 text-[10px] text-muted"} title={said}>
      {reading.verdict === "disagree" ? "readers disagree" : "a model did not find it"}
    </span>
  );
}

export function CrossReadPanel({
  facts,
  rows,
  canManage,
  locked,
}: {
  facts: ImportFacts;
  rows: ParseRowView[];
  canManage: boolean;
  /** Published or rejected: the cells can no longer be corrected. */
  locked: boolean;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [busy, setBusy] = React.useState(false);
  const [using, setUsing] = React.useState<string | null>(null);
  const { cross, ai } = facts;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const disagreements = cross.cells.filter((c) => c.verdict === "disagree");
  const why = !ai.enabled
    ? "AI is switched off for prices."
    : !ai.openai && !ai.anthropic
      ? "No OpenAI or Anthropic key is set (Admin Console → Integrations)."
      : null;

  async function read() {
    setBusy(true);
    await run(crossReadDocument(cross.documentId));
    setBusy(false);
    router.refresh();
  }

  async function use(rowId: string, value: number | null) {
    setUsing(rowId);
    await run(setParseRowPrice({ rowId, printedPaise: value, offered: value != null }));
    setUsing(null);
    router.refresh();
  }

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium text-ink">Three readers</div>
        {cross.ran ? (
          <span className="flex gap-1">
            <Badge tone="success">{cross.counts.agree} agree</Badge>
            {cross.counts.disagree ? <Badge tone="danger">{cross.counts.disagree} disagree</Badge> : null}
            {cross.counts.unseen ? <Badge tone="muted">{cross.counts.unseen} not found</Badge> : null}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-[13px] text-muted">
        The file&apos;s text is read exactly by code. OpenAI and Claude can each read the PDF too, without seeing each other&apos;s answer. A figure only goes into a cell when you pick it.
      </p>

      {cross.readers.length ? (
        <ul className="mt-2 space-y-0.5 text-[12px]">
          {cross.readers.map((r) => (
            <li key={r.provider} className={r.ok ? "text-body" : "text-danger"}>
              {r.label}
              {r.model ? ` (${r.model})` : ""}: {r.ok ? "read it" : (r.error ?? "could not read it")}
            </li>
          ))}
        </ul>
      ) : null}

      {disagreements.length ? (
        <div className="mt-3 border-t border-divider pt-3">
          <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">Where the readers disagree</div>
          <ul className="mt-1.5 space-y-2">
            {disagreements.map((c) => {
              const row = byId.get(c.rowId);
              const options: Array<{ who: string; value: number | null | undefined }> = [
                { who: "Text", value: c.text },
                { who: "GPT", value: c.openai },
                { who: "Claude", value: c.anthropic },
              ];
              return (
                <li key={c.rowId} className="text-[12.5px]">
                  <div className="truncate text-ink" title={row?.rawProductText}>
                    {row?.rawProductText ?? "A cell"}
                    {row?.rawPackText ? <span className="text-muted"> · {row.rawPackText}</span> : null}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-1.5">
                    {options.map((o) =>
                      o.value === undefined ? (
                        <span key={o.who} className="text-[12px] text-muted">
                          {o.who}: not found
                        </span>
                      ) : (
                        <button
                          key={o.who}
                          type="button"
                          disabled={!canManage || locked || using === c.rowId || o.who === "Text"}
                          title={
                            o.who === "Text"
                              ? "This is what the cell holds now."
                              : !canManage
                                ? "Read only."
                                : locked
                                  ? "This document can no longer be corrected."
                                  : "Use this value for the cell"
                          }
                          onClick={() => void use(c.rowId, o.value as number | null)}
                          className="rounded-[4px] border border-line px-1.5 py-0.5 text-[12px] text-body enabled:cursor-pointer enabled:hover:border-brand enabled:hover:text-brand disabled:opacity-80"
                        >
                          {o.who} {fig(o.value)}
                          {o.who !== "Text" && canManage && !locked ? " · use this value" : ""}
                        </button>
                      ),
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {canManage ? (
        <Button
          className="mt-3"
          variant="secondary"
          disabled={busy || locked || !!why}
          title={locked ? "This document has already been brought in, or was rejected." : (why ?? undefined)}
          onClick={() => void read()}
        >
          {busy ? "Both models are reading…" : cross.ran ? "Read again with two AI models" : "Read with two AI models"}
        </Button>
      ) : null}
    </Card>
  );
}
