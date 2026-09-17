"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { stamp } from "@/lib/format";
import { COMMUNICATION_ACTIONS, salesTypeLabel, stageLabel } from "@/lib/lead-labels";
import { recordCommunication } from "@/lib/actions/leads";
import type { PublishedDocument } from "@/lib/services/lead-console-service";
import type {
  CommunicableLead,
  CommunicationActor,
  CommunicationRow,
  CommunicationTally,
} from "@/lib/services/lead-actions-service";
import {
  Banner,
  Button,
  Cell,
  Empty,
  FilterChips,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  Table,
} from "../../parts";
import { plural } from "../../words";

type Action = (typeof COMMUNICATION_ACTIONS)[number];

/* ---------------------------------------------------------------------------
 * §14 — the eleven company-communication actions, across the whole book.
 *
 * The record page has these eleven as buttons for ONE lead. This is the same
 * eleven asked of the book: how many have gone out, to how many leads, when the
 * last one went, and who has been sending them. A manager's question here is
 * not "what did we send this shop" — that is on the shop's own page — it is
 * "has anybody sent a price list to anybody this month", which no per-lead
 * screen can answer.
 *
 * **A tile that offers a brochure nobody has published is a tap that does
 * nothing.** `publishedDocuments()` is the authority on what is actually
 * sendable, one document per category, newest published wins; a category with
 * nothing behind it turns its tile OFF and says the fix in words — somebody has
 * to publish one. That is the same rule the record page's panel already keeps,
 * and it is the reason both read the same function rather than each deciding.
 *
 * **Nothing here writes a timeline kind.** `recordCommunication` does, from
 * `MBOS_EVENT.leadCommunication`, and this screen never names an event type at
 * all — a literal that drifts by one character produces a stream that can never
 * deduplicate against itself, and a retried sync then reads as a second call
 * nobody made.
 * ------------------------------------------------------------------------- */

