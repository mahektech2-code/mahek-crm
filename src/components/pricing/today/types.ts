/* The Today screen's view types — client-safe, read by the server service and the screen. */

export type NeedKind =
  | "billed_below"
  | "change_to_approve"
  | "special_price"
  | "no_book"
  | "book_expiring"
  | "document_review"
  | "finding";

export type NeedRow = {
  key: string;
  kind: NeedKind;
  /** For a finding, its own kind (ladder, typo…). */
  findingKind: string | null;
  severity: "high" | "medium" | "low" | null;
  title: string;
  detail: string;
  /** Money at stake a month, paise. Null where nothing can be put on it. */
  moneyPaise: number | null;
  /** A suffix under the door's basePath, e.g. `/books/b1/changes/c1`. */
  href: string;
  /** A change this viewer made: somebody else approves it. */
  raisedByYou: boolean;
};

export type WeekEvent = {
  key: string;
  day: string;
  kind: "go_live" | "waiting_approval" | "expiring";
  title: string;
  href: string;
};

export type TodayFinding = {
  id: string;
  kind: string;
  severity: "high" | "medium" | "low";
  bookId: string | null;
  listId: string | null;
  productId: string | null;
  message: string;
  moneyPaise: number | null;
  href: string;
};

export type PriceDeskToday = {
  day: string;
  counts: {
    booksInForce: number;
    changesWaiting: number;
    goingLiveThisWeek: number;
    specialPricesWaiting: number;
    billedBelowPaise: number;
  };
  needs: NeedRow[];
  week: Array<{ day: string; events: WeekEvent[] }>;
  findings: TodayFinding[];
  /** When the morning check last ran for today, or null if it has not. */
  checkedAt: string | null;
  dismissedToday: number;
};
