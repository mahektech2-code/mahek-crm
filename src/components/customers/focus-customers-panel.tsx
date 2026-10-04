"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  MetricStrip,
  Td,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import { FilterPills, Modal, RowMenu } from "@/components/ui/overlays";
import { VoiceTextarea } from "@/components/ui/dictate";
import { useToast } from "@/components/ui/toast";
import { Icon } from "@/components/shell/icons";
import { money, shortDateWithYear, stampDate } from "@/lib/format";
import {
  SPAN_LABEL,
  TOP_CUSTOMER_SPANS,
  monthHeading,
  type TopCustomerSpan,
} from "@/lib/top-customers-period";
import { addFocusCustomer, removeFocusCustomer } from "@/lib/actions/focus-customers";
import type { FocusCustomers } from "@/lib/services/focus-customers-service";

/* ---------------------------------------------------------------------------
 * Focus customers — the third tab of Monthly targets.
 *
 * Customers somebody has said need attention to become top customers, drawn
 * beside the same months the Top customers tab uses so the two read as one
 * report: where each stands in the company, what it bought month by month,
 * and how far it is from the cutoff. The figures come from the stored report;
 * this screen only adds who is being watched and why.
 *
 * Drawn with the design system's own pieces — `FilterPills`, `MetricStrip`, a
 * plain table, `Badge` — like every other list in the app.
 * ------------------------------------------------------------------------- */

type Hit = { id: string; name: string; city: string; phone: string };

export function FocusCustomersPanel({
  data,
  basePath,
  customerHrefTemplate,
  today,
}: {
  data: FocusCustomers;
  basePath: string;
  customerHrefTemplate: string;
  /** The business date, so "last order" can say a year only when it is not this one. */
  today: string;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [adding, setAdding] = React.useState(false);
  const { rows, months, span, limit } = data;
  const crossesYear = months[0].slice(0, 4) !== months[months.length - 1].slice(0, 4);
  const already = React.useMemo(() => new Set(rows.map((r) => r.id)), [rows]);

  const inside = rows.filter((r) => r.rank != null && r.gapPaise == null).length;

  return (
    <>
      <MetricStrip
        metrics={[
          { label: "Focus customers", value: String(rows.length) },
          {
            label: `Top ${limit} cutoff`,
            value: data.cutoffPaise != null ? money(data.cutoffPaise) : "Any order",
            sub:
              data.cutoffPaise != null
                ? `the ${limit}th customer's sales in the period`
                : `fewer than ${limit} customers ordered`,
          },
          {
            label: `Already in the top ${limit}`,
            value: String(inside),
            tone: inside ? "success" : "ink",
          },
        ]}
      />

      <Card className="mb-0 flex flex-wrap items-center gap-x-5 gap-y-2.5 rounded-b-none border-b-0 px-4 py-3">
        <FilterPills
          options={TOP_CUSTOMER_SPANS.map((s) => ({ key: String(s), label: SPAN_LABEL[s] }))}
          value={String(span)}
          onChange={(k) => {
            const s = Number(k) as TopCustomerSpan;
            router.push(`${basePath}?view=focus${s === 3 ? "" : `&span=${s}`}`, { scroll: false });
          }}
        />
        <span className="flex-1" />
        <span className="text-[13px] text-muted">
          {`${monthHeading(months[0], true)} – ${monthHeading(months[months.length - 1], true)} · the Top customers report's figures`}
        </span>
        <Button variant="primary" onClick={() => setAdding(true)}>
          Add customer
        </Button>
      </Card>

      <Card className="max-h-[calc(100vh-300px)] overflow-auto rounded-t-none">
        {rows.length ? (
          <table>
            <thead>
              <tr>
                <Th>Party name</Th>
                <Th>Location</Th>
                <Th>Why it is here</Th>
                <Th align="right" title="Rank by sales across the whole company">
                  Company rank
                </Th>
                <Th align="right">Total sales</Th>
                {months.map((m) => (
                  <Th key={m} align="right">
                    {monthHeading(m, crossesYear)}
                  </Th>
                ))}
                <Th align="right">To reach top {limit}</Th>
                <Th>Last order</Th>
                <Th align="right">Outstanding</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.entryId} className="hover:bg-canvas">
                  <Td className="min-w-[200px]">
                    <Link
                      href={customerHrefTemplate.replace("{id}", r.id)}
                      className="font-medium text-ink no-underline hover:underline"
                    >
                      {r.name}
                    </Link>
                    {r.thirdParty ? (
                      <Badge className="ml-2" tone="neutral">
                        Third party
                      </Badge>
                    ) : null}
                    <div className="text-xs text-muted">
                      Sales {r.salesAmName ?? "unassigned"} · Back office{" "}
                      {r.backOfficeAmName ?? "unassigned"}
                    </div>
                  </Td>
                  <Td>{r.location}</Td>
                  <Td className="min-w-[240px] max-w-[320px] whitespace-normal">
                    {r.note ? <div className="text-body">{r.note}</div> : null}
                    <div className="text-xs text-muted">
                      Added by {r.addedByName ?? "someone who has left"}, {stampDate(r.addedAt)}
                    </div>
                  </Td>
                  <Td align="right">
                    {r.rank != null ? `#${r.rank} of ${data.rankedCount}` : "—"}
                  </Td>
                  <Td align="right" className="font-medium text-ink">
                    {money(r.valuePaise)}
                  </Td>
                  {r.months.map((m) => (
                    <Td
                      key={m.month}
                      align="right"
                      className={m.valuePaise > 0 ? undefined : "text-muted"}
                      title={`${m.orders} order${m.orders === 1 ? "" : "s"}`}
                    >
                      {m.valuePaise > 0 ? money(m.valuePaise) : "—"}
                    </Td>
                  ))}
                  <Td align="right">
                    {r.gapPaise == null ? (
                      r.rank != null ? (
                        <Badge tone="success">In the top {limit}</Badge>
                      ) : (
                        <span className="text-muted">Any order</span>
                      )
                    ) : (
                      <span className="text-danger">{money(r.gapPaise)} more</span>
                    )}
                  </Td>
                  <Td>{r.lastOrderDate ? shortDateWithYear(r.lastOrderDate, today) : "Never"}</Td>
                  <Td align="right">
                    {money(r.outstandingPaise)}
                  </Td>
                  <Td align="right">
                    <RowMenu
                      items={[
                        {
                          label: "Take off focus customers",
                          destructive: true,
                          disabled: !r.canRemove,
                          title: r.canRemove
                            ? undefined
                            : "Only the person who added it, or a manager, can take it off",
                          onSelect: async () => {
                            const result = await run(removeFocusCustomer({ entryId: r.entryId }));
                            if (result.ok) router.refresh();
                          },
                        },
                      ]}
                    />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState
            title="No focus customers yet"
            body="Add the customers who need attention to grow into top customers — a new account as readily as one just outside the list. Everybody who works that customer's book sees it here."
            action={
              <Button variant="primary" onClick={() => setAdding(true)}>
                Add customer
              </Button>
            }
          />
        )}
      </Card>

      {adding ? (
        <AddFocusCustomerModal
          already={already}
          onClose={() => setAdding(false)}
          onSubmit={async (customerId, note) => {
            const result = await run(addFocusCustomer({ customerId, note }));
            if (result.ok) {
              setAdding(false);
              router.refresh();
            }
          }}
        />
      ) : null}
    </>
  );
}