export function CommunicationScreen({
  tally,
  unknown,
  documents,
  rows,
  total,
  actors,
  actorId,
  cursor,
  nextCursor,
  leads,
  leadTotal,
  canWork,
}: {
  /** One per code in `COMMUNICATION_ACTIONS`, declared order, zeros included. */
  tally: CommunicationTally[];
  /** Codes in the book that are no longer among the eleven. Should be empty. */
  unknown: CommunicationTally[];
  documents: Record<string, PublishedDocument>;
  rows: CommunicationRow[];
  total: number;
  actors: CommunicationActor[];
  actorId?: string;
  /** Where this page started, so "newest" can be offered only when it is not. */
  cursor?: string;
  nextCursor: string | null;
  leads: CommunicableLead[];
  /** The whole working book, so a capped picker can say what it is a slice of. */
  leadTotal: number;
  canWork: boolean;
}) {
  const [acting, setActing] = React.useState<Action | null>(null);

  const byCode = new Map(tally.map((t) => [t.code, t]));
  const missing = COMMUNICATION_ACTIONS.filter((a) => a.document && !documents[a.document]);
  const reached = tally.reduce((n, t) => Math.max(n, t.leads), 0);

  const chips = [
    {
      key: "all",
      label: "Everybody",
      href: "/sales/leads/actions/communication",
      count: total,
    },
    ...actors.map((a) => ({
      key: a.actorId ?? "nobody",
      label: a.actorName ?? "Nobody recorded",
      href: a.actorId
        ? `/sales/leads/actions/communication?actor=${encodeURIComponent(a.actorId)}`
        : "/sales/leads/actions/communication",
      count: a.count,
    })),
  ];

  return (
    <>
      <ScreenHeader
        title="Communication log"
        subtitle="The eleven things we send or say, across the book. What has gone out, to whom, and by whom — and which of the eleven cannot be sent today because nothing is published behind it."
        actions={
          <Link
            href="/sales/leads"
            className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
          >
            ← All leads
          </Link>
        }
      />

      {missing.length ? (
        <Banner
          tone="warn"
          title={`${missing.length === 1 ? "One action is" : `${missing.length} actions are`} off because nothing is published behind ${missing.length === 1 ? "it" : "them"}`}
          body={`${missing.map((a) => a.label.toLowerCase()).join(", ")}. The library decides what a send picks up, so the fix is publishing one in Documents rather than sending last year's file instead.`}
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: "Recorded", value: String(total) },
          { label: "Of the eleven used", value: String(tally.filter((t) => t.count > 0).length) },
          { label: "Widest reach", value: reached ? plural(reached, "lead") : "—" },
          { label: "People sending", value: String(actors.filter((a) => a.actorId).length) },
        ]}
      />

      {/* ------------------------------------------------------- the eleven */}
      <section className="mb-5">
        <div className="mb-1.5">
          <h2 className="text-[15px] font-semibold text-ink">The eleven</h2>
          <p className="text-[12px] text-muted">
            Declared order rather than volume. A tally sorted by how often something is used reads
            as a league table and buries the action nobody has touched, which is the one worth
            looking at.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {COMMUNICATION_ACTIONS.map((a) => {
            const t = byCode.get(a.code);
            const doc = a.document ? documents[a.document] : undefined;
            const noDoc = Boolean(a.document) && !doc;
            const off = !canWork || noDoc;
            return (
              <div key={a.code} className="rounded-[6px] border border-line bg-surface px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-[14px] font-medium text-ink">{a.label}</div>
                    <div className="truncate text-[12px] text-muted">
                      {a.kind === "send"
                        ? doc
                          ? doc.title
                          : "Nothing published"
                        : "Logged as a call"}
                    </div>
                  </div>
                  <Pill tone={t && t.count ? "neutral" : "warn"}>
                    {t ? t.count : 0}
                  </Pill>
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="truncate text-[12px] text-muted">
                    {t && t.count
                      ? `${plural(t.leads, "lead")} · last ${stamp(t.lastAt)}`
                      : "Never used"}
                  </span>
                  <Button
                    size="sm"
                    tone={a.kind === "call" ? "default" : "strong"}
                    disabled={off}
                    title={
                      !canWork
                        ? "Logging a communication needs lead.work, which this account does not hold."
                        : noDoc
                          ? `Nothing is published under ${a.document?.replace(/_/g, " ")}. Publish one in Documents and this starts working — it is not sending an out-of-date file instead.`
                          : doc
                            ? `Sends “${doc.title}”`
                            : "Records the call on the lead's timeline"
                    }
                    onClick={() => setActing(a)}
                  >
                    Log one
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {unknown.length ? (
        <Banner
          tone="warn"
          title={`${plural(unknown.length, "action")} recorded that is no longer one of the eleven`}
          body={`${unknown.map((u) => `${u.code} (${u.count})`).join(", ")}. Somebody used it before it left the list. It is shown rather than dropped, because a row nobody can account for is worse than one that says why it is there.`}
        />
      ) : null}

      {/* ------------------------------------------------------ what went out */}
      <section className="mb-5">
        <div className="mb-1.5">
          <h2 className="text-[15px] font-semibold text-ink">
            What has gone out <span className="font-normal text-muted">· {total}</span>
          </h2>
          <p className="text-[12px] text-muted">
            Newest first, off the shared timeline — the same rows that appear on each lead&rsquo;s own
            record.
          </p>
        </div>

        {chips.length > 1 ? <FilterChips options={chips} current={actorId ?? "all"} /> : null}

        {rows.length === 0 ? (
          <Empty
            title={actorId ? "Nothing recorded by them" : "Nothing sent to anybody yet"}
            body="A lead nobody has contacted and a lead somebody rang four times look identical until one of these is written down. The eleven above are how one gets written."
          />
        ) : (
          <>
            <Table
              minWidth={1120}
              head={
                <>
                  <HeadCell width={250}>Lead</HeadCell>
                  <HeadCell width={420}>What went out</HeadCell>
                  <HeadCell width={180}>By whom</HeadCell>
                  <HeadCell width={180}>When</HeadCell>
                </>
              }
            >
              {rows.map((r, i) => (
                <Row key={r.id} striped={i % 2 === 1}>
                  <Cell truncate={250}>
                    <Link href={`/sales/leads/${r.customerId}`} className="no-underline">
                      {r.customerName}
                    </Link>
                    <span className="block truncate text-[12px] text-muted">
                      {[r.companyName, r.city].filter(Boolean).join(" · ") || "—"}
                    </span>
                  </Cell>
                  <Cell truncate={420}>
                    <span className="text-body">{r.summary}</span>
                    <span className="block truncate text-[12px] text-muted">
                      {r.stage ? stageLabel(r.stage) : "no stage"} ·{" "}
                      {salesTypeLabel(r.salesType)}
                    </span>
                  </Cell>
                  <Cell truncate={180}>
                    {r.actorName ?? <span className="text-muted">not recorded</span>}
                  </Cell>
                  <Cell>{stamp(r.occurredAt)}</Cell>
                </Row>
              ))}
            </Table>

            {/* Paged with a KEYSET rather than an offset, and it is a LINK
                rather than a button: the page is a server read and a cursor in
                the URL is a page somebody can send to somebody else. */}
            {cursor || nextCursor ? (
              <div className="mt-2 flex items-center gap-3 text-[13px]">
                {cursor ? (
                  <Link
                    href={
                      actorId
                        ? `/sales/leads/actions/communication?actor=${encodeURIComponent(actorId)}`
                        : "/sales/leads/actions/communication"
                    }
                    className="no-underline"
                  >
                    ← Newest
                  </Link>
                ) : null}
                {nextCursor ? (
                  <Link
                    href={`/sales/leads/actions/communication?${new URLSearchParams({
                      ...(actorId ? { actor: actorId } : {}),
                      cursor: nextCursor,
                    }).toString()}`}
                    className="no-underline"
                  >
                    Older →
                  </Link>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </section>

      {/* ------------------------------------------------------- the named gap */}
      <section className="rounded-[6px] border border-line bg-surface px-5 py-4">
        <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          Why the two halves of this screen are counted separately
        </div>
        <p className="max-w-[720px] text-[12px] text-pretty text-muted">
          The counts above come from the audit log, where <code>actionCode</code> is stored; the
          list below them comes from the timeline, where the sentence a human reads is stored. The
          timeline row does not carry the code, and its summary is never parsed by anything — so
          the log cannot be filtered to one of the eleven, and a row here cannot say which tile
          produced it. The two rows are written in one transaction and share no key, so no join
          would be honest either. Closing it means{" "}
          <code>recordCommunication</code> carrying the code onto the timeline row; until it does,
          this paragraph is here rather than a filter that looks like it works.
        </p>
      </section>

      <LogModal
        action={acting}
        documents={documents}
        leads={leads}
        leadTotal={leadTotal}
        onClose={() => setActing(null)}
      />
    </>
  );
}

/* ------------------------------------------------- M-17 log a communication */

/**
 * One of the eleven, against one lead.
 *
 * The record page's panel already knows which lead it is standing on; this one
 * does not, so the lead is the first question and it is a SEARCH rather than a
 * list — several hundred working leads is a search box's job, exactly as the
 * product catalogue is. The list is capped and the cap is SAID: a picker that
 * silently holds the newest three hundred of eight hundred is one somebody
 * fails to find their lead in and concludes is broken.
 *
 * State is reset by remounting on the action rather than in an effect.
 */
function LogModal({
  action,
  documents,
  leads,
  leadTotal,
  onClose,
}: {
  action: Action | null;
  documents: Record<string, PublishedDocument>;
  leads: CommunicableLead[];
  leadTotal: number;
  onClose: () => void;
}) {
  return (
    <Modal open={Boolean(action)} onClose={onClose} title={action?.label ?? ""} width={520}>
      {action ? (
        <LogForm
          key={action.code}
          action={action}
          documents={documents}
          leads={leads}
          leadTotal={leadTotal}
          onClose={onClose}
        />
      ) : null}
    </Modal>
  );
}

function LogForm({
  action,
  documents,
  leads,
  leadTotal,
  onClose,
}: {
  action: Action;
  documents: Record<string, PublishedDocument>;
  leads: CommunicableLead[];
  leadTotal: number;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();

  const [query, setQuery] = React.useState("");
  const [leadId, setLeadId] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const doc = action.document ? documents[action.document] : undefined;

  const needle = query.trim().toLowerCase();
  const matches = needle
    ? leads
        .filter((l) =>
          [l.name, l.companyName, l.city].some((v) => v?.toLowerCase().includes(needle)),
        )
        .slice(0, 12)
    : [];
  const chosen = leads.find((l) => l.customerId === leadId) ?? null;

  async function submit() {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await recordCommunication(chosen.customerId, {
        actionCode: action.code,
        documentId: doc?.id,
        note: note.trim() || undefined,
      });
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onClose();
    toast.push(result.message ?? "Recorded.");
    router.refresh();
  }

  return (
    <>
      <div className="mb-3 rounded-[6px] border border-line bg-canvas px-3 py-2.5 text-[13px]">
        {action.kind === "send" ? (
          <>
            <div className="font-medium text-ink">{doc?.title}</div>
            <div className="text-muted">
              The current published {action.document?.replace(/_/g, " ")}. It goes as it stands —
              there is no second copy of it to pick from.
            </div>
          </>
        ) : (
          <div className="text-body">
            This records the attempt. Whether they picked up, and what they said, is what the note
            is for.
          </div>
        )}
      </div>

      <label className="block">
        <span className="mb-1 block text-[13px] font-medium text-ink">Which lead</span>
        {chosen ? (
          <div className="flex items-center justify-between gap-2 rounded-[4px] border border-line bg-surface px-2.5 py-2">
            <span className="min-w-0 truncate text-sm text-ink">
              {chosen.name}
              <span className="text-muted">
                {" "}
                · {stageLabel(chosen.stage)} · {chosen.city ?? "no city"}
              </span>
            </span>
            <Button size="sm" tone="quiet" onClick={() => setLeadId("")}>
              Change
            </Button>
          </div>
        ) : (
          <>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
              placeholder="Name, company or town"
              className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
            />
            {needle ? (
              matches.length ? (
                <ul className="mt-1 max-h-[190px] list-none overflow-auto rounded-[4px] border border-line p-0">
                  {matches.map((l) => (
                    <li key={l.customerId}>
                      <button
                        type="button"
                        onClick={() => setLeadId(l.customerId)}
                        className="block w-full cursor-pointer border-0 border-b border-divider bg-surface px-2.5 py-1.5 text-left text-[13px] last:border-b-0 hover:bg-canvas"
                      >
                        <span className="text-ink">{l.name}</span>
                        <span className="block truncate text-[12px] text-muted">
                          {stageLabel(l.stage)} · {salesTypeLabel(l.salesType)} ·{" "}
                          {[l.companyName, l.city].filter(Boolean).join(" · ") || "—"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-[12px] text-warn-ink">
                  Nothing matched among the {leads.length} leads offered here
                  {leads.length < leadTotal
                    ? ` — this is the ${leads.length} most recently active of ${leadTotal}, so an old quiet lead is reached from its own record instead.`
                    : "."}
                </p>
              )
            ) : (
              <p className="mt-1 text-[12px] text-muted">
                {leads.length < leadTotal
                  ? `The ${leads.length} most recently active of ${leadTotal} working leads. An older one is logged from its own record page.`
                  : `All ${leadTotal} working leads.`}
              </p>
            )}
          </>
        )}
      </label>

      <label className="mt-3 block">
        <span className="mb-1 block text-[13px] font-medium text-ink">Note (optional)</span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
        />
      </label>

      {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

      <div className="mt-4 flex justify-end gap-2">
        <Button tone="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button
          tone="primary"
          disabled={busy || !chosen}
          title={chosen ? undefined : "Pick the lead this went to — a communication against nobody records nothing."}
          onClick={() => void submit()}
        >
          {busy ? "Saving…" : action.kind === "send" ? "Record the send" : "Log the call"}
        </Button>
      </div>
    </>
  );
}
