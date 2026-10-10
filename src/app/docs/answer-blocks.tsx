"use client";

import * as React from "react";
import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import { Flow } from "@/docs/components/flow";
import {
  Hotspot,
  Hotspots,
  WfBar,
  WfBlock,
  WfButton,
  WfCard,
  WfField,
  WfInput,
  WfPanel,
  WfPill,
  WfSpacer,
  WfTable,
  WfTabs,
  WfText,
  WfTitle,
  Wireframe,
} from "@/docs/components/wireframe";
import { parseWireMarkup, type WireNode, type WireProp } from "@/lib/docs-ask/wire-markup";

/* ---------------------------------------------------------------------------
 * An "Ask the docs" answer, drawn.
 *
 * The answer is markdown, and four kinds of fenced block are pictures:
 *
 *   ```mermaid    a flowchart, sequence or state diagram — the docs' own
 *                 <Flow>, so it looks like every diagram on the pages
 *   ```wireframe  the pages' own <Wireframe> markup, read by
 *                 `parseWireMarkup` (never compiled) and drawn with the real
 *                 components
 *   ```svg        an image, shown through <img> from a data URL — an SVG in
 *                 an <img> cannot run a script or fetch anything
 *   anything else code, as code
 *
 * plus markdown tables, lists, headings, bold, code and links (only links into
 * /docs are followed). A block still being written is drawn as "Drawing…" until
 * its closing fence arrives, so half a diagram never flashes up as an error.
 * ------------------------------------------------------------------------- */

type Part = { kind: "text"; text: string } | { kind: "fence"; lang: string; body: string; closed: boolean };

export function splitFences(text: string): Part[] {
  const parts: Part[] = [];
  const re = /^```([\w-]*)[ \t]*\n/gm;
  let at = 0;
  for (;;) {
    re.lastIndex = at;
    const open = re.exec(text);
    if (!open) break;
    if (open.index > at) parts.push({ kind: "text", text: text.slice(at, open.index) });
    const bodyStart = open.index + open[0].length;
    const close = text.indexOf("\n```", bodyStart - 1);
    if (close < 0) {
      parts.push({ kind: "fence", lang: open[1].toLowerCase(), body: text.slice(bodyStart), closed: false });
      return parts;
    }
    parts.push({ kind: "fence", lang: open[1].toLowerCase(), body: text.slice(bodyStart, close), closed: true });
    const after = text.indexOf("\n", close + 4);
    at = after < 0 ? text.length : after + 1;
  }
  if (at < text.length) parts.push({ kind: "text", text: text.slice(at) });
  return parts;
}

export function AnswerBody({ text }: { text: string }) {
  return (
    <>
      {splitFences(text).map((p, i) =>
        p.kind === "text" ? <Markdown key={i} text={p.text} /> : <FenceBlock key={i} lang={p.lang} body={p.body} closed={p.closed} />,
      )}
    </>
  );
}

const DRAWN = new Set(["mermaid", "wireframe", "svg"]);

function FenceBlock({ lang, body, closed }: { lang: string; body: string; closed: boolean }) {
  if (DRAWN.has(lang) && !closed) {
    return (
      <div className="my-3 flex h-24 items-center justify-center gap-2 rounded-[6px] border border-dashed border-line-strong text-[12px] text-muted">
        <span className="block h-3.5 w-3.5 animate-spin rounded-full border-2 border-brand-softer border-t-brand" />
        Drawing the {lang === "mermaid" ? "diagram" : lang === "svg" ? "picture" : "wireframe"}…
      </div>
    );
  }
  if (lang === "mermaid") return <div className="[&_figure]:my-3">{<Flow chart={body} />}</div>;
  if (lang === "wireframe") return <WireDrawing source={body} />;
  if (lang === "svg") return <SvgImage source={body} />;
  return (
    <pre className="my-2 overflow-x-auto rounded-[4px] bg-canvas p-2.5 font-mono text-[11px] leading-[16px] text-body">{body}</pre>
  );
}

