"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Badge, Button, Card, cx, EmptyState, MetricStrip, Td, Th, Tr } from "@/components/ui/primitives";
import { Modal, SelectionBar, Tabs } from "@/components/ui/overlays";
import { Icon } from "@/components/shell/icons";
import { useToast } from "@/components/ui/toast";
import { dndHistoryAction, setWhatsappDndAction } from "@/lib/actions/whatsapp-founder";
import { phoneDisplay, stamp } from "@/lib/format";
import type { ContactFilter, ContactRow } from "@/lib/services/whatsapp-dnd-service";

/* ---------------------------------------------------------------------------
 * The founder's contact list: every customer, whether WhatsApp messages may go
 * to them, and the switch that stops them. Putting somebody on DND — or taking
 * them off — always asks for a remark, and the remark is what every screen
 * that refuses a message says back.
 * ------------------------------------------------------------------------- */

const PAGE = 50;

const LAST_STATUS: Record<string, string> = {
  read: "Read",
  delivered: "Delivered",
  sent: "Sent",
  sent_manually: "Sent by hand",
  copied: "Copied",
  prepared: "Prepared",
  failed: "Failed",
  cancelled: "Cancelled",
};

type Data = { rows: ContactRow[]; total: number; dnd: number; dnc: number; matched: number; page: number };
type Ask = { ids: string[]; names: string[]; dnd: boolean };
type History = { dnd: boolean; reason: string; byName: string; at: string }[];

