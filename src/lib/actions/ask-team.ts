"use server";

import { z } from "zod";
import { requireCapability } from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import { ASK_SYSTEM, teamBrief } from "@/lib/services/team-brief";
import { write } from "@/lib/writing-model";
import { hasSecret } from "@/lib/secrets";
import { isPermanentRefusal } from "@/lib/voice-readiness";
import { err, ok, fromThrown, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * "Ask about the team".
 *
 * NO NEW PROVIDER, and that is deliberate. `lib/writing-model.ts` already
 * exists, already holds the two accounts this deployment has, and already
 * reads its keys from `app_secrets` so a deploy with no shell can set them
 * from a screen. Wiring a third integration for one panel would mean a second
 * place keys are kept and a second thing to be out of credit. What IS
 * different from dictation is the fallback: dictation falls through to Sarvam
 * because a plainer sentence beats no sentence for a note somebody is
 * writing, but this panel asks `write()` for OpenAI only — a manager reading
 * figures back does not benefit from a second model quietly taking over
 * mid-deployment, and a failure here is reported rather than papered over by
 * a different account answering the same question differently.
 *
 * THE MODEL IS NOT GIVEN THE DATABASE. It is given `teamBrief()` — the same
 * figures every screen of this dashboard reads, already formatted — and told
 * it may use nothing else. There is no tool-calling loop and there should not
 * be: the questions a field manager asks are about numbers they can already
 * see, so fetching them all costs one round of queries and removes every path
 * where the model decides what to look up.
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

    if (!(await hasSecret("openai.apiKey"))) {
      /*
       * Said plainly rather than as a failure, and checked before `teamBrief()`
       * runs its round of queries for an answer nothing can read out loud yet.
       * This panel is OpenAI-only, so a Sarvam key alone does not help here —
       * a message that mentioned it would send somebody to fix the wrong thing.
       */
      return err(
        "No OpenAI account is connected yet. Add an OpenAI key in Admin Console → Voice and this will start working.",
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
      // OpenAI only, deliberately. Dictation falls through to Sarvam because a
      // plainer sentence beats no sentence for a note somebody is writing —
      // this panel is a manager reading numbers back, and a second account
      // answering from the same brief with a different model is a second
      // place this could go subtly wrong for no reason this feature needs.
      providers: ["openai"],
    });

    if (!answer.ok) {
      if (answer.reason === "not_configured") {
        return err(
          "No OpenAI account is connected yet. Add an OpenAI key in Admin Console → Voice.",
          "validation",
        );
      }
      // The literal reason — most often the OpenAI account being out of
      // credit — is worth more to whoever reads this than a generic retry
      // prompt, and it is the same detail already logged server-side by
      // `write()`. A manager staring at "try again in a moment" while every
      // retry fails the same way has no way to know it is a billing problem
      // rather than a bug.
      return err(
        isPermanentRefusal(answer.detail)
          ? "OpenAI refused the request — the connected account may be out of credit or the key may be invalid. Check Admin Console → Voice."
          : "Could not read the figures just now. Try again in a moment.",
      );
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
