"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { deletePersonDate, savePersonDate } from "@/lib/actions/studio";

/* ---------------------------------------------------------------------------
 * The birthdays and anniversaries everybody in the Studio shares. One list
 * for everybody, edited by anybody holding Dates, and every change is a
 * version: an edit names the version it started from, so two people editing
 * one date at once cannot silently overwrite each other.
 * ------------------------------------------------------------------------- */

export type PersonDateView = { id: string; version: number; kind: "birthday" | "anniversary"; personName: string; company: string | null; date: string; note: string | null; leadDays: number; next: string | null; daysUntil: number | null; years: number | null; updatedBy: string };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function partsOf(date: string) {
  const m = /^(\d{4}|-)-(\d{2})-(\d{2})$/.exec(date.startsWith("--") ? `-${date.slice(1)}` : date);
  if (!m) return { year: "", month: "", day: "" };
  return { year: m[1] === "-" ? "" : m[1]!, month: String(Number(m[2])), day: String(Number(m[3])) };
}

export function PersonDateForm({ existing, onDone }: { existing?: PersonDateView; onDone?: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const start = existing ? partsOf(existing.date) : { year: "", month: "", day: "" };
  const [kind, setKind] = useState(existing?.kind ?? "birthday");
  const [personName, setPersonName] = useState(existing?.personName ?? "");
  const [company, setCompany] = useState(existing?.company ?? "");
  const [month, setMonth] = useState(start.month);
  const [day, setDay] = useState(start.day);
  const [year, setYear] = useState(start.year);
  const [leadDays, setLeadDays] = useState(String(existing?.leadDays ?? 3));
  const [note, setNote] = useState(existing?.note ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await toast.run(savePersonDate({ kind, personName, company, month, day, year, leadDays, note }, existing ? { id: existing.id, version: existing.version } : undefined));
    setBusy(false);
    if (!res.ok) {
      setErrors(Object.fromEntries((res.fieldErrors ?? []).map((f) => [f.field, f.message])));
      return;
    }
    setErrors({});
    if (!existing) {
      setPersonName("");
      setCompany("");
      setNote("");
      setYear("");
    }
    onDone?.();
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
      <Field label="What" error={errors.kind}>
        <Select value={kind} onChange={(e) => setKind(e.target.value as "birthday" | "anniversary")}>
          <option value="birthday">Birthday</option>
          <option value="anniversary">Anniversary</option>
        </Select>
      </Field>
      <Field label="Whose" error={errors.personName}>
        <Input value={personName} maxLength={120} onChange={(e) => setPersonName(e.target.value)} placeholder="Rajesh Shah" />
      </Field>
      <Field label="Company" optional error={errors.company}>
        <Input value={company} maxLength={120} onChange={(e) => setCompany(e.target.value)} />
      </Field>
      <Field label="Date" group error={errors.date} hint="The year is optional.">
        <div className="flex gap-2">
          <Select value={day} onChange={(e) => setDay(e.target.value)} aria-label="Day">
            <option value="">Day</option>
            {Array.from({ length: 31 }, (_, i) => (
              <option key={i + 1} value={String(i + 1)}>
                {i + 1}
              </option>
            ))}
          </Select>
          <Select value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
            <option value="">Month</option>
            {MONTHS.map((m, i) => (
              <option key={m} value={String(i + 1)}>
                {m}
              </option>
            ))}
          </Select>
          <Input value={year} inputMode="numeric" maxLength={4} placeholder="Year" aria-label="Year" className="w-[90px]" onChange={(e) => setYear(e.target.value)} />
        </div>
      </Field>
      <Field label="Remind everybody" error={errors.leadDays}>
        <Select value={leadDays} onChange={(e) => setLeadDays(e.target.value)}>
          <option value="1">1 day before</option>
          <option value="3">3 days before</option>
          <option value="7">7 days before</option>
        </Select>
      </Field>
      <Field label="Note" optional error={errors.note}>
        <Textarea rows={1} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="sm:col-span-2">
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : existing ? "Save" : "Add date"}
        </Button>
      </div>
    </form>
  );
}

export function PeopleDatesList({ items }: { items: PersonDateView[] }) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  if (!items.length) return <p className="px-5 py-4 text-sm text-muted">No dates yet. Add the first one above.</p>;
  return (
    <ul className="divide-y divide-divider">
      {items.map((p) => (
        <li key={p.id} className="px-5 py-3">
          {editing === p.id ? (
            <Card className="p-3">
              <PersonDateForm key={`${p.id}@${p.version}`} existing={p} onDone={() => setEditing(null)} />
              <Button size="sm" variant="ghost" className="mt-2" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </Card>
          ) : (
            <div className="flex items-center gap-3">
              <div className="w-[110px] flex-none text-sm">
                <div className="font-semibold text-ink">{p.daysUntil === null ? "—" : p.daysUntil === 0 ? "Today" : p.daysUntil === 1 ? "Tomorrow" : `In ${p.daysUntil} days`}</div>
                <div className="text-[12px] text-muted">{p.next ?? "Date not usable"}</div>
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-ink">
                  {p.personName}
                  {p.company ? <span className="font-normal text-muted"> · {p.company}</span> : null}
                </div>
                <div className="text-[12.5px] text-muted">
                  {p.kind === "birthday" ? "Birthday" : "Anniversary"}
                  {p.years ? ` · ${p.kind === "birthday" ? `turns ${p.years}` : `${p.years} years`}` : ""} · reminded {p.leadDays} day{p.leadDays === 1 ? "" : "s"} before · last changed by {p.updatedBy}
                  {p.note ? ` · ${p.note}` : ""}
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setEditing(p.id)}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  const res = await toast.run(deletePersonDate(p.id));
                  if (res.ok) router.refresh();
                }}
              >
                Delete
              </Button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
