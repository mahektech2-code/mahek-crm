import "server-only";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output } from "ai";
import { z } from "zod";
import { getConfig } from "@/lib/config/store";
import {
  cleanScan,
  foundAnything,
  gstinSettled,
  hasIndianScript,
  preferGstin,
  type LeadScanReading,
  type LeadScanResult,
} from "@/lib/engines/lead-scan";
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

Read only what is printed or written. Never guess, complete or invent a value: if a field is not visible, it is null.

EVERY VALUE YOU RETURN IS IN ENGLISH, IN ENGLISH (LATIN) LETTERS ONLY — never Devanagari, Kannada, Telugu, Tamil, Malayalam, Bengali, Gujarati, Gurmukhi, Odia, Urdu or any other script, even when the card is printed only in that script. The office reads these in English.
- A shop's or person's NAME is transliterated, not translated: "ಶ್ರೀ ಗಣೇಶ ಪೇಂಟ್ಸ್" is "Shri Ganesh Paints", "রহিম হার্ডওয়্যার" is "Rahim Hardware", "श्याम ट्रेडर्स" is "Shyam Traders".
- A TOWN or STATE is its usual English spelling: "ಬೆಂಗಳೂರು" is "Bengaluru", "హైదరాబాద్" is "Hyderabad", "कोलकाता" is "Kolkata".
- An ADDRESS keeps its place names transliterated and puts its ordinary words into English: road, main road, cross, near, opposite, market, bazaar, nagar, colony, shop no., first floor.
- Digits printed in an Indian script (०१२, ೦೧೨, ౦౧౨, ০১২) are written as 0-9.

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

    /* ENGLISH, CHECKED RATHER THAN HOPED FOR. The prompt asks for English
       letters, and a card printed only in Kannada still sometimes comes back
       in Kannada — which the salesman then has to retype on a phone keyboard
       that may not even have it. Where any field still carries an Indian
       script, a short text-only pass rewrites those fields alone. No photo
       goes back up, so it costs a second or two; and if it fails, the reading
       stands as it was, because a field in Kannada he can fix beats an empty
       one he cannot. */
    if (needsEnglish(reading)) {
      const remaining = SCAN_BUDGET_MS - (Date.now() - startedAt);
      if (remaining >= 4_000) {
        const english = await toEnglish(model, reading, remaining).catch((e) => {
          console.error("Lead scan: English pass failed:", e instanceof Error ? e.message : e);
          return null;
        });
        if (english) Object.assign(reading, english);
      }
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

/* The fields a person reads. The GSTIN and the phone numbers are characters
   and digits, cleaned on their own path, and are never sent through this. */
const ENGLISH_FIELDS = ["businessName", "contactPerson", "city", "state", "address", "pincode", "note"] as const;

function needsEnglish(r: LeadScanReading): boolean {
  return ENGLISH_FIELDS.some((f) => hasIndianScript(r[f]));
}

const ENGLISH_SYSTEM = `You convert the details of an Indian shop, read off its visiting card or board, into English in English (Latin) letters. Names of shops and people are transliterated, not translated ("ಶ್ರೀ ಗಣೇಶ ಪೇಂಟ್ಸ್" is "Shri Ganesh Paints"). Towns and states take their usual English spelling ("ಬೆಂಗಳೂರು" is "Bengaluru"). In an address, place names are transliterated and ordinary words become English (road, near, opposite, market, nagar, colony). Indian-script digits become 0-9. A value already in English is returned unchanged; null stays null. Add nothing and drop nothing.`;

const englishSchema = z.object({
  businessName: z.string().nullable(),
  contactPerson: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  address: z.string().nullable(),
  pincode: z.string().nullable(),
  note: z.string().nullable(),
});

async function toEnglish(
  model: Parameters<typeof generateText>[0]["model"],
  reading: LeadScanReading,
  timeoutMs: number,
): Promise<Partial<LeadScanReading> | null> {
  const input = Object.fromEntries(ENGLISH_FIELDS.map((f) => [f, reading[f]]));
  const r = await generateText({
    model,
    system: ENGLISH_SYSTEM,
    prompt: JSON.stringify(input),
    output: Output.object({ schema: englishSchema }),
    providerOptions: { openai: { reasoningEffort: "low" } },
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(Math.min(timeoutMs, 20_000)),
  });
  /* Only a field that came back free of Indian script replaces what was read
     — a second answer still in Kannada is no better than the first. */
  const out: Partial<LeadScanReading> = {};
  for (const f of ENGLISH_FIELDS) {
    const v = r.output[f];
    if (reading[f] != null && v != null && !hasIndianScript(v)) out[f] = v;
  }
  return out;
}