/* ----------------------------------------------------------- enlargeable */

function Enlargeable({ label, children }: { label: string; children: React.ReactNode }) {
  const [big, setBig] = React.useState(false);
  return (
    <div className="relative my-3">
      {children}
      <button
        type="button"
        onClick={() => setBig(true)}
        className="absolute top-1.5 right-1.5 z-20 cursor-pointer rounded-[4px] border border-line bg-surface px-2 py-0.5 text-[11px] text-muted shadow-sm hover:text-ink"
      >
        Enlarge
      </button>
      {big ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={label}
          onClick={() => setBig(false)}
          className="fixed inset-0 z-[70] flex cursor-zoom-out items-center justify-center bg-ink/50 p-8"
        >
          <div className="max-h-full w-[min(1040px,100%)] cursor-default overflow-auto rounded-[8px] bg-surface p-6" onClick={(e) => e.stopPropagation()}>
            {children}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------- wireframe */

const str = (v: WireProp | undefined): string | undefined =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
const strs = (v: WireProp | undefined): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string" || typeof x === "number").map(String) : [];
const rowsOf = (v: WireProp | undefined): string[][] =>
  Array.isArray(v) ? v.filter(Array.isArray).map((r) => (r as unknown[]).map((c) => (typeof c === "object" ? "" : String(c)))) : [];
const num = (v: WireProp | undefined): number | undefined => (typeof v === "number" ? v : undefined);
const TONES = ["neutral", "brand", "success", "warn", "danger", "info"] as const;

function Wire({ n }: { n: WireNode }): React.ReactNode {
  if (typeof n === "string") return n;
  const kids = n.children.map((c, i) => <Wire key={i} n={c} />);
  const p = n.props;
  switch (n.tag) {
    case "Wireframe":
      return (
        <Wireframe url={str(p.url) ?? "/"} nav={Array.isArray(p.nav) ? strs(p.nav) : undefined} active={str(p.active)} caption={str(p.caption)}>
          {kids}
        </Wireframe>
      );
    case "Hotspot":
      return <Hotspot n={num(p.n) ?? 1} />;
    case "Hotspots":
      return <Hotspots items={strs(p.items)} />;
    case "WfBar":
      return <WfBar>{kids}</WfBar>;
    case "WfSpacer":
      return <WfSpacer />;
    case "WfTitle":
      return <WfTitle sub={str(p.sub)}>{kids}</WfTitle>;
    case "WfText":
      return <WfText muted={p.muted === true}>{kids}</WfText>;
    case "WfButton":
      return <WfButton primary={p.primary === true}>{kids}</WfButton>;
    case "WfInput":
      return <WfInput placeholder={str(p.placeholder) ?? ""} wide={p.wide === true} />;
    case "WfTabs": {
      const items = strs(p.items);
      return <WfTabs items={items} active={str(p.active) ?? items[0] ?? ""} />;
    }
    case "WfPill": {
      const tone = TONES.find((t) => t === p.tone);
      return <WfPill tone={tone}>{kids}</WfPill>;
    }
    case "WfBlock":
      return <WfBlock label={str(p.label)} h={Math.min(400, Math.max(8, num(p.h) ?? 40))} />;
    case "WfCard":
      return (
        <WfCard title={str(p.title)} tone={p.tone === "warn" || p.tone === "brand" ? p.tone : undefined}>
          {kids}
        </WfCard>
      );
    case "WfTable":
      return <WfTable columns={strs(p.columns)} rows={rowsOf(p.rows)} highlight={num(p.highlight)} />;
    case "WfPanel":
      return (
        <WfPanel title={str(p.title) ?? ""} side={p.side === true}>
          {kids}
        </WfPanel>
      );
    case "WfField":
      return <WfField label={str(p.label) ?? ""}>{kids}</WfField>;
    default:
      return <div>{kids}</div>;
  }
}

function WireDrawing({ source }: { source: string }) {
  const parsed = React.useMemo(() => parseWireMarkup(source), [source]);
  if (!parsed.ok) {
    return (
      <div className="my-3 rounded-[6px] border border-line bg-canvas p-2.5 text-[12px] text-muted">
        This wireframe could not be drawn ({parsed.error}).
      </div>
    );
  }
  return (
    <Enlargeable label="Wireframe">
      <div className="[&_figure]:my-0">
        {parsed.nodes.map((n, i) => (
          <Wire key={i} n={n} />
        ))}
      </div>
    </Enlargeable>
  );
}

/* ------------------------------------------------------------------- svg */

function SvgImage({ source }: { source: string }) {
  const svg = source.trim();
  if (!/^<svg[\s>]/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) {
    return <div className="my-3 rounded-[6px] border border-line bg-canvas p-2.5 text-[12px] text-muted">This picture could not be drawn.</div>;
  }
  // As an <img>, an SVG cannot run a script or load anything; the xmlns is what makes it an image at all.
  const withNs = /xmlns=/.test(svg) ? svg : svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withNs)}`;
  return (
    <Enlargeable label="Picture">
      {/* eslint-disable-next-line @next/next/no-img-element -- a data URL, nothing to optimise */}
      <img src={src} alt="A picture drawn for this answer" className="mx-auto block h-auto max-w-full rounded-[6px] border border-line bg-surface" />
    </Enlargeable>
  );
}

/* --------------------------------------------------------------- markdown */

function Markdown({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let table: string[][] | null = null;
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, i) => (
      <li key={i} className="mb-0.5">
        <Inline text={it} />
      </li>
    ));
    blocks.push(
      list.ordered ? (
        <ol key={blocks.length} className="mb-2 list-decimal pl-5">
          {items}
        </ol>
      ) : (
        <ul key={blocks.length} className="mb-2 list-disc pl-5">
          {items}
        </ul>
      ),
    );
    list = null;
  };
  const flushTable = () => {
    if (!table) return;
    const rows = table.filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c.trim())));
    const [head, ...body] = rows;
    blocks.push(
      <div key={blocks.length} className="my-2 overflow-x-auto rounded-[6px] border border-line">
        <table className="w-full border-collapse text-left text-[12px]">
          {head ? (
            <thead className="bg-canvas">
              <tr>
                {head.map((c, i) => (
                  <th key={i} className="border-b border-line px-2 py-1.5 font-semibold text-ink">
                    <Inline text={c} />
                  </th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {body.map((r, i) => (
              <tr key={i} className="border-b border-divider last:border-0">
                {r.map((c, j) => (
                  <td key={j} className="px-2 py-1.5 align-top text-body">
                    <Inline text={c} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>,
    );
    table = null;
  };

  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushList();
      table ??= [];
      table.push(line.trim().slice(1, -1).split("|").map((c) => c.trim()));
      continue;
    }
    flushTable();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = !!numbered;
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]);
      continue;
    }
    flushList();
    if (!line.trim()) continue;
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    blocks.push(
      heading ? (
        <p key={blocks.length} className="mt-2 mb-1 font-semibold text-heading">
          <Inline text={heading[1]} />
        </p>
      ) : (
        <p key={blocks.length} className="mb-2">
          <Inline text={line} />
        </p>
      ),
    );
  }
  flushList();
  flushTable();
  return <>{blocks}</>;
}

function Inline({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > at) parts.push(text.slice(at, m.index));
    if (m[1] !== undefined) {
      parts.push(
        m[2].startsWith("/docs/") ? (
          <Link key={m.index} href={m[2]} className={cx("font-medium text-brand-hover underline decoration-brand-softer underline-offset-2")}>
            {m[1]}
          </Link>
        ) : (
          m[1]
        ),
      );
    } else if (m[3] !== undefined) {
      parts.push(
        <strong key={m.index} className="font-semibold">
          {m[3]}
        </strong>,
      );
    } else {
      parts.push(
        <code key={m.index} className="rounded-[3px] bg-canvas px-1 font-mono text-[12px]">
          {m[4]}
        </code>,
      );
    }
    at = m.index! + m[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}
