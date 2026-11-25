# Spoken Ask AI, handset microphone, lead scan and voice

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**EVERY ASK AI DRAWER TAKES A SPOKEN QUESTION, and answers in the language it
was spoken in.** `components/shell/ask-mic.tsx` puts this same microphone
beside the box in the CRM, Sales, ERP and Docs drawers — the same window, the
same review of the English, with "Ask this" as its button. The ENGLISH is what
the assistant reads, because the SQL, the screen loaders and the documentation
search are all good at English; what was SAID rides beside it as `voice`, and
`lib/ask-voice.ts` turns it into one instruction appended to the question:
write the answer in that language and its own script, keeping figures and
names exactly as the records give them. A telecaller who does not read English
gains nothing from an English answer to a Marathi question. The answer cache
is keyed on the answer's language too, or a Hindi answer would be served to the
next person typing the same question in English. English speech adds nothing —
the model already answers English in English.

**THE SALESMAN GETS THE SAME MICROPHONE, and he needed it more than the
telecaller did.** A telecaller types slowly with a customer on the line; a
salesman types on a phone, one-handed, standing in a shop, in a language he
does not write. MBOS had a microphone on exactly one box — a "Hold to talk"
recorder on the visit screen — and the other seven prose fields on the app
(the lead note, the leave reason, the expense note, the tour purpose, the
complaint's "in their words", the sample's "why he wants it") had none. That
recorder had also never been reachable: nothing on any path called
`requestMicrophone`, so `RECORD_AUDIO` was never asked for and preparing
threw, and the screen reported a broken handset rather than a dialog nobody
put up. `VoiceField` is `VoiceTextarea`'s counterpart and every one of those
boxes is one now.

**It is the SAME hearing, through the same functions, behind a different
door.** `lib/dictation-requests.ts` holds what used to be inside
`/api/dictate/*`: read the configuration, ask `transcribeSpeech`, and turn
each of the six ways it can fail into a status and a sentence. Only the
authentication differs between the two doors — a browser session for the CRM,
a device token for `/api/mbos/dictate/*` — and three of those six sentences
are specific and hard-won ("record it in two shorter goes" is not "the service
is down", and neither is "tell your manager, this one will not fix itself"), so
a second copy of that ladder would drift within a release. The half that
drifts is always the half somebody reads at the worst moment.

**A handset cannot ASK whether it may draw a microphone.** The CRM's mic hits
`/api/dictate` as it renders, which is right for a browser and useless in a
godown with no bars — a screen that had to reach a server before offering a
button would offer none exactly where speaking beats typing most. The answer
rides down on the pull instead, as `mbos.ai.dictation`, and is read from the
local cache. What crosses is the ANSWER and never the question: no `voice.*`
setting goes down that wire and no key behind one, because nothing on a phone
calls a transcription provider — the audio goes to MahekOne and MahekOne spends
the credential. Two tests in `mbos-wire.test.ts` pin both halves, because the
two sides are joined only by a spelling and getting it wrong FAILS SILENTLY:
`getConfig` falls back to `{ available: false }` and every screen simply draws
nothing, on a deployment that paid for the feature and switched it on.

**No signal is a different refusal from no provider, and they are drawn
differently.** No provider — dictation off, or no key — is permanent, so
nothing is drawn at all, which is the rule the CRM already follows. No signal
is temporary and changes minute to minute, so the mic stays where it is and
goes dim; a control that appeared and vanished while somebody looked at the
screen is one they learn is not there.

**And one field has an answer to no signal rather than an apology.** The visit
note is where the recording is a record of what a customer said rather than a
keyboard, and a visit has somewhere to keep audio — so `keepAudio` there means
the mic still works offline: it records, the file joins the media queue, and
the office writes it out on the far side through the transcript channel that
already existed. That is what the old "Hold to talk" recorder claimed to do.
Everywhere else the audio is dropped the moment the words come back, exactly
as the CRM's is, because a recording of a customer conversation is not a thing
to hold without a reason.

**A visit keeps the recording even when it was dictated.** The words in the box
are somebody's reading of what was said; the audio is what was said. Handing it
to the queue happens BEFORE the transcription is attempted, so a provider that
does not answer costs the note and never the recording — and saying it again
discards the superseded file rather than shipping every attempt.

**Speech is not music, and the preset was for a band.**
`RecordingPresets.HIGH_QUALITY` is 128 kbps of stereo at 44.1 kHz — about a
megabyte a minute, crawling up a 2G link while somebody waits for their own
words, or sitting in the media queue ahead of the payment behind it. None of it
buys accuracy: every model this audio can reach downmixes to mono and resamples
to 16 kHz first. 24 kHz mono at 32 kbps is a seventh of the size and still
comfortably above what they use. `LOW_QUALITY` is the wrong floor in the other
direction — AMR narrowband on Android is a telephone line, and a telephone line
is where transcription of Indian-language speech starts losing names and
numbers.

**The bytes are sniffed here too, and for the second reason rather than the
first.** The handset labels its own recordings `audio/m4a`, which names no
container Sarvam recognises — and the extension there is the one place a media
type is genuinely load bearing, since the service refuses the part before it
reads a byte. The bytes say `audio/mp4`, which is both the truth and what
Sarvam can take.

**A VISITING CARD CAN FILL THE NEW LEAD FORM, and only a person moves it in.**
The scan icon in the New lead sheet's header takes up to `leadScan.maxImages`
photographs — a card's front and back, the shop board, a bill head — and
`/api/mbos/lead-scan` reads them in ONE call, because three views of one
business asked about separately are three half-answers to reconcile. What
comes back is a review list, every value editable and ticked where found, and
"Fill the form" moves only the ticked ones; "Add lead" is still the only thing
that saves. A value about to overwrite something he typed says so.

**OpenAI first by default, and the photographs are never stored by us.**
Sarvam's chat endpoint cannot see, but its Document Intelligence Extract can
(`lib/sarvam-extract.ts`: a JOB — create, poll, fetch — not a call), so
`leadScan.provider` may put Sarvam first. That is a ladder, not a swap:
whatever Sarvam fails on or finds nothing in goes to OpenAI inside the same
75-second budget (Sarvam gets the first 35), and an Indian-script field it
returns goes through OpenAI's English pass. The GSTIN second look exists only
on the OpenAI path. With neither reader available `mbos.ai.leadScan` says
unavailable and no icon is drawn. The bytes are read from the request and
dropped, exactly as dictation's audio is — the form's Shop photo is the
deliberate photograph and goes through the media queue as before. SARVAM KEEPS
what it is sent for its account's retention (eight days, not settable per
job); OpenAI is asked to keep nothing. Every setting that sends a card to
Sarvam says so.

