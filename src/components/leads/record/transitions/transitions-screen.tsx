import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import Link from "next/link";
import { money, stamp } from "@/lib/format";
import { cx } from "@/components/ui/primitives";
import {
  DISTRIBUTOR_CONDITIONS,
  PROSPECT_CONDITIONS,
  QUALIFICATION_CONDITIONS,
} from "@/lib/engines/lead-gates";
import { directionOf, type MoveDirection } from "@/lib/engines/lead-ladder";
import {
  labelOf,
  LOST_REASONS,
  OVERRIDE_REASONS,
  PROSPECT_REASONS,
  SAMPLE_REASONS,
  salesTypeLabel,
  stageLabel,
  type LeadSalesType,
  type LeadStage,
} from "@/lib/lead-labels";
import type {
  ParkedFrom,
  StreamEntry,
  StreamPage,
  TransitionPayload,
  TransitionsHead,
} from "@/lib/services/lead-board-service";
import { Empty, Pill, ScreenHeader, plural } from "@/components/console/parts";

/* ---------------------------------------------------------------------------
 * §25, read.
 *
 * THIS IS A SERVER COMPONENT AND THAT IS THE ARGUMENT RATHER THAN AN
 * OPTIMISATION. Every other screen in this workspace is a client component
 * because every other screen can DO something — reassign, archive, advance,
 * override. There is nothing to do here: the table is append-only, a
 * transition recorded wrongly is corrected by a further transition, and a
 * screen with no state to hold is a screen with no way for an edit control to
 * arrive on it by accident.
 * ------------------------------------------------------------------------- */

/**
 * The four coded lists, read in the order the move makes them likely.
 *
 * A reason is a CODE and never a label — that is what makes "how many did we
 * lose on credit terms this quarter" a question somebody can ask — and the cost
 * of it is that the way back is a lookup. Which list a code belongs to is not
 * stored, so it is inferred from the move: a lost lead's reason is §26's, an
 * overridden move's is the override list, a move to Prospect is §5's, anything
 * about a sample is §10's. Where the inference is wrong the fallback still
 * finds it, because `labelOf` returns the code itself rather than an empty
 * string — a code on the screen is ugly and honest, and an empty cell is a
 * reason that looks like it was never given.
 */
function anyReasonLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  for (const list of [LOST_REASONS, OVERRIDE_REASONS, PROSPECT_REASONS, SAMPLE_REASONS]) {
    const hit = list.find((o) => o.code === code);
    if (hit) return hit.label;
  }
  /* The code itself, through the engine's own resolver rather than an empty
     string. A code on the screen is ugly and honest; an empty cell is a reason
     that looks like it was never given. */
  return labelOf(LOST_REASONS, code);
}

function reasonWords(p: TransitionPayload): string | null {
  if (!p.reasonCode) return null;
  const first =
    p.toStage === "lost"
      ? LOST_REASONS
      : p.moveKind === "overridden"
        ? OVERRIDE_REASONS
        : p.toStage === "prospect"
          ? PROSPECT_REASONS
          : SAMPLE_REASONS;
  const preferred = first.find((o) => o.code === p.reasonCode);
  return preferred ? preferred.label : anyReasonLabel(p.reasonCode);
}

/**
 * The sentence behind a condition id, for the override list.
 *
 * `overridden_conditions` stores the ids the gate was refusing on, because the
 * SENTENCES are edited — they are instructions a salesman reads and they get
 * reworded. So they are resolved back through the engine's own lists, which is
 * the same place the refusal drew them from. The three lists overlap on a
 * handful of ids and mean the same thing wherever they do; an id in none of
 * them is drawn as itself rather than dropped, because a condition somebody
 * passed and nobody can now name is precisely what a reader needs to see.
 */
const CONDITION_WORDS = new Map<string, string>(
  [...PROSPECT_CONDITIONS, ...QUALIFICATION_CONDITIONS, ...DISTRIBUTOR_CONDITIONS].map((c) => [
    c.id,
    c.says,
  ]),
);

const DIRECTION_TONE: Record<MoveDirection, "success" | "warn" | "danger" | "neutral"> = {
  up: "success",
  down: "warn",
  out: "danger",
  same: "neutral",
  off_ladder: "neutral",
};

const DIRECTION_WORD: Record<MoveDirection, string> = {
  up: "Forward",
  down: "Back",
  out: "Out",
  same: "Restated",
  /* Not a fault: a lead whose sales type somebody changed has moves in its
     history that were made on another ladder, and calling those "back" or
     "forward" would be a comparison between two different climbs. */
  off_ladder: "Another ladder",
};