export function ContactsControl({ data, q, filter }: { data: Data; q: string; filter: ContactFilter }) {
  const router = useRouter();
  const path = usePathname();
  const [draft, setDraft] = useState(q);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [ask, setAsk] = useState<Ask | null>(null);
  const [history, setHistory] = useState<{ name: string; rows: History | null } | null>(null);
  const { push } = useToast();

  const go = (next: { q?: string; f?: ContactFilter; page?: number }) => {
    const p = new URLSearchParams();
    const nq = next.q ?? q;
    const nf = next.f ?? filter;
    if (nq) p.set("q", nq);
    if (nf !== "all") p.set("f", nf);
    if (next.page && next.page > 1) p.set("page", String(next.page));
    setSel({});
    router.push(`${path}${p.size ? `?${p}` : ""}`);
  };

  const chosen = data.rows.filter((r) => sel[r.id]);
  const allOnPage = data.rows.length > 0 && data.rows.every((r) => sel[r.id]);
  const pages = Math.max(1, Math.ceil(data.matched / PAGE));

  const openHistory = (r: ContactRow) => {
    setHistory({ name: r.name, rows: null });
    void dndHistoryAction(r.id).then((res) => setHistory({ name: r.name, rows: res.ok ? res.data : [] }));
  };

  return (
    <div>
      <MetricStrip
        metrics={[
          { label: "Customers", value: data.total.toLocaleString("en-IN"), sub: "active and inactive, not deactivated", onClick: () => go({ f: "all", page: 1 }) },
          {
            label: "On WhatsApp DND",
            value: data.dnd.toLocaleString("en-IN"),
            tone: data.dnd ? "danger" : undefined,
            sub: "get no WhatsApp messages",
            onClick: () => go({ f: "dnd", page: 1 }),
          },
          {
            label: "Can receive",
            value: (data.total - data.dnd - data.dnc).toLocaleString("en-IN"),
            sub: data.dnc ? `${data.dnc} more are marked do not contact` : "calls are never affected",
            onClick: () => go({ f: "open", page: 1 }),
          },
        ]}
      />

      <Card className="overflow-hidden">
        <Tabs
          className="px-4"
          value={filter}
          onChange={(f) => go({ f, page: 1 })}
          tabs={[
            { key: "all", label: "All customers", count: data.total },
            { key: "dnd", label: "On DND", count: data.dnd },
            { key: "open", label: "Can receive", count: data.total - data.dnd - data.dnc },
          ]}
        />
        <form
          className="flex flex-wrap items-center gap-2.5 border-b border-divider px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            go({ q: draft.trim(), page: 1 });
          }}
        >
          <div className="relative w-[340px] max-w-full">
            <Icon name="search" size={16} className="pointer-events-none absolute top-2 left-2.5 text-muted" />
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Search name, contact, city or phone"
              className="h-8 w-full rounded-[4px] border border-line pr-7 pl-7.5 text-sm outline-none focus:border-brand"
            />
          </div>
          <Button size="sm" variant="secondary" type="submit">
            Search
          </Button>
          {q ? (
            <button
              type="button"
              onClick={() => {
                setDraft("");
                go({ q: "", page: 1 });
              }}
              className="cursor-pointer text-[13px] text-muted hover:text-body"
            >
              Clear
            </button>
          ) : null}
          <span className="flex-1" />
          <span className="text-[13px] text-muted">
            {data.matched.toLocaleString("en-IN")} {data.matched === 1 ? "customer" : "customers"}
          </span>
        </form>

        {data.rows.length ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <Th className="w-9">
                      <input
                        type="checkbox"
                        aria-label="Select this page"
                        checked={allOnPage}
                        onChange={() => {
                          const n = { ...sel };
                          data.rows.forEach((r) => (n[r.id] = !allOnPage));
                          setSel(n);
                        }}
                        className="h-[15px] w-[15px] cursor-pointer accent-[#6835FB]"
                      />
                    </Th>
                    <Th>Customer</Th>
                    <Th>WhatsApp number</Th>
                    <Th>City</Th>
                    <Th>Last message</Th>
                    <Th>WhatsApp</Th>
                    <Th>Remark</Th>
                    <Th align="right">Action</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <Tr key={r.id} className={cx(sel[r.id] ? "bg-brand-soft" : "hover:bg-canvas")}>
                      <Td className="w-9">
                        <input
                          type="checkbox"
                          aria-label={`Select ${r.name}`}
                          checked={!!sel[r.id]}
                          onChange={() => setSel((s) => ({ ...s, [r.id]: !s[r.id] }))}
                          className="h-[15px] w-[15px] cursor-pointer accent-[#6835FB]"
                        />
                      </Td>
                      <Td>
                        <Link href={`/crm/customers/${r.id}`} className="font-medium text-brand">
                          {r.name}
                        </Link>
                        {r.kind === "lead" ? <span className="ml-1.5 text-xs text-muted">Lead</span> : null}
                        {r.doNotContact ? (
                          <span className="ml-1.5">
                            <Badge tone="muted">Do not contact</Badge>
                          </span>
                        ) : null}
                      </Td>
                      <Td className="tabular-nums">{phoneDisplay(r.whatsappPhone || r.phone)}</Td>
                      <Td>{r.city}</Td>
                      <Td className="text-[13px] text-muted">
                        {r.lastMessageAt ? `${LAST_STATUS[r.lastMessageStatus ?? ""] ?? r.lastMessageStatus} · ${stamp(r.lastMessageAt)}` : "Never messaged"}
                      </Td>
                      <Td>
                        {r.dnd ? (
                          <Badge tone="danger">DND</Badge>
                        ) : r.doNotContact ? (
                          <Badge tone="muted" title="Marked do not contact from a call — no calls and no messages">
                            Blocked · do not contact
                          </Badge>
                        ) : (
                          <Badge tone="success">Can receive</Badge>
                        )}
                      </Td>
                      <Td className="max-w-[320px] whitespace-normal">
                        {r.dnd ? (
                          <>
                            <span className="block text-sm text-ink">{r.dndReason}</span>
                            <button onClick={() => openHistory(r)} className="cursor-pointer text-xs text-muted hover:text-brand hover:underline">
                              {r.dndByName} · {stamp(r.dndAt)} · history
                            </button>
                          </>
                        ) : (
                          <button onClick={() => openHistory(r)} className="cursor-pointer text-xs text-muted hover:text-brand hover:underline">
                            History
                          </button>
                        )}
                      </Td>
                      <Td align="right">
                        <Button
                          size="sm"
                          variant={r.dnd ? "secondary" : "ghost"}
                          className={r.dnd ? undefined : "text-danger"}
                          onClick={() => setAsk({ ids: [r.id], names: [r.name], dnd: !r.dnd })}
                        >
                          {r.dnd ? "Take off DND" : "Put on DND"}
                        </Button>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center gap-3 border-t border-divider bg-canvas px-5 py-2.5">
              <span className="text-[13px] text-muted">
                Showing {((data.page - 1) * PAGE + 1).toLocaleString("en-IN")}–
                {Math.min(data.page * PAGE, data.matched).toLocaleString("en-IN")} of {data.matched.toLocaleString("en-IN")}
              </span>
              <span className="flex-1" />
              {pages > 1 ? (
                <>
                  <span className="text-[13px] text-muted">
                    Page {data.page} of {pages}
                  </span>
                  <Button size="sm" variant="secondary" disabled={data.page <= 1} onClick={() => go({ page: data.page - 1 })}>
                    Previous
                  </Button>
                  <Button size="sm" variant="secondary" disabled={data.page >= pages} onClick={() => go({ page: data.page + 1 })}>
                    Next
                  </Button>
                </>
              ) : null}
            </div>
          </>
        ) : (
          <EmptyState
            title={filter === "dnd" && !q ? "Nobody is on WhatsApp DND" : "No customers match"}
            body={filter === "dnd" && !q ? "Customers you put on DND are listed here with their remark." : q ? `Nothing matches “${q}”.` : undefined}
          />
        )}
      </Card>

      <SelectionBar count={chosen.length} onClear={() => setSel({})}>
        <Button variant="dark" size="sm" onClick={() => setAsk({ ids: chosen.map((r) => r.id), names: chosen.map((r) => r.name), dnd: true })}>
          Put on DND
        </Button>
        <Button variant="dark" size="sm" onClick={() => setAsk({ ids: chosen.map((r) => r.id), names: chosen.map((r) => r.name), dnd: false })}>
          Take off DND
        </Button>
      </SelectionBar>

      {ask ? (
        <RemarkDialog
          key={`${ask.dnd}:${ask.ids.join(",")}`}
          ask={ask}
          onClose={() => setAsk(null)}
          onDone={(msg) => {
            setAsk(null);
            setSel({});
            push(msg);
            router.refresh();
          }}
        />
      ) : null}

      <Modal open={!!history} onClose={() => setHistory(null)} title={`WhatsApp DND history · ${history?.name ?? ""}`}>
        {!history?.rows ? (
          <div className="py-4 text-sm text-muted">Loading…</div>
        ) : history.rows.length === 0 ? (
          <div className="py-4 text-sm text-muted">Never put on DND. Messages have always been allowed.</div>
        ) : (
          <ol className="grid gap-3">
            {history.rows.map((h, i) => (
              <li key={i} className="border-b border-divider pb-3 last:border-0">
                <div className="flex items-center gap-2">
                  {h.dnd ? <Badge tone="danger">Put on DND</Badge> : <Badge tone="success">Taken off DND</Badge>}
                  <span className="text-xs text-muted">
                    {h.byName} · {stamp(h.at)}
                  </span>
                </div>
                <div className="mt-1 text-sm text-ink">{h.reason}</div>
              </li>
            ))}
          </ol>
        )}
      </Modal>
    </div>
  );
}

