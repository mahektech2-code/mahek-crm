/**
 * The Salesman's eight Qualification answers, as the form stores them — for the
 * tests that need a lead standing at Qualification with everything collected.
 *
 * The gate reads these keys (`QUALIFICATION_ANSWER_KEYS`) beside four columns:
 * the GST number, the application, the credit days and the decision maker.
 * `qualificationColumns()` is those four, so a fixture can spread both and mean
 * "all eight are answered" without restating either.
 */
export const QUALIFICATION_ANSWERS: Record<string, string> = {
  trial_product: "PU Thinner",
  trial_pack: "20 L",
  trial_quantity: "2 cans",
  trial_tester: "Ramesh",
  trial_duration: "7 days",
  buyer_same: "yes",
  payer_same: "yes",
  price_range: "180 to 200 a litre",
  price_reaction: "accepted",
  delivery_location: "Nashik",
  delivery_lead_time: "3 days",
  delivery_suits: "yes",
  willing_to_test: "yes",
  next_step: "First order of 200 L",
  next_step_date: "2026-11-01",
};

/** The four answers that live on the lead's own columns, as `customers` inserts. */
export function qualificationColumns() {
  return {
    gstin: "27ABCDE1234F1Z5",
    leadApplication: "Wood polish",
    leadCreditDaysWanted: 30,
    leadDecisionMaker: "Ganesh",
  };
}
