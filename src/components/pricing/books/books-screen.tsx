"use client";

/* ---------------------------------------------------------------------------
 * EVERY PRICE BOOK — one row per audience, and what each is doing today.
 *
 * A book is a list and every version it has had, read as one thing: the
 * revision in force, the one scheduled after it, a change somebody is making,
 * when it expires and how many shops it prices. The old Lists tab still shows
 * every version on its own; this is the same data, one row a book.
 *
 * Special prices (agreed-prices books, one shop each) are the Overrides tab
 * rather than rows among the shared books, so nothing is hidden inside a book
 * and nothing crowds the list somebody is scanning for "Mumbai Paid".
 * ------------------------------------------------------------------------- */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, EmptyState, Input, PageHeader, Td, Th, Tr, cx } from "@/components/ui/primitives";
import { FilterPills } from "@/components/ui/overlays";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { PricingSubNav } from "@/components/pricing/sub-nav";
import { BOOK_STATE_LABEL, BOOK_STATE_TONE, type BookRow } from "@/lib/price-book-views";
import { FREIGHT_TERM_LABEL } from "@/lib/price-list-labels";
import { longDate, shortDate } from "@/lib/format";
import { startChange } from "@/lib/actions/price-books";
import { STAGE_TONE, STAGE_WORDS } from "@/components/pricing/books/stage-labels";

type Tab = "all" | "live" | "change" | "expiring" | "drafts" | "overrides" | "retired";

function inTab(b: BookRow, tab: Tab): boolean {
  switch (tab) {
    case "all":
      return b.kind === "standard";
    case "live":
      return b.kind === "standard" && !!b.live;
    case "change":
      return b.kind === "standard" && (b.state === "change_waiting" || b.state === "scheduled" || !!b.openChange);
    case "expiring":
      return b.kind === "standard" && (b.state === "expiring" || b.state === "expired");
    case "drafts":
      return b.kind === "standard" && b.state === "draft";
    case "overrides":
      return b.kind === "agreed";
    case "retired":
      return b.kind === "standard" && b.state === "retired";
  }
}

