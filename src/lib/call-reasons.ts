/**
 * WHY THE CUSTOMER RANG, and what each answer asks for next.
 *
 * The panel used to ask one question — "what was the outcome?" — and make it
 * do two jobs. An outcome is how the call ENDED; a reason is what the customer
 * wanted when they picked up the phone, and on an inbound call those are
 * routinely different: somebody rings to ask a price and the call ends as a
 * follow-up. Collapsed into one enum, the first half was simply not recorded,
 * and "how many people rang us about price this quarter" was a grep over free
 * text rather than a question anybody could ask.
 *
 * PURE and client-safe, like `lib/complaint-labels.ts` and
 * `lib/account-types.ts` beside it: the form that writes these runs in a
 * browser while the service that validates them is `server-only`, and a second
 * copy typed into the screen is one that drifts inside a release — the half
 * that drifts always being the half somebody reads.
 *
 * Every list here is a CODE with a label beside it, never a stored label. A
 * stored label stops resolving the moment somebody rewords it, and the reason
 * these exist at all is to be counted.
 */

/* --------------------------------------------------------------- who rang */

/**
 * WHO PICKED UP THE PHONE AT THEIR END.
 *
 * A price question from the owner and the same question from a store boy are
 * not the same call, and the second is not worth a salesman's visit. There is
 * no contact master to read this from — `customers.contact_person` is one free
 * text field holding whoever last answered — so it is ASKED, and the name box
 * beside it is what a contact master would eventually be built out of.
 */
export const CALLER_ROLES = [
  { code: "owner", label: "Owner / Proprietor" },
  { code: "purchase", label: "Purchase Person" },
  { code: "accounts", label: "Accounts Person" },
  { code: "store", label: "Store / Warehouse" },
  { code: "production", label: "Production" },
  { code: "other", label: "Other" },
] as const;

export type CallerRole = (typeof CALLER_ROLES)[number]["code"];

export const CALLER_ROLE_LABEL: Record<string, string> = Object.fromEntries(
  CALLER_ROLES.map((r) => [r.code, r.label]),
);

/* ------------------------------------------------------------ why they rang */

/**
 * The ten. Ordered as the business thinks of them rather than alphabetically:
 * an order first, money in the middle, and the residual last.
 *
 * `other` is the residual and it is REQUIRED to exist — without one, a caller
 * whose reason is not on the list is recorded under whichever option looks
 * nearest, which is worse than being recorded as unclassified. It is the same
 * discipline the product mix categories keep, one module over.
 */
export const CALL_REASONS = [
  { code: "place_order", label: "Place an Order" },
  { code: "price_quotation", label: "Price / Quotation" },
  { code: "product_enquiry", label: "Product Enquiry" },
  { code: "stock_availability", label: "Stock Availability" },
  { code: "payment_outstanding", label: "Payment / Outstanding" },
  { code: "delivery_transport", label: "Delivery / Transport" },
  { code: "complaint", label: "Complaint" },
  { code: "technical_support", label: "Product / Technical Support" },
  { code: "followup_previous", label: "Follow-up on Previous Discussion" },
  { code: "other", label: "Other" },
] as const;

export type CallReason = (typeof CALL_REASONS)[number]["code"];

export const CALL_REASON_LABEL: Record<string, string> = Object.fromEntries(
  CALL_REASONS.map((r) => [r.code, r.label]),
);

/** The codes alone. Typed, so the save schema can build a zod enum from it
 *  rather than retyping ten strings that would then be free to drift. */
export const CALL_REASON_CODES: CallReason[] = CALL_REASONS.map((r) => r.code);

/* ------------------------------------------------------------ next actions */

/**
 * WHAT SOMEBODY HAS TO DO NOW, as a code per reason.
 *
 * Deliberately not one flat list: "Arrange Stock" against a price enquiry is
 * an answer to a question nobody asked, and a dropdown offering it teaches
 * people to stop reading the dropdown. `nextActionsFor` is the only place the
 * mapping lives, and the server validates against the same function the form
 * draws from — a screen is not a rule.
 */
