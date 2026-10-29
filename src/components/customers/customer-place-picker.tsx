"use client";

import * as React from "react";
import { Field, Input, Select } from "@/components/ui/primitives";
import { placeKey, type PlaceKind } from "@/lib/place-parse";
import { lookup, placeChoices, rungName, setRung, unlistedStates, type PlaceOption, type PlacePick } from "@/lib/erp/transporter-godowns";

/* ---------------------------------------------------------------------------
 * WHERE THE SHOP IS — State, District, City, Area on the reviewed place tree.
 *
 * State and district are dropdowns: a short list somebody reads. City and area
 * are a box that SEARCHES the places under the rung above as you type and
 * takes a name that is not listed — it is added to the tree on save, under the
 * rung above, so the next shop in that area finds it. Changing a rung clears
 * the rungs below it, because they were picked under the old one.
 *
 * The rules (which rungs are required, what may be added) are
 * `lib/customer-place.ts`, run again by the save.
 * ------------------------------------------------------------------------- */

const LABEL: Record<PlaceKind, string> = { state: "State", district: "District", city: "City", area: "Area" };

export function CustomerPlacePicker({
  tree,
  pick,
  onChange,
  error,
}: {
  tree: PlaceOption[];
  pick: PlacePick;
  onChange: (next: PlacePick) => void;
  /** The rung the last check refused, and why. */
  error?: { kind: PlaceKind; message: string } | null;
}) {
  const byId = React.useMemo(() => lookup(tree), [tree]);
  const err = (k: PlaceKind) => (error?.kind === k ? error.message : null);
  const extraStates = React.useMemo(() => unlistedStates(tree), [tree]);
  const stateValue = pick.state?.id ?? (pick.state?.name ? `state:${pick.state.name}` : "");

  return (
    <>
      <Field label="State · required" error={err("state")}>
        <Select
          value={stateValue}
          onChange={(e) => {
            const v = e.target.value;
            onChange(setRung(pick, "state", !v ? null : v.startsWith("state:") ? { name: v.slice(6) } : { id: v }));
          }}
        >
          <option value="">Pick a state</option>
          {placeChoices(tree, "state", pick).map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
          {extraStates.length ? (
            <optgroup label="Rest of the country">
              {extraStates.map((s) => (
                <option key={s} value={`state:${s}`}>
                  {s}
                </option>
              ))}
            </optgroup>
          ) : null}
        </Select>
      </Field>
      <DistrictField tree={tree} pick={pick} byId={byId} onChange={onChange} error={err("district")} />
      <SearchAddField kind="city" required tree={tree} pick={pick} byId={byId} onChange={onChange} error={err("city")} />
      <SearchAddField kind="area" tree={tree} pick={pick} byId={byId} onChange={onChange} error={err("area")} />
    </>
  );
}

/** A dropdown of the districts under the state, ending with "+ Add a district not listed". */
function DistrictField({
  tree,
  pick,
  byId,
  onChange,
  error,
}: {
  tree: PlaceOption[];
  pick: PlacePick;
  byId: ReturnType<typeof lookup>;
  onChange: (p: PlacePick) => void;
  error: string | null;
}) {
  const above = pick.state;
  const rung = pick.district;
  const typing = !!above && (!above.id || (!!rung && !rung.id));
  if (typing)
    return (
      <Field label="District · required" error={error} hint={`New — added under ${rungName(above, byId) ?? "the state"} when you save.`}>
        <span className="flex gap-1.5">
          <Input
            value={rung?.name ?? ""}
            onChange={(e) => onChange(setRung(pick, "district", { name: e.target.value }))}
            placeholder="Type the district's name"
            autoFocus={!!above.id}
          />
          {above.id ? (
            <button
              type="button"
              className="shrink-0 rounded-[4px] px-2 text-[12px] text-brand hover:underline"
              onClick={() => onChange(setRung(pick, "district", null))}
            >
              Pick from list
            </button>
          ) : null}
        </span>
      </Field>
    );
  const opts = placeChoices(tree, "district", pick);
  return (
    <Field label="District · required" error={error}>
      <Select
        value={rung?.id ?? ""}
        disabled={!above}
        onChange={(e) => {
          const v = e.target.value;
          onChange(setRung(pick, "district", v === "__add" ? { name: "" } : v ? { id: v } : null));
        }}
      >
        <option value="">{above ? "Pick a district" : "Pick the state first"}</option>
        {opts.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
        {above ? <option value="__add">+ Add a district not listed…</option> : null}
      </Select>
    </Field>
  );
}

/**
 * A box that searches the places of its kind under the rung above and takes a
 * name that is not listed. A typed name that matches a listed one IS that one.
 */
function SearchAddField({
  kind,
  required = false,
  tree,
  pick,
  byId,
  onChange,
  error,
}: {
  kind: "city" | "area";
  required?: boolean;
  tree: PlaceOption[];
  pick: PlacePick;
  byId: ReturnType<typeof lookup>;
  onChange: (p: PlacePick) => void;
  error: string | null;
}) {
  const aboveKind: PlaceKind = kind === "city" ? "district" : "city";
  const above = pick[aboveKind];
  const rung = pick[kind];
  const opts = placeChoices(tree, kind, pick);
  const listId = React.useId();
  const shown = rung?.id ? (byId.get(rung.id)?.name ?? "") : (rung?.name ?? "");
  const isNew = !!rung && !rung.id && !!(rung.name ?? "").trim();
  const label = `${LABEL[kind]}${required ? " · required" : ""}`;

  return (
    <Field
      label={label}
      error={error}
      hint={
        !above
          ? undefined
          : isNew
            ? `New — added under ${rungName(above, byId) ?? `the ${aboveKind}`} when you save.`
            : opts.length
              ? `Type to search ${opts.length} ${kind === "city" ? "cities" : "areas"}, or type a new one.`
              : `None listed yet — type the ${kind}'s name to add it.`
      }
    >
      <Input
        value={shown}
        disabled={!above}
        list={listId}
        placeholder={above ? `Search or add a${kind === "area" ? "n area" : " city"}` : `Pick the ${aboveKind} first`}
        onChange={(e) => {
          const text = e.target.value;
          const match = opts.find((o) => placeKey(o.name) === placeKey(text));
          onChange(setRung(pick, kind, match ? { id: match.id } : text ? { name: text } : null));
        }}
      />
      <datalist id={listId}>
        {opts.map((o) => (
          <option key={o.id} value={o.name} />
        ))}
      </datalist>
    </Field>
  );
}
