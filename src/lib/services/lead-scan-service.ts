import "server-only";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output } from "ai";
import { z } from "zod";
import { getConfig } from "@/lib/config/store";
import { cleanScan, foundAnything, gstinSettled, preferGstin, type LeadScanResult } from "@/lib/engines/lead-scan";
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

Brands the shop STOCKS (Asian Paints, Berger, Nerolac, Dulux and so on, often printed as logos) are not the business name.

The GSTIN matters most and is the easiest to miss: it is usually in the smallest type on the card, at the bottom or on the back, after "GSTIN", "GST No", "GST IN" or "GST :". Look for it in every photograph before answering. It is exactly 15 characters in this order: 2 digits (the state code, 27 for Maharashtra, 24 for Gujarat), 5 letters, 4 digits, 1 letter, 1 digit or letter, the letter Z, then 1 digit or letter. Use that shape to tell 0 from O and 1 from I, but copy what is printed — never fill in a character you cannot see.`;

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

  const startedAt = Date.now();
  try {
    const client = createOpenAI({ apiKey: key });
    const model = client(config["leadScan.model"]);
    /* HIGH detail, said out loud. Left unset OpenAI picks "auto", which is
       free to read the whole photograph at 512px — enough for the name on a
       board and nowhere near enough for a GSTIN in the card's smallest type,
       which is exactly how it failed: the shop and the mobile came back and
       the GST number did not. */
    const photos = images.map((img) => ({
      type: "file" as const,
      mediaType: img.mediaType,
      data: img.bytes,
      providerOptions: { openai: { imageDetail: "high" as const } },
    }));
    const result = await generateText({
      model,
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
            ...photos,
          ],
        },
      ],
      output: Output.object({ schema: leadScanReadingSchema }),
      /* Medium, not low: copying fifteen characters exactly is the hard part
         of this read, and a few seconds more beats retyping the number. */
      providerOptions: { openai: { reasoningEffort: "medium" } },
      /* One retry, not the SDK's two: somebody is standing in a shop doorway,
         and a refusal like an empty credit balance will not change on a retry. */
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(60_000),
    });

    /* A SECOND LOOK AT THE NUMBER ALONE, only when the first read missed it or
       read one the checksum refuses. Asked about the whole card the model
       spreads its attention over a name, three phones and an address; asked
       for fifteen characters and nothing else, harder, it reads a blurred or
       tiny GSTIN it skipped the first time. The checksum decides which answer
       stands, so a second look can only improve the field — and one that
       fails costs nothing, since the first reading is already in hand. */
    const reading = result.output;
    /* Inside a budget, because the handset gives up at ninety seconds and the
       builds already in pockets cannot be told to wait longer: whatever the
       first read and the upload have not spent of seventy-five goes to the
       second look, and too little left means no second look at all. */
    const left = SCAN_BUDGET_MS - (Date.now() - startedAt);
    if (!gstinSettled(reading.gstin) && left >= 8_000) {
      const second = await rereadGstin(model, photos, left).catch((e) => {
        console.error("Lead scan: GSTIN second look failed:", e instanceof Error ? e.message : e);
        return null;
      });
      reading.gstin = preferGstin(reading.gstin, second);
    }

    const cleaned = cleanScan(reading);
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

const SCAN_BUDGET_MS = 75_000;

const GSTIN_SYSTEM = `You read one thing from photographs of an Indian business's visiting card, board, bill head or GST certificate: its GSTIN (GST number). It is often in very small or blurred type, at the bottom or on the back, after "GSTIN", "GST No", "GST IN" or "GST :". Zoom in on every photograph and read it character by character.

A GSTIN is exactly 15 characters: 2 digits (state code), 5 letters, 4 digits, 1 letter, 1 digit or letter, the letter Z, then 1 digit or letter — for example 27AAPFU0939F1ZV. Use that shape to tell 0 from O, 1 from I, 5 from S and 8 from B. If no GSTIN is printed anywhere, answer null. Never invent one.`;

async function rereadGstin(
  model: Parameters<typeof generateText>[0]["model"],
  photos: { type: "file"; mediaType: string; data: Uint8Array; providerOptions: { openai: { imageDetail: "high" } } }[],
  timeoutMs: number,
): Promise<string | null> {
  const r = await generateText({
    model,
    system: GSTIN_SYSTEM,
    messages: [{ role: "user", content: [{ type: "text", text: "What is the GSTIN?" }, ...photos] }],
    output: Output.object({
      schema: z.object({
        gstin: z.string().nullable().describe("The 15-character GSTIN exactly as printed, or null if none is printed."),
      }),
    }),
    providerOptions: { openai: { reasoningEffort: "high" } },
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(timeoutMs),
  });
  return r.output.gstin;
}
