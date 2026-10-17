"use client";

import { MultiSelect } from "@/components/ui/multi-select";
import {
  PLACE_FILTER_KINDS,
  PLACE_FILTER_LABELS,
  placePickPatch,
  type PlaceFilterOptions,
  type PlaceFilterValues,
} from "@/lib/place-filters";
import { placeLine } from "@/lib/place-tree";
import type { PlaceKind } from "@/lib/place-parse";

const PLACEHOLDER: Record<PlaceKind, string> = {
  state: "All states",
  district: "All districts",
  city: "All cities",
  area: "All areas",
};

/**
 * State, district, city and area as four dropdowns — the one control every
 * list of shops narrows by place with. Picking a rung narrows the options
 * below it (the server counts them under the pick) and clears any pick below
 * it that no longer applies; see `placePickPatch`.
 */
export function PlaceFilterSelects({
  options,
  values,
  onChange,
  className,
}: {
  options: PlaceFilterOptions;
  values: PlaceFilterValues;
  onChange: (patch: Partial<Record<PlaceKind, string | undefined>>) => void;
  className?: string;
}) {
  const asList = (v: string | undefined) => (v ? v.split(",").filter(Boolean) : []);
  return (
    <>
      {PLACE_FILTER_KINDS.map((kind) => (
        <MultiSelect
          key={kind}
          label={PLACE_FILTER_LABELS[kind]}
          placeholder={PLACEHOLDER[kind]}
          options={options[kind]}
          selected={asList(values[kind])}
          onChange={(next) => onChange(placePickPatch(kind, next))}
          className={className}
        />
      ))}
    </>
  );
}

/**
 * Where a shop is, in a table cell: "Kandivali West, Mumbai" on the first
 * line and the district and state under it. Falls back to what the sheet
 * typed where the tree has not placed the shop, and says so on hover.
 */
export function PlaceCell({
  place,
  typed,
}: {
  place: { state: string | null; district: string | null; city: string | null; area: string | null } | null | undefined;
  typed?: string | null;
}) {
  if (!place || !place.state) {
    return typed ? (
      <span className="text-muted" title="Not yet placed on the location tree — this is what the sheet typed">
        {typed}
      </span>
    ) : (
      <span className="text-muted">—</span>
    );
  }
  const near = placeLine({ city: place.city, area: place.area });
  const wider = placeLine({
    district: place.district && place.district !== place.city ? place.district : null,
    state: place.state,
  });
  return (
    <span title={placeLine(place)}>
      <span className="block">{near || place.state}</span>
      {near ? <span className="block text-xs text-muted">{wider}</span> : null}
    </span>
  );
}
