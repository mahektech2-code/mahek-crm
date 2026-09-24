/* ---------------------------------------------------------------------------
 * THE THINGS THAT MUST NOT BE MISSED, found without a model.
 *
 * The language model reads the whole call and is usually right. These rules
 * read the same words and look for a handful of things where being wrong is
 * expensive in one particular direction:
 *
 *   DO NOT CALL — a customer who asked not to be rung and is rung anyway is
 *   the complaint that reaches the owner. If either reader hears it, the card
 *   shows it. A false alarm costs one glance.
 *
 *   NO ANSWER — "NR", "switch off", "phone nahi uthaya". Telecallers type
 *   these in a dozen spellings; the model sometimes reads a note ABOUT a
 *   missed call as a conversation.
 *
 *   MAYBE — "shayad", "sochenge", "may order next week". The client's own
 *   example: a customer who says they may order is an OPPORTUNITY, never an
 *   order, and an order logged on a maybe is stock dispatched to nobody.
 *
 *   MONEY — "50 hazar", "1.5 lakh", "₹25,000". Parsed here because Indian
 *   number words are exactly where a model is confidently wrong by a zero.
 *
 * A rule here never FILLS anything on its own. It raises a flag, or it votes
 * against the model — and a disagreement becomes a question on the screen.
 *
 * PURE. Text in, findings out.
 * ------------------------------------------------------------------------- */

export type Finding = { found: boolean; quote: string | null };

function firstMatch(text: string, patterns: RegExp[]): Finding {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return { found: true, quote: m[0].trim() };
  }
  return { found: false, quote: null };
}

/*
 * Each list is ordered most-specific first, so the quote shown is the phrase
 * that actually decided it rather than the first common word.
 */