export function TransitionsScreen({
  workspace,
  head,
  page,
  parked,
  onFirstPage,
}: {
  /** Which app is drawing this. See `lib/lead-workspace.ts`. */
  workspace: LeadWorkspace;
  head: TransitionsHead;
  page: StreamPage;
  parked: ParkedFrom | null;
  onFirstPage: boolean;
}) {
  return (
    <div className="p-6">
      <ScreenHeader
        title="Stage transitions"
        subtitle={
          <>
            Every move this lead has made, with the manager&rsquo;s calls, the samples, the orders
            and the receipts in the same stream — because &ldquo;the sample went out, and nine days
            later somebody moved it on&rdquo; is a sentence you can only read if the two sit
            together. <strong className="font-semibold text-body">Nothing here can be edited.</strong>{" "}
            A transition recorded wrongly is corrected by a further transition: the row records what
            somebody decided on a day, and a rewrite destroys that question rather than answering it.
          </>
        }
        actions={
          <Link
            href={leadHref(workspace, `leads/${head.customerId}`)}
            className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
          >
            Back to the lead
          </Link>
        }
      />

      <div className="mb-4 rounded-[6px] border border-line bg-surface px-5 py-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-[15px] font-semibold text-ink">{head.name}</span>
          {head.companyName && head.companyName !== head.name ? (
            <span className="text-[13px] text-muted">{head.companyName}</span>
          ) : null}
          <span className="text-[13px] text-muted">{head.city ?? "No city"}</span>
          <span className="text-[13px] text-muted">
            {head.ownerName ?? "Nobody holds this lead"}
          </span>
          <Pill tone="brand">{stageLabel(head.stage)}</Pill>
          <span className="text-[12px] text-muted">
            {head.salesType
              ? salesTypeLabel(head.salesType)
              : "Raised before the funnel — the original ladder"}
          </span>
        </div>

        <p className="mt-2 mb-0 max-w-[820px] text-[12px] text-pretty text-muted">
          {plural(page.total, "entry", "entries")} in the stream,{" "}
          {plural(page.transitionCount, "of them a stage move", "of them stage moves")}
          {page.overrideCount
            ? `, ${plural(page.overrideCount, "of which passed a shut gate", "of which passed shut gates")}`
            : ", none of which passed a shut gate"}
          . Counted in the database rather than off this page — a history that counted what had been
          drawn would say twenty-five however long it is.
        </p>
      </div>

      {parked ? <Parked parked={parked} stage={head.stage} /> : null}

      {page.entries.length === 0 ? (
        <Empty
          title={onFirstPage ? "Nothing has happened to this lead yet" : "The end of the history"}
          body={
            onFirstPage
              ? "No stage move, no verification call, no sample, no order and no receipt. A lead raised and not yet worked is a real state and this is what it looks like — it is not a screen that failed to load."
              : "You have paged past the oldest entry. Nothing is missing: the stream is sorted newest first and this is the far end of it."
          }
          action={
            onFirstPage ? undefined : (
              <Link
                href={leadHref(workspace, `leads/${head.customerId}/transitions`)}
                className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
              >
                Back to the newest
              </Link>
            )
          }
        />
      ) : (
        <>
          <ol className="m-0 list-none p-0">
            {page.entries.map((entry) => (
              <Entry key={entry.key} entry={entry} salesType={head.salesType} />
            ))}
          </ol>

          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="text-[12px] text-muted">
              Newest first, paged on the entry&rsquo;s own instant with its key as the tiebreaker.
              Without that second column a row appears on two pages while another appears on none,
              and it is invisible until the history is long enough to page.
            </span>
            <div className="flex flex-none gap-2">
              {onFirstPage ? null : (
                <Link
                  href={leadHref(workspace, `leads/${head.customerId}/transitions`)}
                  className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
                >
                  Newest
                </Link>
              )}
              {page.next ? (
                <Link
                  href={`${leadHref(
                    workspace,
                    `leads/${head.customerId}/transitions`,
                  )}?after=${encodeURIComponent(`${page.next.at}~${page.next.key}`)}`}
                  className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
                >
                  Older →
                </Link>
              ) : (
                <span className="inline-flex h-9 items-center px-1 text-[13px] text-muted">
                  The whole history is behind you
                </span>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ───────────────────────────────────────────────── the parked lead's rung */

/**
 * WHERE A PARKED LEAD WAS PARKED FROM — which is in this table and nowhere else.
 *
 * `on_hold` DISPLACES the stage, because a lead has one stage column and this
 * took it. Once a qualified lead is parked, the only surviving record that it
 * was ever at Qualification is the `from_stage` of the transition that parked
 * it, which is why this screen surfaces it at the top rather than leaving it to
 * be found nine rows down: a reopen is a move to a NAMED rung, and this is the
 * name whoever reopens it has to read.
 *
 * It is drawn for a lead that is parked NOW. A lead that was parked in March
 * and came back has the same row in its history and does not need a banner —
 * the question "what does a reopen move this to" is not being asked about it.
 */
function Parked({ parked, stage }: { parked: ParkedFrom; stage: LeadStage }) {
  if (stage !== "on_hold") return null;

  return (
    <div className="mb-4 rounded-[6px] border-l-[3px] border-warn bg-warn-soft px-4 py-3">
      <div className="text-[13px] font-semibold text-ink">
        {parked.fromStage
          ? `Parked from ${stageLabel(parked.fromStage)}`
          : "Parked, and the rung it came from was not recorded"}
      </div>
      <p className="mt-1 mb-0 max-w-[820px] text-[13px] text-pretty text-body">
        {parked.fromStage ? (
          <>
            On hold takes the stage column, so {stageLabel(parked.fromStage)} survives only on the
            transition below that parked it. That is the rung a reopen has to move this lead back
            to — there is nowhere else to read it from.
          </>
        ) : (
          <>
            The parking transition carries no from-stage, so nothing on this record says what rung
            this lead was standing on. That is not the same as it having been at the foot of the
            ladder: it is a gap, and whoever reopens this will have to decide the rung rather than
            read it.
          </>
        )}
      </p>
      <div className="mt-1 text-[12px] text-muted">
        {stamp(parked.at)}
        {parked.actorName ? ` · ${parked.actorName}` : " · nobody recorded"}
        {parked.reasonCode ? ` · ${anyReasonLabel(parked.reasonCode)}` : ""}
      </div>
      {parked.note ? (
        <p className="mt-1 mb-0 text-[13px] text-pretty text-body">&ldquo;{parked.note}&rdquo;</p>
      ) : (
        <p className="mt-1 mb-0 text-[12px] text-muted">
          No note. On hold asks for a reason because somebody WILL look again — &ldquo;back after
          Diwali&rdquo; is what tells them when.
        </p>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────── one stream entry */

function Entry({
  entry,
  salesType,
}: {
  entry: StreamEntry;
  salesType: LeadSalesType | null;
}) {
  return (
    <li className="mb-2 rounded-[6px] border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          {entry.kind === "transition" ? (
            <Transition p={entry.payload as unknown as TransitionPayload} salesType={salesType} />
          ) : entry.kind === "call" ? (
            <Call p={entry.payload} />
          ) : entry.kind === "sample" ? (
            <Sample p={entry.payload} />
          ) : entry.kind === "order" ? (
            <Order p={entry.payload} />
          ) : (
            <Receipt p={entry.payload} />
          )}
        </div>
        <span className="flex-none text-[12px] text-muted tabular-nums">{stamp(entry.at)}</span>
      </div>
    </li>
  );
}

function Transition({
  p,
  salesType,
}: {
  p: TransitionPayload;
  salesType: LeadSalesType | null;
}) {
  /* The move is judged against the ladder it was MADE on where the row records
     one, and against the lead's ladder otherwise. A lead whose sales type
     somebody changed has history from two climbs in it, and reading an old move
     against today's ladder is what turns a forward step into "another ladder"
     for no reason anybody can see. */
  const ladder = p.salesType ?? salesType;
  const direction: MoveDirection = p.fromStage
    ? directionOf(p.fromStage, p.toStage, ladder)
    : "up";
  const reason = reasonWords(p);
  const overridden = p.overriddenConditions ?? [];

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-ink">
          {p.fromStage ? `${stageLabel(p.fromStage)} → ${stageLabel(p.toStage)}` : `Raised at ${stageLabel(p.toStage)}`}
        </span>
        <Pill tone={DIRECTION_TONE[direction]}>{DIRECTION_WORD[direction]}</Pill>
        {/* A move that passed a shut gate is NOT the same event as one that did
            not, and the two must never be drawn alike — the whole reason an
            override is allowed rather than refused is that it stays legible
            afterwards. */}
        {p.moveKind === "overridden" ? <Pill tone="danger">Gate overridden</Pill> : null}
        {p.moveKind === "reverted" ? <Pill tone="warn">Reverted</Pill> : null}
      </div>

      <div className="mt-0.5 text-[12px] text-muted">
        {p.actorName ?? "Nobody recorded"}
        {p.actorRole ? ` · ${p.actorRole}` : ""}
        {/* The app as well as the level, because `associate` says neither on its
            own: it is the app that tells the ledger desk from the phones. */}
        {p.actorApp ? ` · ${p.actorApp}` : ""}
        {reason ? ` · ${reason}` : ""}
      </div>

      {p.note ? (
        <p className="mt-1 mb-0 text-[13px] text-pretty text-body">&ldquo;{p.note}&rdquo;</p>
      ) : null}

      {overridden.length ? (
        <div className="mt-1.5 rounded-[4px] border-l-[3px] border-danger bg-danger-soft px-3 py-2">
          <div className="text-[12px] font-semibold text-ink">
            {plural(overridden.length, "condition")} still standing when this was moved
          </div>
          <ul className="mt-1 mb-0 list-none p-0">
            {overridden.map((id) => (
              <li key={id} className="text-[12px] text-body">
                · {CONDITION_WORDS.get(id) ?? id}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function Call({ p }: { p: Record<string, unknown> }) {
  const verdict = (p.verdict as string | null) ?? null;
  const note = (p.note as string | null) ?? null;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-ink">Verification call</span>
        {/* The VERDICT, not a summary of the twelve answers — those live on the
            record, where the form that wrote them is. An unrecorded verdict is
            said as one: nobody having reached a conclusion is different from a
            conclusion of no. */}
        <Pill tone={verdict === "verified" ? "success" : verdict ? "warn" : "neutral"}>
          {verdict ?? "No verdict recorded"}
        </Pill>
      </div>
      <div className="mt-0.5 text-[12px] text-muted">
        {(p.managerName as string | null) ?? "Nobody recorded"}
      </div>
      {note ? (
        <p className="mt-1 mb-0 text-[13px] text-pretty text-body">&ldquo;{note}&rdquo;</p>
      ) : null}
    </>
  );
}

const SAMPLE_STEP_WORDS: Record<string, string> = {
  /* Three parties assert three of these and the words say which. A single
     "sample updated" would lose exactly the distinction §J turns on. */
  requested: "Sample requested",
  approved: "Sample approved",
  dispatched: "Sample dispatched — us saying it went",
  received: "Sample received — the shop saying it is in their hands",
  reviewed: "Trial reviewed",
};

function Sample({ p }: { p: Record<string, unknown> }) {
  const step = String(p.step ?? "");
  const outcome = (p.trialOutcome as string | null) ?? null;
  const rejection = (p.rejectionReason as string | null) ?? null;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-ink">
          {SAMPLE_STEP_WORDS[step] ?? `Sample ${step}`}
        </span>
        {step === "reviewed" && outcome ? (
          <Pill
            tone={
              outcome === "approved" ? "success" : outcome === "rejected" ? "danger" : "warn"
            }
          >
            {outcome}
          </Pill>
        ) : null}
      </div>
      <div className="mt-0.5 text-[12px] text-muted">
        {(p.productName as string | null) ?? "No product named on the sample"}
      </div>
      {rejection && step === "reviewed" ? (
        <p className="mt-1 mb-0 text-[13px] text-pretty text-body">
          Refused: &ldquo;{rejection}&rdquo;
        </p>
      ) : null}
    </>
  );
}

function Order({ p }: { p: Record<string, unknown> }) {
  const status = String(p.status ?? "");
  const decline = (p.declineReason as string | null) ?? null;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-ink">
          Order {(p.orderNo as string | null) ?? "— no number"}
        </span>
        <Pill
          tone={status === "declined" ? "danger" : status === "pending_approval" ? "warn" : "neutral"}
        >
          {status.replace(/_/g, " ")}
        </Pill>
        <span className="text-[13px] text-body tabular-nums">
          {money(Number(p.amountPaise ?? 0))}
        </span>
      </div>
      {/* The status is the ORDER's, written by accounts and by the sheet
          projection. Nothing on this screen has an opinion about it — a
          funnel-owned copy would be overwritten every thirty minutes or land in
          sync_conflicts. */}
      {decline ? (
        <p className="mt-1 mb-0 text-[13px] text-pretty text-body">
          Declined: &ldquo;{decline}&rdquo;
        </p>
      ) : null}
    </>
  );
}

function Receipt({ p }: { p: Record<string, unknown> }) {
  const status = String(p.status ?? "");
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-ink">
          Payment {(p.receiptNo as string | null) ?? "— no number"}
        </span>
        {/* Only CONFIRMED money has moved anything. `reported` is somebody's
            word, `held` is accounts looking for it, and both are drawn as what
            they are rather than as a payment. */}
        <Pill
          tone={
            status === "confirmed"
              ? "success"
              : status === "rejected" || status === "reversed"
                ? "danger"
                : "warn"
          }
        >
          {status}
        </Pill>
        <span className={cx("text-[13px] tabular-nums", status === "confirmed" ? "text-body" : "text-muted")}>
          {money(Number(p.amountPaise ?? 0))}
        </span>
      </div>
      <div className="mt-0.5 text-[12px] text-muted">
        {String(p.mode ?? "mode not recorded")}
        {p.reference ? ` · ${String(p.reference)}` : " · no reference"}
        {" · dated on the day it was received, read in Asia/Kolkata"}
      </div>
    </>
  );
}
