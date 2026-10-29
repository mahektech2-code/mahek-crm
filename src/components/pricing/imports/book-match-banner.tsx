"use client";

/* ---------------------------------------------------------------------------
 * "THIS PDF LOOKS LIKE A REVISION OF <BOOK>" — and the three answers to it.
 *
 * Make it a change on that book (the PDF's prices become a change, checked
 * and approved like any other), choose another book, or say it is a different
 * book — which leaves the old road, publishing as a new list, exactly as it
 * was. The banner suggests; the engine never moves a price on its own. On the
 * read-only door it says what it sees and offers nothing.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Callout, Select, buttonClass } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { money } from "@/lib/format";
import { documentToChange } from "@/lib/actions/price-imports";
import type { BookMatchView, ImportPreview } from "@/lib/price-import-views";

const MIN_SHOWN = 30;

export function BookMatchBanner({
  match,
  basePath,
  canManage,
  dismissed = false,
  onDismiss,
  onMade,
  navigate = true,
}: {
  match: BookMatchView;
  basePath: string;
  canManage: boolean;
  dismissed?: boolean;
  /** "It's a different book" — or undoing it (false). */
  onDismiss?: (dismissed: boolean) => void;
  onMade?: (made: { changeId: string; bookId: string; bookName: string }) => void;
  /** Go to the new change once it is made. */
  navigate?: boolean;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [chosen, setChosen] = React.useState<string>(match.winner?.bookId ?? "");
  const [picking, setPicking] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [preview, setPreview] = React.useState<{ bookId: string; data: ImportPreview | null; loading: boolean } | null>(null);

  if (match.madeChange) {
    return (
      <Callout tone="success" className="flex flex-wrap items-center gap-3">
        <span className="flex-1 text-[13px]">
          This PDF became a change on <b>{match.madeChange.bookName}</b>.
        </span>
        <Link href={`${basePath}/books/${match.madeChange.bookId}/changes/${match.madeChange.changeId}`} className={buttonClass({ size: "sm" })}>
          Open the change
        </Link>
      </Callout>
    );
  }
  if (match.refusal) return null;

  const books = match.candidates;
  const target = books.find((b) => b.bookId === chosen) ?? null;
  const suggested = match.winner ?? (books[0] && books[0].score >= MIN_SHOWN ? books[0] : null);

  if (dismissed) {
    return (
      <Callout tone="neutral" className="flex flex-wrap items-center gap-3">
        <span className="flex-1 text-[13px] text-muted">Treated as a different book — it will be published as a new list.</span>
        {onDismiss ? (
          <button type="button" className="cursor-pointer text-[13px] text-brand hover:underline" onClick={() => onDismiss(false)}>
            Undo
          </button>
        ) : null}
      </Callout>
    );
  }
  if (!suggested && !picking) {
    if (!canManage || !books.length) return null;
    return (
      <Callout tone="neutral" className="flex flex-wrap items-center gap-3">
        <span className="flex-1 text-[13px] text-muted">This does not look like any book you keep. Publish it as a new list, or</span>
        <Button size="sm" variant="secondary" onClick={() => setPicking(true)}>
          Make it a change on a book…
        </Button>
      </Callout>
    );
  }

  const open = target ? match.openChanges[target.bookId] : undefined;
  const why = target?.reasons ?? suggested?.reasons ?? [];

  async function loadPreview(bookId: string) {
    setPreview({ bookId, data: null, loading: true });
    try {
      const r = await fetch(`/api/price-lists/documents/${match.documentId}/book-match?bookId=${encodeURIComponent(bookId)}`, { cache: "no-store" });
      const body = r.ok ? ((await r.json()) as { preview: ImportPreview }) : null;
      setPreview({ bookId, data: body?.preview ?? null, loading: false });
    } catch {
      setPreview({ bookId, data: null, loading: false });
    }
  }

  async function make() {
    if (!target) return;
    setBusy(true);
    const r = await run(documentToChange(match.documentId, target.bookId));
    setBusy(false);
    if (!r.ok) return;
    onMade?.({ changeId: r.data.changeId, bookId: r.data.bookId, bookName: target.name });
    if (navigate) router.push(`${basePath}/books/${r.data.bookId}/changes/${r.data.changeId}`);
    else router.refresh();
  }

  const shown = preview && target && preview.bookId === target.bookId ? preview : null;

  return (
    <Callout tone="brand" className="block">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 text-[13px]">
          {target ? (
            <div className="text-ink">
              {match.winner?.bookId === target.bookId ? "This PDF looks like a revision of " : "Bring it in as a change on "}
              <b>{target.name}</b> <Badge tone="brand">{target.score}/100</Badge>
            </div>
          ) : (
            <div className="text-ink">Which book is this PDF a revision of?</div>
          )}
          {why.length ? <div className="mt-0.5 text-muted">Why: {why.join(" · ")}</div> : null}
          {open ? (
            <div className="mt-1 text-warn-ink">
              {target?.name} already has a change open{open.title ? ` (“${open.title}”)` : ""}, started by {open.makerName}. Finish or cancel it first.
            </div>
          ) : null}
        </div>
        {canManage ? (
          <div className="flex flex-wrap items-center gap-2">
            {target ? (
              <Button
                size="sm"
                variant="primary"
                disabled={busy || !!open}
                title={open ? "That book already has a change open." : undefined}
                onClick={() => void make()}
              >
                {busy ? "Making the change…" : `Make it a change on ${target.name}`}
              </Button>
            ) : null}
            {picking ? (
              <Select
                aria-label="Choose a book"
                value={chosen}
                className="h-8 max-w-[240px] text-[13px]"
                onChange={(e) => setChosen(e.target.value)}
              >
                <option value="">Choose a book…</option>
                {books.map((b) => (
                  <option key={b.bookId} value={b.bookId}>
                    {b.name} ({b.score})
                  </option>
                ))}
              </Select>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => setPicking(true)}>
                Choose another book
              </Button>
            )}
            {onDismiss ? (
              <Button size="sm" variant="ghost" onClick={() => onDismiss(true)}>
                It&apos;s a different book
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {target ? (
        <div className="mt-2">
          {shown ? (
            shown.loading ? (
              <span className="text-[12px] text-muted">Working out what it moves…</span>
            ) : shown.data ? (
              <PreviewTable preview={shown.data} />
            ) : (
              <span className="text-[12px] text-danger">Could not work out what it moves.</span>
            )
          ) : (
            <button type="button" className="cursor-pointer text-[12.5px] text-brand hover:underline" onClick={() => void loadPreview(target.bookId)}>
              See what it would move on {target.name}
            </button>
          )}
        </div>
      ) : null}
    </Callout>
  );
}

const KIND_WORD: Record<string, string> = { up: "up", down: "down", same: "same", added: "new", removed: "comes off", offer_changed: "offer changes" };

function PreviewTable({ preview }: { preview: ImportPreview }) {
  const moved = preview.rows.filter((r) => r.kind !== "same");
  const c = preview.counts;
  return (
    <div className="rounded-[4px] border border-line bg-surface">
      <div className="flex flex-wrap gap-x-4 border-b border-divider px-3 py-1.5 text-[12px] text-muted">
        <span>{c.up} up</span>
        <span>{c.down} down</span>
        <span>{c.added} new</span>
        <span>{c.removed} off the book</span>
        <span>{c.same} unchanged</span>
        {preview.againstVersion != null ? <span>against v{preview.againstVersion}</span> : null}
      </div>
      {preview.blockers.length || preview.warnings.length ? (
        <ul className="border-b border-divider px-3 py-1.5 text-[12px]">
          {preview.blockers.map((b, i) => (
            <li key={`b${i}`} className="text-danger">
              {b}
            </li>
          ))}
          {preview.warnings.map((w, i) => (
            <li key={`w${i}`} className="text-warn-ink">
              {w}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="max-h-[240px] overflow-auto">
        <table className="w-full table-fixed text-[12.5px]">
          <colgroup>
            <col />
            <col className="w-[96px]" />
            <col className="w-[96px]" />
            <col className="w-[88px]" />
          </colgroup>
          <thead>
            <tr className="text-left text-[11px] text-muted uppercase">
              <th className="px-3 py-1 font-medium">Product</th>
              <th className="px-2 py-1 text-right font-medium">Today</th>
              <th className="px-2 py-1 text-right font-medium">The PDF</th>
              <th className="px-3 py-1 text-right font-medium">Move</th>
            </tr>
          </thead>
          <tbody>
            {(moved.length ? moved : preview.rows).map((r) => (
              <tr key={r.key} className="border-t border-divider">
                <td className="truncate px-3 py-1 text-ink" title={r.productName}>
                  {r.productName}
                </td>
                <td className="px-2 py-1 text-right text-body">{r.beforeIncl == null ? "—" : money(r.beforeIncl)}</td>
                <td className="px-2 py-1 text-right text-ink">{r.afterIncl == null ? "—" : money(r.afterIncl)}</td>
                <td className={r.kind === "up" ? "px-3 py-1 text-right text-success" : r.kind === "down" || r.kind === "removed" ? "px-3 py-1 text-right text-danger" : "px-3 py-1 text-right text-muted"}>
                  {r.changeBp != null && r.kind !== "same" ? `${r.changeBp > 0 ? "+" : ""}${(r.changeBp / 100).toFixed(1)}%` : KIND_WORD[r.kind]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {moved.length ? <div className="border-t border-divider px-3 py-1 text-[11.5px] text-muted">Only the cells that move are listed. Prices include GST.</div> : null}
    </div>
  );
}
