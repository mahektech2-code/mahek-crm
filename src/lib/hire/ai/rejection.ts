import "server-only";
import { z } from "zod";
import { runTask, type TaskResult } from "./orchestrator";

/* ---------------------------------------------------------------------------
 * The rejection writer (PRD §6.4, spec §5.9). Most candidates only ever read
 * this, so it is specific, respectful and legally careful: it names the stage
 * and, where asked, something they could work on — and NEVER a reason that
 * could read as a decision about who they are. A person reads and edits it
 * before it goes; it is a draft, not a send.
 * ------------------------------------------------------------------------- */

const Schema = z.object({ subject: z.string(), body: z.string() });
export type RejectionDraft = { subject: string; body: string };

export function rejectionTemplate(a: { firstName: string; roleTitle: string; stageName: string; sender: string }): RejectionDraft {
  return {
    subject: `Your application for ${a.roleTitle}`,
    body: `Dear ${a.firstName},\n\nThank you for the time you gave us through the ${a.stageName} stage for the ${a.roleTitle} role at Mahek Marketing India. We have decided not to take your application further this time.\n\nThis decision was made by a person on our hiring team after reviewing your interviews. You are welcome to apply again for future openings.\n\nWith best wishes,\n${a.sender}\nMahek Marketing India`,
  };
}

export async function draftRejection(args: {
  firstName: string;
  roleTitle: string;
  stageName: string;
  reason: string;
  feedback: string | null;
  language: string;
  sender: string;
  actorId: string;
  applicationId: string;
}): Promise<TaskResult<RejectionDraft>> {
  return runTask({
    taskType: "rejection_draft",
    promptVersion: "rejection/v1",
    tier: "fast",
    system: [
      "You write a short rejection message from Mahek Marketing India to a job candidate, for a person to review before it is sent.",
      "Be clear that the application is not going further, respectful, and free of false encouragement. Do not promise anything.",
      "Never give, imply or hint at a reason connected to gender, age, religion, caste, family, health, appearance, accent, location or personality.",
      "Do not mention AI, scores or thresholds. If developmental feedback is supplied, include it once, gently and specifically. Plain words, under 140 words.",
      "Write in the language requested.",
    ].join(" "),
    prompt: [
      `Language: ${args.language}`,
      `Candidate first name: ${args.firstName}`,
      `Role: ${args.roleTitle}`,
      `Stage reached: ${args.stageName}`,
      `Internal reason (do not quote; use only to keep the message accurate): ${args.reason}`,
      args.feedback ? `Developmental feedback to include: ${args.feedback}` : "No developmental feedback.",
      `Sign off as: ${args.sender}, Mahek Marketing India`,
    ].join("\n"),
    schema: Schema,
    entity: { type: "application", id: args.applicationId, applicationId: args.applicationId },
    actorId: args.actorId,
    redactPrompt: true,
  });
}
