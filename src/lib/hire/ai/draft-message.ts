import "server-only";
import { z } from "zod";
import { runTask } from "./orchestrator";

/* ---------------------------------------------------------------------------
 * MESSAGE DRAFTING (spec §5.9, PRD §6.4). A draft in the candidate's
 * language that a PERSON reads, edits and sends. It never states or implies
 * an outcome that has not been decided — no "congratulations", no "you are
 * selected", no "unfortunately" — and the orchestrator rejects one that does.
 * When AI is unavailable the template below is the draft, without
 * personalisation, and the screen says so.
 * ------------------------------------------------------------------------- */

const PROMPT_VERSION = "draft-message/v1";

export const PURPOSES = [
  ["interview", "Interview details"],
  ["documents", "Documents still needed"],
  ["follow_up", "Following up"],
  ["custom", "Something else"],
] as const;
export type Purpose = (typeof PURPOSES)[number][0];

const OUTCOME = /\b(congratulat\w*|you (have been|are) (selected|shortlisted|rejected|hired)|selected for|not been selected|unfortunately|regret to inform|offer letter|we are pleased)\b/i;

const Schema = z.object({ subject: z.string(), body: z.string() });

type Facts = { firstName: string; roleTitle: string; stageName: string; nextAt: string | null; place: string | null; docsNeeded: string[]; senderName: string; note: string };

/** The plain template — what goes out when AI cannot draft. English only, and the screen says so. */
export function templateFor(purpose: Purpose, f: Facts): { subject: string; body: string } {
  const sign = `\n\n${f.senderName}, Mahek Marketing`;
  switch (purpose) {
    case "interview":
      return {
        subject: `Your ${f.stageName} for ${f.roleTitle}`,
        body: `Dear ${f.firstName},\nYour ${f.stageName} for the ${f.roleTitle} role is ${f.nextAt ? `on ${f.nextAt}` : "being scheduled — we will confirm the time"}${f.place ? ` at ${f.place}` : ""}. Reply here if the time does not suit you.${sign}`,
      };
    case "documents":
      return {
        subject: `Documents for your ${f.roleTitle} application`,
        body: `Dear ${f.firstName},\nTo continue your application for ${f.roleTitle}, please share: ${f.docsNeeded.length ? f.docsNeeded.join(", ") : "the documents we discussed"}.${sign}`,
      };
    case "follow_up":
      return { subject: `Your ${f.roleTitle} application`, body: `Dear ${f.firstName},\nThank you for your time so far. We are working on the next step of your application for ${f.roleTitle} and will be in touch.${sign}` };
    default:
      return { subject: `Your ${f.roleTitle} application`, body: `Dear ${f.firstName},\n${f.note || ""}${sign}` };
  }
}

export async function draftMessage(args: {
  purpose: Purpose;
  channel: "whatsapp" | "sms" | "email";
  language: string;
  facts: Facts;
  actorId: string;
  applicationId: string;
  blueprintId: string;
}): Promise<{ subject: string; body: string; ai: boolean; taskId: string | null; notice: string | null }> {
  const tmpl = templateFor(args.purpose, args.facts);
  const system = [
    "You draft one message from Mahek Marketing India's HR team to a job candidate, for a person to read and send.",
    `Write it in ${args.language}${args.language === "English" ? "" : ", in its own script, natural and polite as people in Maharashtra and Gujarat write it"}.`,
    args.channel === "sms" ? "It is an SMS: under 300 characters, no subject needed." : args.channel === "whatsapp" ? "It is a WhatsApp message: short, warm, plain." : "It is an email: a short subject and a brief body.",
    "Use only the facts given. NEVER state or imply an outcome — no congratulations, no 'selected', no 'unfortunately', no offer — because nothing has been decided. If a time or place is missing, say it will be confirmed.",
    "Always sign with the sender's name and 'Mahek Marketing'.",
  ].join(" ");
  const f = args.facts;
  const prompt = [
    `Purpose: ${args.purpose}`,
    `Candidate's first name: ${f.firstName}`,
    `Role: ${f.roleTitle}`,
    `Current stage: ${f.stageName}`,
    f.nextAt ? `Next appointment: ${f.nextAt}${f.place ? ` at ${f.place}` : ""}` : "No appointment fixed yet.",
    f.docsNeeded.length ? `Documents still needed: ${f.docsNeeded.join(", ")}` : "",
    f.note ? `What the sender wants to say: ${f.note}` : "",
    `Sender: ${f.senderName}`,
  ]
    .filter(Boolean)
    .join("\n");
  const res = await runTask({
    taskType: "message_draft",
    promptVersion: PROMPT_VERSION,
    tier: "fast",
    system,
    prompt,
    schema: Schema,
    entity: { type: "application", id: args.applicationId, applicationId: args.applicationId, blueprintId: args.blueprintId },
    actorId: args.actorId,
    validate: (o) => (OUTCOME.test(`${o.subject} ${o.body}`) ? "The draft stated or implied an outcome that has not been decided." : null),
  });
  if (!res.ok) return { ...tmpl, ai: false, taskId: res.taskId, notice: `${res.reason} This is the plain template${args.language === "English" ? "" : ", in English — translate it before sending"}.` };
  return { subject: res.output.subject, body: res.output.body, ai: true, taskId: res.taskId, notice: null };
}