const NEXT_ACTIONS: Record<string, Array<{ code: string; label: string }>> = {
  place_order: [
    { code: "confirm_order", label: "Confirm the order" },
    { code: "check_stock", label: "Check stock" },
    { code: "call_back", label: "Call back" },
  ],
  price_quotation: [
    { code: "send_price", label: "Send price" },
    { code: "send_quotation", label: "Send quotation" },
    { code: "call_back", label: "Call back" },
    { code: "salesman_visit", label: "Salesman visit" },
  ],
  product_enquiry: [
    { code: "send_brochure", label: "Send brochure" },
    { code: "send_technical", label: "Send technical details" },
    { code: "send_sample", label: "Send sample" },
    { code: "salesman_visit", label: "Salesman visit" },
    { code: "call_back", label: "Call back" },
  ],
  stock_availability: [
    { code: "confirm_stock", label: "Confirm stock" },
    { code: "arrange_stock", label: "Arrange stock" },
    { code: "inform_customer", label: "Inform the customer" },
    { code: "alternative_product", label: "Offer an alternative product" },
  ],
  payment_outstanding: [
    { code: "payment_date_given", label: "Payment date given" },
    { code: "payment_already_made", label: "Payment already made" },
    { code: "payment_proof_required", label: "Payment proof required" },
    { code: "accounts_follow_up", label: "Accounts follow-up" },
    { code: "other", label: "Other" },
  ],
  delivery_transport: [
    { code: "check_transport", label: "Check with transport" },
    { code: "contact_logistics", label: "Contact logistics" },
    { code: "contact_customer", label: "Contact the customer" },
    { code: "escalate", label: "Escalate" },
  ],
  complaint: [
    { code: "raise_complaint", label: "Raise the complaint" },
    { code: "salesman_visit", label: "Salesman visit" },
    { code: "call_back", label: "Call back" },
  ],
  technical_support: [
    { code: "send_technical", label: "Send technical details" },
    { code: "salesman_visit", label: "Salesman visit" },
    { code: "call_back", label: "Call back" },
  ],
  followup_previous: [
    { code: "call_back", label: "Call back" },
    { code: "salesman_visit", label: "Salesman visit" },
    { code: "other", label: "Other" },
  ],
  other: [
    { code: "call_back", label: "Call back" },
    { code: "other", label: "Other" },
  ],
};

/**
 * WHAT AN ORDER TAKEN NEEDS NEXT, and it comes off the OUTCOME rather than the
 * reason.
 *
 * The reason is what the customer wanted when they rang; once the call has
 * ended in an order, what happens next is about the order and nothing else —
 * somebody who rang to ask a price and ended up ordering needs chasing for
 * payment or dispatch, not sending a quotation. So this list REPLACES the
 * reason's own rather than adding to it.
 *
 * `no_follow_up` is the first of the four and it is the point of the set: an
 * order that needs nothing is a real answer, and the only way to tell it from
 * a telecaller who skipped the question is to let them say it. The same shape
 * as "they would not commit to a date" on the No Order form, for the same
 * reason — a blank box cannot tell the two apart.
 */
const OUTCOME_ACTIONS: Record<string, Array<{ code: string; label: string }>> = {
  order_taken: [
    { code: "no_follow_up", label: "No further follow-up required" },
    { code: "follow_up_payment", label: "Follow up for payment" },
    { code: "follow_up_dispatch", label: "Follow up for dispatch" },
    { code: "follow_up_after_delivery", label: "Follow up after delivery" },
  ],
  no_order: [
    { code: "call_back", label: "Call again" },
    { code: "salesman_visit", label: "Visit customer" },
    { code: "send_price", label: "Send price" },
    { code: "send_brochure", label: "Send product information" },
    { code: "send_sample", label: "Send sample" },
    { code: "check_stock", label: "Check stock" },
    { code: "discuss_manager", label: "Discuss with manager" },
    { code: "no_follow_up", label: "No further action" },
  ],
  follow_up: [
    { code: "call_back", label: "Call again" },
    { code: "send_quotation", label: "Send quotation" },
    { code: "send_price_list", label: "Send price list" },
    { code: "send_brochure", label: "Send product brochure" },
    { code: "send_sample", label: "Send sample" },
    { code: "salesman_visit", label: "Arrange a visit" },
    { code: "check_stock", label: "Check stock" },
    { code: "discuss_manager", label: "Discuss with manager" },
  ],
  payment_promised: [
    { code: "follow_up_on_promise", label: "Follow up on the promised date" },
    { code: "follow_up_before_promise", label: "Follow up before the promised date" },
    { code: "no_follow_up", label: "No further action" },
  ],
};

/*
 * THE CODES ARE SHARED WHERE THE ACT IS THE SAME, and the labels are not.
 *
 * "Visit customer" on a No Order and "Arrange a visit" on a Follow-up are one
 * thing said two ways, and two codes would split the number somebody actually
 * wants — "how many visits did the phones ask for this month" answered by
 * adding two columns is the sort of figure that is quietly wrong for a year.
 * So the code is one and each list keeps the words its own screen reads best.
 * `NEXT_ACTION_LABEL` takes the FIRST definition it meets, which is what a
 * history screen renders months later when the list it came from may have been
 * re-cut — one canonical phrasing rather than whichever list was searched
 * first.
 */

