/* ---------------------------------------------------------------------------
 * THE DESIGN'S STYLE LANGUAGE, ON NATIVE VIEWS.
 *
 * The Factory screens were drawn as the design draws them — inline CSS with
 * the design's own pixel values — and that is the part that must not drift:
 * somebody on the floor learns where a button is and stops reading. So the
 * native app keeps those exact style objects and this file is what turns
 * them into React Native: `Div`, `Span`, `Btn`, `Input` take the same props
 * the web elements did and render View, Text, Pressable, ScrollView and
 * TextInput.
 *
 * What it translates, because the web does it and React Native does not:
 *   - text style INHERITS (color, size, weight…) down through containers;
 *   - `display: flex` means a ROW, block means a column;
 *   - a span of words is inline text, and a run of them is one paragraph;
 *   - shorthand boxes, borders, radii and `50%`;
 *   - `display: grid` with N equal columns;
 *   - `overflow: auto` scrolls;
 *   - the four keyframe animations the design uses.
 * ------------------------------------------------------------------------- */
import { Children, cloneElement, createContext, Fragment, isValidElement, useContext, useEffect, useRef, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { Animated, Easing, Pressable, ScrollView, Text, TextInput, View, type TextStyle, type ViewStyle } from "react-native";

type Css = CSSProperties & Record<string, unknown>;

/* ------------------------------------------------------------ values */

const num = (v: unknown, em = 16): number | string | undefined => {
  if (v == null || v === "") return undefined;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  if (s === "auto") return "auto";
  if (s.endsWith("%")) return s;
  if (s.endsWith("px")) return parseFloat(s);
  if (s.endsWith("em")) return parseFloat(s) * em;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
};
const px = (v: unknown, em?: number) => {
  const n = num(v, em);
  return typeof n === "number" ? n : undefined;
};

function box(v: unknown): [unknown, unknown, unknown, unknown] {
  if (typeof v === "number") return [v, v, v, v];
  const p = String(v).trim().split(/\s+/);
  const [a, b = a, c = a, d = b] = p;
  return [a, b, c, d];
}

function border(v: unknown): { w: number; c?: string; s?: "solid" | "dashed" | "dotted" } {
  const s = String(v ?? "").trim();
  if (!s || s === "none" || s === "0") return { w: 0 };
  const m = s.match(/^([\d.]+)px\s+(solid|dashed|dotted)\s+(.+)$/);
  if (m) return { w: parseFloat(m[1]), s: m[2] as "solid", c: m[3] };
  return { w: 1, c: s };
}

const FONT = (f: unknown) => (String(f ?? "").toLowerCase().includes("mono") ? "monospace" : undefined);

/* ------------------------------------------------------------ the translation */

const TEXT_KEYS = ["color", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "textAlign", "fontFamily", "textTransform", "fontStyle"] as const;
export type Inherit = TextStyle;

type Parsed = {
  view: ViewStyle;
  text: TextStyle;
  display: string;
  scroll: "y" | "x" | null;
  grid: number;
  lines?: number;
  anim?: string;
};

export function parse(css: Css | undefined, inherited: TextStyle = {}): Parsed {
  const v: ViewStyle & Record<string, unknown> = {};
  const t: TextStyle & Record<string, unknown> = {};
  let display = "", scroll: Parsed["scroll"] = null, grid = 0, lines: number | undefined, anim: string | undefined;
  if (!css) return { view: v, text: t, display, scroll, grid };
  const fs = px(css.fontSize) ?? (inherited.fontSize as number | undefined) ?? 16;

  for (const [k, raw] of Object.entries(css)) {
    if (raw == null || raw === "") continue;
    switch (k) {
      case "display":
        display = String(raw);
        if (raw === "none") v.display = "none";
        break;
      case "padding":
      case "margin": {
        const [a, b, c, d] = box(raw);
        v[k + "Top"] = num(a, fs); v[k + "Right"] = num(b, fs); v[k + "Bottom"] = num(c, fs); v[k + "Left"] = num(d, fs);
        break;
      }
      case "border":
      case "borderTop":
      case "borderRight":
      case "borderBottom":
      case "borderLeft": {
        const b = border(raw);
        const side = k === "border" ? "" : k.slice(6);
        v["border" + side + "Width"] = b.w;
        if (b.c) v["border" + side + "Color"] = b.c;
        if (b.s && b.s !== "solid") v.borderStyle = b.s;
        break;
      }
      case "borderRadius": {
        const s = String(raw);
        if (s.endsWith("%")) {
          const w = px(css.width) ?? px(css.height);
          v.borderRadius = w ? w / 2 : 9999;
        } else if (/\s/.test(s.trim())) {
          const [a, b, c, d] = box(s);
          v.borderTopLeftRadius = px(a); v.borderTopRightRadius = px(b); v.borderBottomRightRadius = px(c); v.borderBottomLeftRadius = px(d);
        } else v.borderRadius = px(raw);
        break;
      }
      case "background":
      case "backgroundColor":
        v.backgroundColor = String(raw);
        break;
      case "boxShadow": {
        const s = String(raw);
        if (s === "none") break;
        const ins = s.match(/^inset\s+([\d.]+)px\s+0\s+0\s+(.+)$/);
        if (ins) { v.borderLeftWidth = parseFloat(ins[1]); v.borderLeftColor = ins[2]; break; }
        const m = s.match(/^(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?\s+([\d.]+)(?:px)?\s+(.+)$/);
        if (m) {
          v.shadowColor = m[4]; v.shadowOffset = { width: parseFloat(m[1]), height: parseFloat(m[2]) };
          v.shadowRadius = parseFloat(m[3]) / 2; v.shadowOpacity = 1; v.elevation = Math.min(12, Math.round(parseFloat(m[3]) / 3));
        }
        break;
      }
      case "flex":
        if (raw === "none") { v.flexGrow = 0; v.flexShrink = 0; }
        else if (typeof raw === "number" || /^\d+$/.test(String(raw))) v.flex = Number(raw);
        else { const [g, sh] = String(raw).split(/\s+/); v.flexGrow = Number(g) || 0; v.flexShrink = Number(sh ?? 1); }
        break;
      case "inset":
        v.top = v.right = v.bottom = v.left = px(raw) ?? 0;
        break;
      case "overflowY":
      case "overflow":
        if (raw === "auto" || raw === "scroll") scroll = "y";
        else if (raw === "hidden") v.overflow = "hidden";
        break;
      case "overflowX":
        if (raw === "auto" || raw === "scroll") scroll = "x";
        break;
      case "gridTemplateColumns": {
        const s = String(raw);
        const r = s.match(/repeat\((\d+)/);
        grid = r ? Number(r[1]) : s.trim().split(/\s+/).length;
        break;
      }
      case "whiteSpace":
        if (raw === "nowrap") lines = 1;
        break;
      case "animation":
        if (raw !== "none") anim = String(raw).split(" ")[0];
        break;
      case "fontFamily":
        t.fontFamily = FONT(raw);
        break;
      case "fontWeight":
        t.fontWeight = String(raw) as TextStyle["fontWeight"];
        break;
      case "letterSpacing":
        t.letterSpacing = px(raw, fs);
        break;
      case "lineHeight":
        t.lineHeight = px(raw, fs);
        break;
      case "color": case "fontSize": case "textAlign": case "textTransform": case "fontStyle":
        (t as Record<string, unknown>)[k] = k === "fontSize" ? px(raw) : raw;
        break;
      case "width": case "height": case "minWidth": case "minHeight": case "maxWidth": case "maxHeight":
      case "top": case "left": case "right": case "bottom":
      case "marginTop": case "marginBottom": case "marginLeft": case "marginRight":
      case "paddingTop": case "paddingBottom": case "paddingLeft": case "paddingRight":
      case "gap": case "rowGap": case "columnGap": case "borderWidth":
        (v as Record<string, unknown>)[k] = num(raw, fs);
        break;
      case "position": case "zIndex": case "opacity": case "flexDirection": case "flexWrap": case "alignItems":
      case "justifyContent": case "alignSelf": case "flexShrink": case "flexGrow": case "borderColor": case "borderStyle":
        (v as Record<string, unknown>)[k] = raw;
        break;
      default:
        /* cursor, outline, transition, boxSizing, textOverflow, verticalAlign… have no native meaning. */
        break;
    }
  }
  if (display === "flex" || display === "inline-flex") v.flexDirection = (css.flexDirection as ViewStyle["flexDirection"]) ?? "row";
  if (display === "inline-flex" && !v.alignSelf) v.alignSelf = "flex-start";
  if (v.position === "fixed" as unknown) v.position = "absolute";
  /* The web's flex items shrink by default (flex: 0 1 auto); native ones do
     not, and a long name in a row would push its neighbours off the screen. */
  if (v.flex == null && v.flexShrink == null) v.flexShrink = 1;
  return { view: v, text: t, display, scroll, grid, lines, anim };
}

/* ------------------------------------------------------------ children */

/**
 * Children as one flat list: fragments opened, and the empty strings a
 * `{text && …}` leaves behind dropped. A native View may hold no string at
 * all — not even an empty one — so nothing raw may reach one.
 */
export function flat(children: ReactNode, prefix = ""): ReactNode[] {
  const out: ReactNode[] = [];
  /* toArray gives every child a key unique among its siblings, nested arrays included. */
  for (const c of Children.toArray(children)) {
    if (c === "") continue;
    if (isValidElement(c) && c.type === Fragment) out.push(...flat((c.props as { children?: ReactNode }).children, prefix + String(c.key) + "/"));
    else out.push(prefix && isValidElement(c) ? cloneElement(c, { key: prefix + String(c.key) }) : c);
  }
  return out;
}

/* ------------------------------------------------------------ inheritance */

const TextCtx = createContext<TextStyle>({ color: "#1A1E28", fontSize: 16 });
export const useInherited = () => useContext(TextCtx);

function inheritable(t: TextStyle): TextStyle {
  const o: Record<string, unknown> = {};
  for (const k of TEXT_KEYS) if ((t as Record<string, unknown>)[k] != null) o[k] = (t as Record<string, unknown>)[k];
  return o as TextStyle;
}

/** A span with no display of its own, holding only words: it flows inline. */
function isInline(c: ReactNode): boolean {
  if (typeof c === "string" || typeof c === "number") return true;
  if (!isValidElement(c)) return false;
  if (c.type !== Span) return false;
  const p = c.props as { style?: Css; children?: ReactNode; onClick?: unknown };
  if (p.onClick) return false;
  const d = p.style?.display;
  if (d && d !== "inline") return false;
  const kids = flat(p.children);
  return kids.length > 0 && kids.every(isInline);
}

/** Inline content as nested Text — a run of words and spans is one paragraph. */
function inlineText(c: ReactNode, key?: string | number): ReactNode {
  if (typeof c === "string" || typeof c === "number") return c;
  if (!isValidElement(c)) return null;
  const p = c.props as { style?: Css; children?: ReactNode };
  const r = parse(p.style);
  const bg = (r.view as ViewStyle).backgroundColor;
  return (
    <Text key={key} style={[r.text, bg ? { backgroundColor: bg } : null]}>
      {flat(p.children).map((k, i) => inlineText(k, i))}
    </Text>
  );
}

/* ------------------------------------------------------------ animation */

function Animate({ name, style, children }: { name: string; style: ViewStyle; children: ReactNode }) {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let loop: Animated.CompositeAnimation;
    if (name === "fx-spin") loop = Animated.loop(Animated.timing(a, { toValue: 1, duration: 1200, easing: Easing.linear, useNativeDriver: true }));
    else if (name === "fx-pulse" || name === "fx-scan")
      loop = Animated.loop(Animated.sequence([
        Animated.timing(a, { toValue: 1, duration: name === "fx-scan" ? 1200 : 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(a, { toValue: 0, duration: name === "fx-scan" ? 1200 : 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]));
    else loop = Animated.timing(a, { toValue: 1, duration: 200, easing: Easing.bezier(0.2, 0, 0.2, 1), useNativeDriver: true });
    loop.start();
    return () => loop.stop();
  }, [a, name]);
  let extra: Animated.WithAnimatedObject<ViewStyle> = {};
  if (name === "fx-spin") extra = { transform: [{ rotate: a.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }] };
  if (name === "fx-pulse") extra = { opacity: a.interpolate({ inputRange: [0, 1], outputRange: [1, 0.35] }) };
  /* The scan line runs 6% → 90% down the 240-point viewfinder. */
  if (name === "fx-scan") extra = { top: 14, transform: [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [0, 202] }) }] };
  if (name === "fx-up") extra = { opacity: a, transform: [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [28, 0] }) }] };
  return <Animated.View style={[style, extra]}>{children}</Animated.View>;
}

