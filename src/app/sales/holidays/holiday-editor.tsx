"use client";

import * as React from "react";
import { Modal } from "@/components/ui/modal";
import { cx } from "@/components/ui/primitives";
import { Button } from "@/components/console/parts";
import { SalesIcon } from "@/components/console/icons";
import { previewHolidayAudience, saveHoliday, searchHolidayPlaces } from "@/lib/actions/sales";
import {
  HOLIDAY_CATEGORIES,
  HOLIDAY_LEVELS,
  HOLIDAY_LEVEL_LABEL,
  placeKindFor,
  type HolidayLevel,
} from "@/lib/engines/holiday-audience";
import type { HolidayEntry, HolidayPersonRow, HolidayPlace } from "@/lib/services/holiday-service";

/**
 * ADDING OR CHANGING ONE HOLIDAY — the date, what it is, and who gets it.
 *
 * Who gets it is three answers that combine: a LEVEL and the places it names
 * (everybody allocated Odisha), people GIVEN it on top (a man whose family
 * festival it is), and people it is TAKEN FROM (somebody covering a market
 * that stays open). The preview underneath runs the same engine the server
 * saves with, so the count on the button is the count that gets the day.
 *
 * Remounted per holiday by its `key`, so it opens on that holiday's answers
 * rather than resetting state in an effect.
 */
