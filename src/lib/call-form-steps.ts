/**
 * THE CALL FORM IS FIVE STEPS, AND THE OUTCOME DECIDES WHICH OF THEM ARE ASKED.
 *
 * It was one long scroll: the notes, how it happened, who rang and why, the
 * outcome, its questions, the order, the quick notes, the next action and the
 * opportunity, one under the other, with Save at the foot. A refusal landed
 * under a field half a screen away. Now it is the ERP's paged form: one step
 * at a time, Next checks the step you are on, Save checks everything and lands
 * on the first step carrying an error — the server's included.
 *
 * Pure and client-safe: the panel draws from it and the tests pin it.
 */

export type CallStep = "happened" | "outcome" | "order" | "next" | "review";

export const CALL_STEP_LABEL: Record<CallStep, string> = {
  happened: "What happened",
  outcome: "Outcome",
  order: "Order",
  next: "Next step",
  review: "Review",
};

/**
 * The steps this call asks, in order. An order received has no outcome (it
 * IS the outcome); the order step is asked only where the call takes
 * products; the next step only where there is something on it to answer.
 */
export function callSteps(input: {
  orderReceived: boolean;
  takesProducts: boolean;
  hasNextStep: boolean;
}): CallStep[] {
  const steps: CallStep[] = ["happened"];
  if (!input.orderReceived) steps.push("outcome");
  if (input.orderReceived || input.takesProducts) steps.push("order");
  if (input.hasNextStep) steps.push("next");
  steps.push("review");
  return steps;
}

/**
 * Which step a field error belongs to, so a refusal — the screen's or the
 * server's — opens the step where it can be fixed. An unknown field stays
 * where the person is, and the toast still says it.
 */
export function stepOfField(field: string): CallStep | null {
  const head = field.split(".")[0];
  switch (head) {
    case "type":
    case "interactionType":
    case "notes":
    case "callerRole":
    case "callerName":
    case "callReason":
    case "reasonDetail":
      return "happened";
    case "outcome":
    case "outcomeDetail":
    case "complaintCategory":
    case "complaintDescription":
    case "complaintImages":
    case "complaintRequestCn":
    case "followUpDate":
    case "noOrderNextCallDate":
    case "paymentPromiseDate":
      return "outcome";
    case "orderDate":
    case "productQuantities":
    case "lineDiscount":
    case "lineDiscounts":
      return "order";
    case "nextActions":
    case "nextActionDate":
    case "opportunity":
    case "opportunityAnswer":
    case "quickNoteIds":
      return "next";
    default:
      return null;
  }
}

/** The earliest step, in this call's order, that any of these errors names. */
export function firstStepWithError(
  steps: CallStep[],
  fields: string[],
): CallStep | null {
  let best = -1;
  for (const f of fields) {
    const s = stepOfField(f);
    if (!s) continue;
    /* An error on a step this call does not ask (an order date on an outbound
       call) is shown where the person can at least read it: the review. */
    const i = steps.indexOf(s);
    const at = i === -1 ? steps.length - 1 : i;
    if (best === -1 || at < best) best = at;
  }
  return best === -1 ? null : steps[best];
}

/** Where the person is, kept inside the steps this call now asks. */
export function clampStep(steps: CallStep[], step: CallStep): CallStep {
  if (steps.includes(step)) return step;
  /* The step left the list (the outcome changed and took the order with it):
     go to the step that now sits where it was, never further on. */
  const order: CallStep[] = ["happened", "outcome", "order", "next", "review"];
  const at = order.indexOf(step);
  for (let i = at; i >= 0; i--) if (steps.includes(order[i])) return order[i];
  return steps[0];
}
