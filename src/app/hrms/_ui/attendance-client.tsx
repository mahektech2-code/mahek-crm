"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { hrmsRunAction } from "@/lib/actions/hrms-screens";
import { saveAttendanceSettings, saveOfficeWeek, type OfficeDay } from "@/lib/actions/hrms-attendance";

/* The interactive halves of the Workday Clock design's HRMS boards. */

/** Approve or decline one item on Team today's "To review", in place. */
export function ReviewButtons({
  screen,
  id,
  approve,
  decline,
}: {
  screen: string;
  id: string;
  approve: { action: string; label: string; values?: Record<string, string> };
  decline: { action: string; label: string; field: string };
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [why, setWhy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const run = async (action: string, values: Record<string, string>) => {
    setBusy(true);
    const r = await hrmsRunAction(screen, action, id, values);
    setBusy(false);
    setMsg({ ok: r.ok, text: r.ok ? (r.message ?? "Done") : r.error });
    if (r.ok) router.refresh();
  };
  if (msg?.ok) return <div className="text-[12.5px] font-medium text-success">{msg.text}</div>;
  return (
    <div className="grid gap-2">
      {why !== null ? (
        <>
          <textarea
            aria-label="Why"
            rows={2}
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            placeholder="Why — they are told"
            className="w-full rounded-[8px] border border-line-strong px-2.5 py-2 text-[13px]"
          />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setWhy(null)} className="h-8 rounded-[8px] border border-line-strong px-3 text-[12.5px] font-semibold">
              Back
            </button>
            <button type="button" disabled={busy || !why.trim()} onClick={() => run(decline.action, { [decline.field]: why })} className="h-8 rounded-[8px] bg-ink px-3 text-[12.5px] font-semibold text-white disabled:opacity-50">
              {decline.label}
            </button>
          </div>
        </>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <button type="button" disabled={busy} onClick={() => setWhy("")} className="h-9 rounded-[9px] border border-line-strong bg-surface text-[13px] font-semibold text-ink">
            {decline.label}
          </button>
          <button type="button" disabled={busy} onClick={() => run(approve.action, approve.values ?? {})} className="h-9 rounded-[9px] bg-brand text-[13px] font-semibold text-white disabled:opacity-60">
            {approve.label}
          </button>
        </div>
      )}
      {msg && !msg.ok ? <div className="text-[12.5px] text-danger">{msg.text}</div> : null}
    </div>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cx("relative h-6 w-11 flex-none rounded-full transition-colors", on ? "bg-brand" : "bg-line-strong")}
    >
      <span className={cx("absolute top-0.5 size-5 rounded-full bg-white shadow transition-all", on ? "left-[22px]" : "left-0.5")} />
    </button>
  );
}

function Num({ value, onChange, unit, label, step = 1 }: { value: number; onChange: (v: number) => void; unit: string; label: string; step?: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <input
        type="number"
        aria-label={label}
        min={0}
        step={step}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-9 w-20 rounded-[8px] border border-line-strong px-2 text-right font-mono text-[14px]"
      />
      <span className="text-[12.5px] text-muted">{unit}</span>
    </span>
  );
}