**WHO READS FIRST IS DECIDED BY THE READING TRIAL, NOT BY "BUILT FOR INDIA".**
The owner's instinct (2026-11-25) was Sarvam first everywhere; the agreed
rule is per feature, and only where the trial shows Sarvam winning.
`read-trial-service.ts` reads the same photographs with both and keeps
per-field VERDICTS in `ai_read_trials` — never a value read, because a card is
a person's name and number. Expense bills are SCORED against what the salesman
typed (Admin Console → Integrations → "Read bills with both",
`readTrial.expenseBills` at a time, a bill never read twice); lead scans are
COMPARED, field by field, after the handset has its answer (`after()` in the
route, `leadScan.trial`, OFF by default since it sends every card to a second
company). A scan has no truth on file, so its evidence is agreement plus the
GSTIN checksum. The typed expense amount is the CLAIM, which may be less than
the bill — both readers carry that noise, so compare them, not each to 100%.
Speech is already Sarvam first (`complaints-and-dictation.md`); writing stays
OpenAI first (`writing-model.ts`); LR reads stay OpenAI, because the reader is
given each transporter's past LR numbers and Extract takes only a schema.

**What the model read is CHECKED, not trusted, in `engines/lead-scan.ts`.** A
landline with its STD zero stripped is ten digits that look like a mobile, so
the model labels each number's kind and only a mobile-shaped number it did not
call a landline becomes the mobile; the rest are offered as chips. A GSTIN is
judged by its checksum, repaired only where the FORMAT forces the repair (O for
0 in a digit position) and the checksum then agrees, and one that still fails
is passed through UNTICKED with a warning — never dropped, since he can read
the card and we cannot. A valid GSTIN's state code fills an empty state and
never overrules the board. A scanned town is matched to his allocated areas
(`mbos-app/src/engines/lead-scan.ts`), and a town outside them is said rather
than typed into a box the save would refuse.

**And the contact person is optional now, as the form's own sentence always
said.** "Write a name or the shop name" was the refusal while it demanded the
name: a shop board names the shop and nobody in it. The lead's `name` is the
person where there is one and the shop where there is not, and the person also
travels as `contactPerson`; the GSTIN travels on the create, which
`leadSchema` already accepted and the handset never sent.

**AND THE REST OF THE FORM CAN BE SPOKEN.** A card fills six answers from what
is printed; the other ten are what he learned standing there — what they buy,
how much, from whom, who decides, when to come back — and none of that is on a
card. "Speak about the shop", at the top of the New lead sheet, opens a box
with the ordinary microphone in it: he says everything once, in any language,
for up to `voice.maxSeconds` a go (two minutes — the one ceiling every mic on
the handset shares, which is why `leadVoice.*` has no duration of its own), and
presses the mic again to ADD a second take. `/api/mbos/lead-voice` reads the
box into all sixteen answers and the panel lists them exactly as the scan
does: ticked where heard, editable, "Fill the form" moves only the ticked ones,
"Add lead" is still the only save — and what was NOT heard is named, because a
gap he can see is one he fills.

**TEXT GOES UP, NOT AUDIO, and that is the design rather than a shortcut.** The
dictation sheet is the ear: it pauses, sends short audio to Sarvam and long
audio to OpenAI, and shows him the English to correct BEFORE anything is read.
So what the model reads is words he has already checked, a misheard digit is
fixed in the box rather than discovered in the form, and the hearing half is
not built twice. The original-language transcript of each take rides along
while it still belongs to the box, and the prompt prefers it for names and
numbers, as the visit assistant's does. Reading words needs no eyes, so unlike
the scan this takes `readStructured`'s OpenAI-then-Sarvam ladder, and
`mbos.ai.leadVoice` is available on either key — but the handset also asks
`mbos.ai.dictation`, because without an ear there is nothing to speak into.

**`engines/lead-voice.ts` checks what was heard, on top of the scan's rules.**
The mobile and GSTIN rules are the scan's own functions, because they are about
the values and not how they arrived. Speech adds three: a choice (kind of sale,
source, kind of business) must be a code on the office's list or it is dropped
and said; a follow-up is a CUE resolved by `datedFrom` against the working
week, offered as chips where it could mean two days and never filled from a
date the model computed; and a rupee or litre figure past any real shop is a
mishearing ("forty" as "four crore") and is left empty with a line saying so.
The handset re-checks the codes against the lists IT draws, since a phone that
has not pulled since `leads.sources` was edited holds the older list.
