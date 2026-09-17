"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { APP_TIMEZONE } from "@/lib/business-date";
import { reviewDayEvidence } from "@/lib/actions/sales";
import { Modal } from "@/components/ui/modal";
import type { DayEvidence, EvidenceItem } from "@/lib/services/day-evidence-service";
import { Banner, Button, Empty, MetricRow, Pill } from "../../parts";
import { plural } from "../../words";

/**
 * ONE SALESMAN'S DAY, PHOTOGRAPH BY PHOTOGRAPH, and a place to answer each one.
 *
 * Everything on this screen has been arriving at the office since attendance
 * selfies and the odometer camera shipped, and none of it could be ANSWERED:
 * the Attendance screen drew the faces, the Travel ledger drew a "Photo" pill,
 * and a manager who looked at either had nowhere to put what he concluded. So
 * a photograph somebody had checked and a photograph nobody had opened were
 * indistinguishable — on the two records a payslip and a mileage claim are
 * read against.
 *
 * **IT IS ONE LIST IN THE ORDER THE DAY HAPPENED**, not a table of selfies
 * above a table of meters. Read top to bottom it is the morning: he arrived,
 * he set off, he got there, he broke for lunch. Grouped by table it is two
 * lists somebody has to interleave in their head while deciding whether they
 * believe it.
 *
 * **THE PICTURE IS THE ROW.** A forty-eight-pixel thumbnail is enough to say a
 * photograph exists and nothing like enough to judge one, and this is the
 * screen where judging one is the entire job — so the image is drawn at a size
 * a face and four digits can actually be read at, and it opens full size.
 *
 * **ACCEPTING IS ONE PRESS AND DECLINING ASKS FOR WORDS.** A day of six marks
 * that are all fine must cost six clicks, or nobody does this by the second
 * week. A decline is the rare one and it is the one that reaches the salesman,
 * so it is the one that stops to ask.
 */
export function DayCheck({
  salesmanId,
  day,
  longDay,
  today,
  evidence,
  retentionHours,
}: {
  salesmanId: string;
  day: string;
  longDay: string;
  today: string;
  evidence: DayEvidence | null;
  retentionHours: number;
}) {
  const items = evidence?.items ?? [];
  const accepted = items.filter((i) => i.review?.verdict === "accepted").length;
  const declined = items.filter((i) => i.review?.verdict === "declined").length;
  const outstanding = items.length - accepted - declined;
  const gone = items.filter((i) => i.photographed && !i.photoAvailable).length;
  const missing = items.filter((i) => !i.photographed).length;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 text-[13px]">
          <Link
            href={`/sales/people/${salesmanId}?day=${addDays(day, -1)}`}
            className="rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-body no-underline hover:bg-canvas hover:no-underline"
            title="The day before"
          >
            ←
          </Link>
          <span className="px-2 font-medium text-ink">{longDay}</span>
          <Link
            href={`/sales/people/${salesmanId}?day=${addDays(day, 1)}`}
            className="rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-body no-underline hover:bg-canvas hover:no-underline"
            title="The day after"
          >
            →
          </Link>
          {day !== today ? (
            <Link
              href={`/sales/people/${salesmanId}?day=${today}`}
              className="ml-2 rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-body no-underline hover:bg-canvas hover:no-underline"
            >
              Today
            </Link>
          ) : null}
        </div>

        {evidence?.attendance ? (
          <p className="text-[13px] text-muted">
            {evidence.attendance.checkInAt
              ? `In ${clock(evidence.attendance.checkInAt)}`
              : "Never started"}
            {evidence.attendance.checkOutAt
              ? ` · out ${clock(evidence.attendance.checkOutAt)}`
              : evidence.attendance.checkInAt
                ? " · still open"
                : ""}
            {evidence.attendance.autoCheckedOut ? " · closed for him" : ""}
            {" · "}
            {evidence.attendance.status.replace(/_/g, " ")}
          </p>
        ) : null}
      </div>

      {/*
        WHY A CORRECTION MAY BE REFUSED, said before anybody tries rather than
        at the moment they press the button. Once the claim has been decided
        the distance under it stops moving, because changing it would move the
        figures beneath somebody's signature — and the way past it is Reopen,
        one screen along, which asks for a reason and tells the salesman.
      */}
      {evidence?.claim?.decided ? (
        <Banner
          tone="warn"
          title="This day's expense claim has already been decided"
          body="You can still record what you make of these photographs, and the verdicts are worth having. What cannot be changed here is a reading: correcting one would re-price a claim somebody has already signed off. Reopen the day on the Expenses screen to do that."
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: "Photographs", value: String(items.length) },
          { label: "Accepted", value: String(accepted) },
          {
            label: "Declined",
            value: String(declined),
            tone: declined ? "warn" : undefined,
          },
          {
            label: "Still to check",
            value: String(outstanding),
            tone: outstanding ? "warn" : undefined,
            sub: outstanding ? "nobody has looked at these" : "the day is answered",
          },
        ]}
      />

      {items.length === 0 ? (
        <Empty
          title={
            evidence?.attendance
              ? "Nothing was photographed on this day"
              : "He did not open this day"
          }
          body={
            evidence?.attendance
              ? "The day was marked, and neither a check-in photograph nor a meter reached the office for it. On a build old enough that is ordinary; on a current one it is worth asking about."
              : "There is no check-in, no leg and no photograph — either he did not work, or the handset has not synced. The Attendance screen says which days he did open."
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((item) => (
            <EvidenceCard
              key={item.ref}
              item={item}
              canCorrect={!evidence?.claim?.decided}
            />
          ))}
        </div>
      )}

      {/*
        THE TWO ABSENCES, told apart in words rather than by the shape of a
        grey box. An image swept after its window is an ordinary expired file;
        a mark with no photograph against it at all is somebody having got past
        a camera. Drawing them alike is how the first reads as the second on
        the record a payslip is checked against.
      */}
      {gone || missing ? (
        <p className="mt-3 text-[13px] text-muted">
          {gone
            ? `${plural(gone, "photograph")} ${gone === 1 ? "was" : "were"} taken on this day and ${gone === 1 ? "its image has" : "their images have"} since been deleted — attendance photographs are kept for ${retentionWords(retentionHours)} after they reach the office, and the mark, its time and any verdict stay for ever. `
            : ""}
          {missing
            ? `${plural(missing, "mark")} carries no photograph at all, which is a different thing and worth asking about.`
            : ""}
        </p>
      ) : null}
    </div>
  );
}

