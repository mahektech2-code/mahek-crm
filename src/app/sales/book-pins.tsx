"use client";

import * as maplibregl from "maplibre-gl";
import { accountTypeLabel } from "@/lib/account-types";
import { customerStatusLabel } from "@/lib/format";
import type { ShopPin } from "@/lib/services/sales-service";

/* ---------------------------------------------------------------------------
 * THE BOOK, DRAWN ON A MAP — one answer for the two screens that draw it.
 *
 * The Live map and Territory's shop map both plot the same thing underneath
 * their own subject: every account with a coordinate. They are separate
 * components for a good reason — one follows salesmen through a day, the
 * other is a static read of a territory — but WHICH COLOUR A LEAD IS is not
 * a fact either of them owns, and two copies of it drift the day somebody
 * changes one. The colours, the words and the layer paint live here.
 *
 * The three types are `lib/account-types.ts`'s three, resolved by its own
 * `accountTypeLabel` rather than by a colour expression re-deriving the rule:
 * the mark wins over the kind, so a third-party shop is a third-party shop
 * whether it is a lead or a customer underneath.
 * ------------------------------------------------------------------------- */

/** The tones a pin can carry. A string, because it rides in GeoJSON. */
export type BookPinTone = "customer" | "lead" | "third" | "closed";

/**
 * CLOSED OUTRANKS THE TYPE, and nothing else does.
 *
 * `deactivated` is the one status `recomputeInactivity` never writes — it is
 * somebody deciding an account is finished — and drawing one in the same
 * violet as a live customer is the map asserting something nobody would
 * stand behind. It is the only status that takes a colour: a DORMANT shop is
 * a live account that has stopped buying, which is `customer-health.ts`'s
 * question and not this one, and a fourth thing fighting for one glance at
 * four pixels is how none of them get read.
 */
export function bookPinTone(row: {
  kind: string;
  thirdParty: boolean;
  status?: string;
}): BookPinTone {
  if (row.status === "deactivated") return "closed";
  if (row.thirdParty) return "third";
  return row.kind === "lead" ? "lead" : "customer";
}

/**
 * Violet for an account we invoice, amber for one we are still trying to
 * sell to, teal for a shop somebody else bills.
 *
 * Violet is the brand colour and stays with the direct customer because that
 * is what Territory's map has always drawn in it — a colour that changes
 * meaning between releases is worse than a colour nobody loves. Amber and
 * teal are far enough apart in hue to survive being read at four pixels on a
 * pale street map, which is the size these are actually drawn at.
 */
/*
 * THE SAME THREE VALUES `territory/shop-map.tsx` USES, and they have to be.
 *
 * That map defines `PIN_CUSTOMER`, `PIN_LEAD` and `PIN_CLOSED` for its own
 * filter expression, and two screens disagreeing about what colour a lead is
 * drawn in is worse than either choice — a manager reading the Live map and
 * the Territory map in one afternoon would be shown one shop two ways. The
 * lead teal is taken from there rather than chosen here. Third-party is this
 * map's alone: Territory colours by kind and closedness, and has no case for
 * it, so the amber is unclaimed.
 */
export const BOOK_PIN_COLOUR: Record<BookPinTone, string> = {
  customer: "#5223E0",
  lead: "#0E7C6B",
  third: "#E07B00",
  /* The same grey a checked-out salesman's marker carries on the Live map:
     present, recorded, not live. */
  closed: "#8A8F98",
};

/** The legend's own words, and the same three the record pages use. */
export const BOOK_PIN_LABEL: Record<BookPinTone, string> = {
  customer: "Direct customers",
  lead: "Leads",
  third: "Third-party customers",
  closed: "Closed accounts",
};

/**
 * A name a pin can carry at the size a pin's label is drawn.
 *
 * The office's own names run to whole postal addresses in places, and a
 * label that long either collides with every neighbour and is dropped by the
 * renderer, or is drawn and hides the shops around it. Cut at a word
 * boundary where there is one, so "SHREE GANESH PAINTS AND HARDWARE" reads
 * as "SHREE GANESH…" rather than as "SHREE GANESH PAI…".
 */
