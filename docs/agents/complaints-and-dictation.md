# Complaints, credit-note requests, dictation

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**A retired outcome is readable, never writable.** "Part payment promised" is
gone from the follow-up form but stays in `PAY_OUTCOMES` marked `retired`, so
attempts already recorded against it still resolve to a label. The screen reads
`offeredPayOutcomes()`; the save schema simply does not accept it. Hiding it in
the interface alone would leave it reachable.

**A credit note amount without a request is refused.** A figure sitting on a
complaint nobody asked a credit note for reads as an approved amount to whoever
opens it next. Requests have nowhere to go yet — there is no Accounts app — so
they surface on a manager's pending list rather than sitting invisible. That is
interim, and a credit note has financial consequences.

**A credit-note request is a yes, and nothing more.** The telecaller answers
whether the customer asked for one; which bill it is against and what it is
worth are accounts' work, because they hold the ledger. Asking mid-call for the
bill produced either the wrong one or no request at all — the form was three
fields deep behind a radio button, and the person on the phone was waiting.
`bill_id` and `goods_description` stay on the row and are still stored when
something supplies them; nothing on a telecaller's screen asks. The pending
list left-joins the bill, so a request that names none still reaches accounts.

**An attachment nobody can open is an attachment nobody uploaded.** Photographs
were write-only for as long as they have existed: no screen displayed one, and
`canRead` handed a raw snake_case row to `assertCustomerInScope`, which reads
camelCase — with `as never` silencing the compiler. `kind` was absent and
`ownerId` undefined, so the owner was refused their own file and every read
answered 404. It failed SHUT, which is the safe direction and exactly why it
survived: there was no screen to notice it on. A cast that quiets a type error
across a naming boundary is the bug, not the fix.

**A stored enum is not a label.** `packaging_damage` was reaching the screen
unchanged. The categories a person picks from are configuration and several
fold onto one enum value, so the way back cannot be derived from that list —
`lib/complaint-labels.ts` holds it, pure and client-safe.

**A photo picker adds, counts and lets one go.** Complaint photographs are
taken one at a time, so a second visit to the file dialog must not discard the
first; the limit — `attachments.maxPerComplaint`, six — is shown and refused at
the picker rather than silently truncated by `bindAttachments` after the save;
and a wrong photograph comes out on its own. One component, `crm/image-picker`,
because the complaints dialog and the call drawer ask the same question and had
drifted into two answers. Its accept list is `ACCEPTED_IMAGE_TYPES` and never a
literal: both screens offered WebP for months while `sniffContentType` refused
it, so the picker took a file the save would not.

**The microphone is tinted, small, and inside the box.** It shipped as a
muted grey glyph in the bottom corner, the same weight as the resize grip and
overlapping it — and the two read as one piece of furniture. Nobody presses
furniture, least of all the telecaller who is not confident with computers and
is exactly who it was built for. What fixed it was not size: it is that the
control is coloured, so it registers as something offered rather than
something structural, and that it is nudged clear of the grip it used to sit
on. Its words — "speak instead of typing, say it in any language" — ride on
`title` for hover and for screen readers, not in the layout, because twenty
prose fields each carrying a sentence of guidance is clutter, not help.

**No screen names a language.** Not the button, not the modal. A list of four
reads as the set of allowed answers, and somebody whose language is missing
from it stops before they start — which is the exact fear the sentence exists
to remove. "Any language" says more by naming none.

**Dictation shows what it heard before it writes anything.** A telecaller
thinks in Hindi, Marathi or Gujarati and types in English slowly with the
customer waiting, so the note that gets written is the short version of what
was actually said — a loss nobody can see later, because "will pay" reads
exactly like a sentence that never named a date or an amount. The microphone
on every prose box is there to close that gap, and it opens a modal rather
than writing into the box: the person reads the English, edits it, and decides
to import it. Nothing arrives in a field unseen.