/* ------------------------------------------------------------ the elements */

type El = { style?: CSSProperties; children?: ReactNode; onClick?: (e: FakeEvent) => void; "aria-label"?: string; role?: string; title?: string; disabled?: boolean };
type FakeEvent = { stopPropagation: () => void; preventDefault: () => void };
const EV: FakeEvent = { stopPropagation() {}, preventDefault() {} };

function render(kind: "div" | "span" | "button", { style, children, onClick, "aria-label": label }: El, inherited: TextStyle): ReactElement {
  const r = parse(style as Css | undefined, inherited);
  const button = kind === "button" || !!onClick;
  const own = inheritable(r.text);
  const ctx: TextStyle = { ...inherited, ...own };
  if (button && style?.textAlign == null && kind === "button") ctx.textAlign = r.display === "flex" ? ctx.textAlign : "center";
  const kids = flat(children);
  const flowing = r.display !== "flex" && r.display !== "inline-flex" && r.display !== "grid" && kids.length > 0 && kids.every(isInline);
  const view: ViewStyle = { ...r.view };
  if (button && kind === "button" && r.display !== "flex" && r.display !== "inline-flex") view.justifyContent = view.justifyContent ?? "center";

  /* Words only: one Text carries the box and the paragraph. */
  if (flowing && !button && !r.scroll && !r.anim) {
    return (
      <Text style={[ctx, view as TextStyle]} numberOfLines={r.lines} ellipsizeMode="tail" accessibilityLabel={label}>
        {kids.map((k, i) => inlineText(k, i))}
      </Text>
    );
  }

  let body: ReactNode;
  if (flowing) body = <Text style={ctx} numberOfLines={r.lines}>{kids.map((k, i) => inlineText(k, i))}</Text>;
  else if (r.grid) {
    const cells = kids;
    const rows: ReactNode[][] = [];
    for (let i = 0; i < cells.length; i += r.grid) rows.push(cells.slice(i, i + r.grid));
    const gap = (view.gap as number) ?? 0;
    body = rows.map((row, i) => (
      <View key={i} style={{ flexDirection: "row", gap, marginTop: i ? ((view.rowGap as number) ?? gap) : 0 }}>
        {row.map((c, j) => <View key={j} style={{ flex: 1, minWidth: 0 }}>{wrapText(c, ctx, undefined, j)}</View>)}
        {Array.from({ length: r.grid - row.length }, (_, j) => <View key={"pad" + j} style={{ flex: 1 }} />)}
      </View>
    ));
    delete view.gap;
    view.flexDirection = "column";
  } else body = kids.map((k, i) => wrapText(k, ctx, r.lines, i));

  let el: ReactElement;
  if (r.scroll) {
    /* `flex: 1` in a box with only a max height (a bottom sheet) would be
       zero tall natively; sized from its content and allowed to grow and
       shrink, it fills a screen and fits a sheet alike. */
    if (view.flex === 1) { delete view.flex; view.flexGrow = 1; view.flexShrink = 1; view.flexBasis = "auto"; }
    const inner: ViewStyle = {};
    for (const k of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "gap", "flexDirection", "alignItems", "justifyContent", "flexWrap"] as const) {
      if (view[k] != null) { (inner as Record<string, unknown>)[k] = view[k]; delete view[k]; }
    }
    el = (
      <ScrollView style={view} contentContainerStyle={r.scroll === "x" ? { ...inner, flexDirection: "row" } : inner} horizontal={r.scroll === "x"} showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {body}
      </ScrollView>
    );
  } else if (button) {
    el = (
      <Pressable onPress={() => onClick?.(EV)} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [view, pressed && kind === "button" ? { opacity: 0.82 } : null]}>
        {body}
      </Pressable>
    );
  } else if (r.anim) {
    el = <Animate name={r.anim} style={view}>{body}</Animate>;
  } else el = <View style={view} accessibilityLabel={label}>{body}</View>;
  return <TextCtx.Provider value={ctx}>{el}</TextCtx.Provider>;
}

