# Call form steps, call assistant, visit assistant

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**THE CALL FORM IS FIVE STEPS, AND THE OUTCOME DECIDES WHICH (Oct 2026).** The
call panel's Call log tab was one long scroll with Save at its foot, so a
refusal landed under a field half a screen away. It is now the ERP's paged
form: What happened (the assistant, notes, how it happened, the script, and on
an inbound call who rang, why, and their bills, delivery or stock) → Outcome
(the grid and what the chosen one asks) → Order (only where the call takes
products; an order received has no Outcome step) → Next step (quick notes,
next action and its day, the opportunity — skipped where none applies) →
Review (every answer said back, each with Change). `lib/call-form-steps.ts` is
the rule, pure: which steps a call asks, which step a field error belongs to,
and where somebody standing on a step that left the list goes (back, never
on). Next checks the step it leaves (`stepProblems`); Save checks every step in
order and opens the first with a problem, and a server field error opens its
step too. Steps are drawn hidden, never unmounted, so the assistant and the
pickers keep what they hold. Nothing sent to `saveInteractionAction` changed.

**THE CALL ASSISTANT PROPOSES THE FORM, AND NEVER WRITES A RECORD.** The
telecaller presses one button on the call panel and says what happened, in
any language, or types it. `lib/services/call-intel-service.ts` reads it and
`components/crm/call-assistant.tsx` shows what it understood: the outcome,
the dates, the products, the amount, the feedback, and what else the call
produced. "Fill the form" puts that into the ordinary call form, filling only
fields nobody has typed in, and the ordinary Save is still the only thing
that writes. A sample, a complaint on a call filed as something else, or a
second reminder opens its own ordinary form, filled in. The one row the
assistant writes is `call_ai_drafts`: the transcript in the language it was
spoken, the proposal, and, written by `saveInteraction` in the call's own
transaction, what the call was actually saved as. The audio is still never
stored.

**Three readers, because each is wrong in a different direction.** The
language model (`callIntel.model`, OpenAI then Sarvam) extracts everything
into `callReadingSchema`, whose coded answers are built from the same lists
the form draws, so it cannot answer in a code the save would refuse. The
rules (`engines/call-intel-signals.ts`) look only for what is expensive to
miss: do-not-call, a missed call, "maybe", and money in Indian number words.
The classifier (`engines/call-intel-classifier.ts`), Naive Bayes trained
nightly on our own logged notes, votes on the outcome. It votes against the
model ONLY if its own cross-validation says it is right at least 80% of the
time when sure, because Naive Bayes is overconfident by construction.
`engines/call-intel-decide.ts` combines them and is where the client's rules
live.

**The model reports date CUES, never dates.** "After 15 days" comes back as
`{in_days: 15}` with the words it came from, and `engines/call-intel-dates.ts`
does the arithmetic against the business date and the working week. That file
also parses the same words itself. Where the two readings land on different
days, or "next Friday" can mean two days, or the day has already gone, the
date is left EMPTY and the candidates are offered as buttons.

**Unsure means ASK, and a default is never filled in.** Below
`callIntel.confirmBelowPercent`, or where a trusted classifier disagrees, the
card asks "Which was it?" with each candidate ready to apply. A date nobody
said is a question with suggestions, not a filled field. "I may order next
week" is an opportunity, never an order: an order needs the model to say
confirmed AND no "maybe" in the words. Do-not-call is shown whenever either
reader hears it, and the option that writes it is always the telecaller's
click. Existing open reminders, complaints, opportunities and samples are
read first, and a match is named, with a move offered in place of a second
reminder.

**A DICTATION HAS NO LENGTH A PERSON WILL MEET, because it is sent while it is
spoken.** The recorder cuts itself into pieces at the speaker's own pauses —
at least 15 seconds of speech, then the first stretch as quiet as the room,
never later than 27 — and each piece is a fresh MediaRecorder on the same
stream, so each is a complete file sent to `/api/dictate/piece` the moment it
is cut. The next piece starts before the last stops, so nothing between them
is lost. Every piece sits inside Sarvam's 30-second ceiling, so no provider's
limit reaches the person any more, and the wait after Stop is ONE short piece
however long they talked. The only ceiling is an hour, which exists so a
microphone left open on a desk overnight does not stream the office to a
provider. A piece that fails is retried once and then offered as "Send it
again" from the audio still held; a refusal no retry will change (no key, no
credit, switched off) stops the recording at once rather than after five more
minutes of talking. Each piece is written into English as a CONTINUATION
(`PIECE_NOTE`), so the pieces join into one note rather than a stack of small
ones. A call note keeps up to `interactions.maxNotesLength` — 20,000 now, moved
from 2,000 by `0171` where nobody chose it — and the assistant reads up to
`MAX_CALL_TEXT`.

