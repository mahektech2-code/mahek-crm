"use client";

import { useState, useTransition } from "react";
import { addDays } from "@/lib/format";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Field, Input, Select } from "@/components/ui/primitives";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { scheduleInterview, suggestInterviewTimes } from "@/lib/hire/actions/pipeline";
import type { CalEvent, Slot, ToSchedule } from "@/lib/hire/services/schedule";
import { Btn, BtnLink, Callout, Empty, hs, Label, Panel } from "../_ui/kit";

const HOURS = [9, 10, 11, 12, 13, 14, 15, 16, 17];
const ROW = 56;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const istParts = (iso: string) => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { ymd: `${g("year")}-${g("month")}-${g("day")}`, h: Number(g("hour")) % 24, m: Number(g("minute")) };
};
const addYmd = (ymd: string, d: number) => addDays(ymd, d);
const dayLabel = (ymd: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "2-digit", month: "short" }).format(new Date(`${ymd}T12:00:00Z`));
const whenLabel = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

export function CalendarView({
  monday,
  prev,
  next,
  today,
  events,
  waiting,
  staff,
  meId,
  canSchedule,
}: {
  monday: string;
  prev: string;
  next: string;
  today: string;
  events: CalEvent[];
  waiting: ToSchedule[];
  staff: { id: string; name: string; role: string | null }[];
  meId: string;
  canSchedule: boolean;
}) {
  const days = DAYS.map((l, i) => ({ l, ymd: addYmd(monday, i) }));
  const [pick, setPick] = useState<string | null>(null);
  const picked = waiting.find((w) => w.applicationId === pick) ?? null;
  const sunday = events.filter((e) => istParts(e.startIso).ymd === addYmd(monday, 6)).length;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-4">
      <div>
        <div className="mb-3 flex items-center gap-2">
          <BtnLink size="sm" href={`/hire/calendar?w=${prev}`}>‹ Previous week</BtnLink>
          <BtnLink size="sm" href="/hire/calendar">This week</BtnLink>
          <BtnLink size="sm" href={`/hire/calendar?w=${next}`}>Next week ›</BtnLink>
          <span className="ml-2 text-sm text-muted tabular-nums">
            {dayLabel(monday)} – {dayLabel(addYmd(monday, 5))} · {events.length} interview{events.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
          <div className="grid grid-cols-[64px_repeat(6,minmax(0,1fr))] border-b border-line bg-page">
            <span />
            {days.map((d) => (
              <span key={d.ymd} className={cx("px-2 py-2 text-xs font-medium", d.ymd === today ? "text-brand-hover" : "text-muted")}>
                {d.l} <span className="tabular-nums">{dayLabel(d.ymd)}</span>
              </span>
            ))}
          </div>
          <div className="grid grid-cols-[64px_repeat(6,minmax(0,1fr))]">
            <div>
              {HOURS.map((h) => (
                <div key={h} style={{ height: ROW }} className="border-b border-canvas px-2 pt-0.5 text-[11px] text-muted tabular-nums">
                  {String(h).padStart(2, "0")}:00
                </div>
              ))}
            </div>
            {days.map((d) => (
              <div key={d.ymd} className={cx("relative border-l border-canvas", d.ymd === today ? "bg-page" : "")} style={{ height: ROW * HOURS.length }}>
                {HOURS.map((h) => (
                  <div key={h} style={{ top: (h - 9) * ROW, height: ROW }} className="absolute right-0 left-0 border-b border-canvas" />
                ))}
                {events
                  .filter((e) => istParts(e.startIso).ymd === d.ymd)
                  .map((e) => {
                    const p = istParts(e.startIso);
                    const top = Math.max(0, ((p.h - 9) * 60 + p.m) / 60) * ROW;
                    const height = Math.max(26, (e.minutes / 60) * ROW - 2);
                    const href = e.mine && e.status !== "completed" ? `/hire/workspace/${e.execId}` : `/hire/c/${e.applicationId}`;
                    return (
                      <Link
                        key={e.execId}
                        href={href}
                        title={`${e.name} · ${e.stage} · ${e.role}${e.interviewer ? ` · ${e.interviewer}` : ""}${e.place ? ` · ${e.place}` : ""}`}
                        style={{ top, height }}
                        className={cx(
                          "absolute right-1 left-1 overflow-hidden rounded-[4px] border px-1.5 py-1 no-underline hover:no-underline",
                          e.status === "completed" ? "border-divider bg-canvas" : e.mine ? "border-brand-softer bg-brand-soft" : "border-line bg-surface",
                        )}
                      >
                        <span className="block truncate text-xs font-semibold text-heading">{e.name}</span>
                        <span className="block truncate text-[11px] text-body">
                          {String(p.h).padStart(2, "0")}:{String(p.m).padStart(2, "0")} · {e.stage}
                        </span>
                        {e.interviewer ? <span className="block truncate text-[11px] text-muted">{e.interviewer}</span> : null}
                      </Link>
                    );
                  })}
              </div>
            ))}
          </div>
        </div>
        {sunday ? <div className="mt-2 text-[13px] text-muted">{sunday} interview{sunday === 1 ? " is" : "s are"} booked on Sunday and not drawn on this grid.</div> : null}
      </div>

      <div className="flex flex-col gap-3">
        {!canSchedule ? (
          <Panel title="Your interviews">
            <p className="m-0 text-sm text-muted">Interviews are booked by a recruiter or hiring manager. Yours appear on the grid, and open the interview workspace when clicked.</p>
          </Panel>
        ) : picked ? (
          <Booker key={picked.applicationId} item={picked} staff={staff} meId={meId} today={today} onDone={() => setPick(null)} />
        ) : (
          <Panel title="To schedule" sub="In a scored interview stage with nothing booked, longest waiting first." pad={false}>
            {!waiting.length ? (
              <div className="p-5">
                <Empty title="Nothing waiting">Every candidate in an interview stage has a time booked.</Empty>
              </div>
            ) : (
              <div className="max-h-[560px] overflow-y-auto">
                {waiting.map((w) => (
                  <button key={w.applicationId} onClick={() => setPick(w.applicationId)} className="flex w-full cursor-pointer items-center gap-2 border-0 border-b border-divider bg-surface px-4 py-2.5 text-left last:border-b-0 hover:bg-canvas">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-heading">{w.name}</span>
                      <span className="block truncate text-xs text-muted">
                        {w.stage} · {w.role}
                        {w.location ? ` · ${w.location}` : ""}
                      </span>
                    </span>
                    <span className="flex-none text-xs text-muted tabular-nums" title="Waiting in this stage">
                      {hs(w.waitingHours)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Panel>
        )}
      </div>
    </div>
  );
}

function Booker({ item, staff, meId, today, onDone }: { item: ToSchedule; staff: { id: string; name: string; role: string | null }[]; meId: string; today: string; onDone: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [interviewerId, setInterviewer] = useState(item.interviewerId ?? (staff.some((s) => s.id === meId) ? meId : (staff[0]?.id ?? "")));
  const [minutes, setMinutes] = useState(45);
  const [modality, setModality] = useState("in_person");
  const [place, setPlace] = useState(item.location ? `${item.location} office` : "");
  const [date, setDate] = useState(today);
  const [time, setTime] = useState("11:00");
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const book = (startIso: string) =>
    start(async () => {
      setError(null);
      const r = await scheduleInterview({ applicationId: item.applicationId, interviewerId, startIso, minutes, place, modality });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast.push(r.message ?? "Booked.");
      onDone();
      router.refresh();
    });

  const suggest = () =>
    start(async () => {
      setError(null);
      const r = await suggestInterviewTimes(item.applicationId, interviewerId, minutes);
      if (!r.ok) setError(r.error);
      else setSlots(r.data);
    });

  return (
    <Panel
      title={`Schedule ${item.name}`}
      sub={`${item.stage} · ${item.role}`}
      actions={
        <Btn size="sm" kind="ghost" onClick={onDone}>
          Back
        </Btn>
      }
    >
      <div className="flex flex-col gap-3.5">
        <Field label="Interviewer">
          <Select value={interviewerId} onChange={(e) => { setInterviewer(e.target.value); setSlots(null); }} className="w-full">
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Length">
            <Select value={String(minutes)} onChange={(e) => { setMinutes(Number(e.target.value)); setSlots(null); }} className="w-full">
              {[30, 45, 60, 90].map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </Select>
          </Field>
          <Field label="How">
            <Select value={modality} onChange={(e) => setModality(e.target.value)} className="w-full">
              <option value="in_person">In person</option>
              <option value="video">Video</option>
              <option value="phone">Phone</option>
            </Select>
          </Field>
        </div>
        <Field label="Where" hint="Office, or the video link.">
          <Input value={place} onChange={(e) => setPlace(e.target.value)} />
        </Field>

        <div>
          <Label className="mb-1.5">Proposed times</Label>
          <p className="mt-0 mb-2 text-xs text-muted">The first free slot on each of the next working days, 10:00–18:00 IST, around the interviewer’s and the candidate’s bookings. Nothing is booked until you confirm one.</p>
          {slots == null ? (
            <Btn size="sm" disabled={pending || !interviewerId} onClick={suggest}>
              {pending ? "Looking…" : "Suggest times"}
            </Btn>
          ) : !slots.length ? (
            <Callout tone="warn">No free slot in the next three weeks for this interviewer. Pick a time below.</Callout>
          ) : (
            <div className="flex flex-col gap-2">
              {slots.map((s) => (
                <div key={s.startIso} className="flex items-center gap-2 rounded-[4px] border border-line px-3 py-2">
                  <span className="flex-1 text-sm text-heading tabular-nums">{whenLabel(s.startIso)}</span>
                  <Btn size="sm" kind="primary" disabled={pending} onClick={() => book(s.startIso)}>
                    Book this
                  </Btn>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-divider pt-3">
          <Label className="mb-1.5">Or choose a time</Label>
          <div className="grid grid-cols-2 gap-3">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <Input type="time" value={time} step={900} onChange={(e) => setTime(e.target.value)} />
          </div>
          <Btn className="mt-2.5" size="sm" disabled={pending || !date || !time} onClick={() => book(new Date(`${date}T${time}:00+05:30`).toISOString())}>
            Book {date && time ? `${dayLabel(date)}, ${time}` : ""}
          </Btn>
        </div>
        {error ? <Callout tone="danger">{error}</Callout> : null}
      </div>
    </Panel>
  );
}
