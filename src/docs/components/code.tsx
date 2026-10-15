import * as React from "react";
import index from "@/docs/_generated/index.json";

/* ---------------------------------------------------------------------------
 * <Code file="src/lib/engines/queue.ts" symbol="buildQueue" />
 * <Code file="src/lib/config/registry.ts" lines="172-182" />
 *
 * A piece of the real source, cut and coloured at BUILD time by
 * `scripts/docs-index.mjs` — the runtime image carries no source to read. A
 * symbol that has been renamed fails that script, and so fails the build,
 * rather than quietly quoting whatever now sits on those lines.
 *
 * `title` says what the excerpt is for; the file path and line range are
 * always shown beside it, because a quotation without its source is a claim
 * nobody can check.
 * ------------------------------------------------------------------------- */

type Excerpt = { file: string; symbol: string | null; startLine: number; endLine: number; html: string };
const EXCERPTS = index.excerpts as Record<string, Excerpt>;

export function Code({
  file,
  symbol,
  lines,
  title,
  collapsed,
}: {
  file: string;
  symbol?: string;
  lines?: string;
  title?: string;
  /** Long excerpts can start folded; the header still says what they are. */
  collapsed?: boolean;
}) {
  const excerpt = EXCERPTS[`${file}#${symbol ?? `L${lines}`}`];
  if (!excerpt) {
    return (
      <div className="my-4 rounded-[6px] border border-warn-line bg-warn-soft px-4 py-3 text-[13px] text-warn-ink">
        The excerpt <code className="font-mono">{file}#{symbol ?? lines}</code> is not in the docs index yet — run{" "}
        <code className="font-mono">npm run docs:index</code>.
      </div>
    );
  }
  const n = excerpt.endLine - excerpt.startLine + 1;
  const head = (
    <div className="flex items-center gap-2 border-b border-line bg-canvas px-3 py-2 font-mono text-[12px] text-muted">
      <span className="text-ink">{excerpt.file}</span>
      <span>
        L{excerpt.startLine}–{excerpt.endLine}
      </span>
      {excerpt.symbol ? <span className="rounded-[3px] bg-brand-soft px-1.5 text-brand-hover">{excerpt.symbol}</span> : null}
      <span className="flex-1" />
      {title ? <span className="font-sans text-[12px] text-body">{title}</span> : null}
    </div>
  );
  const body = (
    <div
      className="docs-code max-h-[560px] overflow-auto text-[12.5px] leading-[20px] [&_pre]:!bg-surface [&_pre]:px-4 [&_pre]:py-3"
      style={{ counterReset: `line ${excerpt.startLine - 1}` }}
      dangerouslySetInnerHTML={{ __html: excerpt.html }}
    />
  );
  if (collapsed) {
    return (
      <details className="group my-5 overflow-hidden rounded-[6px] border border-line bg-surface">
        <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
          {head}
          <div className="px-3 py-1.5 text-[12px] text-brand-hover group-open:hidden">Show {n} lines</div>
        </summary>
        {body}
      </details>
    );
  }
  return (
    <div className="my-5 overflow-hidden rounded-[6px] border border-line bg-surface">
      {head}
      {body}
    </div>
  );
}