export function BooksScreen({
  basePath,
  canManage,
  books,
}: {
  basePath: string;
  canManage: boolean;
  books: BookRow[];
}) {
  const router = useRouter();
  const { run } = useToast();
  const [tab, setTab] = React.useState<Tab>("all");
  const [q, setQ] = React.useState("");
  const [comparing, setComparing] = React.useState(false);
  const [a, setA] = React.useState("");
  const [b, setB] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);

  const counts = React.useMemo(() => {
    const out = {} as Record<Tab, number>;
    for (const t of ["all", "live", "change", "expiring", "drafts", "overrides", "retired"] as Tab[]) {
      out[t] = books.filter((x) => inTab(x, t)).length;
    }
    return out;
  }, [books]);

  const shown = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    return books
      .filter((x) => inTab(x, tab))
      .filter((x) => !needle || x.name.toLowerCase().includes(needle) || x.scopeSummary.toLowerCase().includes(needle));
  }, [books, tab, q]);

  const live = books.filter((x) => x.live && x.kind === "standard");

  async function edit(book: BookRow) {
    setBusy(book.id);
    try {
      const r = await run(startChange(book.id));
      if (r.ok) router.push(`${basePath}/books/${book.id}/changes/${r.data.changeId}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Price books"
        subtitle="One book per audience. Edit a book in place: the change is checked, approved by somebody else and goes live on its date — the old prices stay until then."
        actions={
          <>
            <Button variant="secondary" onClick={() => setComparing(true)} disabled={live.length < 2}>
              Compare two books
            </Button>
            {canManage ? (
              <Link href={`${basePath}?import=1`} className="inline-flex">
                <Button variant="secondary">Import a PDF</Button>
              </Link>
            ) : null}
          </>
        }
      />
      <PricingSubNav basePath={basePath} current="books" />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <FilterPills<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { key: "all", label: "All", count: counts.all },
            { key: "live", label: "Live", count: counts.live },
            { key: "change", label: "Change waiting", count: counts.change },
            { key: "expiring", label: "Expiring", count: counts.expiring },
            { key: "drafts", label: "Drafts", count: counts.drafts },
            { key: "overrides", label: "Overrides", count: counts.overrides },
            { key: "retired", label: "Retired", count: counts.retired },
          ]}
        />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search books or who they cover" className="w-72" />
      </div>

      {tab === "overrides" ? (
        <Card className="mb-3 px-5 py-3 text-[13px] text-muted">
          Each shop&apos;s special prices are one agreed-prices book. The prices themselves, with their dates and conditions, are on{" "}
          <Link className="text-brand hover:underline" href={`${basePath}/overrides`}>
            Overrides
          </Link>
          .
        </Card>
      ) : null}

      <Card className="overflow-x-auto">
        {shown.length ? (
          <table className="w-full table-fixed">
            <colgroup>
              <col style={{ width: 260 }} />
              <col style={{ width: 230 }} />
              <col style={{ width: 150 }} />
              <col style={{ width: 210 }} />
              <col style={{ width: 90 }} />
              <col style={{ width: 130 }} />
              <col style={{ width: 120 }} />
            </colgroup>
            <thead>
              <tr>
                <Th>Book</Th>
                <Th>Who it covers</Th>
                <Th>In force</Th>
                <Th>What is next</Th>
                <Th align="right">Shops</Th>
                <Th>State</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {shown.map((book) => (
                <Tr key={book.id} className="hover:bg-canvas">
                  <Td className="truncate">
                    <Link href={`${basePath}/books/${book.id}`} className="font-medium text-ink hover:text-brand" title={book.name}>
                      {book.name}
                    </Link>
                    <div className="text-xs text-muted">
                      {book.freightTerm !== "not_stated" ? `${FREIGHT_TERM_LABEL[book.freightTerm]} · ` : ""}
                      {book.revisions} revision{book.revisions === 1 ? "" : "s"}
                    </div>
                  </Td>
                  <Td className="truncate" title={book.scopeSummary}>
                    <span className={cx(book.scopeCount ? "text-body" : "text-danger")}>{book.scopeSummary}</span>
                  </Td>
                  <Td>
                    {book.live ? (
                      <>
                        <div>Revision {book.live.version}</div>
                        <div className="text-xs text-muted">since {shortDate(book.live.effectiveFrom)}</div>
                      </>
                    ) : (
                      <span className="text-muted">Nothing in force</span>
                    )}
                  </Td>
                  <Td className="whitespace-normal">
                    {book.openChange ? (
                      <div className="flex items-center gap-1.5">
                        <Badge tone={STAGE_TONE[book.openChange.stage]}>{STAGE_WORDS[book.openChange.stage]}</Badge>
                        <span className="truncate text-xs text-muted">by {book.openChange.makerName}</span>
                      </div>
                    ) : null}
                    {book.scheduled ? (
                      <div className="text-xs text-body">New revision from {longDate(book.scheduled.effectiveFrom)}</div>
                    ) : null}
                    {!book.openChange && !book.scheduled && book.live?.expiresOn ? (
                      <div className="text-xs text-muted">Valid to {longDate(book.live.expiresOn)}</div>
                    ) : null}
                    {!book.openChange && !book.scheduled && !book.live?.expiresOn ? <span className="text-xs text-muted">Nothing scheduled</span> : null}
                  </Td>
                  <Td align="right">{book.shops.toLocaleString("en-IN")}</Td>
                  <Td>
                    <Badge tone={BOOK_STATE_TONE[book.state]}>{BOOK_STATE_LABEL[book.state]}</Badge>
                  </Td>
                  <Td align="right">
                    {canManage && book.live && book.kind === "standard" ? (
                      <Button size="sm" variant={book.openChange ? "secondary" : "primary"} disabled={busy === book.id} onClick={() => edit(book)}>
                        {book.openChange ? "Open change" : "Edit prices"}
                      </Button>
                    ) : (
                      <Link href={`${basePath}/books/${book.id}`} className="text-[13px] text-brand hover:underline">
                        Open
                      </Link>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState
            title={q ? "No book matches that" : "Nothing here"}
            body={
              tab === "all"
                ? "A book appears once a price list is made — import a PDF, or make a list on the Lists tab."
                : "No book is in this state today."
            }
          />
        )}
      </Card>

      <Modal
        open={comparing}
        onClose={() => setComparing(false)}
        title="Compare two books"
        footer={
          <>
            <Button variant="ghost" onClick={() => setComparing(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!a || !b || a === b}
              onClick={() => {
                const la = live.find((x) => x.id === a)?.live?.listId;
                const lb = live.find((x) => x.id === b)?.live?.listId;
                if (la && lb) router.push(`${basePath}/books/compare?a=${la}&b=${lb}`);
              }}
            >
              Compare
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-[13px] text-muted">The revisions in force today, product by product, with the difference between them.</p>
          {[
            { value: a, set: setA, label: "First book" },
            { value: b, set: setB, label: "Second book" },
          ].map((f) => (
            <label key={f.label} className="block text-[13px] text-body">
              {f.label}
              <select
                className="mt-1 h-9 w-full rounded-control border border-line bg-surface px-2 text-sm"
                value={f.value}
                onChange={(e) => f.set(e.target.value)}
              >
                <option value="">Choose…</option>
                {live.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </Modal>
    </div>
  );
}
