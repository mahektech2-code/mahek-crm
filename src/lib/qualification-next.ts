/**
 * The sentence on a next action, as this workflow writes it.
 *
 * Constants because they are also how the workflow RECOGNISES its own work: a
 * next action reading "Review qualification" owed by the lead manager is the
 * review having been asked for, and a second pass must not ask again. A literal
 * that drifted by one character would put a second bell on the manager's phone
 * every time somebody saved a checklist.
 *
 * Its own pure file so the lead list's SQL can read it without importing the
 * flow service, which sits in an import cycle with the sales service.
 */
export const QUAL_NEXT = {
  verify: "Sales Manager verification call",
  complete: "Complete the qualification",
  review: "Review qualification",
  answer: "Answer the Sales Manager's note",
  sample: "Request the sample",
  gst: "Correct the GST number",
  assign: "Assign a Salesman to complete the qualification",
} as const;
