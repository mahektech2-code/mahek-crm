import type { LeadVantage } from "./engines/lead-role-action";

/* ---------------------------------------------------------------------------
 * WHICH OF THE FIVE JOBS IS THIS PERSON DOING ON THIS LEAD.
 *
 * `engines/lead-role-action.ts` is emphatic about the distinction and this
 * file is the other half of it, so the argument is worth restating rather than
 * pointed at: a VANTAGE IS NOT A ROLE AND IT IS NOT A CAPABILITY. MahekOne has
 * three levels and per-app grants — `access-control.ts` says a role is a level
 * and the app is the job — and there is deliberately no `management` role and
 * no `back_office` role anywhere in the product. Management is `admin` holding
 * `distributor.approve`; the back office is a SEAT on the row,
 * `customers.back_office_am_id`, held by somebody whose hat is an ordinary CRM
 * one. §2's five actors are a way of reading a lead, not five new values for
 * `users.role`, and adding them as roles would teach scope, the console, the
 * audit log and every switcher a vocabulary that exists nowhere else.
 *
 * So this answers exactly one question: WHAT SENTENCE TO PUT IN FRONT OF
 * SOMEBODY. It decides no rights whatever. Every action in
 * `lib/actions/leads.ts` goes on asking `requireCapability`, because a server
 * action is a URL and a sentence is not a permission, and a reader who
 * mistakes this for the security boundary might delete a real check believing
 * it redundant. It is the same shape as the rule about a territory narrowing a
 * book without being a permission.
 *
 * PURE AND CLIENT-SAFE, like `customer-health`, `seat-labels` and
 * `account-types` beside it, and for the reason all three are: the leads list
 * is a client component and resolves this PER ROW — two of the five vantages
 * are read off seats on the row rather than off the person — so a copy of the
 * rule typed into a screen would be a second answer that drifts, and the half
 * that drifts is always the half somebody is reading. The hats are read once
 * on the server (`services/lead-vantage-service.ts`) and handed down as four
 * booleans; nothing here performs I/O.
 * ------------------------------------------------------------------------- */

/**
 * What the person brings to the row, resolved from their hats ONCE.
 *
 * Booleans rather than the hats themselves, deliberately: `Hat[]` would put
 * the capability matrix in the browser and invite a screen to ask it a
 * question about rights, which is the exact confusion the header above spends
 * thirty lines preventing. Four answers, all of them about words.
 */
export type VantageViewer = {
  /** The signed-in person, compared against the seats on the row. */
  id: string;
  /**
   * Holds `field` — MBOS, the handset. It is the one grant that means "this
   * person walks a beat", which is what makes it the right test for the
   * salesman vantage rather than the level: a field salesman is an ASSOCIATE,
   * and so is a telecaller, and so is an accounts clerk.
   */
  holdsField: boolean;
  /**
   * Management, as §2 means it — which in this product is `distributor.approve`
   * and admin's alone. Asked as the capability rather than as `role === admin`
   * so the sentence follows the matrix: if the capability is ever widened,
   * whoever gains it starts reading "Approval required" on the leads that are
   * waiting for them, rather than on the day somebody remembers this file.
   */
  canApproveDistributors: boolean;
  /** Manager level on a lead-carrying app — the CRM or the Sales Dashboard. */
  isSalesManager: boolean;
  /**
   * Holds the CRM at all. The calling desk is the CRM's associate — the
   * telecaller — and this is the floor rather than a job title: somebody with
   * the CRM and nothing else is on the phones.
   */
  holdsCrm: boolean;
};

/**
 * The seats ON THE ROW, which is where two of the five vantages come from.
 *
 * `back_office_am_id` is dispatch, billing and paperwork — AGENTS.md's own
 * note on the brief's "Logistics" actor says so in as many words, and says why
 * no such role was created. `owner_id` is whose book the lead is on, which is
 * what `ASSIGNED_TO_SQL` reads for a lead.
 *
 * `leadManagerId` is deliberately NOT a vantage of its own. It is the
 * coordinating seat and the person in it is doing the sales manager's job on
 * this lead, which is the vantage §7 already gives them; a sixth entry for it
 * would be a sixth column in a table that has five.
 */
export type VantageSeats = {
  ownerId: string | null;
  backOfficeAmId: string | null;
  leadManagerId: string | null;
};

