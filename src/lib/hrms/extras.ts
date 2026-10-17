import type { ListSpec, Tone } from "@/lib/erp/ui";

/* ---------------------------------------------------------------------------
 * What an HRMS list may carry beyond the shared contract: the design's
 * calendar, chart and scope switch, drawn above the list. PURE, client-safe.
 * ------------------------------------------------------------------------- */

export type Scope = "mine" | "team" | "all";

export type HrmsExtras = {
  /** A month grid of bars, one per row, from `from` to `to` (row value keys). */
  calendar?: { from: string; to: string; label: string; tone: string; month: string; holidays?: { date: string; name: string }[] };
  /** A line with a trend, above the list. */
  chart?: {
    caption: string;
    series: { d: string; v: number }[];
    /** A picker (Sales performance: whose score). */
    pick?: { param: string; value: string; options: { v: string; l: string }[] };
    /** The latest day's components (Sales performance). */
    parts?: { title: string; items: { l: string; got: number; max: number }[] };
  };
  /** Mine / team / all, where the person may choose. */
  scope?: { current: Scope; options: Scope[] };
  /** A line above the list that links somewhere (e.g. your pending check-outs). */
  notice?: { text: string; href?: string; tone?: Tone };
  /** A date or period the screen was read for, with the parameter that changes it. */
  period?: { label: string; params: { k: string; l: string; v: string; type: "date" | "month" }[] };
  /**
   * A list too long to send whole: the server searches and pages it, and the
   * list below filters and sorts only the page it was sent — so the strip
   * says which page and of how many, rather than letting a page pass for
   * the book.
   */
  paged?: { q: string; page: number; pages: number; total: number; from: number; to: number; placeholder: string };
};

export type HrmsListSpec = ListSpec & { hrms?: HrmsExtras };
