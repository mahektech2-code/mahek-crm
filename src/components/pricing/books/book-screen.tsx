"use client";

/* ---------------------------------------------------------------------------
 * A PRICE BOOK — its prices, who it covers, the special prices on its shops,
 * every revision it has had, and who did what.
 *
 * ONE BUTTON CHANGES PRICES: "Edit prices". It opens a change — a copy of the
 * live revision — and the shops keep paying what this page shows until the
 * change is approved and its day arrives. A scheduled change is a banner at
 * the top, with its date and who approved it, and can be moved or taken off
 * from there until it starts.
 *
 * Who the book covers is the BOOK's, not a revision's: a rule added here is
 * carried onto the revision scheduled after it and onto the open change.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Callout, Card, CardHeader, EmptyState, Input, Td, Th, Tr, cx } from "@/components/ui/primitives";
import { FilterPills, RowMenu, type MenuItem } from "@/components/ui/overlays";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { ImpactDialog } from "@/components/ui/impact-dialog";
import { PricingSubNav } from "@/components/pricing/sub-nav";
import { ScopeModal } from "@/components/pricing/modals/scope-modal";
import { BOOK_STATE_LABEL, BOOK_STATE_TONE, EVENT_LABEL, type BookDetail, type BookCoverage, type BookSits, type OverrideView } from "@/lib/price-book-views";
import type { PriceListDetail, PricingOptions, ScopeView } from "@/lib/price-list-views";
import { FREIGHT_TERM_LABEL, SCOPE_KIND_LABEL } from "@/lib/price-list-labels";
import { OVERRIDE_STATE_LABEL } from "@/lib/engines/price-overrides";
import { longDate, money, shortDate } from "@/lib/format";
import { cancelChange, moveGoLive, propagateBookCoverage, startChange } from "@/lib/actions/price-books";
import { removeScope } from "@/lib/actions/price-lists";
import { STAGE_TONE, STAGE_WORDS, pctWords } from "@/components/pricing/books/stage-labels";

type Tab = "prices" | "covers" | "overrides" | "history" | "activity";

export function BookScreen({
  basePath,
  canManage,
  todayIso,
  detail,
  list,
  coverage,
  overrides,
  options,
  sits,
}: {
  basePath: string;
  canManage: boolean;
  todayIso: string;
  detail: BookDetail;
  list: PriceListDetail | null;
  coverage: BookCoverage | null;
  overrides: OverrideView[];
  options: PricingOptions;
  sits: BookSits | null;
}) {
  const router = useRouter();
  const { run } = useToast();
  const { book } = detail;
  const [tab, setTab] = React.useState<Tab>("prices");
  const [incl, setIncl] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [moving, setMoving] = React.useState<string | null>(null);
  const [newDate, setNewDate] = React.useState("");
  const [cancelling, setCancelling] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");
  const [addingScope, setAddingScope] = React.useState<false | "in" | "out">(false);
  const [removing, setRemoving] = React.useState<ScopeView | null>(null);
  const [sharing, setSharing] = React.useState(false);

  const scheduledRev = detail.revisions.find((r) => r.role === "scheduled") ?? null;
  const liveRev = detail.revisions.find((r) => r.role === "live") ?? null;
  const scheduledChangeId = scheduledRev?.change?.id ?? null;

  async function edit(restoreFromListId?: string) {
    setBusy(true);
    try {
      const r = await run(startChange(book.id, restoreFromListId ? { restoreFromListId } : undefined));
      if (r.ok) router.push(`${basePath}/books/${book.id}/changes/${r.data.changeId}`);
    } finally {
      setBusy(false);
    }
  }

  const menu: MenuItem[] = [
    ...(list ? [{ label: "Open as a list (every detail)", onSelect: () => router.push(`${basePath}/${list.list.id}`) }] : []),
    ...(list ? [{ label: "Print or save the PDF", onSelect: () => window.open(`/api/price-lists/${list.list.id}/pdf`, "_blank") }] : []),
    ...(canManage && list ? [{ label: "Duplicate or retire (on the list)", onSelect: () => router.push(`${basePath}/${list.list.id}`) }] : []),
  ];

  return (
    <div>
      {/* ------------------------------------------------------------ head */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[13px] text-muted">
            <Link href={`${basePath}/books`} className="hover:text-brand">
              Price books
            </Link>{" "}
            /
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[24px] leading-tight font-semibold text-ink">{book.name}</h1>
            <Badge tone={BOOK_STATE_TONE[book.state]}>{BOOK_STATE_LABEL[book.state]}</Badge>
            {book.kind === "agreed" ? <Badge tone="brand">Agreed prices</Badge> : null}
          </div>
          <p className="mt-1 text-[13px] text-muted">
            {book.scopeSummary}
            {book.freightTerm !== "not_stated" ? ` · ${FREIGHT_TERM_LABEL[book.freightTerm]}` : ""} · {book.shops.toLocaleString("en-IN")} shop
            {book.shops === 1 ? "" : "s"} priced from it today
          </p>
          {book.live ? (
            <p className="mt-0.5 text-[13px] text-muted">
              Revision {book.live.version} since {longDate(book.live.effectiveFrom)}
              {book.live.expiresOn ? ` · valid to ${longDate(book.live.expiresOn)}` : " · open ended"}
            </p>
          ) : null}
        </div>
        <div className="flex flex-none items-center gap-2">
          {list ? (
            <Button variant="secondary" onClick={() => setSharing(true)}>
              Share with shops
            </Button>
          ) : null}
          {canManage && book.head && book.kind === "standard" ? (
            book.openChange ? (
              <Link href={`${basePath}/books/${book.id}/changes/${book.openChange.id}`}>
                <Button variant="primary">Open the change</Button>
              </Link>
            ) : (
              <Button variant="primary" disabled={busy} onClick={() => edit()}>
                ✎ Edit prices
              </Button>
            )
          ) : null}
          {menu.length ? <RowMenu items={menu} /> : null}
        </div>
      </div>
      <PricingSubNav basePath={basePath} current="books" />

      {/* ---------------------------------------------------------- banners */}
      {scheduledRev ? (
        <Callout tone="brand" className="flex-wrap">
          <div className="min-w-0 flex-1 text-[13px] text-body">
            <b>A change is scheduled.</b> Revision {scheduledRev.version} goes live on <b>{longDate(scheduledRev.effectiveFrom)}</b>
            {scheduledRev.change?.approverName ? `, approved by ${scheduledRev.change.approverName}` : ""}
            {scheduledRev.change?.secondApproverName ? ` and ${scheduledRev.change.secondApproverName}` : ""}.{" "}
            {liveRev ? `Revision ${liveRev.version} stays live until then.` : ""}
            {scheduledRev.change?.reason ? <span className="text-muted"> Reason: {scheduledRev.change.reason}</span> : null}
          </div>
          {canManage && scheduledChangeId ? (
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => { setNewDate(scheduledRev.effectiveFrom); setMoving(scheduledChangeId); }}>
                Move the date
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCancelling(scheduledChangeId)}>
                Take it off
              </Button>
              <Link href={`${basePath}/books/${book.id}/changes/${scheduledChangeId}`}>
                <Button size="sm" variant="ghost">
                  See the change
                </Button>
              </Link>
            </div>
          ) : null}
        </Callout>
      ) : null}
      {book.openChange ? (
        <Callout tone="warn">
          <div className="text-[13px] text-body">
            <Badge tone={STAGE_TONE[book.openChange.stage]}>{STAGE_WORDS[book.openChange.stage]}</Badge>{" "}
            {book.openChange.makerName} is changing this book{book.openChange.title ? ` — ${book.openChange.title}` : ""}
            {book.openChange.goLive ? `, planned for ${longDate(book.openChange.goLive)}` : ""}. Nothing changes for shops until it is approved.{" "}
            <Link className="text-brand hover:underline" href={`${basePath}/books/${book.id}/changes/${book.openChange.id}`}>
              Open it
            </Link>
          </div>
        </Callout>
      ) : null}
      {book.state === "expired" ? (
        <Callout tone="danger">
          <div className="text-[13px]">This book is past its validity. Edit its prices to issue a new revision, or move its shops to another book.</div>
        </Callout>
      ) : null}

      <div className="mb-4">
        <FilterPills<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { key: "prices", label: "Prices" },
            { key: "covers", label: "Who it covers", count: coverage?.rules.length },
            { key: "overrides", label: "Overrides", count: overrides.length },
            { key: "history", label: "History", count: detail.revisions.length },
            { key: "activity", label: "Activity", count: detail.events.length },
          ]}
        />
      </div>

      {tab === "prices" ? (
        <div className="grid grid-cols-[minmax(0,1fr)_300px] gap-4">
          <Card className="min-w-0">
            <CardHeader
              title={list ? `Prices · revision ${list.list.version}` : "Prices"}
              hint={incl ? "With GST, per can. Hover a price for the figure before GST." : "Before GST, per can."}
              action={
                <Button size="sm" variant="ghost" onClick={() => setIncl((v) => !v)}>
                  {incl ? "Show before GST" : "Show with GST"}
                </Button>
              }
            />
            {list && list.grid.rows.length ? (
              <div className="max-h-[640px] overflow-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <Th className="min-w-[220px]">Product</Th>
                      {list.grid.columns.map((c) => (
                        <Th key={c.key} align="right">
                          {c.label}
                        </Th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {list.grid.rows.map((row) => (
                      <Tr key={row.familyKey}>
                        <Td className="max-w-[300px] truncate font-medium text-ink" title={row.family}>
                          {row.family}
                        </Td>
                        {row.cells.map((cell) => (
                          <Td
                            key={cell.column.key}
                            align="right"
                            title={cell.rate ? `${cell.rate.productName} · ${money(cell.rate.rateExGstPaise)} before GST` : undefined}
                          >
                            {cell.rate ? (
                              cell.rate.offered ? (
                                <span className="font-medium text-ink">{money(incl ? cell.rate.rateInclGstPaise : cell.rate.rateExGstPaise)}</span>
                              ) : (
                                <span className="text-muted">—</span>
                              )
                            ) : (
                              <span className="text-line-strong">·</span>
                            )}
                          </Td>
                        ))}
                      </Tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState title="No prices yet" body="This book has no revision with prices in it." />
            )}
          </Card>
          <div className="space-y-4">
            <Card className="px-4 py-3.5">
              <div className="text-sm font-semibold text-ink">How this book sits</div>
              {sits ? (
                <ul className="mt-2 space-y-1.5 text-[13px] text-body">
                  <li>
                    {sits.vsBooksBp == null
                      ? "No other live book shares its products."
                      : `On the ${sits.sharedProducts} products other books also price, this one is ${pctWords(sits.vsBooksBp)} against their average.`}
                  </li>
                  <li>
                    {sits.ladderBreaks.length
                      ? `${sits.ladderBreaks.length} pack-size step${sits.ladderBreaks.length === 1 ? "" : "s"} where a bigger pack costs more a litre: ${sits.ladderBreaks.slice(0, 2).join("; ")}`
                      : "Every bigger pack is cheaper a litre than the smaller one — the ladder is consistent."}
                  </li>
                  {sits.belowLastMonth ? (
                    <li>
                      {sits.belowLastMonth.lines
                        ? `${sits.belowLastMonth.lines} order line${sits.belowLastMonth.lines === 1 ? " was" : "s were"} billed below this book last month — ${money(sits.belowLastMonth.givenAwayPaise)} given away.`
                        : "Nobody was billed below this book last month."}{" "}
                      <Link className="text-brand hover:underline" href={`${basePath}/watch`}>
                        Watch
                      </Link>
                    </li>
                  ) : null}
                </ul>
              ) : (
                <p className="mt-2 text-[13px] text-muted">Nothing to say until a revision is in force.</p>
              )}
            </Card>
            {list?.discountTerms.length ? (
              <Card className="px-4 py-3.5">
                <div className="text-sm font-semibold text-ink">Discount terms</div>
                <ul className="mt-2 space-y-1 text-[13px] text-body">
                  {list.discountTerms.map((t) => (
                    <li key={t.id}>{t.sentence}</li>
                  ))}
                </ul>
              </Card>
            ) : null}
            <Card className="px-4 py-3.5">
              <div className="text-sm font-semibold text-ink">Revisions</div>
              <ol className="mt-2 space-y-2">
                {detail.revisions.slice(0, 6).map((r) => (
                  <li key={r.listId} className="text-[13px]">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-ink">Rev {r.version}</span>
                      <RoleBadge role={r.role} />
                    </div>
                    <div className="text-xs text-muted">
                      {shortDate(r.effectiveFrom)}
                      {r.effectiveTo ? ` – ${shortDate(r.effectiveTo)}` : " onward"}
                      {r.change?.approverName ? ` · approved by ${r.change.approverName}` : r.publishedByName ? ` · published by ${r.publishedByName}` : ""}
                    </div>
                  </li>
                ))}
              </ol>
              <button type="button" className="mt-2 text-[13px] text-brand hover:underline" onClick={() => setTab("history")}>
                Every revision
              </button>
            </Card>
          </div>
        </div>
      ) : null}

      {tab === "covers" ? (
        <div className="space-y-4">
          <Card>
            <CardHeader
              title="Who it covers"
              hint="Rules are kept through every revision. A shop named by a narrower book (a city inside this state, a named shop) is priced from that one."
              action={
                canManage && list && book.live ? (
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setAddingScope("out")}>
                      Leave somebody out
                    </Button>
                    <Button size="sm" variant="primary" onClick={() => setAddingScope("in")}>
                      Add who it covers
                    </Button>
                  </div>
                ) : null
              }
            />
            {coverage?.rules.length ? (
              <table className="w-full table-fixed">
                <colgroup>
                  <col style={{ width: 150 }} />
                  <col />
                  <col style={{ width: 110 }} />
                  <col style={{ width: 90 }} />
                  <col style={{ width: 90 }} />
                  <col style={{ width: 90 }} />
                  <col style={{ width: 80 }} />
                </colgroup>
                <thead>
                  <tr>
                    <Th>Kind</Th>
                    <Th>Rule</Th>
                    <Th>Transport</Th>
                    <Th align="right">Reaches</Th>
                    <Th align="right">Wins</Th>
                    <Th align="right">Loses</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {coverage.rules.map((r) => (
                    <Tr key={r.scopeId}>
                      <Td>
                        {r.excluded ? <span className="mr-1.5 text-[11px] font-semibold text-danger uppercase">Except</span> : null}
                        {SCOPE_KIND_LABEL[r.kind as keyof typeof SCOPE_KIND_LABEL] ?? r.kind}
                      </Td>
                      <Td className="truncate" title={r.label}>
                        {r.label}
                      </Td>
                      <Td>{r.excluded ? "—" : r.freight === "any" ? "Any" : r.freight === "paid" ? "Paid" : "To Pay"}</Td>
                      <Td align="right" className={r.excluded ? "text-danger" : undefined} title={r.excluded ? "Shops this row takes off the book" : undefined}>
                        {r.excluded ? `−${r.reach.toLocaleString("en-IN")}` : r.reach.toLocaleString("en-IN")}
                      </Td>
                      <Td align="right" className="font-medium text-ink">
                        {r.excluded ? "—" : r.win.toLocaleString("en-IN")}
                      </Td>
                      <Td align="right" className={cx(r.lose ? "text-warn-ink" : "text-muted")}>
                        {r.excluded ? "—" : r.lose.toLocaleString("en-IN")}
                      </Td>
                      <Td align="right">
                        {canManage ? (
                          <button
                            type="button"
                            className="text-[13px] text-danger hover:underline"
                            onClick={() => setRemoving(list?.scopes.find((s) => s.id === r.scopeId) ?? null)}
                          >
                            Remove
                          </button>
                        ) : null}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState title="Nobody yet" body="A book that names nobody prices nobody. Add the places, salesmen, customer types or shops it is for." />
            )}
          </Card>
          {coverage && (coverage.wonWithoutFreight || coverage.wonWithoutPlace) ? (
            <Callout tone="warn">
              <div className="text-[13px] text-body">
                Coverage check: of the {coverage.won.toLocaleString("en-IN")} shops this book prices,{" "}
                {coverage.wonWithoutFreight ? `${coverage.wonWithoutFreight} have no transport term` : ""}
                {coverage.wonWithoutFreight && coverage.wonWithoutPlace ? " and " : ""}
                {coverage.wonWithoutPlace ? `${coverage.wonWithoutPlace} have no reviewed place` : ""}. They may be on the wrong book —{" "}
                <Link href={`${basePath}/coverage`} className="text-brand hover:underline">
                  review them on Coverage
                </Link>
                .
              </div>
            </Callout>
          ) : null}
          <Card>
            <CardHeader
              title="Shops also on another list"
              hint="This book names them, and another list prices them instead. A shop should be on one list: settle them on Coverage, or leave them out here."
            />
            {coverage?.lost.length ? (
              <div className="max-h-[420px] overflow-auto">
                <table className="w-full table-fixed">
                  <colgroup>
                    <col style={{ width: 260 }} />
                    <col style={{ width: 240 }} />
                    <col />
                  </colgroup>
                  <thead>
                    <tr>
                      <Th>Shop</Th>
                      <Th>Priced from</Th>
                      <Th>Why</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {coverage.lost.map((s) => (
                      <Tr key={s.customerId}>
                        <Td className="truncate">
                          <Link href={`${basePath}/shops/${s.customerId}`} className="text-ink hover:text-brand">
                            {s.name}
                          </Link>
                        </Td>
                        <Td className="truncate">{s.toListName}</Td>
                        <Td className="truncate text-muted" title={s.why}>
                          {s.why}
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="px-5 py-4 text-[13px] text-muted">None — every shop this book names is priced from it.</p>
            )}
          </Card>
        </div>
      ) : null}

      {tab === "overrides" ? (
        <Card>
          <CardHeader
            title="Special prices on this book's shops"
            hint="Each is one shop and one product with its dates; everything else the shop buys comes from this book."
            action={
              <Link href={`${basePath}/overrides`} className="text-[13px] text-brand hover:underline">
                All overrides
              </Link>
            }
          />
          {overrides.length ? (
            <table className="w-full table-fixed">
              <colgroup>
                <col style={{ width: 220 }} />
                <col />
                <col style={{ width: 120 }} />
                <col style={{ width: 120 }} />
                <col style={{ width: 170 }} />
                <col style={{ width: 110 }} />
              </colgroup>
              <thead>
                <tr>
                  <Th>Shop</Th>
                  <Th>Product</Th>
                  <Th align="right">Special ex GST</Th>
                  <Th align="right">Book ex GST</Th>
                  <Th>Dates</Th>
                  <Th>State</Th>
                </tr>
              </thead>
              <tbody>
                {overrides.map((o) => (
                  <Tr key={o.id}>
                    <Td className="truncate">
                      <Link href={`${basePath}/shops/${o.customerId}`} className="text-ink hover:text-brand">
                        {o.customerName}
                      </Link>
                    </Td>
                    <Td className="truncate" title={o.productName}>
                      {o.productName}
                    </Td>
                    <Td align="right" className="font-medium text-ink">
                      {money(o.rateExGstPaise)}
                    </Td>
                    <Td align="right" className="text-muted">
                      {o.bookExGstPaise != null ? money(o.bookExGstPaise) : "—"}
                    </Td>
                    <Td className="text-[13px]">
                      {shortDate(o.validFrom)} – {o.validTo ? shortDate(o.validTo) : "no end"}
                    </Td>
                    <Td>
                      <Badge tone={o.state === "live" ? "success" : o.state === "scheduled" ? "brand" : "muted"}>{OVERRIDE_STATE_LABEL[o.state]}</Badge>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="px-5 py-4 text-[13px] text-muted">No shop on this book has a special price.</p>
          )}
        </Card>
      ) : null}

      {tab === "history" ? (
        <Card>
          <CardHeader title="Every revision" hint="Orders are priced from the revision in force on their own date, so an old revision still explains an old order." />
          <ol className="divide-y divide-divider">
            {detail.revisions.map((r, i) => {
              const previous = detail.revisions[i + 1];
              return (
                <li key={r.listId} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-ink">Revision {r.version}</span>
                      <RoleBadge role={r.role} />
                      <span className="text-[13px] text-muted">
                        {longDate(r.effectiveFrom)}
                        {r.effectiveTo ? ` – ${longDate(r.effectiveTo)}` : " onward"}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[13px] text-muted">
                      {r.change
                        ? `Made by ${r.change.makerName ?? "—"}${r.change.approverName ? `, approved by ${r.change.approverName}` : ""}${r.change.secondApproverName ? ` and ${r.change.secondApproverName}` : ""}`
                        : `${r.createdByName ? `Made by ${r.createdByName}` : "Made before price books"}${r.publishedByName ? `, published by ${r.publishedByName}` : ""}`}
                      {` · ${r.rateCount} price${r.rateCount === 1 ? "" : "s"}`}
                    </div>
                    {r.change?.reason ? <div className="mt-0.5 text-[13px] text-body">“{r.change.reason}”</div> : null}
                  </div>
                  <div className="flex flex-none items-center gap-3 text-[13px]">
                    <Link className="text-brand hover:underline" href={`${basePath}/${r.listId}`}>
                      Open
                    </Link>
                    {previous ? (
                      <Link className="text-brand hover:underline" href={`${basePath}/books/compare?a=${previous.listId}&b=${r.listId}`}>
                        Compare with rev {previous.version}
                      </Link>
                    ) : null}
                    {r.change ? (
                      <Link className="text-brand hover:underline" href={`${basePath}/books/${book.id}/changes/${r.change.id}`}>
                        The change
                      </Link>
                    ) : null}
                    {canManage && r.role === "history" && !book.openChange && book.kind === "standard" ? (
                      <button type="button" className="text-brand hover:underline" disabled={busy} onClick={() => edit(r.listId)}>
                        Restore as a new change
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
          {detail.changes.filter((c) => c.stage === "cancelled").length ? (
            <div className="border-t border-divider px-5 py-3 text-[13px] text-muted">
              Cancelled changes:{" "}
              {detail.changes
                .filter((c) => c.stage === "cancelled")
                .map((c) => (
                  <Link key={c.id} href={`${basePath}/books/${book.id}/changes/${c.id}`} className="mr-2 text-brand hover:underline">
                    {c.title ?? shortDate(c.updatedAt)}
                  </Link>
                ))}
            </div>
          ) : null}
        </Card>
      ) : null}

      {tab === "activity" ? (
        <Card>
          <CardHeader title="Who did what" />
          {detail.events.length ? (
            <ol className="divide-y divide-divider">
              {detail.events.map((e) => (
                <li key={e.id} className="flex items-start justify-between gap-3 px-5 py-2.5 text-[13px]">
                  <div className="min-w-0">
                    <span className="font-medium text-ink">{e.actorName ?? "MahekOne"}</span>{" "}
                    <span className="text-body">{(EVENT_LABEL[e.kind] ?? e.kind).toLowerCase()}</span>
                    {e.note ? <span className="text-muted"> — {e.note}</span> : null}
                  </div>
                  <Link href={`${basePath}/books/${book.id}/changes/${e.changeId}`} className="flex-none text-muted hover:text-brand">
                    {new Date(e.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
                  </Link>
                </li>
              ))}
            </ol>
          ) : (
            <p className="px-5 py-4 text-[13px] text-muted">Nothing yet. Changes made through the book are recorded here.</p>
          )}
        </Card>
      ) : null}

      {/* ----------------------------------------------------------- dialogs */}
      <Modal
        open={!!moving}
        onClose={() => setMoving(null)}
        title="Move the go-live date"
        footer={
          <>
            <Button variant="ghost" onClick={() => setMoving(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!newDate || busy}
              onClick={async () => {
                if (!moving) return;
                setBusy(true);
                const r = await run(moveGoLive(moving, newDate));
                setBusy(false);
                if (r.ok) {
                  setMoving(null);
                  router.refresh();
                }
              }}
            >
              {newDate === todayIso ? "Put it live today" : "Move"}
            </Button>
          </>
        }
      >
        <p className="mb-3 text-[13px] text-muted">The current revision stays in force until the day before. Today puts the change live now.</p>
        <Input type="date" min={todayIso} value={newDate} onChange={(e) => setNewDate(e.target.value)} />
      </Modal>

      <Modal
        open={!!cancelling}
        onClose={() => setCancelling(null)}
        title="Take the scheduled change off"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCancelling(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              disabled={!reason.trim() || busy}
              onClick={async () => {
                if (!cancelling) return;
                setBusy(true);
                const r = await run(cancelChange(cancelling, reason));
                setBusy(false);
                if (r.ok) {
                  setCancelling(null);
                  router.refresh();
                }
              }}
            >
              Take it off
            </Button>
          </>
        }
      >
        <p className="mb-3 text-[13px] text-muted">It never goes live, and the current revision stays in force with no end date. Say why.</p>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason" />
      </Modal>

      {list ? (
        <ScopeModal
          open={!!addingScope}
          leaving={addingScope === "out"}
          onClose={async () => {
            setAddingScope(false);
            await propagateBookCoverage(book.id);
            router.refresh();
          }}
          priceListId={list.list.id}
          scope={null}
          options={options}
        />
      ) : null}
      {removing ? (
        <ImpactDialog
          kind="price-list-scope"
          id={removing.id}
          onClose={() => setRemoving(null)}
          onConfirm={async (confirmation) => {
            const r = await removeScope(removing.id, confirmation);
            if (r.ok) {
              await propagateBookCoverage(book.id);
              setRemoving(null);
              router.refresh();
            }
            return r;
          }}
        />
      ) : null}

      <ShareModal open={sharing} onClose={() => setSharing(false)} bookName={book.name} listId={list?.list.id ?? null} effectiveFrom={book.live?.effectiveFrom ?? null} />
    </div>
  );
}

function RoleBadge({ role }: { role: "live" | "scheduled" | "history" | "draft" | "withdrawn" }) {
  const tone = role === "live" ? "success" : role === "scheduled" ? "brand" : role === "withdrawn" ? "danger" : "muted";
  const words = role === "live" ? "Live" : role === "scheduled" ? "Scheduled" : role === "withdrawn" ? "Withdrawn" : role === "draft" ? "Draft" : "History";
  return <Badge tone={tone}>{words}</Badge>;
}

/**
 * Share the PDF with shops. Sending is a person's act: the PDF is opened to be
 * attached, and the message is copied — MahekOne does not send prices to
 * shops on its own.
 */
function ShareModal({
  open,
  onClose,
  bookName,
  listId,
  effectiveFrom,
}: {
  open: boolean;
  onClose: () => void;
  bookName: string;
  listId: string | null;
  effectiveFrom: string | null;
}) {
  const { push } = useToast();
  const text = `Namaste. Please find attached Mahek's price list "${bookName}"${effectiveFrom ? `, in force from ${longDate(effectiveFrom)}` : ""}. Prices are per can, including GST. — Mahek Marketing India`;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Share with shops"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {listId ? (
            <Button variant="secondary" onClick={() => window.open(`/api/price-lists/${listId}/pdf`, "_blank")}>
              Open the PDF
            </Button>
          ) : null}
          <Button
            variant="primary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text);
                push("Message copied. Paste it with the PDF in WhatsApp.");
              } catch {
                push("Could not copy — select the text and copy it.", "error");
              }
            }}
          >
            Copy the message
          </Button>
        </>
      }
    >
      <p className="mb-2 text-[13px] text-muted">Download the PDF, then send it with this message from WhatsApp or email.</p>
      <div className="rounded-control border border-line bg-canvas px-3 py-2 text-[13px] text-body">{text}</div>
    </Modal>
  );
}