function SaveBar({ dirty, busy, onSave, msg }: { dirty: boolean; busy: boolean; onSave: () => void; msg: { ok: boolean; text: string } | null }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-3">
      {msg ? <span className={cx("text-[13px]", msg.ok ? "text-success" : "text-danger")}>{msg.text}</span> : null}
      <button type="button" disabled={!dirty || busy} onClick={onSave} className="h-10 rounded-[10px] bg-brand px-5 text-[14px] font-bold text-white disabled:opacity-50">
        {busy ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

export type AttendanceSettings = {
  lockEnabled: boolean;
  exemptPlatformAdmins: boolean;
  warn: number;
  brk: number;
  out: number;
  breakOut: number;
  reasons: string[];
  present: number;
  half: number;
};

/** The design's board 14, saved through the audited settings store. */
export function AttendanceSettingsEditor({ initial, canEdit, timingsHref }: { initial: AttendanceSettings; canEdit: boolean; timingsHref: string }) {
  const router = useRouter();
  const [v, setV] = React.useState(initial);
  const [adding, setAdding] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const set = <K extends keyof AttendanceSettings>(k: K, x: AttendanceSettings[K]) => {
    setV((o) => ({ ...o, [k]: x }));
    setMsg(null);
  };
  const dirty = JSON.stringify(v) !== JSON.stringify(initial);
  const save = async () => {
    setBusy(true);
    const map: Record<string, unknown> = {
      "hrms.workday.lockEnabled": v.lockEnabled,
      "hrms.workday.exemptPlatformAdmins": v.exemptPlatformAdmins,
      "hrms.workday.idleWarnMinutes": v.warn,
      "hrms.workday.idleBreakMinutes": v.brk,
      "hrms.workday.idleOutMinutes": v.out,
      "hrms.workday.breakOutMinutes": v.breakOut,
      "hrms.workday.breakReasons": v.reasons.join(", "),
      "hrms.attendance.presentHours": v.present,
      "hrms.attendance.halfDayHours": v.half,
    };
    const was: Record<string, unknown> = {
      "hrms.workday.lockEnabled": initial.lockEnabled,
      "hrms.workday.exemptPlatformAdmins": initial.exemptPlatformAdmins,
      "hrms.workday.idleWarnMinutes": initial.warn,
      "hrms.workday.idleBreakMinutes": initial.brk,
      "hrms.workday.idleOutMinutes": initial.out,
      "hrms.workday.breakOutMinutes": initial.breakOut,
      "hrms.workday.breakReasons": initial.reasons.join(", "),
      "hrms.attendance.presentHours": initial.present,
      "hrms.attendance.halfDayHours": initial.half,
    };
    const entries = Object.entries(map)
      .filter(([k, x]) => JSON.stringify(x) !== JSON.stringify(was[k]))
      .map(([key, value]) => ({ key, value }));
    const r = await saveAttendanceSettings(entries);
    setBusy(false);
    setMsg({ ok: r.ok, text: r.ok ? (r.message ?? "Saved") : r.error });
    if (r.ok) router.refresh();
  };
  const idle = [
    { k: "warn" as const, l: "Ask “are you still working?” after", s: "With a countdown to the break. Any movement cancels it." },
    { k: "brk" as const, l: "Start a break after", s: "Dated from the last activity, not from this minute." },
    { k: "out" as const, l: "Punch out after", s: "The day closes at the last activity." },
    { k: "breakOut" as const, l: "Punch out if a break goes on longer than", s: "Somebody who starts a break and never comes back is not left on a break all night." },
  ];
  const pct = (n: number) => `${Math.min(100, (n / Math.max(v.out, 1)) * 100)}%`;
  return (
    <fieldset disabled={!canEdit} className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[20px] font-bold text-ink">Attendance settings</h2>
        {canEdit ? <SaveBar dirty={dirty} busy={busy} onSave={save} msg={msg} /> : <span className="text-[13px] text-muted">Only the HR team changes these.</span>}
      </div>

      <Section title="Punch-in">
        <Row l="Lock MahekOne when not working" s="Every app is locked before punch-in, during a break and after punch-out.">
          <Switch on={v.lockEnabled} onChange={(x) => set("lockEnabled", x)} label="Require punch-in" />
        </Row>
        <Row l="Who does not need to punch in" s="Field salesmen already punch in on the handset.">
          <span className="flex flex-wrap justify-end gap-2">
            <span className="rounded-full border border-line bg-canvas px-3 py-1 text-[12.5px] font-semibold text-ink">Field app holders</span>
            {v.exemptPlatformAdmins ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-line bg-canvas px-3 py-1 text-[12.5px] font-semibold text-ink">
                Platform admins
                <button type="button" aria-label="Lock platform admins too" onClick={() => set("exemptPlatformAdmins", false)} className="text-muted hover:text-danger">
                  ×
                </button>
              </span>
            ) : (
              <button type="button" onClick={() => set("exemptPlatformAdmins", true)} className="rounded-full border border-dashed border-line-strong px-3 py-1 text-[12.5px] font-semibold text-brand">
                + Platform admins
              </button>
            )}
          </span>
        </Row>
      </Section>

      <Section title="When nobody is at the screen">
        {idle.map((r) => (
          <Row key={r.k} l={r.l} s={r.s}>
            <Num value={v[r.k]} onChange={(x) => set(r.k, x)} unit="min" label={r.l} />
          </Row>
        ))}
        <div className="px-5 pb-4">
          <div className="relative h-2.5 overflow-hidden rounded-[5px] bg-divider">
            <span className="absolute inset-y-0 left-0 bg-success" style={{ width: pct(v.warn) }} />
            <span className="absolute inset-y-0 bg-warn" style={{ left: pct(v.warn), width: `calc(${pct(v.brk)} - ${pct(v.warn)})` }} />
            <span className="absolute inset-y-0 bg-danger/70" style={{ left: pct(v.brk), right: 0 }} />
          </div>
          <div className="mt-1.5 flex justify-between font-mono text-[11px] text-muted">
            <span>last activity</span>
            <span>{v.warn} warn</span>
            <span>{v.brk} break</span>
            <span>{v.out} out</span>
          </div>
        </div>
      </Section>

      <Section title="Break reasons">
        <p className="px-5 text-[13px] text-muted">Offered when somebody starts a break. Picking one is optional.</p>
        <div className="flex flex-wrap items-center gap-2 px-5 pb-4">
          {v.reasons.map((r) => (
            <span key={r} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-canvas px-3 py-1.5 text-[13px] font-medium text-ink">
              {r}
              <button type="button" aria-label={`Remove ${r}`} onClick={() => set("reasons", v.reasons.filter((x) => x !== r))} className="text-muted hover:text-danger">
                ×
              </button>
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5">
            <input
              aria-label="A new break reason"
              value={adding}
              maxLength={40}
              onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && adding.trim() && !v.reasons.includes(adding.trim())) {
                  set("reasons", [...v.reasons, adding.trim()]);
                  setAdding("");
                }
              }}
              placeholder="+ Add reason"
              className="h-8 w-36 rounded-full border border-dashed border-line-strong px-3 text-[13px]"
            />
          </span>
        </div>
      </Section>

      <Section
        title="Present, half day or absent"
        action={
          <a href={timingsHref} className="text-[13px] font-semibold text-brand hover:underline">
            Office timings →
          </a>
        }
      >
        <p className="px-5 text-[13px] text-muted">
          Counted on hours worked, breaks left out. The same rule and the same two numbers as the MBOS handset, so office and field days are judged alike. A weekday can ask for different hours in Office timings.
        </p>
        <Row l="Present" s="worked at least">
          <Num value={v.present} onChange={(x) => set("present", x)} unit="h" label="Present at hours" step={0.5} />
        </Row>
        <Row l="Half day" s="worked at least">
          <Num value={v.half} onChange={(x) => set("half", x)} unit="h" label="Half day at hours" step={0.5} />
        </Row>
        <Row l="Absent" s="less than half day, or not in">
          <span className="font-mono text-[14px] text-muted">&lt; {v.half} h</span>
        </Row>
        <p className="mx-5 mb-4 rounded-[10px] bg-canvas px-3.5 py-3 text-[12.5px] text-body">
          <b>Not counted:</b> Sundays and other week-off days, holidays from the HRMS holiday calendar, and approved leave. These days are never Absent, and MahekOne is not locked on them. Anybody who checks in anyway has those hours recorded as <b>extra work</b>.
        </p>
      </Section>
    </fieldset>
  );
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="grid gap-1 rounded-[14px] border border-line bg-surface pt-4">
      <div className="flex items-center justify-between px-5 pb-1">
        <h3 className="text-[15px] font-bold text-ink">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Row({ l, s, children }: { l: string; s: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-divider px-5 py-3">
      <div>
        <div className="text-[13.5px] font-semibold text-ink">{l}</div>
        <div className="text-[12.5px] text-muted">{s}</div>
      </div>
      {children}
    </div>
  );
}

const ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const asHours = (min: number | null) => (min == null ? "" : String(Math.round((min / 60) * 100) / 100));

/** The design's board 15: one office's week, saved whole. */
export function OfficeWeekEditor({
  officeId,
  officeName,
  initial,
  defaults,
  canEdit,
  hours,
}: {
  officeId: string;
  officeName: string;
  initial: OfficeDay[];
  defaults: { present: number; half: number };
  canEdit: boolean;
  /** The office's own opening and closing, for a week nobody has saved yet. */
  hours: { open: string; close: string };
}) {
  const router = useRouter();
  const start: OfficeDay[] = ORDER.map((d) => initial.find((x) => x.weekday === d) ?? { weekday: d, working: false, inTime: hours.open, outTime: hours.close, presentMin: null, halfMin: null });
  /* No week saved yet: start from Monday to Saturday at the office's hours,
     unsaved, so saving it is one press rather than seven switches. */
  const suggested = initial.length ? start : start.map((d) => ({ ...d, working: d.weekday !== "Sunday" }));
  const [week, setWeek] = React.useState(suggested);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const dirty = JSON.stringify(week) !== JSON.stringify(start);
  const patch = (i: number, p: Partial<OfficeDay>) => {
    setWeek((w) => w.map((d, j) => (j === i ? { ...d, ...p } : d)));
    setMsg(null);
  };
  const copyMonday = () => {
    const m = week[0];
    setWeek((w) => w.map((d, i) => (i === 0 || !d.working ? d : { ...d, inTime: m.inTime, outTime: m.outTime, presentMin: m.presentMin, halfMin: m.halfMin })));
  };
  const save = async () => {
    setBusy(true);
    const r = await saveOfficeWeek(officeId, week);
    setBusy(false);
    setMsg({ ok: r.ok, text: r.ok ? (r.message ?? "Saved") : r.error });
    if (r.ok) router.refresh();
  };
  return (
    <fieldset disabled={!canEdit} className="grid gap-3">
      <section aria-labelledby="wk-t" className="rounded-[14px] border border-line bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4 pb-3">
          <h3 id="wk-t" className="text-[15px] font-bold text-ink">
            Week at {officeName}
            {!initial.length ? <span className="ml-2 rounded-full bg-warn-soft px-2 py-0.5 text-[11.5px] font-semibold text-warn-ink">Suggested · not saved yet</span> : null}
          </h3>
          <div className="flex items-center gap-3">
            <button type="button" onClick={copyMonday} className="text-[13px] font-semibold text-brand hover:underline">
              Copy Monday to every working day
            </button>
            {canEdit ? <SaveBar dirty={dirty} busy={busy} onSave={save} msg={msg} /> : null}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-[13px]">
            <thead>
              <tr className="bg-ink text-left text-[11px] font-bold tracking-[0.05em] text-white">
                <th className="px-5 py-2.5">DAY</th>
                <th className="px-3 py-2.5">WORKING</th>
                <th className="px-3 py-2.5">OPENS</th>
                <th className="px-3 py-2.5">CLOSES</th>
                <th className="px-3 py-2.5">PRESENT AT</th>
                <th className="px-5 py-2.5">HALF DAY AT</th>
              </tr>
            </thead>
            <tbody>
              {week.map((d, i) => (
                <tr key={d.weekday} className="border-t border-divider">
                  <td className="px-5 py-2.5 font-semibold text-ink">{d.weekday}</td>
                  <td className="px-3 py-2.5">
                    <Switch on={d.working} onChange={(x) => patch(i, { working: x })} label={`${d.weekday} is a working day`} />
                  </td>
                  {d.working ? (
                    <>
                      <td className="px-3 py-2.5">
                        <input type="time" aria-label={`${d.weekday} opens`} value={d.inTime} onChange={(e) => patch(i, { inTime: e.target.value })} className="h-9 rounded-[8px] border border-line-strong px-2 font-mono" />
                      </td>
                      <td className="px-3 py-2.5">
                        <input type="time" aria-label={`${d.weekday} closes`} value={d.outTime} onChange={(e) => patch(i, { outTime: e.target.value })} className="h-9 rounded-[8px] border border-line-strong px-2 font-mono" />
                      </td>
                      <td className="px-3 py-2.5">
                        <HoursInput label={`${d.weekday} present at`} value={d.presentMin} placeholder={asHours(defaults.present * 60)} onChange={(m) => patch(i, { presentMin: m })} />
                      </td>
                      <td className="px-5 py-2.5">
                        <HoursInput label={`${d.weekday} half day at`} value={d.halfMin} placeholder={asHours(defaults.half * 60)} onChange={(m) => patch(i, { halfMin: m })} />
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-3 py-2.5 text-muted">Week off</td>
                      <td />
                      <td />
                      <td />
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </fieldset>
  );
}

function HoursInput({ value, onChange, label, placeholder }: { value: number | null; onChange: (m: number | null) => void; label: string; placeholder: string }) {
  const [text, setText] = React.useState(asHours(value));
  return (
    <span className="inline-flex items-center gap-1.5">
      <input
        aria-label={label}
        inputMode="decimal"
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          const t = e.target.value.replace(/[^\d.]/g, "");
          setText(t);
          onChange(t === "" ? null : Math.round(Number(t) * 60));
        }}
        className="h-9 w-16 rounded-[8px] border border-line-strong px-2 text-right font-mono"
      />
      <span className="text-[12px] text-muted">h</span>
    </span>
  );
}

/** The late grace, which belongs to the attendance settings but is asked on Office timings, as in the design. */
export function GraceEditor({ initial, canEdit }: { initial: number; canEdit: boolean }) {
  const router = useRouter();
  const [v, setV] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-line bg-surface px-5 py-4">
      <div>
        <div className="text-[13.5px] font-semibold text-ink">Late if punched in after opening by more than</div>
        <div className="text-[12.5px] text-muted">Late is shown to the manager. It does not change Present or Absent.</div>
      </div>
      <span className="flex items-center gap-3">
        <fieldset disabled={!canEdit}>
          <Num value={v} onChange={setV} unit="min" label="Late grace minutes" />
        </fieldset>
        {canEdit ? (
          <SaveBar
            dirty={v !== initial}
            busy={busy}
            msg={msg}
            onSave={async () => {
              setBusy(true);
              const r = await saveAttendanceSettings([{ key: "hrms.attendance.graceMinutes", value: v }]);
              setBusy(false);
              setMsg({ ok: r.ok, text: r.ok ? "Saved" : r.error });
              if (r.ok) router.refresh();
            }}
          />
        ) : null}
      </span>
    </section>
  );
}
