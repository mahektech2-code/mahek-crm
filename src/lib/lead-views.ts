/* ---------------------------------------------------------------------------
 * §8.4 — ONE LIST SCREEN, SEVERAL VIEWS OF IT, AND THE NINE TILES ABOVE IT.
 *
 * The specification asks for All Leads, My Leads, Today's Actions, Overdue and
 * a Distributors & Third-Party register, and says in as many words that they
 * are one table-driven screen parameterised by a view rather than five
 * screens. This file is that parameter, and the summary strip's vocabulary
 * with it.
 *
 * PURE AND CLIENT-SAFE, like `lead-filters` and `lead-labels` beside it and
 * for the same reason: the strip and the view chips are drawn by a client
 * component while the service that turns a view into SQL is `server-only`, so
 * the two halves can only share a module that imports neither. A view name
 * typed into a screen is the usual way a chip comes to ask for a view the
 * server has never heard of, which shows up as a list that silently stops
 * narrowing.
 *
 * ---------------------------------------------------------------------------
 * A VIEW IS A URL. That is the whole reason it is a parameter and not a piece
 * of component state: "these eleven, nobody is working them" is what a manager
 * sends somebody, and a view held in memory makes that unsendable and the back
 * button a lie. The eight filters already work this way; this matches them.
 *
 * A VIEW IS NOT A PERMISSION, and none of these narrows anything the scope did
 * not already allow. `leadsVisible` is still the whole of who may see what;
 * a view can only remove rows from what that already permits.
 *
 * ---------------------------------------------------------------------------
 * FIVE OF THE NINE TILES ARE PLAIN FILTER OVERLAYS AND FOUR ARE VIEWS, and
 * that split is the honest one rather than a tidy one.
 *
 * A tile has to satisfy two rules. It has to RECOUNT as the filters change —
 * a strip that keeps saying "412 leads" over a table filtered to eleven is a
 * strip people learn to ignore — and its number has to come from the same
 * clause as the screen it opens, or the tile and its own list disagree about
 * one book and nothing on either says which is right.
 *
 * Both fall out of a tile being a SET OF URL PARAMETERS laid over whatever is
 * already there. The five stage tiles carry `stage=…`, which is a value the
 * filter bar already offers and `leadFilterClause` already reads, so the count
 * and the destination are literally one clause with no second definition
 * anywhere. The four that cannot be said as a stage carry a `view`, which the
 * service resolves — once, in one function, read by the count AND by the page
 * of rows behind it.
 * ------------------------------------------------------------------------- */

import { SALES_TYPES } from "./lead-labels";

/**
 * The views, and `all` is the absence of one.
 *
 * `archived` is older than the rest and keeps its spelling: `?view=archived`
 * is in bookmarks and in links people have already sent each other, and a
 * rename to tidy this list would break every one of them to no purpose.
 */
export type LeadView =
  | "all"
  | "mine"
  | "today"
  | "overdue"
  | "expected"
  | "lost30"
  | "register"
  | "archived";

export const LEAD_VIEWS = [
  "all",
  "mine",
  "today",
  "overdue",
  "expected",
  "lost30",
  "register",
  "archived",
] as const satisfies readonly LeadView[];

/**
 * A view off the URL, and anything unrecognised is `all`.
 *
 * Never a throw and never an empty table: a query string is a thing anybody
 * can write, and a screen that refuses to draw because somebody mistyped a
 * parameter is worse than one that shows them the whole book.
 */
export function viewFromParam(value: string | undefined): LeadView {
  return (LEAD_VIEWS as readonly string[]).includes(value ?? "")
    ? (value as LeadView)
    : "all";
}

/**
 * WHAT THE SCREEN CALLS ITSELF UNDER EACH VIEW.
 *
 * The heading changes with the view because the list does, and a page that
 * says "Leads" over a table of eleven overdue promises is one somebody reads
 * as the whole book having collapsed. The subtitle is where the narrowing is
 * said in words — §8.4's views are not filters somebody set and can see
 * ticked, so the only place the screen can admit what it is showing is here.
 */