/**
 * One photograph, and the verdict on it.
 *
 * The controls change shape once answered rather than disappearing: a manager
 * who mis-clicked Accept needs a way back, and a verdict with no way to revise
 * it is one people work around by not giving it.
 */
function EvidenceCard({ item, canCorrect }: { item: EvidenceItem; canCorrect: boolean }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const answered = item.review !== null;

  const accept = async () => {
    setBusy(true);
    setError(null);
    const r = await reviewDayEvidence({ ref: item.ref, verdict: "accepted" });
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? "That did not save.");
      return;
    }
    router.refresh();
  };

  return (
    <div
      className={
        "flex gap-3 rounded-[6px] border bg-surface p-3 " +
        (item.review?.verdict === "declined"
          ? "border-warn-edge"
          : "border-line")
      }
    >
      <Photo item={item} onOpen={() => setOpen(true)} />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium text-ink">{item.label}</span>
          {item.at ? <span className="text-[13px] text-muted">{clock(item.at)}</span> : null}
          {item.km !== null ? (
            <span className="text-sm font-medium text-ink">
              {item.km.toLocaleString("en-IN")} km
            </span>
          ) : null}
          {item.kind === "odometer" && item.km === null ? (
            <span className="text-[13px] text-warn-ink">no reading entered</span>
          ) : null}
        </div>

        {item.context ? (
          <p className="mt-0.5 truncate text-[13px] text-muted" title={item.context}>
            {item.context}
          </p>
        ) : null}

        {answered ? (
          <div className="mt-1.5 text-[13px]">
            <span className="mr-1.5">
              <Pill tone={item.review!.verdict === "accepted" ? "success" : "warn"}>
                {item.review!.verdict === "accepted" ? "Approved" : "Declined"}
              </Pill>
            </span>
            {item.review!.correctedKm !== null ? (
              <span className="text-body">
                Read as {item.review!.correctedKm!.toLocaleString("en-IN")} km
                {item.review!.reportedKm !== null
                  ? ` — he entered ${item.review!.reportedKm!.toLocaleString("en-IN")} km`
                  : ""}
                .{" "}
              </span>
            ) : null}
            {item.review!.remark ? (
              <span className="text-body">“{item.review!.remark}”</span>
            ) : null}
            <span className="block text-[12px] text-muted">
              {item.review!.decidedByName ?? "Somebody"} · {stamp(item.review!.decidedAt)}
            </span>
          </div>
        ) : null}

        {error ? <p className="mt-1.5 text-[13px] text-danger">{error}</p> : null}
      </div>

      <div className="flex shrink-0 items-start gap-1.5">
        {answered ? (
          <Button tone="quiet" size="sm" onClick={() => setOpen(true)}>
            Change
          </Button>
        ) : (
          <>
            <Button tone="quiet" size="sm" disabled={busy} onClick={() => setOpen(true)}>
              Decline
            </Button>
            <Button tone="primary" size="sm" disabled={busy} onClick={accept}>
              {busy ? "…" : "Approve"}
            </Button>
          </>
        )}
      </div>

      {open ? (
        <DecideDialog
          key={item.ref}
          item={item}
          canCorrect={canCorrect}
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The photograph itself — or the honest account of why there is not one.
 *
 * Three states and three different facts: an image you can open, an image that
 * was taken and has since been swept, and a mark with no photograph against it
 * at all. The last two are the ones a screen usually collapses, and collapsing
 * them turns an expired file into what looks like somebody skipping a camera.
 *
 * **The thumbnail OPENS THE VIEWER and does not open a tab.** A new tab shows
 * the picture and takes the person away from the thing they were about to do
 * with it — they come back to a screen that has forgotten which row they were
 * on, and the verdict is two navigations from the evidence it is about. The
 * viewer is where both live together.
 */
function Photo({ item, onOpen }: { item: EvidenceItem; onOpen?: () => void }) {
  /* One size, because there is one caller. The viewer draws its own image at
     the size the evidence needs and does not reach for this. */
  const box = { width: 96, height: 96 };

  if (item.photoId && item.photoAvailable) {
    const img = (
      /* eslint-disable-next-line @next/next/no-img-element */
      <img
        src={`/api/attachments/${item.photoId}`}
        alt={item.label}
        loading="lazy"
        style={box}
        className="rounded-[3px] object-cover"
      />
    );
    return onOpen ? (
      <button
        type="button"
        onClick={onOpen}
        title="Open it, and say whether you accept it"
        className="block shrink-0 cursor-pointer rounded-[4px] border border-line p-0 hover:border-brand"
      >
        {img}
      </button>
    ) : (
      <span className="block shrink-0 rounded-[4px] border border-line">{img}</span>
    );
  }

  const placeholder = (
    <span
      style={box}
      className={
        "flex shrink-0 items-center justify-center rounded-[4px] border border-dashed px-2 text-center text-[11px] leading-[13px] " +
        (item.photographed ? "border-line text-muted" : "border-warn-edge text-warn-ink")
      }
    >
      {item.photographed ? "photographed, image since deleted" : "no photograph taken"}
    </span>
  );

  /* Still clickable where there is nothing to see: the verdict is on the mark
     rather than on the file, and "the image is gone and I am satisfied from
     the times" is a real answer somebody needs to be able to give. */
  return onOpen ? (
    <button
      type="button"
      onClick={onOpen}
      className="shrink-0 cursor-pointer border-0 bg-transparent p-0"
      title="There is no image to look at — you can still record a verdict on the mark"
    >
      {placeholder}
    </button>
  ) : (
    placeholder
  );
}

/**
 * THE IMAGE VIEWER, and the two buttons that are the whole point of it.
 *
 * **The picture and the decision are one screen.** Looking at a photograph
 * produces a verdict, and every arrangement that puts them apart — a new tab,
 * a lightbox with a close button, a row you have to find again afterwards —
 * puts a navigation between the evidence and the answer. That gap is where the
 * work stops getting done: it is one more thing to do after the interesting
 * part is over.
 *
 * **It is drawn at a size the evidence can be judged at.** A face and four
 * digits on a dial are what this screen exists to read, and a hundred-pixel
 * square cannot carry either. `object-contain` on a dark ground, because a
 * meter photographed in a lane is a wide picture and a selfie is a tall one,
 * and cropping either to fill a box is how the reading ends up outside the
 * frame.
 *
 * **Declining may carry the reading.** A declined odometer is nearly always a
 * digit — 41,208 typed for a meter showing 41,280 — and a viewer that recorded
 * the disagreement without letting the person holding the photograph say what
 * it reads leaves the wrong number standing in the only place the distance is
 * worked out from. It is optional: a photograph too blurred to read is a real
 * decline with no figure behind it.
 *
 * **Approving asks for nothing.** The photograph is the reason, and a day of
 * six good marks has to cost six presses or nobody does this twice.
 */
function DecideDialog({
  item,
  canCorrect,
  onClose,
  onDone,
}: {
  item: EvidenceItem;
  canCorrect: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [remark, setRemark] = React.useState(item.review?.remark ?? "");
  const [km, setKm] = React.useState(
    item.review?.correctedKm !== null && item.review?.correctedKm !== undefined
      ? String(item.review.correctedKm)
      : "",
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const isOdometer = item.kind === "odometer";
  const viewable = Boolean(item.photoId && item.photoAvailable);
  const typed = km.replace(/[^0-9]/g, "");

  const run = async (verdict: "accepted" | "declined") => {
    setBusy(true);
    setError(null);
    const r = await reviewDayEvidence({
      ref: item.ref,
      verdict,
      remark: verdict === "declined" ? remark : null,
      correctedKm: verdict === "declined" && isOdometer && typed ? Number(typed) : null,
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? "That did not save.");
      return;
    }
    onDone();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`${item.label}${item.at ? ` · ${clock(item.at)}` : ""}`}
      width={720}
    >
      {viewable ? (
        <div className="mb-3 flex items-center justify-center rounded-[6px] bg-[#111418] p-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/attachments/${item.photoId}`}
            alt={item.label}
            className="max-h-[52vh] w-auto max-w-full rounded-[4px] object-contain"
          />
        </div>
      ) : (
        <div className="mb-3 flex flex-col items-center justify-center gap-1 rounded-[6px] border border-dashed border-line px-4 py-10 text-center">
          <p className="text-sm font-medium text-ink">
            {item.photographed
              ? "This was photographed, and the image has since been deleted"
              : "No photograph was taken at this mark"}
          </p>
          <p className="max-w-[46ch] text-[13px] text-muted">
            {item.photographed
              ? "Attendance photographs are swept after their window and the mark, its time and its verdict stay for ever. You can still answer for it — say in the remark what you are going on."
              : "That is a different thing from an expired one, and it is worth asking about. The verdict you give here is on the mark itself."}
          </p>
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[13px]">
        <span className="min-w-0 text-body">{item.context ?? "\u00a0"}</span>
        <span className="flex items-center gap-3">
          {isOdometer ? (
            <span className="text-muted">
              He entered{" "}
              <span className="font-medium text-ink">
                {item.km === null ? "nothing" : `${item.km.toLocaleString("en-IN")} km`}
              </span>
            </span>
          ) : null}
          {viewable ? (
            /* The original, for anybody who needs to zoom into a dial the
               viewer has scaled down. A link and not the default: opening a
               tab is the thing this modal exists to stop being the only way
               to see the picture. */
            <a
              href={`/api/attachments/${item.photoId}`}
              target="_blank"
              rel="noreferrer"
              className="text-[#5223E0] no-underline hover:underline"
            >
              Open full size
            </a>
          ) : null}
        </span>
      </div>

      {isOdometer ? (
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-ink">
            What the meter reads — leave empty if you cannot read it
          </span>
          <input
            value={km}
            onChange={(e) => setKm(e.target.value)}
            inputMode="numeric"
            disabled={!canCorrect}
            placeholder={item.km === null ? "" : String(item.km)}
            className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand disabled:bg-canvas disabled:text-muted"
          />
          <span className="mt-1 block text-[12px] text-muted">
            {canCorrect
              ? "Kilometres, and it rides on the decline. It replaces the reading on the leg and the distance is worked out again — his own figure is kept beside it, so both stay readable."
              : "The claim for this day has already been decided, so a reading cannot be changed here. Reopen the day on the Expenses screen to correct it."}
          </span>
        </label>
      ) : null}

      <label className={isOdometer ? "mt-3 block" : "block"}>
        <span className="mb-1 block text-[13px] font-medium text-ink">
          Why — required to decline, and he is told it word for word
        </span>
        <textarea
          value={remark}
          onChange={(e) => setRemark(e.target.value)}
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
          tone="danger"
          disabled={busy || !remark.trim()}
          title={!remark.trim() ? "A decline has to say why — he is told this." : undefined}
          onClick={() => run("declined")}
        >
          {busy ? "Saving…" : "Decline"}
        </Button>
        <Button tone="primary" disabled={busy} onClick={() => run("accepted")}>
          {busy ? "Saving…" : "Approve"}
        </Button>
      </div>
    </Modal>
  );
}

function retentionWords(hours: number): string {
  if (hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? "24 hours" : `${days} days`;
  }
  return `${hours} hours`;
}

/**
 * Pure date arithmetic on the ISO string. No clock is read during render.
 *
 * It is spelled out of `getUTC*` rather than off `toISOString().slice(0, 10)`,
 * which is the same answer and is the spelling §11's grep guard refuses on
 * sight — rightly, because on a real instant that truncation is a bare `::date`
 * in different clothes and dates a 2am IST row to the previous day. There is no
 * instant here: the value was built by `Date.UTC` out of a calendar date and
 * carries no time of day for a zone to move. A guard cannot see that
 * difference, and a guard somebody has learned to step around is worth less
 * than the one line it costs to keep it happy.
 */
function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  at.setUTCDate(at.getUTCDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

/** Named, because a server render is not in Asia/Kolkata. */
function clock(at: Date | string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(at));
}

function stamp(at: Date | string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIMEZONE,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(at));
}
