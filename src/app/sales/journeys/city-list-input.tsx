"use client";

import * as React from "react";
import { ComboBox } from "@/components/ui/combo-box";
import { Button } from "@/components/console/parts";
import { cityKey } from "@/lib/city-match";
import { normaliseCities } from "@/lib/journey-cities";

/* ---------------------------------------------------------------------------
 * ONE OR MORE CITIES FOR A JOURNEY DAY — chips, and a box to add another.
 *
 * A day used to be one city, picked or typed into a single `ComboBox`. The
 * office can now name several, and this is that control: the cities chosen so
 * far sit as chips (the first is the PRIMARY one — the one a handset filters its
 * shop list by — and says so once there are several), and a `ComboBox` beside
 * them adds the next.
 *
 * **FREE TEXT IS KEPT**, for the reason `ComboBox` gives: `customers.city` is
 * whatever the sheet typed, so the cities offered are a shortcut past typing and
 * never a constraint — proposing a town nobody has sold in yet is an ordinary
 * Tuesday. A city is added with the Add button or by pressing Enter once the
 * list has closed; picking a row from the list fills the box and Add commits it.
 *
 * One city behaves as the single box always did: one chip, removable, and the
 * same `onChange` with a one-element list.
 * ------------------------------------------------------------------------- */

export function CityListInput({
  value,
  onChange,
  options,
  disabled,
  label,
  placeholder = "Propose a city",
  emptyHint,
  title,
  className,
}: {
  /** The cities chosen so far, in order — the first is the primary. */
  value: string[];
  onChange: (next: string[]) => void;
  /** What his book names — a shortcut, never a constraint. */
  options: string[];
  disabled?: boolean;
  label: string;
  placeholder?: string;
  emptyHint?: string;
  title?: string;
  className?: string;
}) {
  const [draft, setDraft] = React.useState("");

  /* A city already chosen is not offered again. */
  const chosen = new Set(value.map((c) => cityKey(c)));
  const offered = options.filter((o) => !chosen.has(cityKey(o)));

  const next = normaliseCities(value, draft);
  const canAdd = !disabled && draft.trim() !== "" && next.length > value.length;

  function add() {
    if (!canAdd) return;
    onChange(next);
    setDraft("");
  }

  function remove(city: string) {
    onChange(value.filter((c) => cityKey(c) !== cityKey(city)));
  }

  return (
    <div
      className={"flex flex-wrap items-center gap-1.5 " + (className ?? "")}
      title={title}
      onBlur={(e) => {
        /* Leaving the control with a city typed and not yet added adds it — so typing
           a city and pressing Propose still proposes it, exactly as the single box
           always did. A move to the Add button (inside) or the list (which keeps
           focus on the field) is not leaving. */
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        add();
      }}
      onKeyDown={(e) => {
        /* `ComboBox` swallows Enter while its list is open (it closes the list);
           once it is closed the same key adds what is typed. */
        if (e.key === "Enter" && !e.defaultPrevented && canAdd) {
          e.preventDefault();
          add();
        }
      }}
    >
      {value.map((city, i) => (
        <span
          key={cityKey(city)}
          className="inline-flex h-7 max-w-full items-center gap-1 rounded-[4px] border border-brand bg-brand-soft pr-1 pl-2 text-[12px] font-medium text-brand-hover"
        >
          <span className="truncate">{city}</span>
          {i === 0 && value.length > 1 ? (
            <span
              className="text-[10px] font-normal text-brand-hover/70"
              title="The first city is the primary one — the one a handset filters its shop list by."
            >
              first
            </span>
          ) : null}
          <button
            type="button"
            disabled={disabled}
            onClick={() => remove(city)}
            aria-label={`Take off ${city}`}
            title={`Take off ${city}`}
            className="flex size-5 items-center justify-center rounded-[3px] text-brand-hover/70 hover:bg-[#5223E0]/10 hover:text-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            ×
          </button>
        </span>
      ))}

      <ComboBox
        value={draft}
        options={offered}
        onChange={setDraft}
        onCommit={(picked) => {
          /* A row picked from the list is added at once. */
          onChange(normaliseCities(value, picked));
          setDraft("");
        }}
        disabled={disabled}
        label={label}
        placeholder={value.length ? "Add another city" : placeholder}
        emptyHint={emptyHint}
        className="w-[190px] flex-none"
      />
      <Button size="sm" tone="quiet" disabled={!canAdd} onClick={add} title="Add this city to the day">
        Add
      </Button>
    </div>
  );
}
