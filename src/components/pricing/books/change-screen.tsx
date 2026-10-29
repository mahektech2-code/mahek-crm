"use client";

/* ---------------------------------------------------------------------------
 * A CHANGE TO A PRICE BOOK — Edit → Check → Approve → Live, on one page.
 *
 * You edit a copy of the live revision; shops keep paying the live one until
 * the change is approved and its go-live date arrives. The step bar says where
 * it is, and the panel on the right is the one thing to do next:
 *
 *   EDIT     the details (why, from when, who to tell) beside the grid;
 *   CHECK    rule checks on the server, and the two AI reviewers, each flag
 *            fixed or explained before it can be sent;
 *   APPROVE  somebody else reads what changes, sorted by money, with the
 *            maker's notes and a second opinion, and approves or sends it back;
 *   LIVE     the date, with Move and Take off until it starts.
 *
 * Every button here only draws what the server will answer; the actions in
 * `lib/actions/price-books.ts` refuse on the same engine (`submitRefusal`,
 * `approvalRefusal`), so a stale screen cannot send or approve anything.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Callout, Card, CardHeader, Input, MetricStrip, Td, Textarea, Th, Tr, cx } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { PricingSubNav } from "@/components/pricing/sub-nav";
import { ChangeGrid } from "@/components/pricing/books/change-grid";
import { EVENT_LABEL, type ChangeView } from "@/lib/price-book-views";
import { openFlags, submitRefusal, type ChangeFlag } from "@/lib/engines/price-change";
import { longDate, money } from "@/lib/format";
import {
  acknowledgeFlag,
  approveChange,
  cancelChange,
  checkChange,
  clearAcknowledgement,
  moveGoLive,
  requestSecondOpinion,
  sendBackChange,
  setChangeDetails,
  submitChange,
  takeOverChange,
  withdrawSubmission,
} from "@/lib/actions/price-books";
import { STAGE_TONE, STAGE_WORDS, STEPS, pctWords, signedMoney, stepOf } from "@/components/pricing/books/stage-labels";

export function ChangeScreen({
  basePath,
  canManage,
  viewerId,
  change,
  todayIso,
  ai,
  makerChecker,
  otherDeskPeople,
  addable,
}: {
  basePath: string;
  canManage: boolean;
  viewerId: string;
  change: ChangeView;
  todayIso: string;
  ai: { enabled: boolean; openai: boolean; anthropic: boolean };
  makerChecker: boolean;
  otherDeskPeople: number;
  addable: Array<{ id: string; name: string; millilitresPerCan: number | null; family: string }>;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [cancelling, setCancelling] = React.useState(false);
  const [cancelReason, setCancelReason] = React.useState("");

  const isMaker = change.maker.id === viewerId;
  const editableStatus = change.status === "draft" || change.status === "sent_back";
  const editable = canManage && editableStatus && isMaker;
  const step = stepOf(change.stage);

  async function act<T extends { ok: boolean }>(key: string, p: Promise<T>) {
    setBusy(key);
    try {
      const r = await run(p as Promise<T & { message?: string; error?: string }>);
      if (r.ok) router.refresh();
      return r;
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      {/* ------------------------------------------------------------ head */}
      <div className="mb-3 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[13px] text-muted">
            <Link href={`${basePath}/books`} className="hover:text-brand">
              Price books
            </Link>{" "}
            /{" "}
            <Link href={`${basePath}/books/${change.bookId}`} className="hover:text-brand">
              {change.bookName}
            </Link>{" "}
            /
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[24px] leading-tight font-semibold text-ink">{change.title || `Change to ${change.bookName}`}</h1>
            <Badge tone={STAGE_TONE[change.stage]}>{STAGE_WORDS[change.stage]}</Badge>
            {change.source === "import" ? <Badge tone="brand">From a PDF</Badge> : null}
            {change.source === "restore" ? <Badge tone="brand">Restored revision</Badge> : null}
            {change.needsSecond ? <Badge tone="warn">Two approvers</Badge> : null}
          </div>
          <p className="mt-1 text-[13px] text-muted">
            Made by {change.maker.name}
            {change.baseList ? ` from revision ${change.baseList.version}` : ""}
            {change.goLive ? ` · planned for ${longDate(change.goLive)}` : ""} · {change.shops.toLocaleString("en-IN")} shop{change.shops === 1 ? "" : "s"} on this book
          </p>
        </div>
        <div className="flex flex-none items-center gap-2">
          {canManage && editableStatus && !isMaker ? (
            <Button variant="secondary" disabled={!!busy} onClick={() => act("takeover", takeOverChange(change.id))}>
              Take it over
            </Button>
          ) : null}
          {canManage && (change.status === "draft" || change.status === "sent_back" || change.status === "submitted" || change.stage === "scheduled") ? (
            <Button variant="ghost" onClick={() => setCancelling(true)}>
              {change.stage === "scheduled" ? "Take it off" : "Cancel the change"}
            </Button>
          ) : null}
        </div>
      </div>
      <PricingSubNav basePath={basePath} current="books" />

      {/* -------------------------------------------------------- step bar */}
      {change.stage !== "cancelled" ? (
        <ol className="mb-4 grid grid-cols-4 gap-2">
          {STEPS.map((s, i) => (
            <li
              key={s}
              className={cx(
                "rounded-control border px-3 py-2 text-[13px]",
                i < step ? "border-success-soft bg-success-soft text-success" : i === step ? "border-brand bg-brand-soft font-medium text-brand-hover" : "border-line bg-surface text-muted",
              )}
            >
              <span className="mr-1.5 font-semibold">{i + 1}</span>
              {s}
              {i === 3 && change.stage === "scheduled" && change.goLive ? <span className="ml-1 text-xs">· {longDate(change.goLive)}</span> : null}
            </li>
          ))}
        </ol>
      ) : (
        <Callout tone="neutral">
          <div className="text-[13px]">This change was cancelled{change.cancelReason ? `: ${change.cancelReason}` : "."} Nothing in it ever priced a shop.</div>
        </Callout>
      )}

      {change.sendBackReason && change.status === "sent_back" ? (
        <Callout tone="danger">
          <div className="text-[13px] text-body">
            <b>Sent back:</b> {change.sendBackReason}
          </div>
        </Callout>
      ) : null}
      {change.checkStale && editableStatus ? (
        <Callout tone="warn">
          <div className="text-[13px]">Prices changed after the last check. Check again before sending.</div>
        </Callout>
      ) : null}

      <MetricStrip
        metrics={[
          { label: "Prices changed", value: String(change.counts.changed), sub: `${change.counts.up} up · ${change.counts.down} down` },
          { label: "Average move", value: pctWords(change.counts.averageBp) },
          { label: "Largest move", value: pctWords(change.counts.largestBp), tone: (change.counts.largestBp ?? 0) < -1000 ? "danger" : "ink" },
          {
            label: "Effect a month",
            value: signedMoney(change.effect.totalPerMonthPaise, money),
            sub: `at ${change.effect.months} months' volume`,
            tone: change.effect.totalPerMonthPaise < 0 ? "danger" : "ink",
          },
          { label: "Flags open", value: String(openFlags(change.flags, change.acks).length), tone: openFlags(change.flags, change.acks).length ? "danger" : "ink" },
        ]}
      />

      <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-4">
        <ChangeGrid change={change} editable={editable} addable={addable} />
        <div className="space-y-4">
          {editableStatus ? (
            <EditPanel change={change} editable={editable} todayIso={todayIso} ai={ai} busy={busy} act={act} />
          ) : null}
          {change.status === "submitted" ? (
            <ApprovePanel
              change={change}
              canManage={canManage}
              viewerId={viewerId}
              isMaker={isMaker}
              makerChecker={makerChecker}
              otherDeskPeople={otherDeskPeople}
              todayIso={todayIso}
              ai={ai}
              busy={busy}
              act={act}
            />
          ) : null}
          {change.status === "approved" ? <ApprovedPanel change={change} canManage={canManage} todayIso={todayIso} busy={busy} act={act} /> : null}
          <FlagsPanel change={change} editable={editable} busy={busy} act={act} />
          <Card>
            <CardHeader title="Who did what" />
            <ol className="max-h-[260px] divide-y divide-divider overflow-auto">
              {change.events.map((e) => (
                <li key={e.id} className="px-4 py-2 text-[13px]">
                  <span className="font-medium text-ink">{e.actorName ?? "MahekOne"}</span> <span>{(EVENT_LABEL[e.kind] ?? e.kind).toLowerCase()}</span>
                  {e.note ? <div className="text-muted">{e.note}</div> : null}
                  <div className="text-[11px] text-muted">
                    {new Date(e.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>

      <Modal
        open={cancelling}
        onClose={() => setCancelling(false)}
        title={change.stage === "scheduled" ? "Take the scheduled change off" : "Cancel this change"}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCancelling(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              disabled={!cancelReason.trim() || !!busy}
              onClick={async () => {
                const r = await act("cancel", cancelChange(change.id, cancelReason));
                if (r.ok) setCancelling(false);
              }}
            >
              {change.stage === "scheduled" ? "Take it off" : "Cancel the change"}
            </Button>
          </>
        }
      >
        <p className="mb-3 text-[13px] text-muted">The current revision stays in force. The change and its history are kept. Say why.</p>
        <Input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="Reason" />
      </Modal>
    </div>
  );
}

type Act = <T extends { ok: boolean }>(key: string, p: Promise<T>) => Promise<T>;

/* --------------------------------------------------------------- edit */

function EditPanel({
  change,
  editable,
  todayIso,
  ai,
  busy,
  act,
}: {
  change: ChangeView;
  editable: boolean;
  todayIso: string;
  ai: { enabled: boolean; openai: boolean; anthropic: boolean };
  busy: string | null;
  act: Act;
}) {
  const [title, setTitle] = React.useState(change.title ?? "");
  const [reason, setReason] = React.useState(change.reason ?? "");
  const [goLive, setGoLive] = React.useState(change.goLive ?? "");
  const [team, setTeam] = React.useState(!!change.notify.team);
  const [useAi, setUseAi] = React.useState(ai.openai || ai.anthropic);
  const dirty = title !== (change.title ?? "") || reason !== (change.reason ?? "") || goLive !== (change.goLive ?? "") || team !== !!change.notify.team;
  const refusal = submitRefusal({
    status: change.status,
    checkedHash: change.checkStale ? "stale" : change.checkedAt ? change.currentHash : null,
    currentHash: change.currentHash,
    flags: change.flags,
    acks: change.acks,
    goLive: change.goLive,
    reason: change.reason,
  });
  return (
    <Card>
      <CardHeader title="This change" hint="Why, from when, and who is told. The approver reads all of it." />
      <div className="space-y-3 px-4 py-3">
        <label className="block text-[13px] text-body">
          Name (optional)
          <Input value={title} disabled={!editable} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. November revision" className="mt-1 w-full" />
        </label>
        <label className="block text-[13px] text-body">
          Why prices are changing
          <Textarea rows={2} value={reason} disabled={!editable} onChange={(e) => setReason(e.target.value)} placeholder="e.g. solvent cost up 6% since September" className="mt-1 w-full" />
        </label>
        <label className="block text-[13px] text-body">
          Goes live on
          <Input type="date" min={todayIso} value={goLive} disabled={!editable} onChange={(e) => setGoLive(e.target.value)} className="mt-1 w-full" />
          <span className="text-[12px] text-muted">The current revision keeps pricing until the day before.</span>
        </label>
        <label className="flex items-center gap-2 text-[13px] text-body">
          <input type="checkbox" checked={team} disabled={!editable} onChange={(e) => setTeam(e.target.checked)} /> Tell the salesmen and telecallers of this book&apos;s shops when it is approved
        </label>
        {editable && dirty ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={!!busy}
            onClick={() => act("details", setChangeDetails(change.id, { title, reason, goLive: goLive || null, notify: { ...change.notify, team } }))}
          >
            Save these
          </Button>
        ) : null}
      </div>
      {editable ? (
        <div className="space-y-2 border-t border-divider px-4 py-3">
          <label className="flex items-center gap-2 text-[13px] text-body" title={ai.openai || ai.anthropic ? "" : "No AI key is connected"}>
            <input type="checkbox" checked={useAi} disabled={!(ai.openai || ai.anthropic)} onChange={(e) => setUseAi(e.target.checked)} />
            Also ask {[ai.openai ? "OpenAI" : null, ai.anthropic ? "Claude" : null].filter(Boolean).join(" and ") || "the AI reviewers"} to review it
          </label>
          <Button variant="secondary" className="w-full" disabled={!!busy || dirty} onClick={() => act("check", checkChange(change.id, { ai: useAi }))} title={dirty ? "Save the details first" : ""}>
            {busy === "check" ? "Checking…" : change.checkedAt && !change.checkStale ? "Check again" : "Run the check"}
          </Button>
          <Button variant="primary" className="w-full" disabled={!!busy || !!refusal} onClick={() => act("submit", submitChange(change.id))} title={refusal ?? ""}>
            Send for approval
          </Button>
          {refusal ? <p className="text-[12px] text-muted">{refusal}</p> : null}
        </div>
      ) : (
        <p className="border-t border-divider px-4 py-3 text-[13px] text-muted">
          {change.maker.name} is editing this change. Only they can send it — or take it over to finish it.
        </p>
      )}
    </Card>
  );
}

/* --------------------------------------------------------------- flags */

function FlagsPanel({ change, editable, busy, act }: { change: ChangeView; editable: boolean; busy: string | null; act: Act }) {
  const [noting, setNoting] = React.useState<ChangeFlag | null>(null);
  const [note, setNote] = React.useState("");
  if (!change.checkedAt && !change.flags.length) {
    return (
      <Card className="px-4 py-3 text-[13px] text-muted">
        Not checked yet. The check looks for ₹0 prices, products dropped from the live revision, GST that does not add up, a bigger pack dearer a litre
        than a smaller one, moves larger than {""}
        the configured limit, prices far off other books, and special prices the change would undercut.
      </Card>
    );
  }
  const blocking = change.flags.filter((f) => f.blocking);
  const needsNote = change.flags.filter((f) => !f.blocking && !change.acks[f.key]);
  const noted = change.flags.filter((f) => !f.blocking && change.acks[f.key]);
  const section = (title: string, flags: ChangeFlag[], tone: string) =>
    flags.length ? (
      <div className="px-4 py-3">
        <div className={cx("mb-1.5 text-xs font-semibold tracking-label uppercase", tone)}>
          {title} · {flags.length}
        </div>
        <ul className="space-y-2">
          {flags.map((f) => (
            <li key={f.key} className="text-[13px]">
              <div className="flex items-start gap-2">
                <Badge tone={f.severity === "high" ? "danger" : f.severity === "medium" ? "warn" : "muted"}>{f.by === "rules" ? "Rule" : f.by}</Badge>
                <span className="text-body">{f.message}</span>
              </div>
              {change.acks[f.key] ? (
                <div className="mt-0.5 ml-1 text-[12px] text-muted">
                  Intended — “{change.acks[f.key].note}”{change.acks[f.key].byName ? ` (${change.acks[f.key].byName})` : ""}
                  {editable ? (
                    <button type="button" className="ml-2 text-brand hover:underline" onClick={() => act("unack", clearAcknowledgement(change.id, f.key))}>
                      Clear
                    </button>
                  ) : null}
                </div>
              ) : editable && !f.blocking ? (
                <button
                  type="button"
                  className="mt-0.5 ml-1 text-[12px] text-brand hover:underline"
                  onClick={() => {
                    setNote("");
                    setNoting(f);
                  }}
                >
                  It&apos;s intended…
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    ) : null;
  return (
    <Card>
      <CardHeader
        title="The check"
        hint={change.checkedAt ? `Last checked ${new Date(change.checkedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}${change.checkStale ? " — out of date" : ""}` : undefined}
      />
      <div className="divide-y divide-divider">
        {section("Must be fixed", blocking, "text-danger")}
        {section("Fix or say it is intended", needsNote, "text-warn-ink")}
        {section("Said to be intended", noted, "text-muted")}
        {!change.flags.length ? <p className="px-4 py-3 text-[13px] text-success">Nothing found.</p> : null}
        {change.reviews.length ? (
          <div className="px-4 py-3">
            <div className="mb-1.5 text-xs font-semibold tracking-label text-muted uppercase">Independent reviews</div>
            <div className="space-y-2">
              {change.reviews.map((r) => (
                <div key={r.provider} className="rounded-control border border-line px-3 py-2 text-[13px]">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-ink">{r.label}</span>
                    <span className="text-[12px] text-muted">{r.ok ? `${r.findings.length} finding${r.findings.length === 1 ? "" : "s"}` : "did not answer"}</span>
                  </div>
                  <p className="mt-0.5 text-body">{r.ok ? r.summary : r.reason}</p>
                </div>
              ))}
              {change.reviews.length === 2 && change.reviews.every((r) => r.ok) && change.reviews[0].findings.length !== change.reviews[1].findings.length ? (
                <p className="text-[12px] text-muted">The two reviewers found different things. Both are listed above, each named — read both before deciding.</p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      <Modal
        open={!!noting}
        onClose={() => setNoting(null)}
        title="Why it is intended"
        footer={
          <>
            <Button variant="ghost" onClick={() => setNoting(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!note.trim() || !!busy}
              onClick={async () => {
                if (!noting) return;
                const r = await act("ack", acknowledgeFlag(change.id, noting.key, note));
                if (r.ok) setNoting(null);
              }}
            >
              Save the note
            </Button>
          </>
        }
      >
        <p className="mb-2 text-[13px] text-body">{noting?.message}</p>
        <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="The approver reads this" className="w-full" />
      </Modal>
    </Card>
  );
}

/* -------------------------------------------------------------- approve */

function ApprovePanel({
  change,
  canManage,
  viewerId,
  isMaker,
  makerChecker,
  otherDeskPeople,
  todayIso,
  ai,
  busy,
  act,
}: {
  change: ChangeView;
  canManage: boolean;
  viewerId: string;
  isMaker: boolean;
  makerChecker: boolean;
  otherDeskPeople: number;
  todayIso: string;
  ai: { enabled: boolean; openai: boolean; anthropic: boolean };
  busy: string | null;
  act: Act;
}) {
  const [goLive, setGoLive] = React.useState(change.goLive ?? "");
  const [note, setNote] = React.useState("");
  const [team, setTeam] = React.useState(!!change.notify.team);
  const [sendingBack, setSendingBack] = React.useState(false);
  const [why, setWhy] = React.useState("");
  const firstDone = !!change.approver && change.needsSecond;
  const mayApprove = canManage && (!isMaker || !makerChecker) && !(firstDone && change.approver?.id === viewerId);

  if (isMaker && makerChecker) {
    return (
      <Card>
        <CardHeader title="Waiting for approval" />
        <div className="space-y-2 px-4 py-3 text-[13px] text-body">
          <p>
            Somebody else on the Price Desk approves it{change.needsSecond ? " — and because of its size, two people do" : ""}.{" "}
            {otherDeskPeople ? "They have been told." : "Nobody else holds the Price Desk yet, so nobody can approve it."}
          </p>
          {firstDone ? <p>Approved by {change.approver!.name}; one more approver is needed.</p> : null}
          <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => act("pull", withdrawSubmission(change.id))}>
            Pull it back to edit
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader title={firstDone ? "Second approval" : "Approve"} hint={`Sent by ${change.maker.name}. Reason: ${change.reason ?? "—"}`} />
      <div className="max-h-[280px] overflow-auto border-b border-divider">
        <table className="w-full table-fixed">
          <colgroup>
            <col />
            <col style={{ width: 70 }} />
            <col style={{ width: 90 }} />
          </colgroup>
          <thead>
            <tr>
              <Th>By money</Th>
              <Th align="right">Move</Th>
              <Th align="right">A month</Th>
            </tr>
          </thead>
          <tbody>
            {change.effect.rows.slice(0, 40).map((r) => (
              <Tr key={r.key}>
                <Td className="truncate text-[13px]" title={`${r.productName}: ${money(r.beforeExPaise)} → ${money(r.afterExPaise)} before GST, ${r.cansPerMonth.toFixed(1)} cans a month`}>
                  {r.productName}
                </Td>
                <Td align="right" className="text-[13px]">
                  {r.beforeExPaise ? pctWords(Math.round((((r.afterExPaise ?? 0) - r.beforeExPaise) * 10000) / r.beforeExPaise)) : "—"}
                </Td>
                <Td align="right" className={cx("text-[13px]", r.effectPerMonthPaise < 0 ? "text-danger" : "text-body")}>
                  {signedMoney(r.effectPerMonthPaise, money)}
                </Td>
              </Tr>
            ))}
          </tbody>
        </table>
        {!change.effect.rows.length ? <p className="px-4 py-3 text-[13px] text-muted">The book&apos;s shops bought none of the changed products recently.</p> : null}
      </div>
      {Object.keys(change.acks).length ? (
        <div className="border-b border-divider px-4 py-3 text-[13px]">
          <div className="mb-1 text-xs font-semibold tracking-label text-muted uppercase">The maker says these are intended</div>
          <ul className="space-y-1">
            {change.flags
              .filter((f) => change.acks[f.key])
              .map((f) => (
                <li key={f.key}>
                  <span className="text-body">{f.message}</span> <span className="text-muted">— “{change.acks[f.key].note}”</span>
                </li>
              ))}
          </ul>
        </div>
      ) : null}
      <div className="border-b border-divider px-4 py-3 text-[13px]">
        {change.secondOpinion ? (
          <div className="rounded-control border border-line bg-canvas px-3 py-2">
            <div className="mb-0.5 text-[12px] text-muted">Second opinion ({change.secondOpinion.provider === "anthropic" ? "Claude" : "OpenAI"}) — advice only</div>
            <p className="text-body">{change.secondOpinion.text}</p>
          </div>
        ) : null}
        {ai.openai || ai.anthropic ? (
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act("opinion", requestSecondOpinion(change.id))}>
            {busy === "opinion" ? "Asking…" : change.secondOpinion ? "Ask again" : "Get a second opinion"}
          </Button>
        ) : null}
      </div>
      {mayApprove ? (
        <div className="space-y-3 px-4 py-3">
          <label className="block text-[13px] text-body">
            Goes live on
            <Input type="date" min={todayIso} value={goLive} onChange={(e) => setGoLive(e.target.value)} className="mt-1 w-full" />
          </label>
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={team} onChange={(e) => setTeam(e.target.checked)} /> Tell the team of this book&apos;s shops
          </label>
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="A note for the record (optional)" className="w-full" />
          <div className="flex gap-2">
            <Button
              variant="primary"
              className="flex-1"
              disabled={!!busy || !goLive}
              onClick={() => act("approve", approveChange(change.id, { note, goLive, notify: { ...change.notify, team } }))}
            >
              {change.needsSecond && !firstDone ? "Approve (first of two)" : goLive > todayIso ? `Approve for ${longDate(goLive)}` : "Approve — live today"}
            </Button>
            {!isMaker ? (
              <Button variant="secondary" disabled={!!busy} onClick={() => setSendingBack(true)}>
                Send back
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="px-4 py-3 text-[13px] text-muted">
          {firstDone && change.approver?.id === viewerId ? "You approved it. A second person on the Price Desk approves it next." : "Waiting for the Price Desk to approve."}
        </p>
      )}
      <Modal
        open={sendingBack}
        onClose={() => setSendingBack(false)}
        title="Send it back"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSendingBack(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!why.trim() || !!busy}
              onClick={async () => {
                const r = await act("back", sendBackChange(change.id, why));
                if (r.ok) setSendingBack(false);
              }}
            >
              Send back
            </Button>
          </>
        }
      >
        <p className="mb-2 text-[13px] text-muted">Say what needs to change. {change.maker.name} reads this.</p>
        <Textarea rows={3} value={why} onChange={(e) => setWhy(e.target.value)} className="w-full" />
      </Modal>
    </Card>
  );
}

/* -------------------------------------------------------------- approved */

function ApprovedPanel({ change, canManage, todayIso, busy, act }: { change: ChangeView; canManage: boolean; todayIso: string; busy: string | null; act: Act }) {
  const [moving, setMoving] = React.useState(false);
  const [date, setDate] = React.useState(change.goLive ?? "");
  const scheduled = change.stage === "scheduled";
  return (
    <Card>
      <CardHeader title={scheduled ? "Scheduled" : "Live"} />
      <div className="space-y-2 px-4 py-3 text-[13px] text-body">
        <p>
          Approved by {change.approver?.name ?? "—"}
          {change.secondApprover ? ` and ${change.secondApprover.name}` : ""}
          {change.approverNote ? ` — “${change.approverNote}”` : ""}.
        </p>
        <p>
          {scheduled
            ? `Goes live on ${longDate(change.goLive)}. Until then shops pay revision ${change.baseList?.version ?? ""}.`
            : `In force since ${longDate(change.goLive)}.`}
        </p>
        {canManage && scheduled ? (
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setMoving(true)}>
              Move the date
            </Button>
          </div>
        ) : null}
      </div>
      <Modal
        open={moving}
        onClose={() => setMoving(false)}
        title="Move the go-live date"
        footer={
          <>
            <Button variant="ghost" onClick={() => setMoving(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!date || !!busy}
              onClick={async () => {
                const r = await act("move", moveGoLive(change.id, date));
                if (r.ok) setMoving(false);
              }}
            >
              {date === todayIso ? "Put it live today" : "Move"}
            </Button>
          </>
        }
      >
        <Input type="date" min={todayIso} value={date} onChange={(e) => setDate(e.target.value)} />
      </Modal>
    </Card>
  );
}