const DO_NOT_CALL: RegExp[] = [
  /\b(?:do not|don'?t|never|stop)\s+(?:call|ring|phone|contact)(?:ing)?\b[^.\n]{0,40}/iu,
  /\bno more calls?\b/iu,
  /\bremove (?:my|our|his|her|the) (?:number|name)\b/iu,
  /\bnot to (?:call|contact|ring)\b[^.\n]{0,30}/iu,
  /\b(?:call|phone|fone)\s+(?:mat|na|nahi|mt)\s+(?:karo|karna|kare|karein|kijiye|kariye)\b/iu,
  /\bdobara\s+(?:call|phone|fone)\s+(?:mat|na|nahi)\b/iu,
  /\bphir se\s+(?:call|phone|fone)\s+(?:mat|na|nahi)\b/iu,
  /(?:कॉल|फोन|फ़ोन)\s+(?:मत|ना|नहीं)\s+(?:करो|करना|करें|कीजिए|करिए)/u,
  /\bdnc\b/iu,
];

const NO_ANSWER: RegExp[] = [
  /\b(?:not|nt|didn'?t|did not)\s+(?:picked?|pick(?:ing)?|answer(?:ed|ing)?|respond(?:ed|ing)?|reachable|received?)\b(?:\s+(?:up|the call))?/iu,
  /\b(?:call|phone)\s+(?:not|nahi|nai)\s+(?:picked|pick|uthaya|utha|lagi|laga|received)\b/iu,
  /\b(?:switch(?:ed)?\s*off|swich off|sw off)\b/iu,
  /\bout of (?:network|coverage|reach)\b/iu,
  /\b(?:no response|no answer|unanswered|ringing only|just ringing|call rejected|call cut|disconnected)\b/iu,
  /* "Busy" alone is a customer saying they are busy this week, which is a
     conversation. Only the phone being busy is a missed call. */
  /\bnahi utha(?:ya|i)\b|\bnot reachable\b|\b(?:phone|line|number|call)\s+(?:is\s+)?busy\b|\bbusy (?:tone|aa raha|aaya|aa rha)\b/iu,
  /\bnr\b|\bn\.r\.?\b|\brnr\b/iu,
  /*
   * FROM THE CALL LOG ITSELF (Sep 2026, 374 logged missed calls). These are
   * how this office actually writes it. "Phone rang" here means it rang and
   * nobody answered — thirteen times, never once for a conversation.
   */
  /\bno\s*in\s*coming\s+calls?\b|\bincoming\s+calls?\s+(?:not\s+)?(?:available|receivable|can\s*(?:not|'?t)?\s*be\s+received)\b|\bno\s+out\s*going\b/iu,
  /\b(?:wrong|invalid)\s+number\b|\bnumber\s+(?:is\s+)?(?:wrong|invalid|does\s*(?:not|n'?t)\s+exist|not\s+in\s+service)\b/iu,
  /\bvoice\s*mail\b|\bout\s+of\s+service\b|\bcall\s+forwarded\b/iu,
  /\bnot?\s+pick\s*up\b|\bno\s+pickup\b|\bring\s+(?:nhi|nahi)\s+(?:lag|lagta|laga)|\bblock\s+(?:kela|kiya|kar\s+diya)\b|\bn\s+response\b/iu,
  /\b(?:hanging\s+up|keeps?\s+(?:getting\s+)?disconnect(?:ing)?|repeatedly\s+disconnect(?:ing)?)\b/iu,
  /\bphone\s+rang\b(?![^.\n]{0,30}\b(?:spoke|said|told|answered|picked)\b)/iu,
  /* The whole note is one word — a status, not a sentence. */
  /^\s*(?:busy|ringing|not\s+reachable|switched?\s*off|currently\s+not\s+available)\s*[.!]*\s*$/iu,
  /(?:फोन|फ़ोन|कॉल)\s+(?:नहीं|नही)\s+(?:उठाया|उठाई|लगा|लगी)/u,
];

const TENTATIVE: RegExp[] = [
  /\b(?:may|might|maybe|perhaps|possibly|probably)\b[^.\n]{0,40}\border/iu,
  /\bwill (?:think|see|check|confirm|let (?:you|us) know|decide|inform)\b/iu,
  /\b(?:let (?:us|me|you) know|get back|revert)\b/iu,
  /\bshayad\b|\bsochenge\b|\bsoch(?:kar|ke)\b|\bdekhenge\b|\bdekhte hain\b|\bbatayenge\b|\bbata denge\b|\bconfirm karenge\b/iu,
  /शायद|सोचेंगे|सोचकर|देखेंगे|बताएंगे|बता देंगे/u,
  /\bif (?:required|needed|they need)\b|\bjarurat (?:padi|hogi)\b|ज़रूरत (?:पड़ी|होगी)/iu,
];

const FIRM_ORDER: RegExp[] = [
  /\b(?:order|po)\s+(?:given|placed|confirmed|done|booked|received|diya|de diya|mil gaya|mila|confirm)\b/iu,
  /\b(?:placed|gave|confirmed|booked)\s+(?:an?|the|their)?\s*order\b/iu,
  /\b(?:send|dispatch|bhej(?:o|do|dena|denge)|bhijwa do)\b[^.\n]{0,40}\b(?:today|kal|tomorrow|aaj|immediately|jaldi)\b/iu,
  /ऑर्डर\s+(?:दिया|दे दिया|कन्फर्म|मिला)|भेज (?:दो|देना|दीजिए)/u,
];

export type RuleSignals = {
  doNotCall: Finding;
  noAnswer: Finding;
  tentative: Finding;
  firmOrder: Finding;
};

export function readSignals(text: string): RuleSignals {
  return {
    doNotCall: firstMatch(text, DO_NOT_CALL),
    noAnswer: firstMatch(text, NO_ANSWER),
    tentative: firstMatch(text, TENTATIVE),
    firmOrder: firstMatch(text, FIRM_ORDER),
  };
}

/* -------------------------------------------------------------- money */

const MULTIPLIERS: Array<[RegExp, number]> = [
  [/^(crore|cr|करोड़)$/u, 10_000_000],
  [/^(lakh|lakhs|lac|lacs|laakh|l|लाख)$/u, 100_000],
  [/^(thousand|k|hazar|hazaar|hajar|hajaar|हज़ार|हजार)$/u, 1_000],
];

/**
 * Every rupee amount mentioned, in whole rupees, in order.
 *
 * "50 hazar", "1.5 lakh", "₹25,000", "Rs 12000", "25k". A bare number with no
 * currency word and no multiplier is NOT money — "20 cans" and "15 days" are
 * the commonest numbers on a call, and reading them as rupees is the mistake
 * this function exists to avoid.
 */
export function parseAmounts(text: string): number[] {
  const out: Array<{ at: number; rupees: number }> = [];
  const lower = text.toLowerCase();

  const re =
    /(₹|rs\.?|inr|rupees?|रुपये|रुपए)?\s*(\d{1,3}(?:,\d{2,3})+|\d+(?:\.\d+)?)\s*([\p{L}]+)?/gu;
  for (const m of lower.matchAll(re)) {
    const currency = Boolean(m[1]);
    const raw = Number(m[2].replace(/,/g, ""));
    if (!Number.isFinite(raw) || raw <= 0) continue;
    const word = m[3] ?? "";
    const mult = MULTIPLIERS.find(([r]) => r.test(word))?.[1] ?? null;
    const trailingCurrency = /^(rs|rupees?|rupaye|rupaiye|रुपये|रुपए)$/u.test(
      word,
    );
    if (mult) out.push({ at: m.index!, rupees: Math.round(raw * mult) });
    else if (currency || trailingCurrency)
      out.push({ at: m.index!, rupees: Math.round(raw) });
  }
  return out.sort((a, b) => a.at - b.at).map((a) => a.rupees);
}