/**
 * EVERY VANTAGE THIS PERSON HOLDS ON THIS LEAD, most specific first.
 *
 * Several rather than one, because on nine people several is the ordinary
 * case: a sales manager is routinely also the lead manager, and a CRM manager
 * who was given the handset to try it out holds the salesman vantage on his
 * own leads. Returning one would mean picking silently, and the two screens
 * that read this want different halves of the answer — the row's own column
 * wants the instruction for the job the reader is most plainly doing, and the
 * expanded panel wants the whole table so a manager can see what is owed by
 * whom. One function answers both; a "primary" computed twice would not.
 *
 * THE ORDER IS SEATS BEFORE HATS, and that is the load-bearing decision. A
 * seat is a fact about THIS ROW — somebody put this person's name on this
 * lead — while a hat is a fact about the person and is true of all four
 * hundred of them. So a manager who is also the named back office person on
 * one lead reads "Dispatch sample" on that one and "Verify prospect" on the
 * rest, which is exactly right: the specific instruction is the one he can act
 * on this afternoon. Management sits above `sales_manager` for the same reason
 * one level up — an approval is work nobody else in the building can do, and a
 * manager's verb offered in its place would hide the only thing that is
 * actually waiting.
 *
 * An empty array is a real answer and callers must draw it as one: somebody
 * holding the leads module through an app that gives them no job on this
 * particular shop. It is NOT the same as `calling_desk`, and defaulting to a
 * job nobody holds would put a telecaller's instruction in front of an
 * accounts clerk.
 */
export function vantagesFor(viewer: VantageViewer, seats: VantageSeats): LeadVantage[] {
  const out: LeadVantage[] = [];

  /* Both halves are asked. Owning a lead without the handset is an office
   * person holding a book — which happens on an imported book, where
   * `owner_id` is whoever ran the import — and telling them to go and visit
   * the shop would be an instruction nobody in that seat can carry out. */
  if (viewer.holdsField && seats.ownerId === viewer.id) out.push("salesman");

  if (seats.backOfficeAmId === viewer.id) out.push("back_office");

  if (viewer.canApproveDistributors) out.push("management");

  /* The lead manager is doing this job on this row whatever level their
   * account carries, which is the point of the seat: the office asks that
   * somebody coordinates the conversion, and the sentence in front of them has
   * to be the one about coordinating it. */
  if (viewer.isSalesManager || seats.leadManagerId === viewer.id) out.push("sales_manager");

  if (viewer.holdsCrm && !viewer.isSalesManager) out.push("calling_desk");

  return out;
}

/**
 * The one to print where there is room for one.
 *
 * Null rather than a fallback, because the fallback would have to be a guess
 * about somebody's job and the screen can say "no job on this lead" honestly.
 */
export function primaryVantage(
  viewer: VantageViewer,
  seats: VantageSeats,
): LeadVantage | null {
  return vantagesFor(viewer, seats)[0] ?? null;
}

/**
 * The five, in the order a manager reads them down the ladder, and their
 * words.
 *
 * Here rather than in the engine because the engine answers about ONE vantage
 * and never has to name the others; this is the vocabulary the cross-vantage
 * panel needs, and it is the same reason `lead-labels.ts` sits apart from
 * `lead-ladder.ts`. The order is the shape of the work — the field, then the
 * phones, then the two people who decide, then the desk that ships it.
 */
export const LEAD_VANTAGES: readonly LeadVantage[] = [
  "salesman",
  "calling_desk",
  "sales_manager",
  "management",
  "back_office",
] as const;

const VANTAGE_LABELS: Record<LeadVantage, string> = {
  salesman: "Salesman",
  calling_desk: "Calling desk",
  sales_manager: "Sales manager",
  management: "Management",
  back_office: "Back office",
};

export function vantageLabel(vantage: LeadVantage): string {
  return VANTAGE_LABELS[vantage];
}

/**
 * "You, as the sales manager" — the possessive form, for a row that is
 * printing the reader's OWN instruction.
 *
 * A column headed with somebody else's job title reads as a column about
 * somebody else, and on a list of four hundred rows that is the difference
 * between a worklist and a report.
 */
export function vantageAsYou(vantage: LeadVantage): string {
  return `You, as the ${VANTAGE_LABELS[vantage].toLowerCase()}`;
}
