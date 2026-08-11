"use client";

import * as React from "react";

/* ---------------------------------------------------------------------------
 * Picking a person.
 *
 * ONE control, not two. A dropdown is faster than a search box while the list
 * is short, and slower the moment it is not — scrolling ninety names to find a
 * colleague mid-task is how the wrong one gets picked. But building a
 * `<select>` for small teams and a combobox for large ones means two
 * components, two behaviours and two sets of bugs, and the day the company
 * hires its eleventh salesperson somebody has to notice and swap them.
 *
 * So it is always the same searchable list, and the only thing the threshold
 * decides is whether the search field takes focus when it opens. Under it, the
 * list is right there to click. Over it, typing is already working.
 *
 * `threshold` is `people.pickerSearchThreshold` — configuration, because "how
 * many is too many to read" is exactly the sort of number a manager should be
 * able to change without a deploy.
 * ------------------------------------------------------------------------- */

export type Person = { id: string; name: string; role?: string };

export function PersonPicker({
  people,
  value,
  onChange,
  threshold = 10,
  allowUnassigned = false,
  label,
  placeholder = "Search by name",
  disabled = false,
}: {
  people: Person[];
  /** `null` is a real answer — unassigned — and distinct from "not chosen". */
  value: string | null | undefined;
  onChange: (id: string | null) => void;
  threshold?: number;
  allowUnassigned?: boolean;
  label: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [term, setTerm] = React.useState("");
  const searchLeads = people.length > threshold;

  const matches = React.useMemo(() => {
    const t = term.trim().toLowerCase();
    if (!t) return people;
    // Name only, and substring rather than prefix: people are searched for by
    // the part of the name the searcher remembers, which is often not the
    // start of it.
    return people.filter((p) => p.name.toLowerCase().includes(t));
  }, [people, term]);

  const chosen = value ? people.find((p) => p.id === value) : null;

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[11px] tracking-wide text-muted uppercase">{label}</span>
        {chosen ? (
          <span className="text-[12px] text-ink">{chosen.name}</span>
        ) : value === null ? (
          <span className="text-[12px] text-muted">Unassigned</span>
        ) : null}
      </div>

      {searchLeads ? (
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          // Focused only where the list is too long to read, which is the
          // whole of what the threshold decides.
          autoFocus
          className="mb-1.5 h-8 w-full rounded-[4px] border border-line px-2.5 text-sm outline-none focus:border-brand"
        />
      ) : null}

      <div className="max-h-52 overflow-y-auto rounded-[4px] border border-line">
        {allowUnassigned ? (
          <Option
            selected={value === null}
            onClick={() => onChange(null)}
            disabled={disabled}
          >
            <span className="text-muted">Leave unassigned</span>
          </Option>
        ) : null}

        {matches.map((p) => (
          <Option
            key={p.id}
            selected={value === p.id}
            onClick={() => onChange(p.id)}
            disabled={disabled}
          >
            {p.name}
            {p.role ? <span className="ml-1.5 text-[11px] text-muted">{p.role}</span> : null}
          </Option>
        ))}

        {/* Three different silences, said apart. "Nobody matched what you
            typed" and "there is nobody to pick" send a person to different
            places, and one message for both sends them to neither. */}
        {!matches.length && people.length ? (
          <p className="px-2.5 py-3 text-[13px] text-muted">
            Nobody here matches “{term.trim()}”.
          </p>
        ) : null}
        {!people.length ? (
          <p className="px-2.5 py-3 text-[13px] text-muted">
            There is nobody with an account to assign this to.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Option({
  selected,
  onClick,
  disabled,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={`block w-full cursor-pointer border-b border-line px-2.5 py-2 text-left text-[13px] last:border-b-0 disabled:cursor-not-allowed ${
        selected ? "bg-brand/10 text-ink" : "text-ink hover:bg-canvas"
      }`}
    >
      {children}
    </button>
  );
}