**The English it shows first is faithful, not a summary.** Transcription and
translation are two passes and the second is instructed to drop nothing —
numbers, bill numbers, product names and commitments all survive. Tightening
is a THIRD pass somebody asks for by pressing a button, having read the long
version, and Undo puts it back. A summariser on the way in would quietly lose
the bill number, and the note it produced would look exactly like an honest
one. The original-language transcript is a click away, because the only way to
know a translation went wrong is to read the sentence it came from.

**A held recording captures nothing, and the screen has to look like it.**
Pause is `MediaRecorder.pause()`, so the held seconds are ABSENT from the blob
rather than recorded as silence — what comes back is what was said before and
after, joined. The audio track is disabled alongside it, which takes the
microphone out of the loop as well as the container. The timer stops, so
`elapsed` counts recorded seconds and not wall-clock ones: that is the number
the recording ceiling has to be measured in — a five-minute interruption must
not eat somebody's limit — and it is the number the server routes on, since
Sarvam's 30-second refusal is about the length of the audio and not how long
the modal was open. The pulse ring stops, the level meter goes STILL rather
than falling back to its idle loop, and the sentence says nothing is being
recorded. A meter travelling under the word "Held" is the screen claiming it
can still hear you. The button is not drawn at all where the browser cannot
pause — Safari only learned in 14.1 — for the same reason the microphone is
not drawn where it cannot record. Closing the modal from a pause has to
release the microphone too: the cleanup tests `state !== "inactive"`, because
a held recorder is neither recording nor inactive and `=== "recording"` left
it running.

**The audio is never stored.** It is read from the request, sent to the model
and dropped: no `attachments` row, no blob key, no retention window and no id
to fetch it back by. A recording of a customer conversation is a different
thing to hold than a photograph of a damaged can, and nothing here has asked
to hold it. That is also why dictation is a route handler rather than a server
action — two minutes of Opus is past the 1MB action body limit, and raising
that ceiling for every action in the app to carry one feature's audio is the
wrong trade.

**A microphone that fails when pressed is worse than one never offered.** It
draws nothing at all when `voice.enabled` is off, when there is no key, or
when the browser cannot record — and the setting is checked in the route as
well as in the interface, because a hidden box is not a disabled feature.

**Sarvam is asked first, and OpenAI catches what it cannot take.** `saaras`
is built for Indian languages and code-mixed speech — Hindi with English words
dropped in mid-sentence is what it is FOR rather than something it copes with,
which is how a telecaller actually talks. Its synchronous endpoint refuses
audio over 30 seconds, and rather than cap every recording at half a minute,
anything longer goes to OpenAI instead, as does anything Sarvam fails on. The
recording is never lost to a provider's ceiling, and `checkConsistency`
refuses a recording limit above 30 seconds only when the fallback is off —
otherwise the limit and the ceiling are allowed to differ, because the routing
is what reconciles them.

**OpenAI is the floor; Sarvam is an improvement on it.** A deployment with
only an OpenAI key runs the whole feature — hearing, writing, tightening — at
the full recording limit, whatever the provider and fallback settings say.
Sarvam is what makes the short recordings better, not what makes dictation
work. The fallback switch exists to honour the opposite deployment, one that
HAS a Sarvam key and wants audio kept inside India at the cost of the
30-second ceiling; with no Sarvam key there is no such deployment to honour,
and the switch used to refuse OpenAI on behalf of a provider nothing was going
to ask — a configured account sitting unused behind a microphone nobody was
shown. Both `resolveReadiness` and the guard in `transcribeSpeech` now require
a Sarvam key to be present before the switch means anything, and the tests
sweep every provider/fallback combination against a missing Sarvam key to say
so.

**The duration comes from the browser, and being wrong about it is cheap.**
The recorder already counted the seconds for the timer on screen, so the
client sends them and the server routes on that. Decoding the audio
server-side would ship a decoder to answer a question the recorder had already
answered; a tampered value costs one refused Sarvam call and a fallback, which
is what would have happened anyway. A missing value reads as long, which is
the safe direction.

