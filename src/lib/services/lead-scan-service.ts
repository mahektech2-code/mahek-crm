import "server-only";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output } from "ai";
import { getConfig } from "@/lib/config/store";
import { cleanScan, foundAnything, type LeadScanResult } from "@/lib/engines/lead-scan";
import { leadScanReadingSchema } from "@/lib/lead-scan-schema";
import { err, ok, type Result } from "@/lib/result";
import { readSecret } from "@/lib/secrets";

/* ---------------------------------------------------------------------------
 * A VISITING CARD IN, THE NEW LEAD FORM'S FIRST SIX ANSWERS OUT.
 *
 * The salesman is outside a shop with a card in his hand or a board over the
 * door, typing a GSTIN on a phone keyboard one character at a time. This reads
 * up to `leadScan.maxImages` photographs in ONE call — a card's front and back
 * and the board are three views of one business, and asking the model about
 * each alone would give three half-answers to reconcile — and returns what it
 * found for him to CHECK. Nothing here writes a lead: the form's own "Add
 * lead" is still the only thing that does, so every value passes in front of
 * the person who can see the card.
 *
 * OPENAI ONLY, unlike the visit assistant's OpenAI-then-Sarvam ladder. Sarvam's
 * chat endpoint takes text, and a fallback that cannot see the photograph is
 * not a fallback. Without an OpenAI key the handset simply draws no scan
 * button (`lead-scan-availability.ts`).
 *
 * THE PHOTOGRAPHS ARE NEVER STORED. They are read from the request, handed to
 * the model and dropped — no `attachments` row, no id to fetch them back by —
 * exactly as dictation's audio is. A card is a person's name and number; the
 * lead it produces holds those, and a second copy as a picture nobody asked to
 * keep is a thing to hold without a reason. The shop photo on the form is a
 * separate, deliberate photograph and goes through the media queue as before.
 * ------------------------------------------------------------------------- */

export type LeadScanImage = { bytes: Uint8Array; mediaType: string };

const SYSTEM = `You read photographs a field salesman in India has taken of a business he wants to sell paint and thinner to: a visiting card (front or back), a shop board, a poster, a bill head, a letterhead or a GST certificate. All the photographs are of ONE business.

Read only what is printed or written. Never guess, complete or invent a value: if a field is not visible, it is null. Text may be in English, Hindi, Marathi, Gujarati or another Indian language — give names and addresses in English letters (transliterate, do not translate a shop's name).

Brands the shop STOCKS (Asian Paints, Berger, Nerolac, Dulux and so on, often printed as logos) are not the business name.`;

export async function scanLeadImages(images: LeadScanImage[]): Promise<Result<LeadScanResult>> {
  const config = await getConfig();
  if (!config["leadScan.enabled"]) {
    return err("Reading photos is switched off. Type the details instead.", "rule_violation");
  }
  if (images.length === 0) return err("Take a photo of the card or the shop board first.");
  if (images.length > config["leadScan.maxImages"]) {
    return err(`Up to ${config["leadScan.maxImages"]} photos at a time.`);
  }

  const key = await readSecret("openai.apiKey");
  if (!key) {
    return err("Reading photos is not set up on this deployment. Type the details instead.", "rule_violation");
  }

  try {
    const client = createOpenAI({ apiKey: key });
    const result = await generateText({
      model: client(config["leadScan.model"]),
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                images.length === 1
                  ? "Read this photograph."
                  : `Read these ${images.length} photographs of the same business together.`,
            },
            ...images.map((img) => ({ type: "file" as const, mediaType: img.mediaType, data: img.bytes })),
          ],
        },
      ],
      output: Output.object({ schema: leadScanReadingSchema }),
      providerOptions: { openai: { reasoningEffort: "low" } },
      /* One retry, not the SDK's two: somebody is standing in a shop doorway,
         and a refusal like an empty credit balance will not change on a retry. */
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(60_000),
    });

    const cleaned = cleanScan(result.output);
    if (!foundAnything(cleaned)) {
      return err(
        "Nothing about a business could be read in these photos. Try again closer, with the card flat and in good light.",
        "not_found",
      );
    }
    return ok(cleaned);
  } catch (e) {
    console.error("Lead scan: OpenAI read failed:", e instanceof Error ? e.message : e);
    return err("The photos could not be read just now. Type the details instead — nothing is lost.", "rule_violation");
  }
}