function RemarkDialog({ ask, onClose, onDone }: { ask: Ask; onClose: () => void; onDone: (msg: string) => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const who = ask.names.length === 1 ? ask.names[0] : `${ask.names.length} customers`;
  const submit = async () => {
    if (reason.trim().length < 3) return setError("Write a remark — it is kept with the customer and shown wherever a message is refused.");
    setBusy(true);
    const res = await setWhatsappDndAction(ask.ids, ask.dnd, reason);
    setBusy(false);
    if (res.ok) onDone(res.message ?? "Saved");
    else setError(res.error);
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={ask.dnd ? `Put ${who} on WhatsApp DND` : `Take ${who} off WhatsApp DND`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={ask.dnd ? "danger" : "primary"} onClick={submit} disabled={busy}>
            {busy ? "Saving…" : ask.dnd ? "Put on DND" : "Take off DND"}
          </Button>
        </>
      }
    >
      <p className="text-sm text-body">
        {ask.dnd
          ? "No WhatsApp message will go to them — not the automatic reminders, not a message a telecaller sends by hand. Calls are not affected."
          : "WhatsApp messages can go to them again, from the automatic rules and from people."}
      </p>
      {ask.names.length > 1 ? (
        <p className="mt-2 text-[13px] text-muted">
          {ask.names.slice(0, 6).join(", ")}
          {ask.names.length > 6 ? ` and ${ask.names.length - 6} more` : ""}
        </p>
      ) : null}
      <label className="mt-4 block">
        <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">Remark · required</span>
        <textarea
          autoFocus
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setError("");
          }}
          placeholder={ask.dnd ? "e.g. Customer asked on the phone not to be sent reminders" : "e.g. Customer asked to receive reminders again"}
          className={cx(
            "h-20 w-full resize-y rounded-[4px] border bg-surface px-2.5 py-2 text-sm outline-none focus:border-brand",
            error ? "border-danger" : "border-line",
          )}
        />
        {error ? <span className="mt-1 block text-[13px] text-danger">{error}</span> : null}
      </label>
    </Modal>
  );
}