export const VIEW_TEXT: Record<LeadView, { title: string; subtitle: string }> = {
  all: {
    title: "Leads",
    subtitle:
      "Prospects each salesman is working. Anything untouched for the configured window is tagged stale.",
  },
  mine: {
    title: "My leads",
    subtitle:
      "Leads carrying one of your seats — the book you own, the ones you coordinate as lead manager, and the ones whose paperwork is yours. Whether a seat is asking you for something today is the For you column.",
  },
  /*
   * THESE TWO ARE NARROWER THAN THE NEXT COLUMN ON THE SAME SCREEN, and both
   * subtitles say so.
   *
   * §24's windows — `dueTodayWindow` and `overdueWindow` — read the next action
   * and a park coming back, and nothing else. The table's own Next column and
   * the Next dropdown above it read `OWED_DATE_SQL`, which is those two plus
   * the salesman's own diary entry, because the BOOK has to show a promise
   * somebody broke whichever column it was written in.
   *
   * So a lead can be drawn "3 days overdue" in the Next column and be absent
   * from this view, and that is correct: §24 never demanded a diary entry, and
   * a worklist for a rule should hold the rule's own population. What is not
   * allowed is the two using one word for two populations without saying so,
   * which is the whole of why these sentences name the difference. The handset
   * settled the same split — see `LEAD_WHENS` in `mbos-app/src/engines/leads.ts`.
   */
  today: {
    title: "Today's actions",
    subtitle:
      "What §24 says is owed today: a next action falling due, and a parked lead whose day has come. The same window the Actions screen reads — narrower than the Next column, which counts a salesman's own follow-up promise too.",
  },
  overdue: {
    title: "Overdue",
    subtitle:
      "Past its day with nobody having answered it, and parks read back late. The same window the Overdue screen reads — narrower than the Next column, which counts a salesman's own follow-up promise too.",
  },
  expected: {
    title: "Expected orders",
    subtitle:
      "A day AND a size — §3.4's commitment. A day on its own is a follow-up somebody has to make, not money anybody may forecast.",
  },
  lost30: {
    title: "Lost in the last 30 days",
    subtitle:
      "Leads that reached Lost within the window, with the reason each one was closed on. Nobody rings these again — they are here to be read, not worked.",
  },
  register: {
    title: "Distributors & third-party",
    subtitle:
      "Who sells our goods on, and the shops the goods actually go to. One register, because the two are one chain and reading either half alone leaves nobody to ask about the other.",
  },
  archived: {
    title: "Archived leads",
    subtitle:
      "Filed out of the way, newest first. Nothing here is deleted — restore one to put it back on the working list.",
  },
};

/**
 * The views offered as CHIPS above the table, in the order somebody reads
 * them: everything, then mine, then the two dated cuts, then the register.
 *
 * `expected` and `lost30` are deliberately absent. They are reachable, and
 * they are reachable from the tile that counts them — a chip strip that listed
 * every view would be seven chips over a nine-tile strip saying most of the
 * same words twice. `archived` is absent for its own reason: it is a different
 * book rather than a cut of this one, and it keeps the link it has always had
 * beside the export button.
 */
export const VIEW_CHIPS = ["all", "mine", "today", "overdue", "register"] as const satisfies
  readonly LeadView[];

/* ═══════════════════════════════════════════════════ §8.2 — the nine tiles */

export type LeadTileId =
  | "mine"
  | "today"
  | "overdue"
  | "suspects"
  | "prospects"
  | "sample"
  | "negotiation"
  | "expected"
  | "lost30";

export type LeadTile = {
  id: LeadTileId;
  label: string;
  /** What the number MEANS, drawn under it. A count with no sentence gets read
   *  as whichever thing the reader was already worried about. */
  hint: string;
  /**
   * `warn` and `danger` are earned by the QUESTION and never by the size of
   * the number — the same rule the manager dashboard's own strip states. A
   * forecast drawn red teaches people to ignore the colours.
   */
  tone: "brand" | "warn" | "danger" | "muted";
  /**
   * WHAT PRESSING IT PUTS ON THE URL, laid over whatever is already there.
   *
   * This is the whole mechanism. A tile that carries `stage` is asking the
   * filter bar a question it already answers, so its count and its destination
   * are one clause with no second definition; a tile that carries `view` is
   * asking the one function in `lead-views-service.ts` that both the count and
   * the page of rows go through. Either way the tile cannot be wrong about the
   * list behind it, because there is nothing separate for it to be wrong with.
   */
  params: Record<string, string>;
};