/** A bare string or number among views becomes Text in the inherited style. */
function wrapText(c: ReactNode, ctx: TextStyle, lines?: number, i = 0): ReactNode {
  if (typeof c === "string" || typeof c === "number") return <Text key={"t" + i} style={ctx} numberOfLines={lines}>{c}</Text>;
  return c;
}

export function Div(p: El) {
  return render("div", p, useContext(TextCtx));
}
export function Span(p: El) {
  return render("span", p, useContext(TextCtx));
}
export function Btn(p: El) {
  return render("button", p, useContext(TextCtx));
}

/** The root: the text every screen starts from. */
export function Root({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return (
    <TextCtx.Provider value={{ color: "#1A1E28", fontSize: 16 }}>
      <View style={[{ flex: 1 }, style]}>{flat(children).map((c, i) => wrapText(c, { color: "#1A1E28", fontSize: 16 }, undefined, i))}</View>
    </TextCtx.Provider>
  );
}

type InputProps = {
  value: string;
  onChange: (e: { target: { value: string } }) => void;
  onKeyDown?: (e: { key: string }) => void;
  inputMode?: string;
  type?: string;
  maxLength?: number;
  autoFocus?: boolean;
  placeholder?: string;
  style?: CSSProperties;
  "aria-label"?: string;
  autoComplete?: string;
};

export function Input({ value, onChange, onKeyDown, inputMode, type, maxLength, autoFocus, placeholder, style, "aria-label": label, autoComplete }: InputProps) {
  const inh = useContext(TextCtx);
  const r = parse(style as Css | undefined, inh);
  const s: TextStyle = { ...inh, ...r.view, ...r.text } as TextStyle;
  if (s.height != null && s.lineHeight == null) s.paddingVertical = 0;
  return (
    <TextInput
      value={value}
      onChangeText={(v) => onChange({ target: { value: v } })}
      onSubmitEditing={() => onKeyDown?.({ key: "Enter" })}
      keyboardType={inputMode === "numeric" ? "number-pad" : "default"}
      secureTextEntry={type === "password"}
      maxLength={maxLength}
      autoFocus={autoFocus}
      placeholder={placeholder}
      placeholderTextColor="#9BA3B2"
      accessibilityLabel={label}
      textContentType={autoComplete === "one-time-code" ? "oneTimeCode" : undefined}
      autoComplete={autoComplete === "one-time-code" ? "sms-otp" : autoComplete === "tel" ? "tel" : "off"}
      style={s}
    />
  );
}
