/* ---------------------------------------------------------------------------
 * The three decision queues, in one shape.
 *
 * Orders, payments and credit notes are the same screen asked three times: a
 * list oldest-first, a drawer that says what you are deciding, and two buttons
 * where the negative one demands a reason. Writing it three times is how the
 * three drift — the design drew one, and this is its type.
 *
 * Client-safe: no `server-only` import, because the screen that renders it is
 * a client component and these are plain values by the time they arrive.
 * ------------------------------------------------------------------------- */

export type QueueKind = "orders" | "payments" | "credits";

export type QueueRow = {
  id: string;
  customerId: string;
  customerName: string;
  /** Paise. What approving, confirming or issuing this row is worth. */
  amount: number;
  /** Hours since it landed. Oldest first, everywhere. */
  waitingHours: number;
  /**
   * Column two: who put it here, over when they did. Two lines rather than one
   * joined string — a name and a timestamp on one line is the pair that gets
   * truncated first, and losing the time is losing the reason the row is here.
   */
  byName: string | null;
  byWhen: string;
  /** Under the customer's name: the contact, the source, or the complaint. */
  byMeta: string;
  /** Column three: middle detail, different per queue. */
  middle: string;
  /**
   * A second line under it. The payment reference lives here rather than
   * joined onto the mode: it is the string accounts match against the bank
   * statement, and it was the half that got truncated away.
   */
  middleSub?: string;
  /** Column four: right-aligned context — owed, or the bill named. */
  context: string;
  contextTone: "danger" | "muted" | "warn" | "body";
  /** Shown against the customer's name. */
  slowPayer: boolean;
  overdueBills: number;
  /**
   * Something about this row a person should look at before deciding — a
   * credit note naming no bill, say. It tones the middle cell and it is what
   * the "needs a second look" metric counts, so the number and the highlight
   * can never describe different rows.
   */
  needsAttention?: boolean;
};

/** What the drawer shows once a row is opened. Loaded per row, never in bulk. */
export type OrderDetail = {
  kind: "orders";
  outstanding: number;
  overdueBills: number;
  slowPayer: boolean;
  creditDays: number | null;
  lineCount: number;
  takenByName: string | null;
  orderedAt: string;
  contact: string;
};

export type PaymentDetail = {
  kind: "payments";
  mode: string;
  reference: string | null;
  receivedAt: string;
  note: string | null;
  source: string;
  reportedAt: string;
  outstanding: number;
  lines: Array<{ billId: string | null; billNo: string | null; amount: number }>;
  onAccount: number;
};

export type CreditDetail = {
  kind: "credits";
  categoryLabel: string;
  description: string;
  goodsDescription: string | null;
  raisedAt: string;
  billNo: string | null;
  billBalance: number | null;
  outstanding: number;
  photos: Array<{ id: string; filename: string }>;
  /** Null where the telecaller recorded no figure — accounts set it. */
  requestedAmount: number | null;
};

export type QueueDetail = OrderDetail | PaymentDetail | CreditDetail;

/** Where a reported payment came from, in words rather than a stored word. */
export const SOURCE_WORDS: Record<string, string> = {
  collections_call: "Reported on a collections call",
  bills_screen: "Entered against a bill",
  accounts: "Entered by accounts",
  sheet_import: "From the payment sheet",
};

export const QUEUE_COPY: Record<
  QueueKind,
  {
    title: string;
    subtitle: string;
    managerNotice: string;
    emptyTitle: string;
    emptyBody: string;
    negative: string;
    reasonLabel: string;
    reasonPlaceholder: string;
    reasonHint: string;
    reasonButton: string;
    columns: [string, string, string, string, string, string, string];
  }
> = {
  orders: {
    title: "Order approvals",
    subtitle:
      "Every order taken on a call waits here. Nothing is billed, and nothing counts towards a target, until it is approved.",
    managerNotice:
      "Approving an order is the accounts team’s. Nothing here is actionable for you.",
    emptyTitle: "Nothing waiting",
    emptyBody:
      "Every order taken has been decided. New ones appear here the moment a telecaller logs them.",
    negative: "Decline",
    reasonLabel: "Why it is being declined",
    reasonPlaceholder: "Outstanding is over their limit — clear the June bills first.",
    reasonHint:
      "The telecaller sees this and has to ring the customer back with it, so write something they can repeat.",
    reasonButton: "Decline this order",
    columns: ["Customer", "Taken", "Owed now", "Items", "Order value", "Waiting", ""],
  },
  payments: {
    title: "Payments to confirm",
    subtitle:
      "Money somebody has been told about and nobody has found yet. Nothing here has moved a bill, and the customer is not being chased for it in the meantime.",
    managerNotice:
      "Confirming that money arrived is the accounts team’s, because they hold the bank statement.",
    emptyTitle: "Nothing waiting",
    emptyBody:
      "Every payment reported has been decided on. Money entered by accounts is confirmed as it is written and never appears here.",
    negative: "Reject",
    reasonLabel: "If the money never arrived",
    reasonPlaceholder: "Nothing against this reference in the statement for the whole week.",
    reasonHint:
      "This lands on the customer’s timeline. Whoever was told about the payment has to ring back and say something.",
    reasonButton: "Reject this payment",
    columns: ["Customer", "Reported by", "Received", "How", "Amount", "Waiting", ""],
  },
  credits: {
    title: "Credit note requests",
    subtitle:
      "A telecaller raised these on a complaint. Issuing one takes money off what the customer owes, so it is accounts who decide.",
    managerNotice:
      "Issuing a credit note is the accounts team’s. You can read the complaint and the amount asked for.",
    emptyTitle: "Nothing waiting",
    emptyBody:
      "No credit note has been asked for. Telecallers raise these from a complaint, and they arrive here the moment they do.",
    negative: "Refuse",
    reasonLabel: "Why it is being refused",
    reasonPlaceholder:
      "The seals were intact on the LR copy — this needs the transporter, not a credit.",
    reasonHint:
      "The telecaller who raised it has to explain this to the customer, so write it in their words.",
    reasonButton: "Refuse the request",
    columns: ["Customer", "Raised by", "Complaint", "Bill", "Asked for", "Waiting", ""],
  },
};