**Sarvam is asked twice, in parallel, on the same audio.** `transcribe` gives
what was said in the language it was said in; `translate` gives the English.
Both are needed because the "show what was heard" panel is the only way anyone
catches a translation that went wrong, and they run together so the person
waits for the slower rather than the sum. Where OpenAI serves instead, the
English is a second, text-only pass over the transcript — same two answers,
different shape.

**Claude could not have been the ear.** Its inputs are text, images and
documents, with no audio modality at all, so an Anthropic key buys the writing
half and none of the hearing half. Transcription is the half that decides
whether a microphone can do anything, which is why it is not offered there.

**Hearing and WRITING are two jobs, and only one of them needs a particular
provider.** The bytes can only go where the audio is sent, but turning what
was heard into English is a text call any chat model can make, so
`lib/writing-model.ts` tries OpenAI and then Sarvam and the note gets written
either way. Welding both jobs to one account is what produced a deployment
whose Sarvam key worked perfectly and whose notes were raw machine
translation, with Tighten and Rewrite hidden and nothing saying why. OpenAI is
asked first because English prose is what it is best at; Sarvam second because
a plainer sentence beats no sentence. A permanent refusal — no credit, revoked
key — moves straight to the next provider rather than being reported, because
the person is mid-call and does not care whose billing failed.

**Every path runs the written pass, including Sarvam's.** Sarvam's `translate`
is a translation and reads like one: correct in substance, rough in grammar,
unpunctuated where speech was. It was going to the telecaller verbatim, which
made them the proofreader mid-call — most of what dictation was supposed to
give back. The writing model is handed BOTH the original-language transcript
and Sarvam's English, because the two disagree usefully: the transcript holds
what was said, the draft holds a reading of it by a model built for these
languages. Rendering from the transcript alone throws away the better half of
the evidence for a name or a number.

**Correct English is a rule of the prompt, not a hope.** `RENDER_SYSTEM` makes
grammar, tense, agreement, articles, prepositions, word order and awkward
machine-translation phrasing all the model's to fix — and says in the same
breath that fixing the English is not licence to change a fact. A note somebody
has to decode is a note they stop trusting; a note that reads well and quietly
lost the bill number is worse than both.

**Tighten and Rewrite are left out rather than shown broken.** They are a text
call, so `/api/dictate` answers `canRefine` and the modal omits the buttons
when it is false — but that is now false only when NEITHER provider has a key.
Requiring OpenAI hid both buttons on a deployment that could have run them,
which is the microphone mistake one level down: a capability withheld because
of who was asked rather than because of what could be done.

**The keys are set from a screen, because a terminal is not a fallback.** On a
deploy nobody has shell access to, an environment variable is a door somebody
else has to open, and the feature stays off until they do with nothing saying
why — the same lesson the sheet import already learned. `app_secrets` is
DELIBERATELY not `app_settings`: settings are rendered on screens, exported as
JSON, and audited with their before and after values, so a key kept there
would be readable in four places and one of them is a log nobody prunes.
`readSecret` is the only function that selects the value and it is called by
the request about to spend it; screens call `secretStatuses`, which selects
the last four characters and nothing else. The audit row records who changed
which credential and when, never what to. The console wins over the
environment where both are set, and the environment still works alone, so a
deploy that already has variables needs no migration.

**A key is stored as written, and the screen says so.** There is nowhere to
keep an encryption key that MahekOne can read and a database backup cannot —
one in the environment puts us back to needing shell access, which is the
problem the table exists to solve. Pretending otherwise on the screen would be
worse than the storage itself, so the screen states the trade and says to
rotate at the provider if a dump ever leaves your hands.

**Dictated text is added, never substituted, unless somebody says otherwise.**
Where the box already has words, Add and Replace are two buttons and Add is
the default one. `VoiceTextarea` decides the joining and the `maxLength`
ceiling in one place rather than at twenty call sites that would each get one
of them slightly wrong — `maxLength` stops typing but not a programmatic set,
so the box would otherwise accept more than the field will save.
