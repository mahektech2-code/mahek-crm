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

/**
 * Ola's style, with the layers it declares over data it does not serve taken
 * out.
 *
 * Its published style JSON carries `3d_model_data`, a layer reading a source
 * layer called `3d_model` that its own `vectordata` source does not contain.
 * MapLibre validates every layer against its source and reports it as an
 * error on EVERY load — which reaches an app in development as a console
 * error overlay nobody can act on, since the fault is in somebody else's
 * style file.
 *
 * It is not only noise. A style carrying a layer MapLibre rejects never
 * settles, so the map's `load` event does not fire — and anything waiting on
 * `load` waits for ever. Here that was every salesman marker and the opening
 * `fitBounds`, which is why the Live map used to open on the whole of
 * Bangalore with the day's travel a few pixels wide in the middle of it. That
 * has its own belt in `street-map.tsx` (both now hang off `style.load`), and
 * this is the braces: with the bad layer gone the style is valid, `load`
 * fires, and the error stops being printed at all.
 *
 * DROPPED BY WHAT IS WRONG WITH IT, not by name. Every source-layer the
 * style's own sources advertise is collected from their TileJSON, and any
 * layer naming one that is absent goes. A second bad layer needs no change
 * here, and the day Ola ships `3d_model` for real it is kept automatically —
 * whereas a hardcoded id would go on deleting a layer that had become valid.
 *
 * Anything unreadable — the TileJSON refusing, a source with no url — leaves
 * the style EXACTLY as it came. A style we could not check is not a style to
 * start removing things from.
 */
export async function olaMapsStyle(
  mode: OlaMapsStyleMode,
  apiKey: string,
): Promise<unknown> {
  const withKey = (url: string) => {
    const u = new URL(url);
    u.searchParams.append("api_key", apiKey);
    return u.toString();
  };

  const style = (await fetch(withKey(olaMapsStyleUrl(mode))).then((r) => r.json())) as {
    sources?: Record<string, { url?: string; vector_layers?: { id: string }[] }>;
    layers?: { id: string; source?: string; "source-layer"?: string }[];
  };
  if (!style?.layers?.length || !style.sources) return style;

  /* What each source actually serves, from the source itself. */
  const served = new Map<string, Set<string>>();
  for (const [name, source] of Object.entries(style.sources)) {
    let layers = source.vector_layers;
    if (!layers && source.url) {
      try {
        const tileJson = (await fetch(withKey(source.url)).then((r) => r.json())) as {
          vector_layers?: { id: string }[];
        };
        layers = tileJson.vector_layers;
      } catch {
        /* Unreadable. Nothing is dropped for this source. */
      }
    }
    if (layers) served.set(name, new Set(layers.map((l) => l.id)));
  }

  style.layers = style.layers.filter((layer) => {
    const wanted = layer["source-layer"];
    if (!wanted || !layer.source) return true;
    const available = served.get(layer.source);
    /* Unknown source, or a source we could not read: left alone. */
    return !available || available.has(wanted);
  });

  return style;
}

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
