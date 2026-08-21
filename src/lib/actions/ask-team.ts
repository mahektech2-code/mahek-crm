"use server";

import { z } from "zod";
import { requireCapability } from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import { ASK_SYSTEM, teamBrief } from "@/lib/services/team-brief";
import { write, writingConfigured } from "@/lib/writing-model";
import { err, ok, fromThrown, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * "Ask about the team".
 *
 * NO NEW PROVIDER, and that is deliberate. `lib/writing-model.ts` already
 * exists, already holds the two accounts this deployment has, already tries
 * OpenAI and falls through to Sarvam on a permanent refusal, and already reads
 * its keys from `app_secrets` so a deploy with no shell can set them from a
 * screen. Wiring a third integration for one panel would mean a second place
 * keys are kept and a second thing to be out of credit.
 *
 * THE MODEL IS NOT GIVEN THE DATABASE. It is given `teamBrief()` — the same
 * figures the Performance and Today screens read, already formatted — and told
 * it may use nothing else. There is no tool-calling loop and there should not
 * be: the questions a field manager asks are about a dozen numbers they can
 * already see, so fetching them all costs one round of queries and removes
 * every path where the model decides what to look up.
 *
 * WHAT IT CANNOT DO is act. There is no write here, no approval, no nudge —
 * the design's answers carry a link to a screen and nothing more, and that is
 * the right shape. A model that could approve an order is a model whose
 * hallucination has a consequence.
 * ------------------------------------------------------------------------- */

const schema = z.object({
  question: z.string().trim().min(1).max(500),
});

export type AskTeamAnswer = {
  text: string;
  /** Which account served it, for the console's own diagnostics. */
  servedBy: "openai" | "sarvam";
  /** The window the figures cover, so the panel can say what it read. */
  period: { from: string; to: string };
};

export async function askTeam(raw: {
  question: string;
}): Promise<Result<AskTeamAnswer>> {
  try {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return err("Type a question first.", "validation");
    }

    /*
     * The same capability the console itself is gated on. Not a new one: this
     * panel reads figures the manager is already looking at, so anybody who
     * can open the screen can ask about what is on it — and `teamBrief` is
     * scoped, so "the team" means their own either way.
     */
    const ctx = await requireCapability("team.report");

    if (!(await writingConfigured())) {
      /*
       * Said plainly rather than as a failure. Neither account has a key, which
       * is a thing somebody can fix on the secrets screen in a minute — and a
       * generic "something went wrong" would send them looking in the wrong
       * place.
       */
      return err(
        "No AI account is connected yet. Add an OpenAI or Sarvam key in Admin Console → Secrets and this will start working.",
        "validation",
      );
    }

    const brief = await teamBrief();
    if (brief.empty) {
      // Nothing to answer FROM. Asking a model to be interesting about an
      // empty table is how an invented number reaches a manager.
      return err(
        "There are no figures to read yet — no visits, orders or collections have been recorded this month.",
        "not_found",
      );
    }

    const config = await getConfig();
    const answer = await write({
      system: ASK_SYSTEM,
      prompt: `FIGURES\n\n${brief.text}\n\nThe manager asking is ${ctx.user.name}.\n\nQUESTION\n${parsed.data.question}`,
      // The deployment's text model, which is the same one dictation writes
      // with. One model setting, one place to change it.
      openaiModel: config["voice.languageModel"],
      // Shorter than dictation's minute: somebody is waiting with the panel
      // open, and a slow answer to "who is behind" is worth less than a quick
      // admission that it could not be got.
      timeoutMs: 30_000,
    });

    if (!answer.ok) {
      return answer.reason === "not_configured"
        ? err(
            "No AI account is connected yet. Add an OpenAI or Sarvam key in Admin Console → Secrets.",
            "validation",
          )
        : err("Could not read the figures just now. Try again in a moment.");
    }

    return ok({
      text: answer.text,
      servedBy: answer.servedBy,
      period: brief.period,
    });
  } catch (e) {
    return fromThrown(e);
  }
}
