"use client";

import * as React from "react";
import { cx } from "@/components/ui/primitives";
import { DictateButton, joinDictation } from "@/components/ui/dictate";

/* ---------------------------------------------------------------------------
 * The formatted editor, for help articles and anything else an app declares as
 * rich text.
 *
 * It writes Markdown into a plain textarea rather than driving a contentEditable
 * surface. Two reasons: what gets stored is legible in the database and in an
 * audit diff, and a paste from Word cannot smuggle styling into the CRM. The
 * preview underneath is what the reader will actually see.
 * ------------------------------------------------------------------------- */

type Tool = { label: string; title: string; wrap?: [string, string]; line?: string };

const TOOLS: Tool[] = [
  { label: "B", title: "Bold", wrap: ["**", "**"] },
  { label: "I", title: "Italic", wrap: ["_", "_"] },
  { label: "H", title: "Heading", line: "## " },
  { label: "•", title: "Bullet list", line: "- " },
  { label: "1.", title: "Numbered list", line: "1. " },
  { label: "”", title: "Quote", line: "> " },
];

export function RichTextEditor({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  const ref = React.useRef<HTMLTextAreaElement>(null);

  function apply(tool: Tool) {
    const el = ref.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;

    if (tool.wrap) {
      const [open, close] = tool.wrap;
      const selected = value.slice(start, end) || "text";
      const next = value.slice(0, start) + open + selected + close + value.slice(end);
      onChange(next);
      // Leave the cursor around what was just wrapped, not at the end.
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(start + open.length, start + open.length + selected.length);
      });
      return;
    }

    // Line tools apply to every line the selection touches.
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const lineEnd = value.indexOf("\n", end) === -1 ? value.length : value.indexOf("\n", end);
    const block = value
      .slice(lineStart, lineEnd)
      .split("\n")
      .map((l) => (l.startsWith(tool.line!) ? l.slice(tool.line!.length) : tool.line! + l))
      .join("\n");
    onChange(value.slice(0, lineStart) + block + value.slice(lineEnd));
    requestAnimationFrame(() => el.focus());
  }

  return (
    <span className="block">
      <span className="flex flex-wrap items-center gap-1 rounded-t-[4px] border border-b-0 border-line bg-canvas px-1.5 py-1.5">
        {TOOLS.map((t) => (
          <button
            key={t.label}
            type="button"
            title={t.title}
            aria-label={t.title}
            onClick={() => apply(t)}
            className={cx(
              "h-7 min-w-7 cursor-pointer rounded-[4px] border border-line bg-surface px-2 text-[13px] text-body hover:bg-canvas",
              t.label === "B" ? "font-semibold" : t.label === "I" ? "italic" : "",
            )}
          >
            {t.label}
          </button>
        ))}
        <span className="flex-1" />
        <span className="pr-1 text-[11px] tracking-[0.04em] text-muted uppercase">Markdown</span>
      </span>
      <span className="relative block">
        <textarea
          ref={ref}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="h-[200px] w-full resize-y rounded-[4px] rounded-t-none border border-line bg-surface px-2.5 py-2 pr-9 font-mono text-[13px] leading-[20px] text-ink outline-none focus:border-brand"
        />
        {/* Dictation writes plain prose — the markdown around it stays whatever
            the author typed. Appending, not replacing, is what a long SOP wants. */}
        <DictateButton
          hasExistingText={value.trim().length > 0}
          onImport={(text, replace) => onChange(replace ? text : joinDictation(value, text))}
          className="absolute right-2 bottom-3"
        />
      </span>
      <span className="mt-3 block">
        <span className="mb-1.5 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
          What the reader sees
        </span>
        <span className="block rounded-[4px] border border-line bg-canvas p-4">
          <RichTextPreview markdown={value} />
        </span>
      </span>
    </span>
  );
}

/** A deliberately small subset — headings, lists, quotes, bold, italic, code. */
export function RichTextPreview({ markdown }: { markdown: string }) {
  const blocks = React.useMemo(() => parse(markdown), [markdown]);

  if (!markdown.trim()) {
    return <span className="block text-sm text-muted">Nothing written yet.</span>;
  }

  return (
    <span className="block">
      {blocks.map((b, i) =>
        b.kind === "heading" ? (
          <span key={i} className="mt-3 block text-[15px] font-semibold text-ink first:mt-0">
            {inline(b.lines[0])}
          </span>
        ) : b.kind === "quote" ? (
          <span key={i} className="mt-2 block border-l-2 border-brand-softer pl-3 text-sm text-body italic">
            {b.lines.map((l, j) => (
              <span key={j} className="block">
                {inline(l)}
              </span>
            ))}
          </span>
        ) : b.kind === "list" ? (
          <span key={i} className="mt-2 block">
            {b.lines.map((l, j) => (
              <span key={j} className="flex gap-2 text-sm leading-[22px] text-body">
                <span className="text-muted">{b.ordered ? `${j + 1}.` : "•"}</span>
                <span>{inline(l)}</span>
              </span>
            ))}
          </span>
        ) : (
          <span key={i} className="mt-2 block text-sm leading-[22px] text-body first:mt-0">
            {b.lines.map((l, j) => (
              <span key={j} className="block">
                {inline(l)}
              </span>
            ))}
          </span>
        ),
      )}
    </span>
  );
}

type Block = { kind: "para" | "heading" | "list" | "quote"; lines: string[]; ordered?: boolean };

function parse(md: string): Block[] {
  const out: Block[] = [];
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      out.push({ kind: "para", lines: [] });
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      out.push({ kind: "heading", lines: [line.replace(/^#{1,6}\s/, "")] });
      continue;
    }
    if (line.startsWith("> ")) {
      append(out, "quote", line.slice(2));
      continue;
    }
    const ordered = /^\d+\.\s/.test(line);
    if (line.startsWith("- ") || ordered) {
      const text = ordered ? line.replace(/^\d+\.\s/, "") : line.slice(2);
      const last = out[out.length - 1];
      if (last?.kind === "list" && last.ordered === ordered) last.lines.push(text);
      else out.push({ kind: "list", lines: [text], ordered });
      continue;
    }
    append(out, "para", line);
  }
  return out.filter((b) => b.lines.length);
}

function append(out: Block[], kind: Block["kind"], line: string) {
  const last = out[out.length - 1];
  if (last?.kind === kind && last.lines.length) last.lines.push(line);
  else out.push({ kind, lines: [line] });
}

/** Bold, italic and inline code. Anything else is left as typed. */
function inline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|_[^_]+_|`[^`]+`)/g).filter(Boolean);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-ink">
          {p.slice(2, -2)}
        </strong>
      );
    }
    if (p.startsWith("_") && p.endsWith("_")) return <em key={i}>{p.slice(1, -1)}</em>;
    if (p.startsWith("`") && p.endsWith("`")) {
      return (
        <code key={i} className="rounded-[3px] bg-divider px-1 font-mono text-[13px]">
          {p.slice(1, -1)}
        </code>
      );
    }
    return <React.Fragment key={i}>{p}</React.Fragment>;
  });
}