/**
 * `no_follow_up` is EXCLUSIVE — it is the absence of the other three, and
 * "nothing further is needed, and also chase the payment" is not a sentence.
 * Enforced in the action and on the form, because a contradiction saved is one
 * nobody can read back.
 */
export const EXCLUSIVE_ACTION = "no_follow_up";

export function nextActionsFor(
  reason: string | null | undefined,
  outcome?: string | null,
): Array<{ code: string; label: string }> {
  /*
   * THE OUTCOME WINS WHERE IT HAS A LIST.
   *
   * The reason is what the customer wanted when they rang; the outcome is what
   * actually happened, and once a call has ended in an order or a refusal the
   * reason has been overtaken. Somebody who rang to ask a price and ended up
   * ordering needs chasing for payment, not sending a quotation.
   *
   * It is also what lets an OUTBOUND call answer this at all: it has no reason
   * to look up, and the four things an order needs next are the same whoever
   * dialled.
   */
  if (outcome && OUTCOME_ACTIONS[outcome]) return OUTCOME_ACTIONS[outcome];
  if (!reason) return [];
  return NEXT_ACTIONS[reason] ?? [];
}

/**
 * Every action code that exists anywhere, for the label lookup a history
 * screen needs — it reads a code stored months ago against a reason whose list
 * may since have been re-cut, so it cannot go through `nextActionsFor`.
 */
export const NEXT_ACTION_LABEL: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const list of [...Object.values(OUTCOME_ACTIONS), ...Object.values(NEXT_ACTIONS)]) {
    for (const a of list) if (!(a.code in map)) map[a.code] = a.label;
  }
  return map;
})();

/**
 * The actions that MEAN a date — somebody has undertaken to do a thing, and a
 * thing undertaken with no day against it is the definition of how a call gets
 * forgotten. The panel asks for one and `saveInteraction` turns it into a
 * reminder, which is the same mechanism a promised payment already uses rather
 * than a second one beside it.
 */
const DATED_ACTIONS = new Set([
  "send_price",
  "send_quotation",
  "send_brochure",
  "send_technical",
  "send_sample",
  "salesman_visit",
  "call_back",
  "arrange_stock",
  "check_stock",
  "check_transport",
  "contact_logistics",
  "contact_customer",
  "accounts_follow_up",
  "payment_proof_required",
  "escalate",
  /* An order chased with no day against it is an order nobody chases. The
     fourth of that set, `no_follow_up`, is deliberately absent: it is the
     statement that there is nothing to put a date on. */
  "follow_up_payment",
  "follow_up_dispatch",
  "follow_up_after_delivery",
  "send_price_list",
  "discuss_manager",
  /*
   * BOTH PAYMENT CHASES TAKE A DAY, including the one "on the promised date" —
   * which sounds like it needs none, and is exactly the one that does. A
   * promise date can be pushed off a Sunday, and the chase is a different act
   * on a different desk from the promise itself; deriving its day from the
   * promise would leave "follow up BEFORE the promised date" with no day at
   * all, since the whole point of it is that it is earlier.
   */
  "follow_up_on_promise",
  "follow_up_before_promise",
]);

export function wantsDate(actions: string[]): boolean {
  return actions.some((a) => DATED_ACTIONS.has(a));
}

/**
 * Which reminder a next action becomes. `send_information` and `check_stock`
 * have been in `reminderTypeEnum` since the CRM shipped with nothing ever
 * writing one; these are what they were for.
 */
export function reminderTypeFor(
  actions: string[],
): "call_back" | "payment_promise" | "order_confirmation" | "send_information" | "check_stock" | "other" {
  /* The order's own chases first: they are the whole of what an Order Taken
     call produces, and reading them as a generic call-back would file the
     payment chase under the same heading as "ring them next week". */
  if (
    actions.includes("follow_up_payment") ||
    actions.includes("follow_up_on_promise") ||
    actions.includes("follow_up_before_promise")
  ) {
    return "payment_promise";
  }
  if (actions.includes("follow_up_dispatch")) return "order_confirmation";
  if (actions.includes("follow_up_after_delivery")) return "call_back";
  if (actions.some((a) => a === "check_stock" || a === "arrange_stock")) {
    return "check_stock";
  }
  if (
    actions.some(
      (a) =>
        a === "send_price" ||
        a === "send_quotation" ||
        a === "send_brochure" ||
        a === "send_price_list" ||
        a === "send_technical",
    )
  ) {
    return "send_information";
  }
  if (actions.includes("call_back")) return "call_back";
  return "other";
}

/* --------------------------------------------------------- delivery issues */