export function shortPinName(name: string, max = 18): string {
  const clean = name.trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > 8 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * What a pin says when it is opened, as one sentence.
 *
 * The STATUS is said in words where it is not simply live, because only one
 * of the two states that are not gets a colour of its own — a dormant shop
 * is drawn exactly like a buying one, deliberately, and this is where that
 * difference is recoverable. `customerStatusLabel` is the same function the
 * customer record and the quick-view drawer print, so one account is never
 * described two ways.
 */
export function bookPinLabel(pin: ShopPin): string {
  const status = pin.status === "active" ? "" : ` · ${customerStatusLabel(pin)}`;
  return (
    `${pin.name} · ${accountTypeLabel(pin)}${status}` +
    (pin.city ? ` · ${pin.city}` : "") +
    (pin.salesmanName ? ` · ${pin.salesmanName}` : "") +
    (pin.approximate ? " · approximate, from the address" : "")
  );
}

export function bookPinFeatures(pins: ShopPin[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: pins.map((p) => ({
      type: "Feature" as const,
      properties: {
        customerId: p.id,
        tone: bookPinTone(p),
        approximate: p.approximate,
        shortName: shortPinName(p.name),
        label: bookPinLabel(p),
      },
      geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
    })),
  };
}

/** The `match` both maps paint their unclustered points with. */
export const BOOK_PIN_COLOUR_EXPRESSION = [
  "match",
  ["get", "tone"],
  "lead",
  BOOK_PIN_COLOUR.lead,
  "third",
  BOOK_PIN_COLOUR.third,
  "closed",
  BOOK_PIN_COLOUR.closed,
  BOOK_PIN_COLOUR.customer,
] as unknown as maplibregl.ExpressionSpecification;

/**
 * The book as two layers on a map that already exists: a dot per account,
 * and its name once somebody is close enough for a name to mean anything.
 *
 * **UNCLUSTERED, unlike Territory's.** That map answers "where does the book
 * sit", and a cluster bubble reading 240 answers it. This one is drawn under
 * a day's travel so a manager can see what a salesman walked PAST, and a
 * bubble cannot be walked past — the shops have to be individually there at
 * every zoom. A few thousand circles in one GeoJSON source is what MapLibre
 * is for; the radius grows with the zoom so the same source reads as a
 * density at district scale and as doorways in a market lane.
 *
 * **The label is optional in the renderer's own sense of the word.** MapLibre
 * drops a label that would collide rather than overlapping two, so a dense
 * lane shows the names it has room for and no more — which is the honest
 * behaviour: the dots are all still there, and zooming in is what buys the
 * rest of the names. `text-optional` keeps the DOT when its label is dropped,
 * which is the half that would otherwise take shops off the map.
 */
export function addBookPinLayers(
  map: maplibregl.Map,
  {
    features,
    visible,
    beforeId,
  }: {
    features: GeoJSON.FeatureCollection;
    visible: boolean;
    /** What to draw this beneath, where the map has a subject of its own. */
    beforeId?: string;
  },
) {
  map.addSource("book", { type: "geojson", data: features });

  map.addLayer(
    {
      id: "book-points",
      type: "circle",
      source: "book",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 2, 11, 3.2, 14, 5, 17, 7],
        /* Hollow where the pin was looked up from an address rather than
           captured in the doorway — the same rule, and the same reason, as
           Territory's map and the Live map's stale activity fix: a guess
           drawn identically to a measurement is a guess presented as one. */
        "circle-color": [
          "case",
          ["get", "approximate"],
          "#FFFFFF",
          BOOK_PIN_COLOUR_EXPRESSION,
        ] as unknown as maplibregl.ExpressionSpecification,
        "circle-stroke-width": 1.5,
        "circle-stroke-color": BOOK_PIN_COLOUR_EXPRESSION,
        /* Soft, because this is the ground a day is read against and not the
           day itself. Solid dots under a trail turn the route into the thing
           joining them. */
        "circle-opacity": 0.85,
      },
    },
    beforeId,
  );

  map.addLayer(
    {
      id: "book-labels",
      type: "symbol",
      source: "book",
      /* A name is worth ink only once the map is at street scale. Above this
         the labels are a grey fog over the whole district and the dots —
         which are the thing being read at that zoom — disappear underneath
         them. */
      minzoom: 13.5,
      layout: {
        "text-field": ["get", "shortName"],
        "text-size": 10,
        "text-anchor": "top",
        "text-offset": [0, 0.7],
        "text-optional": true,
        "text-max-width": 9,
      },
      paint: {
        "text-color": "#3A3F47",
        /* The halo is what makes 10px type readable over a street map at
           all — without it a label lands on a road casing and is gone. */
        "text-halo-color": "#FFFFFF",
        "text-halo-width": 1.4,
      },
    },
    beforeId,
  );

  setBookPinsVisible(map, visible);
}

export function setBookPinsVisible(map: maplibregl.Map, visible: boolean) {
  for (const id of ["book-points", "book-labels"]) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    }
  }
}

/** One swatch and its count, the shape both maps' legends are built from. */
export function BookPinSwatch({ tone }: { tone: BookPinTone }) {
  return (
    <span
      className="inline-block h-2.5 w-2.5 rounded-full"
      style={{ background: BOOK_PIN_COLOUR[tone] }}
    />
  );
}

/** How many of each type are in a set of pins, for the legend to say so. */
export function countByTone(pins: ShopPin[]): Record<BookPinTone, number> {
  const counts: Record<BookPinTone, number> = { customer: 0, lead: 0, third: 0, closed: 0 };
  for (const p of pins) counts[bookPinTone(p)] += 1;
  return counts;
}
