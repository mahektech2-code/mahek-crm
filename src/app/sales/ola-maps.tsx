"use client";

/* ---------------------------------------------------------------------------
 * What the Live map and Territory's shop map share about Ola Maps, so the
 * two do not carry two copies of the same style URLs, the same
 * authentication mechanism and the same switcher that would drift the day
 * one of them changed.
 *
 * The key itself is NOT here — each screen's own `page.tsx` reads it once,
 * server-side, and hands it down as a prop; see `street-map.tsx`'s doc
 * comment for why that is the one credential in `app_secrets` that reaches
 * the browser at all.
 * ------------------------------------------------------------------------- */

/** Ola Maps' own default vector style. */
export const OLAMAPS_STYLE_MAP =
  "https://api.olamaps.io/tiles/vector/v1/styles/default-light-standard/style.json";

/**
 * Ola Maps' satellite style — the same roads and labels, laid over Sentinel-2
 * imagery rather than flat vector fill. Its own name in Ola's style library
 * is odd ("default-dark-standard-satellite") but the imagery is real, not a
 * dark theme with a misleading id.
 */
export const OLAMAPS_STYLE_SATELLITE =
  "https://api.olamaps.io/tiles/vector/v1/styles/default-dark-standard-satellite/style.json";

export type OlaMapsStyleMode = "map" | "satellite";

export function olaMapsStyleUrl(mode: OlaMapsStyleMode): string {
  return mode === "satellite" ? OLAMAPS_STYLE_SATELLITE : OLAMAPS_STYLE_MAP;
}

/**
 * Authenticates every request MapLibre makes against Ola Maps — style,
 * tiles, glyphs, the sprite sheet — EXCEPT images, which need no key. Read
 * out of Ola Maps' own published web SDK source rather than guessed at,
 * because a wrong guess here fails silently as a blank map with no error
 * worth reading.
 */
export function olaMapsTransformRequest(apiKey: string) {
  return (url: string, resourceType?: string) => {
    if (resourceType === "Image") return { url };
    const withKey = new URL(url);
    withKey.searchParams.append("api_key", apiKey);
    return { url: withKey.toString() };
  };
}

/**
 * Map / satellite, drawn top-left so it never sits over the NavigationControl
 * MapLibre draws top-right — the two floated at the same corner is an overlap
 * the Live map has already shipped and fixed once.
 */
export function OlaMapsStyleSwitcher({
  mode,
  onChange,
}: {
  mode: OlaMapsStyleMode;
  onChange: (mode: OlaMapsStyleMode) => void;
}) {
  return (
    <div className="absolute top-2 left-2 z-10 inline-flex overflow-hidden rounded-[4px] border border-line bg-surface shadow-[0_1px_4px_rgba(22,22,22,0.25)]">
      {(["map", "satellite"] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          className={
            "px-2.5 py-1 text-[12px] font-medium capitalize " +
            (mode === option
              ? "bg-brand-soft text-[#5223E0]"
              : "bg-surface text-body hover:bg-canvas")
          }
        >
          {option}
        </button>
      ))}
    </div>
  );
}