/**
 * A search over the reader's own book — `/api/search`, the same scoped read
 * the header search runs — so nobody can be offered a customer they would be
 * refused. The action checks the scope again regardless.
 */
function AddFocusCustomerModal({
  already,
  onClose,
  onSubmit,
}: {
  already: ReadonlySet<string>;
  onClose: () => void;
  onSubmit: (customerId: string, note: string) => Promise<void>;
}) {
  const [query, setQuery] = React.useState("");
  const [picked, setPicked] = React.useState<Hit | null>(null);
  const [note, setNote] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  /* The answer tagged with the question it answers, so a slow reply for an
     earlier query cannot overwrite a newer one. */
  const [remote, setRemote] = React.useState<{ q: string; hits: Hit[] } | null>(null);

  React.useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        const data = (await res.json()) as { customers?: Hit[] };
        setRemote({ q, hits: data.customers ?? [] });
      } catch {
        /* Aborted by the next keystroke, or offline — the list stays as it was. */
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const q = query.trim();
  const hits = remote && remote.q === q ? remote.hits : null;

  return (
    <Modal
      open
      onClose={onClose}
      title="Add a focus customer"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!picked || saving}
            onClick={async () => {
              if (!picked) return;
              setSaving(true);
              await onSubmit(picked.id, note);
              setSaving(false);
            }}
          >
            Add to focus customers
          </Button>
        </>
      }
    >
      {picked ? (
        <div className="mb-4 flex items-center justify-between rounded-[4px] border border-line bg-canvas px-3 py-2.5">
          <span>
            <span className="font-medium text-ink">{picked.name}</span>
            <span className="ml-2 text-[13px] text-muted">{picked.city}</span>
          </span>
          <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>
            Change
          </Button>
        </div>
      ) : (
        <Field label="Customer" hint="Any customer in your book — new or long-standing.">
          <div className="relative">
            <Icon
              name="search"
              size={16}
              className="pointer-events-none absolute top-2.5 left-2.5 text-muted"
            />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, contact or phone"
              className="pl-8"
            />
          </div>
          <div className="mt-2 max-h-[240px] overflow-y-auto">
            {q.length < 2 ? (
              <p className="text-[13px] text-muted">Type two letters or more.</p>
            ) : hits === null ? (
              <p className="text-[13px] text-muted">Searching…</p>
            ) : hits.length === 0 ? (
              <p className="text-[13px] text-muted">Nobody in your book matches “{q}”.</p>
            ) : (
              hits.map((h) => {
                const on = already.has(h.id);
                return (
                  <button
                    key={h.id}
                    type="button"
                    disabled={on}
                    onClick={() => setPicked(h)}
                    className={cx(
                      "flex w-full items-center justify-between rounded-[4px] px-2.5 py-2 text-left text-sm",
                      on ? "cursor-default text-muted" : "cursor-pointer hover:bg-canvas",
                    )}
                  >
                    <span>
                      <span className="font-medium text-ink">{h.name}</span>
                      <span className="ml-2 text-[13px] text-muted">{h.city}</span>
                    </span>
                    {on ? <span className="text-xs">Already on the list</span> : null}
                  </button>
                );
              })
            )}
          </div>
        </Field>
      )}
      <Field label="Why it needs attention" hint="Optional. Everybody who sees the list reads this.">
        <VoiceTextarea
          value={note}
          maxLength={500}
          rows={3}
          onChange={(e) => setNote(e.target.value)}
          onDictate={setNote}
          placeholder="e.g. Ordering every month but only thinner — pitch the PU range"
        />
      </Field>
    </Modal>
  );
}