/**
 * THE NINE §8.2 NAMES, in the order it names them.
 *
 * Every one is a DOOR. A figure nobody can get behind is one they have to take
 * on trust, which is the thing a summary strip exists not to be.
 *
 * The five stage tiles spell their rungs out, and that is deliberate rather
 * than derived from a band: `bandOf` maps twenty-three rungs onto four funnel
 * bands, which is the right vocabulary for a funnel and the wrong one here —
 * "In sample" is three consecutive rungs and "Prospects" is one, and folding
 * either into a band would make a tile that opens a list its own number does
 * not describe. They are written as the filter values the bar itself offers,
 * so a rung renamed in the enum fails the stage filter and this together.
 */
export const LEAD_TILES: readonly LeadTile[] = [
  {
    id: "mine",
    label: "My leads",
    hint: "Carrying one of your seats.",
    tone: "brand",
    params: { view: "mine" },
  },
  {
    id: "today",
    label: "Today's actions",
    hint: "Owed today — promises and parks read back.",
    tone: "brand",
    params: { view: "today" },
  },
  {
    id: "overdue",
    label: "Overdue",
    /* DANGER on the question rather than on the number: §24 exists because a
       lead sits for six weeks with everybody assuming somebody else is holding
       it, and one of these is already that. */
    hint: "Past its day and nobody has answered it.",
    tone: "danger",
    params: { view: "overdue" },
  },
  {
    id: "suspects",
    label: "New suspects",
    /* `new` beside `suspect` because the legacy six-rung ladder is still under
       every lead raised before the funnel shipped — `lead-labels.ts` keeps it
       first in the enum and nothing backfills a sales type onto one. A tile
       that counted only the new word would quietly leave those leads out of
       the one figure that is supposed to say how much unworked book there is. */
    hint: "Nobody has decided about these yet.",
    tone: "brand",
    params: { stage: "suspect,new" },
  },
  {
    id: "prospects",
    label: "Prospects",
    /* `contacted` is the legacy ladder's second rung and is the same fact:
       somebody has spoken to them and nobody has qualified them. */
    hint: "Worth something, not yet qualified.",
    tone: "brand",
    params: { stage: "prospect,contacted" },
  },
  {
    id: "sample",
    label: "In sample",
    /* Three rungs, because stock has left the godown at all three and the
       question — has anybody written down what the customer thought — is the
       same one at each. */
    hint: "Stock is out and a verdict is owed.",
    tone: "warn",
    params: { stage: "sample_trial,sample_received,sample_review" },
  },
  {
    id: "negotiation",
    label: "Negotiations",
    hint: "A commercial conversation is open.",
    tone: "brand",
    params: { stage: "negotiation" },
  },
  {
    id: "expected",
    label: "Expected orders",
    /* NOT drawn as a problem however large it gets. A commitment is a plan;
       the block that wants a manager today is the slipped one, and that is the
       dashboard's, one tab along. */
    hint: "A day and a size somebody wrote down.",
    tone: "brand",
    params: { view: "expected" },
  },
  {
    id: "lost30",
    label: "Lost (30 days)",
    /* MUTED, and it is the only tile here that is not work. It is on the strip
       because §8.2 names it and because a funnel with no visible bottom is one
       nobody learns from — but drawn at the weight of a queue it would read as
       something to go and do. */
    hint: "Closed in the last 30 days, with reasons.",
    tone: "muted",
    params: { view: "lost30" },
  },
];

/* ═══════════════════════════════════ the register, and the retired ladder */

/**
 * WHETHER THE DISTRIBUTOR HALF OF THE REGISTER IS STILL BEING FED.
 *
 * Read off `SALES_TYPES` rather than asserted, because that is where the
 * decision lives: Mahek withdrew the distributor ladder — nine rungs through a
 * management review and a two-step appointment approval nobody in the building
 * had the authority to complete — and the whole of the withdrawal is a single
 * `retired: true`. A register that drew a Distributors column and said nothing
 * would read as a book somebody is still filling, and the leads in it would
 * read as work in progress rather than as leads parked half way up a ladder
 * that closed. Deleting the `retired` line turns this sentence off everywhere
 * at once, exactly as it turns the ladder back on.
 *
 * Null where the ladder is live — there is nothing to explain.
 */
export function retiredLadderNote(): string | null {
  const distributor = SALES_TYPES.find((s) => s.code === "distributor");
  if (!distributor?.retired) return null;
  return "No new lead can be started on the distributor ladder — it was withdrawn because nobody in the building could complete its appointment approval. The leads listed under it are the ones already on it: they keep their rung, their gates and their profile, and they can still be advanced. Nothing is being added.";
}