/** §Delivery — what is actually wrong, as a code rather than a sentence. */
export const DELIVERY_ISSUES = [
  { code: "not_received", label: "Not received" },
  { code: "delayed", label: "Delayed" },
  { code: "tracking_required", label: "Tracking required" },
  { code: "short_delivery", label: "Short delivery" },
  { code: "damaged", label: "Damaged" },
  { code: "other", label: "Other" },
] as const;

export const DELIVERY_ISSUE_LABEL: Record<string, string> = Object.fromEntries(
  DELIVERY_ISSUES.map((i) => [i.code, i.label]),
);

/* ----------------------------------------------------------- what is asked */

/**
 * The detail each reason collects, as data rather than as JSX.
 *
 * The panel renders this list and `saveInteraction` validates against it, so
 * the form and the rule cannot disagree about which box is mandatory — the
 * mistake this codebase already records for the payment-followup outcomes,
 * which is why those are declared once too.
 *
 * `required` is the narrow set: the answer without which the record says
 * nothing. A price enquiry with no product named is a note saying somebody
 * rang about a price, and the whole point of the section is to stop that.
 */
export type ReasonField = {
  key: string;
  label: string;
  kind: "text" | "number" | "date" | "yesno" | "choice";
  required?: boolean;
  hint?: string;
  /** `choice` only. */
  options?: ReadonlyArray<{ code: string; label: string }>;
};

const REASON_FIELDS: Record<string, ReasonField[]> = {
  price_quotation: [
    { key: "product", label: "Product", kind: "text", required: true },
    {
      key: "approxQuantity",
      label: "Approximate quantity",
      kind: "text",
      hint: "In their own words — “about 20 cans a month” is an answer.",
    },
    { key: "packaging", label: "Packaging", kind: "text" },
    {
      key: "expectedPrice",
      label: "Existing / expected price",
      kind: "text",
      hint: "What they are paying now, or what they are asking for.",
    },
    { key: "quotationRequired", label: "Quotation required?", kind: "yesno" },
  ],
  product_enquiry: [
    { key: "product", label: "Product", kind: "text", required: true },
    {
      key: "application",
      label: "Requirement / application",
      kind: "text",
      hint: "What they want it for. “Thinner for a spray booth” is the useful answer.",
    },
    { key: "quantityPotential", label: "Quantity potential", kind: "text" },
    { key: "newProduct", label: "New product enquiry?", kind: "yesno" },
  ],
  stock_availability: [
    { key: "product", label: "Product", kind: "text", required: true },
    { key: "requiredQuantity", label: "Required quantity", kind: "text" },
    { key: "requiredDate", label: "Required by", kind: "date" },
  ],
  payment_outstanding: [
    {
      key: "customerQuery",
      label: "What they asked",
      kind: "text",
      required: true,
      hint: "Their question about the money, in their words.",
    },
    {
      key: "paymentStatus",
      label: "What they say the position is",
      kind: "text",
      hint: "“Cheque posted Tuesday”, “disputing the last bill”.",
    },
  ],
  delivery_transport: [
    {
      key: "orderRef",
      label: "Order / invoice number",
      kind: "text",
      hint: "Whatever they quoted. MahekOne does not hold the transporter or the LR number yet.",
    },
    {
      key: "issue",
      label: "Issue",
      kind: "choice",
      required: true,
      options: DELIVERY_ISSUES,
    },
  ],
  technical_support: [
    { key: "product", label: "Product", kind: "text", required: true },
    {
      key: "problem",
      label: "What is going wrong",
      kind: "text",
      required: true,
    },
  ],
};

export function reasonFieldsFor(reason: string | null | undefined): ReasonField[] {
  if (!reason) return [];
  return REASON_FIELDS[reason] ?? [];
}

/**
 * Whether this reason wants the ledger read back to the telecaller.
 *
 * The outstanding figure and the open bills are already on the panel — fetched
 * for the script's placeholders — and a payment conversation held without them
 * on screen is one where the telecaller asks the customer what they owe.
 */
export function showsLedger(reason: string | null | undefined): boolean {
  return reason === "payment_outstanding";
}

/**
 * Reasons that have no record behind them in MahekOne, and the sentence the
 * screen says so with.
 *
 * There is no quotation record to project from and no inventory to check — the
 * brief asks for both and neither exists, and a screen that implied otherwise
 * would have a telecaller telling a customer stock is confirmed on the
 * strength of a dropdown. Naming the gap is what turns it into something
 * somebody can fix; a silent one never does.
 */
export function unbackedBy(reason: string | null | undefined): string | null {
  if (reason === "price_quotation") {
    return "MahekOne holds no quotation record yet, so this is captured against the call. Whoever sends the quotation still sends it themselves.";
  }
  if (reason === "stock_availability") {
    return "There is no stock system connected, so nothing here checks availability. Confirm with the godown before telling the customer.";
  }
  return null;
}
