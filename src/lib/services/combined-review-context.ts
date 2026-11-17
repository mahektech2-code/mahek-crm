import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/* ---------------------------------------------------------------------------
 * WHO MAY WRITE THE QUALIFICATION-ONLY ANSWERS FROM THE ONE REVIEW.
 *
 * `saveLeadQualification` and `saveProspectFields` refuse the Sales Manager the
 * answers Qualification keeps for the Telecaller who collects them, and refuse
 * them before Qualification opens. In the one-review flow the designated Sales
 * Manager answers them in the review itself, so those two refusals have to step
 * aside — for that one request and nothing else.
 *
 * It is a CONTEXT and never a parameter: both writers are server actions, and an
 * argument on a server action is an argument anybody can post. This can only be
 * entered by server code that has already asked who the person is
 * (`saveQualificationReviewEdits`), is tied to the one lead it was entered for,
 * and ends with the call.
 * ------------------------------------------------------------------------- */

const store = new AsyncLocalStorage<{ customerId: string }>();

export function runInCombinedReview<T>(customerId: string, fn: () => Promise<T>): Promise<T> {
  return store.run({ customerId }, fn);
}

export function inCombinedReview(customerId: string): boolean {
  return store.getStore()?.customerId === customerId;
}