**THE MICROPHONE READS THE CALL WHILE IT WRITES THE NOTE, not after.** It
used to be two trips with a person between them: the modal transcribed and
wrote the English, the telecaller pressed "Use this", and only then did the
assistant start. Each piece's answer is a stream — `heard` (the words and the
provider's rough English) before `written` — and the moment every piece is
heard the call assistant starts reading from the transcript, while the last
piece's English is still being written. So the wait is the last piece plus the
slower of writing and reading, not their sum plus a click. The draft is
corrected to the English actually used once it exists
(`noteDraftEnglish`). A reading that fails never costs the note.

**The reading is drawn IN the modal, and one press uses both.** "Use this and
fill the form" puts the note in the box and fills the form from the first pick
— only where that pick is READY. Anything the assistant would have asked about
stays a question: in the modal "Which was it?" is a row of buttons, and tapping
one IS the import. Do-not-call is shown there and filled by nothing but the
telecaller's own click on the panel, as before. `DictationCompanion` is how
`dictate.tsx` carries this without knowing what a call is.

**An edit is read again, and the edit wins.** The reading is of the words that
were heard; a telecaller who corrects "15 days" to "5 days" has made the one
change that matters, and filling the form from the old reading would put the
mistake back. So a pause after typing re-reads the note with `edited: true`,
which tells the model the corrected English overrides the transcript and keeps
the transcript out of the rules and the classifier. Until the new answer lands
the card says so and its buttons are held. Pressing "Use this" on a note the
reading has not caught up with — an edit, Tighten, or Replace dropping the typed
half — reads it again first and fills when it lands. Every reading is its own
`call_ai_drafts` row; only the one applied is linked to the call.

**Examples come from our own book, not from a fine-tune.** Each request shows
the model the past calls whose notes read most like this one
(`calls_notes_trgm_idx`, trigram KNN), one per distinct note, and leaves out
any note the office itself logged two ways. `npm run jobs -- call-intel-train`
relearns the classifier (nightly too), and `npm run jobs -- call-intel-eval
--limit=80` runs the whole pipeline over logged calls and reports how often
its outcome matches the one somebody chose.

**THE SALESMAN HAS THE SAME ASSISTANT, AND IT READS A VISIT RATHER THAN A
CALL.** In the shop he speaks into the visit note's microphone, in any
language, or types, and presses "Read my note". `/api/mbos/visit-assist` reads
it (`lib/services/visit-intel-service.ts`) and the card on the visit screen
(`mbos-app/src/components/visit-assistant.tsx`) shows what it understood: the
outcome chip, the day to come back, and each follow-on the visit implies. "Fill
the visit" fills the outcome and the day ONLY where he has not answered them
himself (`engines/visit-assist.ts`, `fillVisit`). Each follow-on opens its own
ordinary form with the answers in it: the order screen with the cart filled,
the receipt with the amount and mode, the complaint and sample sheets drafted,
the lead's requirement boxes. His Save on each is still the only thing that
writes. The one row the assistant writes is `call_ai_drafts` with
`channel = 'visit'`, and `handleVisit` writes what the visit was SAVED as onto
it in the visit's own transaction. It writes only onto the salesman's own
visit draft, so a payload naming somebody else's draft id marks nothing.

**A visit is not a call, which is why it has its own reading and its own
engine.** `visitReadingSchema` asks what a phone call never can. Was money
HANDED OVER, which is a receipt to write now, or promised, which is a day to
come back? Filing the second as the first puts cash in a salesman's pocket
that is not there. Was anybody there at all? A shut shutter files as Shop
closed and drops whatever a staff member guessed about an order. On a lead,
what does the shop need? `engines/visit-intel-decide.ts` is pure and applies
the call assistant's rules unchanged:

- A maybe is not an order.
- Unsure means ask. Two strong intents on different chips become a question.
- An amount the model and `parseAmounts` disagree on is named twice.
- Litres are asked about, never turned into cans.
- An open complaint in the same category, or an open sample of the same
  product, is named rather than proposed again.

What it shares with the call assistant is imported, not copied: date cues
through `datedFrom`, products through `chooseProduct`, and the model ladder
through `lib/structured-read.ts`. Both assistants now call that one
OpenAI-then-Sarvam function.

**The Suspect verdict is a SUGGESTION he taps, and only where the cap demands
it.** §28 is that no lead climbs a rung on its own, so "sounds like a prospect"
selects the answer on the lead card and moves nothing. The requirement is
proposed for leads only.

**It has no classifier, deliberately.** The call assistant's third reader is
trained on thousands of logged call notes. Visit notes were optional and most
are blank, so a classifier trained on them would vote with confidence it has
not earned. The drafts table is collecting the labelled pairs one will need.

**It needs signal and says so before it is pressed.** A proposal that arrived
through the outbox tomorrow would be a suggestion about a visit already saved,
so unlike the visit it is never queued. `mbos.ai.visitAssistant` rides the
pull as an ANSWER, the way `mbos.ai.dictation` does. It is worked out from
`visitIntel.enabled` and whether a model key exists. No key and no model name
crosses the wire, and the handset defaults to unavailable. The model is
`visitIntel.model`, and the confidence floor is the call assistant's
`callIntel.confirmBelowPercent`, because how often a person should be asked is
one judgement, not two.
