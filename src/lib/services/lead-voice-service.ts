import "server-only";
import { getConfig } from "@/lib/config/store";
import { cleanVoice, heardAnything, type LeadVoiceResult } from "@/lib/engines/lead-voice";
import { offeredSalesTypes } from "@/lib/lead-labels";
import { LEAD_VOICE_SHAPE_HINT, leadVoiceReadingSchema, type LeadVoiceReadingParsed } from "@/lib/lead-voice-schema";
import { today } from "@/lib/recompute";
import { err, ok, type Result } from "@/lib/result";
import { readStructured } from "@/lib/structured-read";

/* ---------------------------------------------------------------------------
 * A SALESMAN TALKING ABOUT A SHOP IN, THE WHOLE NEW LEAD FORM OUT.
 *
 * The card scan fills six answers from what is PRINTED; most of the form is
 * what he LEARNED standing there — what they buy, how much, from whom, who
 * decides, when to come back — and none of that is on a card. So he says it,
 * once, in any language, through the dictation sheet every prose box on the
 * handset already has: it records for up to `voice.maxSeconds` (two minutes),
 * pauses, routes short audio to Sarvam and long audio to OpenAI, and shows him
 * the English to correct BEFORE this runs. This reads that text into all
 * sixteen answers for him to CHECK.
 *
 * TEXT, NOT AUDIO, arrives here — on purpose. The words he has already read
 * and corrected are a better input than the recording they came from, the
 * hearing half is not built twice, and a salesman whose dictation is off can
 * still type a paragraph and have it read.
 *
 * NOTHING HERE WRITES A LEAD. The form's own "Add lead" is still the only
 * thing that does, so every value passes in front of the person who was in
 * the shop. Nothing is stored either: the text is read and dropped, as the
 * card scan's photographs are.
 *
 * THE OPENAI-THEN-SARVAM LADDER, through `readStructured`, unlike the card
 * scan: reading words needs no eyes, so Sarvam is a real fallback here, and a
 * deployment with only a Sarvam key still gets the feature.
 * ------------------------------------------------------------------------- */

export type LeadVoiceInput = {
  /** What is in the box — his corrected English, or what he typed. */
  text: string;
  /** What was said, in the language it was said in, where it was dictated. */
  spoken: string;
};

/* The enum's four values, worded the way a salesman describes a shop. The
   codes are `customer_type` verbatim — the handset draws the same four. */
const CUSTOMER_TYPES = [
  { code: "dealer", label: "Dealer", hint: "sells our kind of goods on to others, usually with a counter" },
  { code: "retailer", label: "Retailer", hint: "a shop selling to the public or to painters" },
  { code: "distributor", label: "Distributor", hint: "buys in bulk and supplies other shops" },
  { code: "manufacturer", label: "Manufacturer", hint: "a factory or workshop that USES paint or thinner to make things" },
];

const OTHER_SOURCE = "other";

export async function readLeadFromVoice(input: LeadVoiceInput): Promise<Result<LeadVoiceResult>> {
  const config = await getConfig();
  if (!config["leadVoice.enabled"]) {
    return err("Filling the form by voice is switched off. Type the details instead.", "rule_violation");
  }
  const text = input.text.trim();
  if (text.length < 8) return err("Say a little about the shop first — who you met, the shop, the number.");

  const day = await today();
  const working = {
    timezone: config["workingDay.timezone"],
    dayBoundaryHour: config["workingDay.dayBoundaryHour"],
    workingDays: config["workingDay.workingDays"],
  };
  const salesTypes = offeredSalesTypes();
  const sources = config["leads.sources"];

  const read = await readStructured({
    label: "Lead by voice",
    system: systemPrompt(day),
    prompt: userPrompt({ text, spoken: input.spoken.trim(), salesTypes, sources }),
    schema: leadVoiceReadingSchema,
    shapeHint: LEAD_VOICE_SHAPE_HINT,
    model: config["leadVoice.model"],
  });
  const reading = read.output as LeadVoiceReadingParsed | null;
  if (!reading) {
    return err(
      "That could not be read just now — no language model answered. Type the details instead; what you said is still in the box.",
      "rule_violation",
    );
  }

  const result = cleanVoice(reading, {
    today: day,
    working,
    salesTypes,
    sources,
    customerTypes: CUSTOMER_TYPES,
    otherSource: OTHER_SOURCE,
  });
  if (!heardAnything(result)) {
    return err(
      "Nothing for the form was heard in that. Say the shop's name, who you met and their number, then try again.",
      "not_found",
    );
  }
  return ok(result);
}

function systemPrompt(day: string): string {
  return [
    "You read what a field salesman in India said about a shop or business he has just visited, for Mahek,",
    "a B2B paint and chemicals company (thinners, PU, NC, lacquers, primers — sold in cans, boxes and drums).",
    "You fill the answers of the New lead form. He checks every answer before anything is saved, so",
    "leaving a field null is always better than guessing it.",
    "",
    `Today is ${day}. You never compute dates: report the CUE — the kind of date and the exact words.`,
    "'after 15 days' is {kind: in_days, n: 15}; 'next Monday' is {kind: weekday, weekday: 1, which: next};",
    "'20 tarikh' is day_of_month 20; 'kal' about the future is tomorrow; 'parso' is day_after_tomorrow.",
    "",
    "Rules:",
    "1. Report only what the words say. Never invent a name, a number, an amount or a date.",
    "2. Give names, shops and places in English letters — transliterate, never translate a shop's name.",
    "3. Phone numbers: write every digit he said, in order. Spoken digits in Hindi/Marathi/Gujarati are digits too.",
    "   If he corrected himself ('no, 1 0 0 1'), use the corrected number.",
    "4. Money is whole rupees a MONTH: 40 hazar = 40000, 1.5 lakh = 150000, '5 lakh a year' = 41667.",
    "5. Litres a month only when litres, or a drum/can of a named size, were said.",
    "6. The three lists below are the only answers for salesType, source and customerType — give the CODE,",
    "   or null when the words do not settle it. Never pick one just to fill it.",
    "7. 'requirement' is what they want, in a few English words. 'competitor' is whoever supplies them now.",
    "8. If he spoke about more than one shop, read only the first and say so in 'unclear'.",
  ].join("\n");
}

function userPrompt(args: {
  text: string;
  spoken: string;
  salesTypes: { code: string; label: string; hint: string }[];
  sources: { code: string; label: string }[];
}): string {
  const list = (rows: { code: string; label: string; hint?: string }[]) =>
    rows.map((r) => `- ${r.code}: ${r.label}${r.hint ? ` — ${r.hint}` : ""}`).join("\n");
  const said =
    args.spoken && args.spoken !== args.text
      ? [
          "What he said, in the language he said it in — prefer this for names, numbers and amounts",
          "wherever it and the English below disagree:",
          "```",
          args.spoken.slice(0, 8000),
          "```",
          "",
          "The same, in English, as he checked it:",
        ]
      : ["What he said or typed:"];
  return [
    "Kinds of sale (salesType):",
    list(args.salesTypes),
    "",
    "How he found them (source):",
    list(args.sources),
    "",
    "What kind of business (customerType):",
    list(CUSTOMER_TYPES),
    "",
    ...said,
    "```",
    args.text.slice(0, 8000),
    "```",
  ].join("\n");
}
