import type { AskSetup } from "./ask-panel";

/* What each app's Ask AI is called and offers first. Each chip has to be
   answerable from what that app's catalog lets its asker read. */

export const SALES_ASK: AskSetup = {
  endpoint: "/api/sales/ask",
  title: "Ask about the team",
  intro:
    "Ask anything — attendance, leave, visits, routes, orders, collections, targets — answered from the data your access lets you see.",
  chips: [
    "Who has not punched in today?",
    "Who is on leave today, and who has leave coming up this week?",
    "Who is behind on target this month and by how much?",
    "Which shops did each salesman visit yesterday?",
    "How many salesmen do I have, and where does each one work?",
  ],
  placeholder: "Ask anything about the team",
  source: "From your team's data",
  button: "Ask AI",
};

export const CRM_ASK: AskSetup = {
  endpoint: "/api/crm/ask",
  title: "Ask the CRM",
  intro:
    "Ask anything about your customers — who owes what, who is due to order, calls and promises, reminders, complaints, bills — answered from the book you can see.",
  chips: [
    "Which of my customers owe the most, and how overdue are they?",
    "Who is due to reorder this week but has not ordered?",
    "What payments were promised for this week?",
    "Which reminders are overdue?",
    "Which complaints are still open, and since when?",
  ],
  placeholder: "Ask anything about your customers",
  source: "From your book",
  button: "Ask AI",
};

export const ERP_ASK: AskSetup = {
  endpoint: "/api/erp/ask",
  title: "Ask the ERP",
  intro:
    "Ask about stock, orders, purchases, transport, complaints or petty cash — answered from the ERP screens you can open, with the records it read.",
  chips: [
    "How much Toluene do we have, and in which godown?",
    "Which order lines are ready but not yet billed?",
    "Which raw materials are below their re-order level?",
    "Which dispatched bills are still waiting for an LR?",
    "Which customer requests are still open?",
  ],
  placeholder: "Ask anything about the ERP",
  source: "From the ERP screens you can open",
  button: "Ask AI",
};
