"use client";

import * as React from "react";
import { Modal } from "@/components/ui/modal";
import { Button, Pill } from "@/components/console/parts";
import { cx } from "@/components/ui/primitives";
import { plural } from "@/components/console/words";
import type { DocumentPerson } from "@/lib/services/sales-service";

/**
 * WHO A DOCUMENT IS FOR, PICKED BY NAME.
 *
 * The field team is a few dozen people, and the question asked of this list is
 * always "find Rahul", so the search reads names and nothing else — matching a
 * city as well turns "Pune" into every salesman who ever covered it, which is
 * not what anybody typing a name meant. The city is still SHOWN under each
 * name, because two Rahuls are told apart by where they work.
 *
 * Ticking nobody is an answer, not an error: it means everybody in the field,
 * which is what an untagged document has always meant. The footer says which
 * of the two it is before anything is saved.
 *
 * Mounted only while open, so it starts from what is saved every time rather
 * than from whatever somebody ticked and abandoned last time.
 */
export function TagPeopleModal({
  title,
  people,
  initial,
  extra,
  busy,
  error,
  confirmLabel = "Save",
  onClose,
  onSave,
}: {
  /** What is being tagged — the document's title. */
  title: string;
  people: DocumentPerson[];
  initial: readonly string[];
  /**
   * People already tagged who are no longer offered — taken off the field
   * since. Kept ticked and named, so saving does not quietly drop somebody the
   * manager never saw, and untickable, so they can be dropped deliberately.
   */
  extra?: { id: string; name: string; initials: string }[];
  busy?: boolean;
  error?: string | null;
  confirmLabel?: string;
  onClose: () => void;
  onSave: (userIds: string[]) => void;
}) {
  const [picked, setPicked] = React.useState<Set<string>>(() => new Set(initial));
  const [query, setQuery] = React.useState("");

  const everyone = React.useMemo(() => {
    const offered = new Set(people.map((p) => p.id));
    const gone = (extra ?? [])
      .filter((p) => !offered.has(p.id))
      .map((p) => ({ ...p, places: "No longer on the field app" as string | null }));
    return [...people, ...gone];
  }, [people, extra]);

  const needle = query.trim().toLowerCase();
  const shown = needle ? everyone.filter((p) => p.name.toLowerCase().includes(needle)) : everyone;
  const shownPicked = shown.filter((p) => picked.has(p.id)).length;

  function toggle(id: string) {
    setPicked((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function setShown(on: boolean) {
    setPicked((was) => {
      const next = new Set(was);
      for (const p of shown) {
        if (on) next.add(p.id);
        else next.delete(p.id);
      }
      return next;
    });
  }

  /* In roster order, so the saved list reads the way the screen did. */
  const chosen = everyone.filter((p) => picked.has(p.id));

  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title={
        <span className="block">
          Tag employees
          <span className="mt-0.5 block truncate text-[13px] font-normal text-muted">{title}</span>
        </span>
      }
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-[13px] text-muted">
            {chosen.length === 0 ? (
              <>
                Nobody ticked — <span className="font-medium text-body">everybody in the field</span>{" "}
                will see it.
              </>
            ) : (
              <>
                Only <span className="font-medium text-body">{plural(chosen.length, "person", "people")}</span>{" "}
                will see it.
              </>
            )}
          </span>
          <span className="flex gap-2">
            <Button tone="quiet" onClick={onClose}>
              Cancel
            </Button>
            <Button
              tone="primary"
              disabled={busy}
              title={busy ? "Saving." : undefined}
              onClick={() => onSave(chosen.map((p) => p.id))}
            >
              {busy ? "Saving…" : confirmLabel}
            </Button>
          </span>
        </div>
      }
    >
      <p className="mb-3 text-[13px] text-muted">
        Tick who should find this in Documents on their handset. It leaves the phones of anybody you
        untick on their next sync.
      </p>

      <div className="mb-2 flex items-center gap-2">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name"
          aria-label="Search by name"
          className="h-9 min-w-0 flex-1 rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
        />
        <Button
          size="sm"
          disabled={shown.length === 0 || shownPicked === shown.length}
          title={
            shown.length === 0
              ? "Nobody matches the search."
              : shownPicked === shown.length
                ? "Everybody shown is already ticked."
                : undefined
          }
          onClick={() => setShown(true)}
        >
          {needle ? "Tick these" : "Tick all"}
        </Button>
        <Button
          size="sm"
          tone="quiet"
          disabled={shownPicked === 0}
          title={shownPicked === 0 ? "Nobody shown is ticked." : undefined}
          onClick={() => setShown(false)}
        >
          Clear
        </Button>
      </div>

      {chosen.length ? (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {chosen.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => toggle(p.id)}
              title={`Untag ${p.name}`}
              className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[14px] border border-brand bg-brand-soft pr-2 pl-1 text-[12px] font-medium text-[#5223E0] hover:bg-surface"
            >
              <Initials initials={p.initials} small />
              {p.name}
              <span aria-hidden className="text-[14px] leading-none">
                ×
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="max-h-[320px] overflow-y-auto rounded-[6px] border border-line">
        {shown.length === 0 ? (
          <p className="px-3 py-6 text-center text-[13px] text-muted">
            {everyone.length === 0
              ? "Nobody holds the field app yet, so there is nobody to tag. Grant it on the Access screen first."
              : `Nobody in the field is called “${query.trim()}”.`}
          </p>
        ) : (
          shown.map((p, i) => {
            const on = picked.has(p.id);
            return (
              <label
                key={p.id}
                className={cx(
                  "flex cursor-pointer items-center gap-3 px-3 py-2",
                  i > 0 ? "border-t border-divider" : "",
                  on ? "bg-brand-soft/40" : "hover:bg-canvas",
                )}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(p.id)}
                  className="h-4 w-4 flex-none accent-[#6835FB]"
                />
                <Initials initials={p.initials} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{p.name}</span>
                  <span className="block truncate text-[12px] text-muted">
                    {p.places || "No area allocated"}
                  </span>
                </span>
              </label>
            );
          })
        )}
      </div>

      {error ? <p className="mt-3 text-[13px] text-danger">{error}</p> : null}
    </Modal>
  );
}

export function Initials({ initials, small }: { initials: string; small?: boolean }) {
  return (
    <span
      aria-hidden
      className={cx(
        "inline-flex flex-none items-center justify-center rounded-full bg-divider font-semibold text-body",
        small ? "h-5 w-5 text-[9px]" : "h-7 w-7 text-[11px]",
      )}
    >
      {initials || "?"}
    </span>
  );
}

/**
 * Who a document reaches, said in one line: "Everybody in the field", or a
 * count and the first names. Used in the table so the column and the drawer
 * cannot phrase one list two ways; the full list rides on the hover.
 */
export function AudienceLine({
  tagged,
  max = 2,
}: {
  tagged: { id: string; name: string; initials: string }[];
  max?: number;
}) {
  if (tagged.length === 0) return <span className="text-muted">Everybody in the field</span>;
  const named = tagged.slice(0, max).map((p) => p.name);
  const rest = tagged.length - named.length;
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-2" title={tagged.map((p) => p.name).join(", ")}>
      <Pill tone="brand">{plural(tagged.length, "person", "people")}</Pill>
      <span className="truncate">
        {named.join(", ")}
        {rest > 0 ? ` +${rest}` : ""}
      </span>
    </span>
  );
}