export function HolidayEditor({
  open,
  editing,
  defaultDate,
  people,
  states,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: HolidayEntry | null;
  defaultDate: string;
  people: HolidayPersonRow[];
  states: HolidayPlace[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [onDate, setOnDate] = React.useState(editing?.onDate ?? defaultDate);
  const [name, setName] = React.useState(editing?.name ?? "");
  const [category, setCategory] = React.useState(editing?.category ?? "Festival");
  const [level, setLevel] = React.useState<HolidayLevel>(editing?.level ?? "company");
  const [places, setPlaces] = React.useState<HolidayPlace[]>(editing?.places ?? []);
  const [include, setInclude] = React.useState<string[]>(editing?.include.map((a) => a.userId) ?? []);
  const [exclude, setExclude] = React.useState<string[]>(editing?.exclude.map((a) => a.userId) ?? []);
  const [note, setNote] = React.useState(editing?.note ?? "");
  const [notify, setNotify] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<{ id: string; name: string; reasons: string[] }[] | null>(null);

  const kind = placeKindFor(level);
  const chosen = places.filter((p) => p.kind === kind);

  /* The preview, a moment after the answers stop moving. */
  const ruleKey = JSON.stringify([level, chosen.map((p) => p.id), include, exclude]);
  React.useEffect(() => {
    if (!open) return;
    let live = true;
    const t = setTimeout(async () => {
      const r = await previewHolidayAudience({ level, placeIds: chosen.map((p) => p.id), include, exclude });
      if (live && r.ok) setPreview(r.data);
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `ruleKey` is the whole of what the preview depends on
  }, [ruleKey, open]);

  function pickLevel(next: HolidayLevel) {
    setLevel(next);
    /* A place of another rung means nothing at this level; keep only what still fits. */
    setPlaces((ps) => ps.filter((p) => p.kind === placeKindFor(next)));
  }

  async function save() {
    setBusy(true);
    setError(null);
    let r;
    try {
      r = await saveHoliday({
        id: editing?.id ?? null,
        onDate,
        name,
        category,
        level,
        placeIds: chosen.map((p) => p.id),
        include,
        exclude,
        note,
        notify,
      });
    } finally {
      setBusy(false);
    }
    if (!r.ok) {
      setError(r.error);
      return;
    }
    onSaved(r.message ?? "Saved.");
  }

  const missing = !onDate
    ? "Pick the date."
    : !name.trim()
      ? "Give the holiday a name."
      : kind && !chosen.length
        ? `Pick at least one ${kind}.`
        : level === "people" && !include.length
          ? "Name at least one person."
          : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={760}
      title={editing ? `Edit ${editing.name}` : "Add a holiday"}
      footer={
        <>
          <label className="mr-auto flex items-center gap-2 text-[13px] text-body">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
            Tell the people it reaches on their phones
          </label>
          <Button tone="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button tone="primary" disabled={busy || !!missing} title={missing ?? undefined} onClick={() => void save()}>
            {busy ? "Saving…" : editing ? "Save changes" : "Add the holiday"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-[160px_1fr_160px] gap-3">
          <Field label="Date">
            <input type="date" value={onDate} onChange={(e) => setOnDate(e.target.value)} className={INPUT} />
          </Field>
          <Field label="What it is">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Raja Parba" maxLength={120} className={INPUT} />
          </Field>
          <Field label="Kind of day">
            <select value={category} onChange={(e) => setCategory(e.target.value)} className={INPUT}>
              {HOLIDAY_CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Who it is for">
          <div className="flex flex-wrap gap-1.5">
            {HOLIDAY_LEVELS.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => pickLevel(l)}
                className={cx(
                  "h-8 cursor-pointer rounded-[4px] border px-3 text-[13px]",
                  level === l ? "border-brand bg-brand-soft font-medium text-[#5223E0]" : "border-line bg-surface text-body hover:border-brand",
                )}
              >
                {HOLIDAY_LEVEL_LABEL[l]}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[12px] text-muted">{LEVEL_HELP[level]}</p>
        </Field>

        {kind === "state" ? (
          <Field label={`States (${chosen.length} picked)`}>
            <div className="grid max-h-[180px] grid-cols-3 gap-x-3 gap-y-1 overflow-y-auto rounded-[4px] border border-line p-2">
              {states.map((s) => {
                const on = chosen.some((c) => c.id === s.id);
                return (
                  <label key={s.id} className="flex items-center gap-2 text-[13px] text-ink">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => setPlaces((ps) => (on ? ps.filter((p) => p.id !== s.id) : [...ps, s]))}
                    />
                    {s.label}
                  </label>
                );
              })}
            </div>
          </Field>
        ) : kind ? (
          <PlaceSearch kind={kind} chosen={chosen} onChange={setPlaces} />
        ) : null}

        <div className="rounded-[6px] border border-line bg-canvas px-3 py-2.5">
          <div className="text-[13px] font-medium text-ink">
            {preview === null
              ? "Working out who it reaches…"
              : `Reaches ${preview.length} of ${people.length} ${people.length === 1 ? "person" : "people"} on your team`}
          </div>
          {preview && preview.length ? (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {preview.map((p) => (
                <span key={p.id} title={p.reasons.join(" · ")} className="rounded-[9px] bg-surface px-2 py-0.5 text-[12px] text-body ring-1 ring-line">
                  {p.name} <span className="text-muted">· {p.reasons.join(", ")}</span>
                </span>
              ))}
            </div>
          ) : preview ? (
            <p className="mt-1 text-[12px] text-muted">
              Nobody on your team works where this is. It is still saved — anybody allocated there later gets it.
            </p>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <PeoplePicker
            label={level === "people" ? "The people it is for" : "Also give it to"}
            hint={level === "people" ? undefined : "Somebody the place does not reach — their own festival, family in that state."}
            people={people}
            selected={include}
            disabled={exclude}
            onChange={setInclude}
          />
          <PeoplePicker
            label="Not for"
            hint="Taken away whatever the level says — covering a market that stays open."
            people={people}
            selected={exclude}
            disabled={include}
            onChange={setExclude}
          />
        </div>

        <Field label="Note (optional)">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Shown with the holiday — why, or what to do instead" maxLength={300} className={INPUT} />
        </Field>

        {editing?.typedScope ? (
          <p className="rounded-[4px] bg-warn-soft px-3 py-2 text-[13px] text-warn-ink">
            Before levels existed this was typed as “{editing.typedScope}”. It has been read as company-wide — pick the level it really is.
          </p>
        ) : null}

        {error ? <p className="text-[13px] text-danger">{error}</p> : null}
      </div>
    </Modal>
  );
}

const INPUT = "h-8.5 w-full rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand";

const LEVEL_HELP: Record<HolidayLevel, string> = {
  company: "Everybody in the company, wherever they work.",
  state: "Everybody allocated a state, or a city or area inside it.",
  district: "Everybody allocated a city or area inside the district.",
  city: "Everybody allocated the city, or an area inside it.",
  area: "Everybody allocated that area (beat).",
  people: "Only the people you name — a community's festival, a special day.",
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{label}</span>
      {children}
    </div>
  );
}

/** A district, city or area, found by typing — the tree is thousands of places. */
function PlaceSearch({
  kind,
  chosen,
  onChange,
}: {
  kind: string;
  chosen: HolidayPlace[];
  onChange: (fn: (ps: HolidayPlace[]) => HolidayPlace[]) => void;
}) {
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<HolidayPlace[] | null>(null);

  React.useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      const r = await searchHolidayPlaces(kind, query);
      if (live && r.ok) setResults(r.data);
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [kind, query]);

  return (
    <Field label={`${kind[0].toUpperCase()}${kind.slice(1)}s (${chosen.length} picked)`}>
      {chosen.length ? (
        <div className="mb-2 flex flex-wrap gap-1">
          {chosen.map((p) => (
            <span key={p.id} className="inline-flex items-center gap-1 rounded-[9px] bg-brand-soft px-2 py-0.5 text-[12px] text-[#5223E0]">
              {p.label}
              <button
                type="button"
                aria-label={`Remove ${p.label}`}
                onClick={() => onChange((ps) => ps.filter((x) => x.id !== p.id))}
                className="cursor-pointer"
              >
                <SalesIcon name="close" size={11} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${kind}s by name`} className={INPUT} />
      <div className="mt-1 max-h-[150px] overflow-y-auto rounded-[4px] border border-line">
        {results === null ? (
          <p className="px-2 py-1.5 text-[12px] text-muted">Searching…</p>
        ) : results.length === 0 ? (
          <p className="px-2 py-1.5 text-[12px] text-muted">No {kind} by that name on the place tree.</p>
        ) : (
          results.map((p) => {
            const on = chosen.some((c) => c.id === p.id);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onChange((ps) => (on ? ps.filter((x) => x.id !== p.id) : [...ps, p]))}
                className={cx("flex w-full cursor-pointer items-center justify-between px-2 py-1 text-left text-[13px] hover:bg-canvas", on ? "text-[#5223E0]" : "text-ink")}
              >
                {p.label}
                {on ? <SalesIcon name="tick" size={13} /> : null}
              </button>
            );
          })
        )}
      </div>
    </Field>
  );
}

function PeoplePicker({
  label,
  hint,
  people,
  selected,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  people: HolidayPersonRow[];
  selected: string[];
  /** Picked in the other list — one person cannot be both given and refused a day. */
  disabled: string[];
  onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = React.useState("");
  const shown = people.filter((p) => !query.trim() || `${p.name} ${p.where}`.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <Field label={`${label} (${selected.length})`}>
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your team" className={INPUT} />
      <div className="mt-1 max-h-[150px] overflow-y-auto rounded-[4px] border border-line">
        {shown.length === 0 ? (
          <p className="px-2 py-1.5 text-[12px] text-muted">Nobody by that name on your team.</p>
        ) : (
          shown.map((p) => {
            const on = selected.includes(p.id);
            const blocked = disabled.includes(p.id);
            return (
              <label
                key={p.id}
                title={blocked ? "Already in the other list." : p.where || "No area allocated"}
                className={cx("flex items-center gap-2 px-2 py-1 text-[13px]", blocked ? "text-muted" : "text-ink")}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={blocked}
                  onChange={() => onChange(on ? selected.filter((x) => x !== p.id) : [...selected, p.id])}
                />
                <span className="truncate">
                  {p.name}
                  {p.where ? <span className="text-muted"> · {p.where}</span> : null}
                </span>
              </label>
            );
          })
        )}
      </div>
      {hint ? <p className="mt-1 text-[12px] text-muted">{hint}</p> : null}
    </Field>
  );
}
