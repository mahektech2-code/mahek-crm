"use client";

import * as React from "react";

/* ---------------------------------------------------------------------------
 * <Flow chart={`flowchart TD …`} caption="…" />
 *
 * Flowcharts, sequence diagrams and state machines, written as Mermaid text
 * inside the MDX so a diagram is reviewed in the same diff as the rule it
 * draws. Mermaid is several megabytes, so it is imported only when a diagram
 * is actually on the page, and only in the browser — it measures text with
 * the DOM and cannot run on the server.
 *
 * The theme is MahekOne's own tokens rather than Mermaid's defaults: a
 * diagram in the brand's purple and greys reads as part of the page; one in
 * Mermaid's pastel yellow reads as a screenshot from somewhere else.
 *
 * A diagram that fails to parse shows its source and the parser's message
 * rather than a blank box — the person who sees it is the one who can fix it.
 * ------------------------------------------------------------------------- */

let ready: Promise<typeof import("mermaid").default> | null = null;

function loadMermaid() {
  ready ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      fontFamily: '"Google Sans Flex", system-ui, sans-serif',
      themeVariables: {
        fontSize: "13px",
        primaryColor: "#f1ecff",
        primaryBorderColor: "#6835fb",
        primaryTextColor: "#161616",
        secondaryColor: "#f7f8fa",
        secondaryBorderColor: "#c2c8d2",
        tertiaryColor: "#fdf6e7",
        tertiaryBorderColor: "#f9e9c4",
        lineColor: "#6b7385",
        textColor: "#3d4453",
        edgeLabelBackground: "#ffffff",
        clusterBkg: "#fcfcfd",
        clusterBorder: "#dde1e8",
        noteBkgColor: "#fdf6e7",
        noteBorderColor: "#f9e9c4",
        actorBkg: "#f1ecff",
        actorBorder: "#6835fb",
        signalColor: "#3d4453",
        labelBoxBkgColor: "#f1ecff",
      },
      flowchart: { curve: "basis", padding: 12, nodeSpacing: 34, rankSpacing: 38, htmlLabels: true },
      sequence: { mirrorActors: false, messageMargin: 28 },
    });
    return mermaid;
  });
  return ready;
}

export function Flow({ chart, caption }: { chart: string; caption?: string }) {
  const id = React.useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [zoomed, setZoomed] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    loadMermaid()
      .then((mermaid) => mermaid.render(`flow-${id}`, chart.trim()))
      .then(({ svg }) => live && setSvg(svg))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [chart, id]);

  return (
    <figure className="my-6">
      <div
        className="relative overflow-x-auto rounded-[6px] border border-line bg-surface p-5 [background-image:radial-gradient(#edeff3_1px,transparent_1px)] [background-size:16px_16px]"
      >
        {error ? (
          <div className="text-[13px] text-danger">
            <div className="mb-2 font-medium">This diagram could not be drawn: {error}</div>
            <pre className="overflow-x-auto rounded-[4px] bg-canvas p-3 font-mono text-[12px] text-body">{chart.trim()}</pre>
          </div>
        ) : svg ? (
          <>
            <div
              className="flex justify-center [&_svg]:h-auto [&_svg]:max-w-full"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
            <button
              type="button"
              onClick={() => setZoomed(true)}
              className="absolute top-2 right-2 cursor-pointer rounded-[4px] border border-line bg-surface px-2 py-1 text-[11px] text-muted hover:text-ink"
            >
              Enlarge
            </button>
          </>
        ) : (
          <div className="flex h-40 items-center justify-center text-[13px] text-muted">Drawing the diagram…</div>
        )}
      </div>
      {caption ? <figcaption className="mt-2 text-center text-[12px] text-muted">{caption}</figcaption> : null}
      {zoomed && svg ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={caption ?? "Diagram"}
          onClick={() => setZoomed(false)}
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-ink/50 p-8"
        >
          <div
            className="max-h-full max-w-full overflow-auto rounded-[6px] bg-surface p-8 [&_svg]:h-auto [&_svg]:!max-w-none [&_svg]:min-w-[900px]"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      ) : null}
    </figure>
  );
}
