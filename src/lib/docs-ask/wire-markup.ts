/* ---------------------------------------------------------------------------
 * The wireframe markup an "Ask the docs" answer may draw with — parsed, never
 * evaluated.
 *
 * The pages draw screens with `<Wireframe>` and the `Wf*` pieces, written as
 * JSX in the MDX, and the assistant is shown that source so it can draw the
 * same screen in an answer. An answer is model output, so it is NOT compiled:
 * this reads a small subset of JSX into a tree — known tags only, props that
 * are a string, a number, true, or a JSON literal in braces — and the panel
 * renders the tree with the real components. Anything else (an unknown tag, an
 * expression, an event handler, `className`, `style`) is dropped, which is why
 * a model's mistake costs a plainer drawing and never runs anything.
 *
 * PURE: text in, tree out.
 * ------------------------------------------------------------------------- */

export const WIRE_TAGS = [
  "Wireframe",
  "Hotspot",
  "Hotspots",
  "WfBar",
  "WfSpacer",
  "WfTitle",
  "WfText",
  "WfButton",
  "WfInput",
  "WfTabs",
  "WfPill",
  "WfBlock",
  "WfCard",
  "WfTable",
  "WfPanel",
  "WfField",
] as const;
export type WireTag = (typeof WIRE_TAGS)[number];

/** The props each tag may carry. Everything else is dropped. */
const ALLOWED_PROPS: Record<WireTag, string[]> = {
  Wireframe: ["url", "nav", "active", "caption"],
  Hotspot: ["n"],
  Hotspots: ["items"],
  WfBar: [],
  WfSpacer: [],
  WfTitle: ["sub"],
  WfText: ["muted"],
  WfButton: ["primary"],
  WfInput: ["placeholder", "wide"],
  WfTabs: ["items", "active"],
  WfPill: ["tone"],
  WfBlock: ["label", "h"],
  WfCard: ["title", "tone"],
  WfTable: ["columns", "rows", "highlight"],
  WfPanel: ["title", "side"],
  WfField: ["label"],
};

export type WireProp = string | number | boolean | WireJson;
type WireJson = null | string | number | boolean | WireJson[] | { [k: string]: WireJson };
export type WireNode = string | { tag: WireTag | "group"; props: Record<string, WireProp>; children: WireNode[] };

export type WireParse = { ok: true; nodes: WireNode[] } | { ok: false; error: string };

const isTag = (t: string): t is WireTag => (WIRE_TAGS as readonly string[]).includes(t);

/** A brace expression's value, if it is a plain literal. */
function literal(src: string): WireProp | undefined {
  const s = src.trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === "true" || s === "false") return s === "true";
  if (/^`[^`$]*`$/.test(s)) return s.slice(1, -1);
  try {
    // Trailing commas are ordinary in hand-written JSX arrays.
    return JSON.parse(s.replace(/,(\s*[\]}])/g, "$1")) as WireJson;
  } catch {
    return undefined;
  }
}

/** Where the brace opened at `from` closes, stepping over strings. */
function closeBrace(src: string, from: number): number {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

export function parseWireMarkup(src: string, maxNodes = 600): WireParse {
  let i = 0;
  let count = 0;
  const root: WireNode[] = [];
  const stack: Array<{ tag: string; node: Exclude<WireNode, string> | null; children: WireNode[] }> = [
    { tag: "#root", node: null, children: root },
  ];
  const top = () => stack[stack.length - 1];

  const pushText = (t: string) => {
    const text = t.replace(/\s+/g, " ");
    if (text.trim()) top().children.push(text);
  };

  while (i < src.length) {
    const lt = src.indexOf("<", i);
    const brace = src.indexOf("{", i);
    // A `{…}` in children is an expression: a comment or a value. Keep a literal string, drop the rest.
    if (brace >= 0 && (lt < 0 || brace < lt)) {
      pushText(src.slice(i, brace));
      const end = closeBrace(src, brace);
      if (end < 0) return { ok: false, error: "A { is never closed." };
      const v = literal(src.slice(brace + 1, end));
      if (typeof v === "string" || typeof v === "number") pushText(String(v));
      i = end + 1;
      continue;
    }
    if (lt < 0) {
      pushText(src.slice(i));
      break;
    }
    pushText(src.slice(i, lt));
    i = lt + 1;

    if (src[i] === "/") {
      const end = src.indexOf(">", i);
      if (end < 0) return { ok: false, error: "A closing tag is never finished." };
      const name = src.slice(i + 1, end).trim();
      // Close back to the matching open tag; a stray close is ignored.
      const at = stack.map((s) => s.tag).lastIndexOf(name);
      if (at > 0) stack.length = at;
      i = end + 1;
      continue;
    }

    const nameMatch = /^[A-Za-z][\w.]*/.exec(src.slice(i));
    if (!nameMatch) {
      pushText("<");
      continue;
    }
    const name = nameMatch[0];
    i += name.length;

    const props: Record<string, WireProp> = {};
    let selfClosing = false;
    for (;;) {
      while (/\s/.test(src[i] ?? "")) i++;
      if (i >= src.length) return { ok: false, error: `<${name}> is never finished.` };
      if (src.startsWith("/>", i)) {
        selfClosing = true;
        i += 2;
        break;
      }
      if (src[i] === ">") {
        i++;
        break;
      }
      const attr = /^[A-Za-z_][\w-]*/.exec(src.slice(i));
      if (!attr) return { ok: false, error: `<${name}> has something that is not a prop.` };
      const key = attr[0];
      i += key.length;
      while (/\s/.test(src[i] ?? "")) i++;
      if (src[i] !== "=") {
        props[key] = true;
        continue;
      }
      i++;
      while (/\s/.test(src[i] ?? "")) i++;
      if (src[i] === '"' || src[i] === "'") {
        const q = src[i];
        const end = src.indexOf(q, i + 1);
        if (end < 0) return { ok: false, error: `${key} on <${name}> is never closed.` };
        props[key] = src.slice(i + 1, end);
        i = end + 1;
      } else if (src[i] === "{") {
        const end = closeBrace(src, i);
        if (end < 0) return { ok: false, error: `${key} on <${name}> is never closed.` };
        const v = literal(src.slice(i + 1, end));
        if (v !== undefined) props[key] = v;
        i = end + 1;
      } else {
        return { ok: false, error: `${key} on <${name}> has no value.` };
      }
    }

    if (++count > maxNodes) return { ok: false, error: "The drawing is too big." };
    const tag: WireTag | "group" = isTag(name) ? name : "group";
    const kept: Record<string, WireProp> = {};
    if (tag !== "group") for (const k of ALLOWED_PROPS[tag]) if (k in props) kept[k] = props[k];
    const node: Exclude<WireNode, string> = { tag, props: kept, children: [] };
    top().children.push(node);
    if (!selfClosing) stack.push({ tag: name, node, children: node.children });
  }

  return root.length ? { ok: true, nodes: root } : { ok: false, error: "There is nothing to draw." };
}
