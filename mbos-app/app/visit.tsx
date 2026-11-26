import React from 'react';
import { Animated, View, Text, Pressable, TextInput, type StyleProp, type ViewStyle } from 'react-native';
import { router, useNavigation } from 'expo-router';
import { color as C, HIT, weight } from '../src/theme/tokens';
import { Icon, type IconName } from '../src/components/ui/Icon';
import { Pop, Presence, PressableScale, Pulse, Swap, useShake } from '../src/components/ui/motion';
import { feedback } from '../src/components/ui/feedback';
import { HERO } from '../src/components/shell/Chrome';
import { skuText } from '../src/components/ui/sku';
import { BottomSheet, Calendar } from '../src/components/ui/overlays';
import { AppFrame } from '../src/components/shell/AppFrame';
import { OdometerCamera, type OdometerResult } from '../src/components/ui/odometer-camera';
import {
  abandonLeg,
  arriveForVisit,
  arrivedLegFor,
  bindLegToVisit,
  openLegOf,
  travelModes,
  type TravelLeg,
  type TravelMode,
} from '../src/data/travel';
import {
  arrivalNeedsMeter,
  arrivalPrompt,
  legLine,
  navigationLine,
  travellingFor,
} from '../src/lib/travel-leg';
import { suspectFor, visitCapThresholds } from '../src/data/leads';
import { visitCapLabel, visitCapState, type VisitCapThresholds } from '../src/engines/leads';
import { restoreVisitDraft, useCustomer, useStore, type VisitForm, type VisitLinked } from '../src/state/store';
import { useBoot } from '../src/state/boot';
import { hhmm, isoDate, pretty, distanceLabel } from '../src/lib/format';
import { cleanDecimal, cleanWhole, parseDecimal, parseWhole, wholeOnly } from '../src/lib/decimal-input';
import { elapsedLabel, FOLLOW_ON, unansweredQuestions, visitChecks, visitVerdict } from '../src/lib/visit';
import { COMPLAINT_CATEGORIES, COMPLAINT_PRIORITIES, FOLLOW_UP_MODES, OUTCOMES, outcomeLabel } from '../src/data/fixtures';
import { getConfig } from '../src/data/config';
import { previousVisitNote, saveVisit, type PreviousNote } from '../src/data/visits';
import { checkInAtShop, clearArrival, patchArrival, recordArrival } from '../src/data/arrival';
import { logComplaint, requestSample } from '../src/data/requests';
import { sampleReasons } from '../src/data/lead-samples';
import { type CodedOption } from '../src/engines/funnel';
import { rememberedSuggestions } from '../src/data/order-suggestions';
import { todayStops } from '../src/data/journey';
import {
  checkInVerdict,
  haversineMetres,
  visitLocationVerdict,
  type CheckInVerdict,
} from '../src/engines/geo';
import { fixOf, getFix, type Fix } from '../src/native/location';
import { queueOdometerPhoto, queueRecording, takePhoto } from '../src/native/capture';
import { discardQueuedMedia } from '../src/sync/media';
import { VoiceField } from '../src/components/ui/dictate';
import { OUTCOME_ICON, VisitAssistant, type VisitAssistantHandlers } from '../src/components/visit-assistant';
import {
  cartFrom,
  complaintDraft,
  fillVisit,
  paymentFill,
  requirementFill,
  sampleDraft,
} from '../src/engines/visit-assist';
import { NavigateButton } from '../src/components/ui/navigate';

/**
 * Capturing a visit.
 *
 * The rule that shapes this screen: the save is never refused outright. The
 * checklist says what is missing and why the rule exists, and the dashed
 * button under it saves anyway — unverified, with a reason, and the manager
 * told. A salesman who cannot log a visit stops logging visits, and then the
 * office knows nothing at all.
 *
 * The GPS follows the same rule one level down, at the SAVE. A fix is evidence
 * there, never a gate: no fix, a fix accurate to half a kilometre, or a shop
 * whose recorded coordinates are simply wrong all let the visit through and
 * are recorded as what they are.
 *
 * **THE ARRIVAL IS THE EXCEPTION, and it is the one thing on this screen that
 * refuses.** Mahek asked for a check-in measurably outside the radius to be
 * turned down rather than flagged, and the arrival is the only place that can
 * honestly happen: nothing has been typed yet, so a refusal costs a walk to
 * the right door instead of a day's work, and he can press the button again.
 * `checkInVerdict` decides it: no fix, or a fix too wide to trust, is refused
 * too, and a shop with no pin goes through only once he confirms he is at it —
 * that check-in becomes its pin. The way past a DISTANCE refusal is a typed
 * sentence, which saves the visit unverified and goes to his manager: the pin
 * in this book is very often the wrong one, and a salesman who cannot record
 * being where he actually is stops recording.
 */

type Product = { id: string; name: string; packSize: string | null; sku?: string | null };

/*
 * How often the On-your-way screen asks the radio where he is, and the range at
 * which that question changes character.
 *
 * NEITHER IS A BUSINESS RULE, which is why neither is in the registry. Nothing
 * is priced, refused or paid on these: the cadence is how often one line of
 * text is refreshed while a screen that only exists mid-journey is open, and
 * the range is where a distance stops meaning "is it worth going" and starts
 * meaning "which doorway". What IS configuration is the age at which a reading
 * is called stale — `mbos.location.activityFixMaxAgeSeconds`, read below —
 * because that decides what a screen ASSERTS about a fix.
 */
const ROAD_FIX_EVERY_MS = 20_000;
const APPROACHING_M = 1_000;

export default function Visit() {
  const c = useCustomer();
  const boot = useBoot();
  const gps = useStore((s) => s.gps);
  const shots = useStore((s) => s.shots);
  const note = useStore((s) => s.note);
  const outcome = useStore((s) => s.outcome);
  const nextDate = useStore((s) => s.nextDate);
  const nextMode = useStore((s) => s.nextMode);
  const visitStart = useStore((s) => s.visitStart);
  const visitDone = useStore((s) => s.visitDone);
  const set = useStore((s) => s.set);
  /* Set on the route screen, before the shop was chosen. See `deviationReason`
     in the save below. */
  const offPlanReason = useStore((s) => s.offPlanReason);
  const notify = useStore((s) => s.notify);
  const markVisitDone = useStore((s) => s.markVisitDone);
  const askConfirm = useStore((s) => s.askConfirm);
  const checkedIntoShop = useStore((s) => s.checkedIntoShop);
  const cart = useStore((s) => s.cart);
  const payAmt = useStore((s) => s.payAmt);
  const payMode = useStore((s) => s.payMode);
  const arrival = useStore((s) => s.arrival);
  const setArrival = useStore((s) => s.setArrival);

  const [form, setForm] = React.useState<'complaint' | 'sample' | null>(null);
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const [formErr, setFormErr] = React.useState<string | null>(null);
  const [calOpen, setCalOpen] = React.useState<'next' | 'trial' | null>(null);
  /*
   * ONE COMPLAINT PER PRESS, and one sample.
   *
   * Both sheets wrote on a bare async handler with nothing disabled while it
   * ran, and `logComplaint` mints a fresh id on every call — so a second tap
   * on a slow write produced two complaints, of which `setLinked` kept only
   * the second. The first reached the desk team attached to no visit at all.
   *
   * The ref is what actually guards, because it is set synchronously: a
   * `useState` flag is read from the closure of the render that drew the
   * button, which is exactly the render where it was still false. The state
   * beside it is only what the label and the disabled look are drawn from.
   *
   * One pair for both sheets: `form` holds one or the other, never both.
   */
  const formBusy = React.useRef(false);
  const [formSaving, setFormSaving] = React.useState(false);
  /*
   * A week out, worked out ONCE when the screen opens.
   *
   * `defaultTrial()` was called from the render path — a clock read during
   * render, which this app forbids and the compiler lint watches for — and it
   * was called again from the save, so a screen open across midnight could
   * offer one date and store another.
   */
  const [trialDefault] = React.useState(defaultTrial);

  /* Everything captured here that is not yet a visit: the fix, the recording,
     the records punched from inside it. `saveVisit` binds the lot in one
     transaction — a half-saved visit describes something that never happened. */
  const [fix, setFix] = React.useState<Fix | null>(null);
  const [fixReason, setFixReason] = React.useState<string | null>(null);
  /* In the store, not here: the visit outlives this screen — see `visitLinked`. */
  const voiceNoteId = useStore((s) => s.visitVoiceNoteId);
  const setVoiceNoteId = (id: string | null) => set({ visitVoiceNoteId: id });
  /*
   * THE VISIT ASSISTANT'S THREE PIECES OF STATE.
   *
   * `heard` is the last dictation in the language it was spoken in — the
   * assistant reads both, because a name or a number is often clearer in the
   * words it was said in than in their English. `nextDatePicked` is whether he
   * chose the return day himself: the cycle's suggestion is the screen's, not
   * his, and a date the customer named may replace it where his own choice
   * may not. `aiDraftId` is the reading the visit was filled from, carried on
   * the save so the office can see what was proposed beside what was kept.
   */
  const [heard, setHeard] = React.useState<{ spoken: string; english: string; language: string | null } | null>(null);
  /* The form's own answers live in the store with the rest of the draft, so
     a reap does not take them — see `VisitForm`. Read and written through two
     small helpers rather than eight `useState`s. */
  const visitForm = useStore((s) => s.visitForm);
  const setForm2 = (patch: VisitForm) => set({ visitForm: { ...useStore.getState().visitForm, ...patch } });
  const nextDatePicked = !!visitForm.nextDatePicked;
  const setNextDatePicked = (v: boolean) => setForm2({ nextDatePicked: v });
  const aiDraftId = visitForm.aiDraftId ?? null;
  const setAiDraftId = (v: string | null) => setForm2({ aiDraftId: v });
  const noFollowUp = !!visitForm.noFollowUp;
  /*
   * §B — is this shop still a Suspect, and is a decision due?
   *
   * Null for anything that is not a lead, which is most of the book: a real
   * customer is never asked to justify a visit. Loaded rather than derived,
   * because the count includes visits the office knows about and this phone
   * does not.
   */
  const [suspect, setSuspect] = React.useState<{ stage: string; visits: number } | null>(null);
  const [capCfg, setCapCfg] = React.useState<VisitCapThresholds | null>(null);
  const decision = visitForm.decision ?? null;
  const setDecision = (v: string | null) => setForm2({ decision: v });
  const decisionWhy = visitForm.decisionWhy ?? '';
  const setDecisionWhy = (v: string) => setForm2({ decisionWhy: v });
  const [decisionErr, setDecisionErr] = React.useState<string | null>(null);
  /* §G — the requirement visit. Shown on a lead only: asking a customer of four
     years what they are looking for is a question they have answered by
     ordering, and a field nobody fills teaches people to scroll past the form. */
  const reqWhat = visitForm.reqWhat ?? '';
  const setReqWhat = (v: string) => setForm2({ reqWhat: v });
  const reqLitres = visitForm.reqLitres ?? '';
  const setReqLitres = (v: string) => setForm2({ reqLitres: v });
  const reqCans = visitForm.reqCans ?? '';
  const setReqCans = (v: string) => setForm2({ reqCans: v });

  React.useEffect(() => {
    if (!c?.id) return;
    let live = true;
    void Promise.all([suspectFor(c.id), visitCapThresholds()]).then(([sus, cfg]) => {
      if (!live) return;
      setSuspect(sus);
      setCapCfg(cfg);
    });
    return () => {
      live = false;
    };
  }, [c?.id]);

  /* `ok` | `warn` | `decide`, and nothing here ever blocks the visit being
     MADE — see the note above `visitCapState`. What `decide` blocks is closing
     it without an answer, which is a different thing and the thing §B wants. */
  const capState =
    suspect && capCfg ? visitCapState(suspect.stage, suspect.visits, capCfg) : 'ok';
  /*
   * "Visit 3 / 3" — the visit being MADE, not the ones already made.
   *
   * `suspect.visits` is the count the office holds and `visitCapState` adds
   * this one before it compares, so on the third visit to a Suspect the card
   * demanded the decision under a heading reading "Visit 2 / 3" — a counter
   * saying he still had one in hand. The number and the demand contradicted
   * each other on one card, which reads as a bug and gets the answer picked at
   * random to get past it. Asked of the engine rather than retyped here, so
   * the wording and the rule cannot drift apart.
   */
  const capLabel =
    suspect && capCfg ? visitCapLabel(suspect.stage, suspect.visits + 1, capCfg) : null;
  const linked = useStore((s) => s.visitLinked);
  const setLinked = (f: (l: VisitLinked) => VisitLinked) =>
    set({ visitLinked: f(useStore.getState().visitLinked) });
  const [products, setProducts] = React.useState<Product[]>([]);
  /* §10's coded list — why a shop wants a trial. Read from the cached
     configuration like every other `mbos.*` answer, so the sheet has it with
     no signal; empty until it arrives, which the sheet says in words rather
     than drawing no question at all. */
  const [reasons, setReasons] = React.useState<CodedOption[]>([]);
  const [stopId, setStopId] = React.useState<string | null>(null);
  /*
   * ONE VISIT PER PRESS.
   *
   * More than one path reaches `saveAndGo`, and the guard was a `useState`
   * flag, which is read from the closure of the render that drew the control —
   * so a second tap arriving before the re-render saved the visit AGAIN: two
   * rows, two queue items, two timeline events, and the office seeing one shop
   * visited twice in a minute. (It was found on the fare sheet that used to
   * sit on the way out.)
   * The ref is set synchronously, so whichever call arrives first shuts the
   * others out; the state beside it is only what the screen is drawn from.
   */
  const savingRef = React.useRef(false);
  const [saving, setSaving] = React.useState(false);
  const [lastTime, setLastTime] = React.useState<PreviousNote | null>(null);

  /* Thresholds, never constants: the dwell floor and the distance that counts
     as a mismatch are both a manager's to move. */
  const [minDwell, setMinDwell] = React.useState(120);
  /* `mbos.visits.minimumNoteChars` — how much counts as saying what happened. */
  const [minNote, setMinNote] = React.useState(20);
  /* The check-out sheet: opened by "Check out" when something is still owed,
     so the questions are asked where he pressed rather than in a toast. */
  const [asking, setAsking] = React.useState(false);
  const [maxLegKm, setMaxLegKm] = React.useState(400);
  const [maxMetres, setMaxMetres] = React.useState(100);

  /**
   * The dwell clock has to tick, because one of the save conditions is time.
   * It is held in state and advanced by the interval rather than read during
   * render — a render that reads the clock gives a different answer every time
   * React happens to re-run it, and here that answer decides whether the save
   * button is live.
   */
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  /**
   * LEAVING A VISIT IN PROGRESS IS ASKED ABOUT, because there is no way back
   * into one.
   *
   * The screen draws the full tab bar and a back chevron, and a tab tap is a
   * `replace` — so one mis-tap while standing in the shop took the note, both
   * photographs, the outcome and the dwell clock with it. Nothing anywhere
   * warned, and every route back in goes through `beginVisit`, which blanks all
   * of that and opens a SECOND journey with a second odometer photograph. The
   * journey screen's "Continue" only shows while the leg is still open, so once
   * he has arrived there is no path back at all.
   *
   * It hangs off the navigator's own `beforeRemove` rather than off the back
   * button, because the back button is the one departure that already looks
   * deliberate — the tab bar is the one that does not, and it is the same event.
   *
   * Only once he has ARRIVED. On the way there the clock has not started and
   * nothing has been typed, and the trip is called off with its own button.
   */
  /*
   * …AND NOW THERE IS A WAY BACK, so leaving costs nothing.
   *
   * A check-in runs until he checks out, wherever he goes in the app. The
   * draft — note, photographs, outcome — lives in the store rather than in
   * this screen, the clock is measured from the check-in instant on disk, and
   * the "In <shop>" bar every other screen draws brings him straight back
   * here without `beginVisit`. So a tab tap is just a tab tap. He is told as he
   * goes that the visit is still open, because the old warning taught him
   * that leaving lost everything.
   */
  const navigation = useNavigation();
  const savedRef = React.useRef(false);
  React.useEffect(() => {
    if (visitStart == null) return;
    return navigation.addListener('beforeRemove', () => {
      if (savedRef.current) return;
      notify('Your visit is still on. Tap the bar at the bottom to come back and check out.', 'info');
    });
  }, [navigation, visitStart, notify]);

  /* ---- the journey that got him here ----
     Read from SQLite, not the store: the app is routinely killed on the road
     and a leg held in memory would be gone by the time he walked in. `null`
     after `legLoaded` means the visit was started before travel legs existed
     or by a path that does not ask — and that visit still saves as it always
     did. */
  const [leg, setLeg] = React.useState<TravelLeg | null>(null);
  const [legLoaded, setLegLoaded] = React.useState(false);
  const [modes, setModes] = React.useState<TravelMode[]>([]);
  const [arriving, setArriving] = React.useState(false);
  const [metering, setMetering] = React.useState(false);
  /*
   * The refusal, held so the card can say the distance rather than raise a
   * toast that is gone before he has read it. Cleared on the next attempt: it
   * describes ONE reading, and he has walked since.
   */
  const [refused, setRefused] = React.useState<CheckInVerdict | null>(null);
  /* The refusal is said in the card above the button rather than in a toast,
     so nothing else buzzes for it — the shake is its whole `warning`, and it
     plays on every refused press, because each one is a fresh reading saying
     no again. */
  const refuseShake = useShake();
  /*
   * The distance he was refused at, kept past the refusal for the pin question
   * that follows an override.
   *
   * That sheet reads `verdictGeo`, which is computed from a SECOND, fresh
   * reading taken when he says he is at the shop — and that one can come back
   * with nothing, leaving the sheet asking him to move a pin "about ? m",
   * which is the one number that makes the question answerable. This reading
   * was measured, seconds earlier, from the same spot.
   *
   * Display only. It is deliberately NOT fed into `metresFromShop`, which has
   * to describe the fix actually stored on the row.
   */
  const [refusedMetres, setRefusedMetres] = React.useState<number | null>(null);
  /*
   * What he said to get past it, and what he was asked next.
   *
   * `overrideReason` rides all the way to the save — it is what makes the
   * visit unverified and what his manager reads — and losing it between the
   * door and the save is how a flagged visit quietly becomes a clean one.
   */
  /* Read off the ARRIVAL, which is on disk — see `Arrival.overrideReason`.
     Held here they went with the screen, and the visit then saved as though
     nobody had been refused at the door at all. */
  const ours = arrival && c && arrival.customerId === c.id ? arrival : null;
  const overrideReason = ours?.overrideReason ?? null;
  const pinRequested = !!ours?.pinCorrectionRequested;
  /* Asked once, after the override, and only where there is a pin to be
     wrong about. An arrival restored after a reap asks again only if it was
     never answered. */
  const pinAsk =
    !!ours && !!ours.overrideReason && !ours.pinAsked && ours.checkedInAt != null &&
    c?.gpsLat != null && c?.gpsLng != null;
  const answerPin = async (yes: boolean) => {
    try {
      const next = await patchArrival({ pinAsked: true, pinCorrectionRequested: yes });
      if (next) setArrival(next);
    } catch {
      notify('That answer could not be saved on this phone. Try again.', 'error');
      return;
    }
    if (yes) notify('Your manager will be asked to move it. It goes with this visit.');
  };
  const answerOdometer = React.useRef<((r: OdometerResult) => void) | null>(null);

  const [checkingIn, setCheckingIn] = React.useState(false);
  /*
   * WHAT A PHOTOGRAPH TAKEN NOW IS A PHOTOGRAPH OF.
   *
   * The literal `pending` was what every visit photograph and voice note went
   * up under, and the media queue sends within a minute — so the file reached
   * the office parented to a visit called `pending`, the office never re-bound
   * it, and nobody, the salesman included, could ever open it. The arrival
   * mints the visit's id at the door; the file names it from the start.
   */
  const mediaParent = ours?.visitId ?? 'pending';

  const custId = c?.id ?? null;
  const userId = boot.session?.user.id ?? '';

  /*
   * The leg he is on, or the one he closed to get here.
   *
   * Both in one read, because they are the same journey at two moments and the
   * screen has to tell them apart: an OPEN leg means he is still travelling
   * and the visit has not begun; a CLOSED one is the journey the visit will be
   * stamped onto when it saves.
   *
   * By person AND by shop. Reading by person alone would hand him a journey to
   * a different shop the moment he opened somebody else's record on the road.
   */
  const loadLeg = React.useCallback(() => {
    let live = true;
    if (!custId || !userId) return;
    void Promise.all([openLegOf(userId), arrivedLegFor(userId, custId), travelModes()])
      .then(([running, arrived, rows]) => {
        if (!live) return;
        setModes(rows);
        setLeg(running && running.customerId === custId ? running : arrived);
        setLegLoaded(true);
      })
      .catch(() => {
        /* A read that FAILED is not a journey still loading, and the screen
           below holds everything until this flag is set. `leg` is left exactly
           as it stands — null on the first pass, which is the "no leg behind
           this visit" case the note above describes, so the form opens as it
           always did rather than the screen reading "Reading…" for ever. */
        if (live) setLegLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [custId, userId]);
  React.useEffect(loadLeg, [loadLeg]);

  /*
   * THE CLOCK, PUT BACK AFTER A REAP.
   *
   * `visitStart` lives in memory and Android takes this app apart on the road
   * for a phone call or a map. Before the arrival was written down there was
   * nothing to restore it from, so a reaped visit was stamped at the save and
   * left open — a real hole, and one that got wider the moment checking in
   * became its own act. The disk holds the instant he walked in; this is what
   * puts it back on the screen.
   */
  React.useEffect(() => {
    if (!custId || visitStart != null) return;
    if (arrival && arrival.customerId === custId && arrival.checkedInAt != null) {
      /* …and what he had typed, photographed and raised inside it. The clock
         coming back alone left a running visit with an empty form and records
         linked to nothing. Restored FIRST, so the clock that follows is the
         one thing that says the restore is done. */
      restoreVisitDraft(arrival);
      checkedIntoShop(arrival.checkedInAt);
    }
  }, [custId, visitStart, arrival, checkedIntoShop]);

  /*
   * NO JOURNEY BEHIND THIS VISIT, AND THE DOOR STILL HAS A GATE.
   *
   * A visit opened with no trip — the punch-in session already closed, a trip
   * that could not be written, a shop opened straight from the customers
   * list — used to check itself in the moment the form opened: no reading, no
   * radius, and no question for a shop with no pin. Every other visit is
   * measured at the door, and this was the way round it that nobody had to be
   * refused by first. So it gets the same door: a check-in card that runs the
   * same `checkInVerdict`, refuses past the radius with the same way past it,
   * and records the same arrival — already walked in, because with no trip
   * there is nothing between arriving and going in.
   */
  const needsDoor =
    !!c && !!custId && legLoaded && visitStart == null && !(leg && leg.endedAt == null) &&
    !(arrival && arrival.customerId === custId);

  const legMode = leg ? modes.find((m) => m.key === leg.modeKey) ?? null : null;
  /* Not on an own-vehicle DAY: that journey set off with no reading because
     the punch-in and punch-out measure the day. See `arrivalNeedsMeter`. */
  const needsMeter = arrivalNeedsMeter({
    requiresOdometer: !!legMode?.requiresOdometer,
    odometerStartKm: leg?.odometerStartKm ?? null,
  });

  /* ---- how far there is left to go ----
   *
   * ONLY WHILE HE IS ON THE ROAD. This is the one screen in the app that is
   * open precisely because somebody is travelling, and it closes the moment he
   * says he is here — so a fix taken on a short cadence costs the radio a few
   * minutes of a ride rather than a day, and buys the only number this screen
   * was missing: whether the shop is round the corner or in the wrong town.
   *
   * The reading is BALANCED at range and PRECISE on the approach. Under a
   * kilometre the figure stops being "is it worth going" and becomes "which
   * doorway", and a fix good to a city block cannot answer the second — while
   * paying for that accuracy over a ten-kilometre ride would buy nothing the
   * rounding does not throw away. The check-in at the end is precise for the
   * same reason, one step further along.
   */
  const onTheRoad = legLoaded && !!leg && leg.endedAt == null;
  /* The pin as two numbers rather than as the customer, so the timer below
     restarts when the SHOP moves and not every time the record is re-read. */
  const pinLat = c?.gpsLat ?? null;
  const pinLng = c?.gpsLng ?? null;
  const [roadFix, setRoadFix] = React.useState<Fix | null>(null);
  /* The same reading, reachable from inside the interval without becoming a
     dependency of it: naming the state there would tear the timer down and
     rebuild it on every fix, which is a cadence nobody chose. */
  const roadFixRef = React.useRef<Fix | null>(null);
  const [staleAfterS, setStaleAfterS] = React.useState(900);
  React.useEffect(() => {
    void getConfig<number>('mbos.location.activityFixMaxAgeSeconds', 900).then(setStaleAfterS);
  }, []);
  React.useEffect(() => {
    if (!onTheRoad) return;
    let live = true;
    const shop = pinLat != null && pinLng != null ? { lat: pinLat, lng: pinLng } : null;

    async function read() {
      const near =
        shop && roadFixRef.current
          ? haversineMetres(roadFixRef.current, shop) < APPROACHING_M
          : false;
      const got = fixOf(
        await getFix({ accuracyThresholdM: 100, timeoutMs: 12_000, precise: near }),
      );
      /* A failed reading leaves the previous one standing rather than blanking
         the line — the last known distance with its age on it is worth more
         than nothing at all, which is what `navigationLine` is built to say. */
      if (live && got) {
        roadFixRef.current = got;
        setRoadFix(got);
      }
    }

    void read();
    const t = setInterval(() => void read(), ROAD_FIX_EVERY_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [onTheRoad, pinLat, pinLng]);

  React.useEffect(() => {
    let live = true;
    void Promise.all([
      getConfig<number>('mbos.visits.minimumDwellSeconds', 120),
      getConfig<number>('mbos.location.visitMismatchM', 100),
      /* This shop's usual products first, then the best sellers — the order
         form's own list, not the first five SKUs alphabetically. */
      custId
        ? rememberedSuggestions(custId).then((s) => [...s.usual, ...s.starter].slice(0, 5))
        : Promise.resolve([]),
      todayStops(),
      getConfig<number>('mbos.travel.maxLegKilometres', 400),
      sampleReasons(),
      getConfig<number>('mbos.visits.minimumNoteChars', 20),
    ]).then(([dwell, metres, skus, stops, maxKm, why, noteMin]) => {
      if (!live) return;
      setMinDwell(dwell);
      setMinNote(noteMin);
      setMaxMetres(metres);
      setMaxLegKm(maxKm);
      setProducts(skus);
      setReasons(why);
      /* A stop on today's plan makes this a planned visit and gets marked
         visited when the save lands. */
      setStopId(stops.find((s) => s.customerId === custId && s.status === 'planned')?.id ?? null);
    });
    return () => {
      live = false;
    };
  }, [custId]);

  /* What he said last time, read back before this call rather than found
     afterwards on the timeline. See `data/visits.ts`. */
  React.useEffect(() => {
    let live = true;
    if (!custId) return;
    void previousVisitNote(custId).then((row) => {
      if (live) setLastTime(row);
    });
    return () => {
      live = false;
    };
  }, [custId]);

  /* The suggested return day comes from the customer's own measured cycle, so
     a shop that reorders every three weeks is not offered the same date as one
     that reorders every three months. He can change it; they often say. */
  React.useEffect(() => {
    if (nextDate || !c) return;
    const gap = c.cycleDays ?? c.visitFrequencyDays ?? 7;
    set({ nextDate: isoDate(new Date(Date.now() + gap * 86_400_000)) });
  }, [nextDate, c, set]);

  /* One attempt at a fix on arrival, ten seconds at most. The salesman is
     standing in a shop with the owner waiting; a spinner is not an option.

     NOT WHERE THE CHECK-IN ALREADY HAS ONE. The gate measured him at the door
     and the arrival kept that reading; taking a fresh one here, after Android
     reaped the app or after he tapped the "forgot to check out" reminder half
     a kilometre down the road, would measure where he is NOW against the shop
     and refuse to let a perfectly good visit check out. The 100 m rule is for
     walking in, never for walking out. */
  const keptFix =
    arrival && arrival.customerId === custId && arrival.checkedInAt != null ? arrival.checkInFix ?? null : null;
  React.useEffect(() => {
    let live = true;
    if (gps !== 'acquiring') return;
    if (keptFix && arrival) {
      setFix({ lat: keptFix.lat, lng: keptFix.lng, accuracyM: keptFix.accuracyM ?? 9999, at: arrival.arrivedAt });
      setFixReason(null);
      set({ gps: 'locked' });
      return;
    }
    void (async () => {
      const threshold = await getConfig<number>('mbos.location.gpsAccuracyThresholdM', 100);
      const result = await getFix({ accuracyThresholdM: threshold });
      if (!live) return;
      const got = fixOf(result);
      setFix(got);
      setFixReason(result.status === 'ok' ? null : result.reason);
      set({ gps: got ? 'locked' : 'off' });
    })();
    return () => {
      live = false;
    };
  }, [gps, set, keptFix, arrival]);

  /* ────────────────────────────────────────────────────────── arriving */

  const askOdometer = () =>
    new Promise<OdometerResult>((resolve) => {
      answerOdometer.current = resolve;
      setMetering(true);
    });

  /**
   * He is here. This is where the visit actually begins — or does not.
   *
   * THE FIX COMES BEFORE THE CAMERA, which reverses the order this function
   * shipped with. The two used to overlap deliberately: the radio settled
   * while the meter was photographed, which cost nothing because nothing could
   * turn the arrival down. Now something can. Photographing the meter first
   * would mean taking a picture, queueing it, and then being told he is three
   * hundred metres away — leaving a photograph of a reading he has to take
   * again, attached to a leg that is still open. So the one thing that can
   * refuse is asked first, and the camera only opens once the arrival is
   * certain to happen.
   *
   * `precise` on the fix for the same reason: this reading now decides
   * something. See `getFix`.
   *
   * `override` is his own sentence, given after a refusal. Passed in rather
   * than read from state because the confirm dialog hands it back and state
   * set a line earlier is not yet readable here. It opens a `too_far` refusal
   * and nothing else: it exists because a stored pin is often wrong, and a
   * missing reading is not a wrong pin.
   *
   * `confirmedHere` is his answer to "are you at this shop?", asked where the
   * shop has no pin and this fix is about to become one.
   */
  const arriveHere = async (override?: string, confirmedHere = false) => {
    if (arriving) return;
    /* On the road, this ends a trip and he is still to walk in. With no open
       trip it is the door itself: the same gate, and he is in. */
    const travelling = !!leg && leg.endedAt == null;
    setArriving(true);
    try {
      const [threshold, radiusM] = await Promise.all([
        /* 100, like every other read of this key. It was 50 here alone, so
           an unpublished key made the door twice as strict as the save. */
        getConfig<number>('mbos.location.gpsAccuracyThresholdM', 100),
        getConfig<number>('mbos.location.visitMismatchM', 100),
      ]);
      const result = await getFix({ accuracyThresholdM: threshold, precise: true });
      const got = fixOf(result);

      const gate = checkInVerdict(
        got ? { lat: got.lat, lng: got.lng, accuracyM: got.accuracyM } : null,
        c && c.gpsLat != null && c.gpsLng != null ? { lat: c.gpsLat, lng: c.gpsLng } : null,
        radiusM,
        threshold,
      );
      if (!gate.accepted && !(override && gate.reason === 'too_far')) {
        /* NOTHING IS WRITTEN. The leg stays open because he is still
           travelling, the dwell clock does not start, and no meter has been
           photographed — so pressing the button again from the right place
           costs him nothing and leaves nothing behind. */
        setRefused(gate);
        refuseShake.shake();
        /* Kept for the pin question that an override leads to — see
           `refusedMetres`. `too_far` is the only refusal there is, and it
           always carries the distance. */
        if (gate.metresAway != null) setRefusedMetres(Math.round(gate.metresAway));
        return;
      }
      setRefused(null);

      /* NO PIN ON THE SHOP: this reading is about to become where the shop is
         for every check-in after it, so he says he is standing in it first.
         Asked before the meter, so "no" costs nothing. The dialog calls back
         in, which takes a fresh reading — the one he confirmed against. */
      if (gate.needsConfirmation && !confirmedHere) {
        const shopName = leg?.toLabel ?? c?.name ?? 'this shop';
        askConfirm({
          title: `At ${shopName}?`,
          body: 'No saved location yet. Where you stand now becomes its pin, and every later check-in is measured against it. Only say yes at the shop.',
          confirmLabel: 'Yes, I am at the shop',
          tone: 'navy',
          lead: { icon: 'pin', tint: C.warnInk, bg: C.warnBg },
          run: () => {
            void arriveHere(undefined, true);
          },
        });
        return;
      }

      let odometer: { km: number; photoId: string } | null = null;
      if (travelling && leg && needsMeter) {
        const shot = await askOdometer();
        /* Cancelled. Nothing written, nothing to undo, and no toast: he has
           just pressed a button whose words say what it abandons. */
        if (!shot) return;
        try {
          odometer = { km: shot.km, photoId: await queueOdometerPhoto(shot.uri, leg.id) };
        } catch {
          notify('The photo could not be saved on this phone. The trip is still open. Try again.', 'error');
          return;
        }
      }

      /*
       * ONE FIX, TWO RECORDS. It closes the leg and it checks the visit in,
       * and they must be the same reading — two acquisitions seconds apart
       * would let the arrival and the check-in disagree about where the shop
       * is, and a manager reading a mismatch would have no way to tell which
       * of the two was being questioned. It is also the reading the gate above
       * was answered on, which is the third thing that must not drift: a
       * salesman let through on one fix and recorded on another would read as
       * having been allowed past a distance nobody measured.
       */
      setFix(got);
      setFixReason(result.status === 'ok' ? null : result.reason);
      set({ gps: got ? 'locked' : 'off' });

      const at = Date.now();
      if (travelling && leg) {
        await arriveForVisit({
          legId: leg.id,
          fix: got ? { lat: got.lat, lng: got.lng } : null,
          odometer,
        });
      }

      /*
       * ARRIVED, AND NOT YET IN. The clock does NOT start here any more.
       *
       * The journey is over — the leg is closed and the meter photographed —
       * and he is standing outside a shop. Checking in is the next tap, and it
       * is what `checkedIntoShop` answers. Written to disk before the screen
       * changes, because everything that proves he got here has already
       * happened and Android may reap this app between the two.
       */
      /* Off the LEG, not off the screen's customer. The leg is what says which
         shop this journey was to, it cannot be null here, and the record on it
         outlives a customer row the store happens not to have loaded. */
      /* The override rides on the arrival, on disk — see `Arrival`. The pin
         question that follows it is asked AFTER he is in, never before: it is
         a second question about a different thing — the book, not him — and
         putting it in front of the arrival would make getting into the shop
         depend on answering it. `pinAsk` above draws it from this record. */
      const recorded = await recordArrival({
        customerId: leg?.customerId ?? c?.id ?? '',
        customerName: leg?.toLabel ?? c?.name ?? 'this shop',
        /* The trip that got him here, open or already closed — the save binds
           it either way. */
        legId: leg?.id ?? null,
        arrivedAt: at,
        checkInFix: got ? { lat: got.lat, lng: got.lng, accuracyM: got.accuracyM } : null,
        /* Only where it was what let him in: a press from the right spot is
           accepted on its own reading and needs no excuse. */
        overrideReason: gate.accepted ? null : override ?? null,
        checkedInAt: travelling ? null : at,
      });
      setArrival(recorded);
      if (!travelling) checkedIntoShop(at);
      /* The trip is over and on disk. No toast says so — the card changing
         to "Arrived" does — so the buzz is the only thing that says it
         landed for somebody already looking at the shop door. */
      feedback('success');
      loadLeg();
    } catch {
      notify('Your arrival could not be saved on this phone. Nothing is lost. Try again.', 'error');
    } finally {
      setArriving(false);
    }
  };

  /**
   * WALKING IN. The second tap, and the one the dwell clock is measured from.
   *
   * It asks for nothing: no fix, no camera, no wait. The reading that proves
   * he is at this shop was taken at the arrival and answered the radius gate
   * there, and taking a second one here would let the two disagree about where
   * the shop is — the "ONE FIX, TWO RECORDS" rule the arrival already keeps.
   * It also means checking in works with the radio off, inside a godown, on a
   * dead battery, which is where half of this book is.
   *
   * The instant is read ONCE and written to both places, for the same reason.
   */
  const checkIn = async () => {
    if (checkingIn) return;
    setCheckingIn(true);
    try {
      const at = Date.now();
      const next = await checkInAtShop(at);
      if (!next) {
        /* The arrival is gone from under him. Midnight alone no longer does
           this — an arrival inside the punch-in he is still on survives the
           date (`arrivalIsCurrent`) — so what is left is one from a stretch
           that has ended, or one he called off on another screen. Sending
           him back to the journey is the honest answer; pretending to check
           him into a shop with no arrival behind it is not. */
        setArrival(null);
        notify('That arrival is no longer on this phone. Start the visit again.', 'error');
        router.replace('/journey');
        return;
      }
      setArrival(next);
      checkedIntoShop(next.checkedInAt ?? at);
      /* In, and the clock is running. Felt rather than toasted: the form
         opening under his thumb is the confirmation on screen. */
      feedback('success');
    } catch {
      notify('The check-in could not be saved on this phone. Nothing is lost. Try again.', 'error');
    } finally {
      setCheckingIn(false);
    }
  };

  /**
   * The way past a refusal, and the only one.
   *
   * A required sentence, because this is the whole of what a manager gets: the
   * distance is already on the record and says nothing about which of the two
   * readings is wrong. `askConfirm` refuses to close without it.
   */
  const overrideRefusal = () =>
    askConfirm({
      title: 'Are you at the shop?',
      body:
        'Saved from here as not checked. Your reason goes to your manager. Some saved pins are wrong, and this is how they get fixed.',
      reasonLabel: 'Where you are now · needed',
      placeholder: 'Inside the shop. The map pin is on the main road.',
      confirmLabel: 'I am at the shop',
      tone: 'navy',
      lead: { icon: 'pin' },
      run: (reason) => {
        void arriveHere(reason);
      },
    });

  /**
   * The recording, queued for the office.
   *
   * Called by the note's microphone in BOTH of its modes — dictated on signal,
   * kept for later without — because a visit is the one place the audio is
   * worth having either way: it is what the customer actually said, and the
   * words in the box are somebody's reading of it.
   *
   * Parented to the visit's id, minted at the door — exactly as a shop
   * photograph is. The visit does not exist yet, but its id does, so the file
   * reaches the office already naming it. `pending` is only for an arrival
   * written before ids were minted there, and `saveVisit` claims those.
   */
  const keepVoiceNote = async (uri: string, mode: 'dictate' | 'record') => {
    try {
      /* Said again means the last one was not wanted. Dropped before the new
         one is queued, so a visit carries the recording it kept and not every
         attempt at it. */
      if (voiceNoteId) await discardQueuedMedia(voiceNoteId);
      const mediaId = await queueRecording(uri, 'visit', mediaParent);
      setVoiceNoteId(mediaId);
      set({ voice: mode === 'dictate' ? 'dictated' : 'queued' });
    } catch {
      /* A save is never blocked by a recording. The note he read and approved
         is already in the box; losing the audio behind it costs the office a
         second copy of something it can already read. */
      notify('The recording could not be kept. Your note is safe.', 'warn');
    }
  };

  const shoot = async (which: 'shop' | 'cust') => {
    const shot = await takePhoto({
      parentType: 'visit',
      parentId: mediaParent,
      kind: which === 'shop' ? 'shop_photo' : 'customer_photo',
    });
    if (!shot.ok) {
      if (shot.reason !== 'cancelled') notify(shot.reason, 'error');
      return;
    }
    set({ shots: { ...shots, [which]: shot.mediaId } });
  };

  /* ---- the two records punched from inside the visit ----
   *
   * Named rather than written inline on the button, because both need the
   * in-flight lock above and a failure has to be SAID: a bottom sheet is a
   * Modal and the app's toast lives underneath it, so a `notify` raised while
   * the sheet is open is a sentence nobody sees. The message goes in the
   * sheet, beside the button that was pressed.
   */
  const submitComplaint = async () => {
    if (formBusy.current) return;
    if (!draft.cat) return setFormErr('cat');
    if (!(draft.what ?? '').trim()) return setFormErr('what');
    if (!c) return;
    formBusy.current = true;
    setFormSaving(true);
    try {
      const id = await logComplaint({
        customerId: c.id,
        category: draft.cat,
        // Normal unless he said otherwise, which is the server's default too.
        priority: draft.priority ?? 'medium',
        description: draft.what.trim(),
      });
      setLinked((l) => ({ ...l, complaintId: id }));
      markVisitDone('complaint', draft.cat + ' · with the office');
      setForm(null);
      setDraft({});
      notify('Complaint saved. The office will see it today.');
    } catch {
      setFormErr('save');
    } finally {
      formBusy.current = false;
      setFormSaving(false);
    }
  };

  /*
   * §10's three answers, asked here exactly as the samples screen asks them.
   *
   * This asked ONE of the three: a sentence, sent as the note. The quantity was
   * hardcoded to a single can — which is a figure nobody typed, on a request the
   * godown picks stock against — and neither the coded reason nor the
   * application was asked at all, so every trial raised on a visit reached the
   * desk with `reason_code` and `application` null. The code is what somebody
   * counts a quarter's trials by and the application is what makes a trial
   * judgeable, so a door that answered neither was a door whose samples could
   * not be read back.
   *
   * The CANS default of one is kept, because one can is what a trial usually
   * is and a box he has to fill in from scratch mid-conversation is a box that
   * gets a wrong number. What changed is that it is a number he can see and
   * correct.
   */
  const submitSample = async () => {
    if (formBusy.current) return;
    if (!draft.sku) return setFormErr('sku');
    const sampleCans = parseWhole(draft.cans ?? '1') ?? 0;
    if (!(sampleCans > 0)) return setFormErr('cans');
    if (!(draft.application ?? '').trim()) return setFormErr('application');
    if (!draft.reasonCode) return setFormErr('reason');
    if (!c) return;
    formBusy.current = true;
    setFormSaving(true);
    const trial = draft.trial ?? trialDefault;
    try {
      const id = await requestSample({
        customerId: c.id,
        productId: draft.sku,
        productName: draft.skuName ?? '',
        cans: sampleCans,
        reasonCode: draft.reasonCode,
        application: draft.application.trim(),
        followUpDate: trial,
      });
      setLinked((l) => ({ ...l, sampleId: id }));
      markVisitDone('sample', (draft.skuName ?? '') + ' · sent for approval');
      setForm(null);
      notify('Sample asked for. Follow-up set for ' + pretty(trial));
      setDraft({});
    } catch {
      setFormErr('save');
    } finally {
      formBusy.current = false;
      setFormSaving(false);
    }
  };

  /*
   * WHEN THE VISIT ENDED. Ordinarily the moment he presses Check out; where the
   * trail noticed him walk away first, the moment it did. A visit he forgot to
   * close is closed at the time he left rather than at the time he remembered,
   * or the ride home would be counted as time with the customer.
   */
  const leftAt =
    arrival && arrival.customerId === custId && arrival.checkedInAt != null ? arrival.leftShopAt ?? null : null;
  const endAt = leftAt != null ? Math.min(leftAt, now) : now;
  const dwellSeconds = visitStart ? Math.max(0, Math.floor((endAt - visitStart) / 1000)) : 0;
  const gpsLocked = gps === 'locked';

  /* The disagreement between the phone and the book, as a disagreement — one
     of the two is wrong and nothing here claims to know which. */
  const verdictGeo = visitLocationVerdict(
    fix ? { lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM } : null,
    c && c.gpsLat != null && c.gpsLng != null ? { lat: c.gpsLat, lng: c.gpsLng } : null,
    maxMetres,
  );
  const metresAway = verdictGeo.metresAway == null ? null : Math.round(verdictGeo.metresAway);

  const checks = visitChecks({
    gpsLocked,
    metresAway,
    dwellSeconds,
    minimumDwellSeconds: minDwell,
    maxMetresFromShop: maxMetres,
    checkInOverridden: !!overrideReason,
    outcome,
    followOnCaptured: !!(outcome && visitDone[outcome]),
    noteChars: note.trim().length,
    minimumNoteChars: minNote,
  });
  /* The answers only he can give — never waived, see `ANSWER_KEYS`. */
  const owed = unansweredQuestions(checks);
  const verdict = visitVerdict(checks, { checkInOverridden: !!overrideReason });
  const followOn = outcome ? FOLLOW_ON[outcome] : undefined;
  const doneLine = outcome ? visitDone[outcome] : undefined;

  /**
   * §B's one refusal, asked BEFORE anything else happens rather than after.
   *
   * It is the only thing that stops a save on this screen, and it stops it to
   * ask rather than to refuse — but the asking was invisible: `saveAndGo` set
   * an error that renders inside the Suspect card, six hundred points above the
   * button he had just pressed, with no toast and no change to the button. He
   * pressed Save, nothing appeared to happen, and the ordinary conclusion is
   * that the handset is broken.
   *
   * So it is a function both entry points ask, and the sentence goes to the
   * bottom of the screen as well as into the card.
   */
  function missingDecision(): string | null {
    if (capState === 'decide' && !decision) {
      return 'Choose which way this lead goes before you close the visit.';
    }
    if (decision === 'still_suspect' && !decisionWhy.trim()) {
      return 'Say why you still visit this shop. Your manager will ask.';
    }
    return null;
  }

  function refuseForDecision(why: string) {
    setDecisionErr(why);
    /* The card is above the fold; the button is not. Said in both places. */
    notify(why, 'error');
  }

  /**
   * Save, once the lead's decision is answered.
   *
   * This used to ask for the bus or train fare on the way out. It does not any
   * more: Mahek asks about travel at the punch-in and the punch-out and
   * nowhere else, and every fare is claimed in Expenses — see `visitLegPlan`.
   */
  function saveWhenDecided(unverifiedReason: string | null = null) {
    const missing = missingDecision();
    if (missing) return refuseForDecision(missing);
    void saveAndGo(elapsedLabel(dwellSeconds), unverifiedReason);
  }

  async function saveAndGo(spent: string, unverifiedReason: string | null) {
    if (!c || savingRef.current) return;
    /* The answers are owed on EVERY path out, the unverified save included —
       see `ANSWER_KEYS`. Asked, not refused: the sheet has the controls. */
    if (owed.length) {
      setAsking(true);
      return;
    }

    /*
     * The one thing that stops a save here, and it stops it to ASK rather than
     * to refuse: past the cap the salesman says which way the lead goes before
     * the visit closes. The visit is still recorded — this is a field on the
     * same form, not a rejection — and the server checks the same rule against
     * the same two configured numbers.
     */
    const missing = missingDecision();
    if (missing) return refuseForDecision(missing);

    savingRef.current = true;
    setSaving(true);
    /*
     * NO CHECK-OUT POSITION, because none was measured.
     *
     * This copied the check-in fix and stamped it with the check-out time, so
     * the office read a check-out position nobody had taken — always exactly
     * at the door he walked in by, which is the one reading that can never
     * show he left early. The time is real and comes off the clock; the place
     * is left empty rather than invented.
     */
    const checkOut: Fix | null = null;
    /*
     * THE NEXT CONTACT, where there is one.
     *
     * The day was filled from the cycle and could not be emptied, so every
     * visit raised a follow-up task — a shop found shut included, which then
     * sat on his list as a visit he had promised nobody. "No follow-up" is an
     * answer now, and a shut shop or an absent owner sets none unless he picked
     * the day himself.
     */
    const quietOutcome = outcome === 'closed' || outcome === 'closed_now';
    const followUpDate = noFollowUp || (quietOutcome && !nextDatePicked) ? null : nextDate || null;
    const savedAs = unverifiedReason != null || !!overrideReason;
    let visitId: string;
    try {
      visitId = await saveVisit({
        id: ours?.visitId ?? null,
        customerId: c.id,
        customerName: c.name,
        userId: boot.session?.user.id ?? '',
        checkIn: fix,
        checkOut,
        /*
         * THE CLOCK, NOT THE FIX.
         *
         * Both instants used to be read off `Fix.at`, so a visit made inside a
         * godown — no fix, which is the case this whole app is designed around
         * — was stored with no check-in instant, no duration and left open for
         * ever: absent from the day's count, never closed by the day-boundary
         * sweep, and printing 1 Jan 1970 on the next visit's "Last time" card.
         * `visitStart` is the moment he said he had arrived, and it exists
         * whether or not the radio answered.
         *
         * Where there was no arrival at all — a visit opened by a path that
         * never asked, which is the only way `visitStart` is null here — the
         * row is stamped at the save and left OPEN rather than claiming a
         * duration of zero that nobody measured.
         */
        checkInAt: visitStart ?? now,
        checkOutAt: visitStart == null ? null : endAt,
        outcome: outcome ?? 'visited',
        notes: note.trim() || null,
        transcript: null,
        transcriptIsAi: false,
        shopPhotoId: shots.shop ?? null,
        custPhotoId: shots.cust ?? null,
        voiceNoteId,
        nextFollowUpDate: followUpDate,
        nextFollowUpMode: nextMode,
        journeyStopId: stopId,
        wasPlanned: !!stopId,
        /*
         * Why this shop, when it is not on the plan.
         *
         * Hardcoded null since this screen was written, while the route screen
         * asked for the reason and threw it away in a toast — so `visits`
         * carried the column, the manager screens read it, and no visit in the
         * history has ever had one. It is taken on the route screen and spent
         * here.
         *
         * Dropped where the shop turns OUT to be on today's plan: a stop he
         * was always going to make is not a deviation, whatever he typed
         * before he chose it.
         */
        deviationReason: stopId ? null : offPlanReason,
        locationMismatch: verdictGeo.mismatch,
        metresFromShop: metresAway,
        /*
         * AN OVERRIDDEN CHECK-IN IS NEVER A CLEAN VISIT, whatever the
         * checklist showed.
         *
         * `visitChecks` lets the gps check read OK on an override so he is not
         * asked for a second sentence at the save — but that is about not
         * asking twice, and it must not become a claim that the visit
         * verified. The server reaches the same answer from the same reason
         * and does not trust this flag; what these two lines keep true is that
         * the record on his OWN phone says what the office's says, and that
         * `saveVisit` raises the "saved unverified" notice it should.
         */
        verified: unverifiedReason == null && !overrideReason,
        unverifiedReason:
          unverifiedReason ??
          (overrideReason ? `Checked in past the ${maxMetres} m radius: ${overrideReason}` : null),
        checkInOverrideReason: overrideReason,
        pinCorrectionRequested: pinRequested,
        savedAnywayReason: unverifiedReason,
        linkedOrderIds: linked.orderIds ?? [],
        linkedPaymentIds: linked.paymentIds ?? [],
        linkedComplaintId: linked.complaintId ?? null,
        linkedSampleId: linked.sampleId ?? null,
        suspectDecision: decision,
        suspectReason: decisionWhy.trim() || null,
        requirement: reqWhat.trim() || null,
        monthlyVolumeLitres: parseDecimal(reqLitres) || null,
        quantityCans: parseWhole(reqCans) || null,
        aiDraftId,
      });
    } catch {
      savingRef.current = false;
      setSaving(false);
      notify('The visit could not be saved on this phone. Nothing is lost. Try again.', 'error');
      return;
    }

    /*
     * PAST HERE THE VISIT IS IN THE LEDGER, and nothing below may claim
     * otherwise.
     *
     * `saveVisit` commits its own transaction and returns an id; everything
     * that follows is tidying up around a record that already exists. All of it
     * used to sit inside the try above, so a failure binding the leg raised
     * "Nothing has been lost — try again" — a sentence that is false in exactly
     * that case, and an instruction that writes the visit a second time.
     */

    /* Spent, whether or not it was used — a reason typed for one shop must
       not attach itself to the next unrelated visit hours later. */
    set({
      visitSpent: spent,
      offPlanReason: null,
      visitSaved: { id: visitId, unverified: savedAs, followUpDate },
    });
    /* The journey is spent on this visit, locally, so the record reads
       correctly on this handset without waiting for a pull — and so the
       next visit to this shop does not pick the same leg up again.
       Deliberately AFTER the save: a leg bound to a visit that failed to
       write would be a journey pointing at nothing. */
    if (leg) {
      try {
        await bindLegToVisit(leg.id, visitId);
      } catch {
        /* Said rather than swallowed, and NOT as a failure of the visit: the
           journey is still on today's travel, it is simply not attached to the
           visit it was made for. */
        notify('The visit is saved. The trip could not be added to it. Check today’s travel.', 'warn');
      }
    }

    /* SPENT. The visit is in the ledger, so the shop he was standing at is no
       longer outstanding — leaving it would put the "check in" bar back on his
       screen for a visit he has just finished. It is cleared after the save
       rather than before, so a failed write leaves him exactly where he was. */
    setArrival(null);
    void clearArrival();

    /* The visit is saved, so the "still running" line on the way out no longer
       applies. */
    savedRef.current = true;
    router.replace('/saved');
  }

  /*
   * WHAT EACH OF THE ASSISTANT'S PROPOSALS DOES ON THIS SCREEN.
   *
   * Every one of them fills a form and stops. The order and the receipt open
   * their own screens with the cart and the amount already in — he still
   * presses their Submit. The complaint and the sample open this screen's own
   * sheets with the draft filled — he still presses their button. The outcome
   * and the day go into the form only where he has not answered them himself
   * (`fillVisit`). Nothing here writes a record, and the visit's Save is
   * still the only thing that saves the visit.
   *
   * Picking a follow-on also picks its outcome chip where none is chosen yet,
   * because opening the order screen from a visit filed as "Visited" would
   * leave the checklist asking for a follow-on it has already had.
   */
  /* The outcome chips are drawn by hand rather than with `Choice`, so they
     tick here the way `Choice` would — and only when the answer moves. */
  const pickOutcome = (k: NonNullable<typeof outcome>) => {
    if (outcome !== k) feedback('select');
    set({ outcome: k });
  };
  const outcomeIfNone = (k: 'order' | 'payment' | 'complaint' | 'sample') => {
    if (outcome == null) set({ outcome: k });
  };
  const assistant: VisitAssistantHandlers = {
    onFill: (analysis) => {
      const f = fillVisit({ outcome, nextDate, nextDatePicked }, analysis);
      if (Object.keys(f.patch).length) set(f.patch as Parameters<typeof set>[0]);
      notify(
        f.filled.length
          ? 'Filled ' + f.filled.join(' and ') + (f.kept.length ? ' · kept ' + f.kept.join(' and ') : '') + '. Check it, then Save'
          : f.kept.length
            ? 'Kept ' + f.kept.join(' and ') + '. Nothing else to fill'
            : 'Nothing to fill. Answer the questions on the card',
        f.filled.length ? 'success' : 'info',
      );
    },
    onChooseOutcome: (key) => set({ outcome: key as NonNullable<typeof outcome> }),
    onChooseDate: (iso) => {
      set({ nextDate: iso });
      setNextDatePicked(true);
    },
    onOrder: (a, picked) => {
      const r = cartFrom(a, cart, picked);
      set({ cart: r.cart });
      outcomeIfNone('order');
      notify(
        r.missing
          ? `${r.added} line${r.added === 1 ? '' : 's'} added · ${r.missing} still to add by hand`
          : `${r.added} line${r.added === 1 ? '' : 's'} added. Check the quantities`,
        r.missing ? 'warn' : 'success',
      );
      router.push('/order?from=visit');
    },
    onPayment: (a) => {
      set(paymentFill(a, { payAmt, payMode }));
      outcomeIfNone('payment');
      router.push('/pay?from=visit');
    },
    onComplaint: (a) => {
      setDraft(complaintDraft(a, COMPLAINT_CATEGORIES));
      setFormErr(null);
      outcomeIfNone('complaint');
      setForm('complaint');
    },
    onSample: (a) => {
      const d = sampleDraft(
        a,
        reasons.map((r) => r.code),
      );
      /* The sheet lists the starter products; a matched product that is not
         among them is added to the list, or the pick would be invisible. */
      if (d.sku && !products.some((x) => x.id === d.sku)) {
        setProducts((prev) => [{ id: d.sku, name: d.skuName ?? '', packSize: null }, ...prev]);
      }
      setDraft(d);
      setFormErr(null);
      outcomeIfNone('sample');
      setForm('sample');
    },
    onRequirement: (a) => {
      const r = requirementFill(a, { what: reqWhat, litres: reqLitres, cans: reqCans });
      if (r.what != null) setReqWhat(r.what);
      if (r.litres != null) setReqLitres(r.litres);
      if (r.cans != null) setReqCans(r.cans);
      notify(Object.keys(r).length ? 'What they need is filled. Check it below' : 'What they need is already filled in', Object.keys(r).length ? 'success' : 'info');
    },
    onDecision: (d) => {
      setDecision(d);
      setDecisionErr(null);
      notify('Chosen on the lead card above. Change it there if it is wrong', 'info');
    },
    onDraft: setAiDraftId,
  };

  /*
   * ─────────────────────────────────────────── at the door, not through it
   *
   * ARRIVING IS NOT CHECKING IN, and this screen is the gap between them.
   *
   * The journey is over: the leg is closed, the meter is photographed, and
   * nothing above can be undone by what happens here. What has NOT happened is
   * the visit — he may be parking, finishing a call, or waiting for the owner
   * to come back from lunch, and every one of those minutes used to be counted
   * as time with the customer.
   *
   * "Not yet" is a real answer and costs him nothing: the arrival is on disk,
   * the bar at the bottom of every screen offers the way back, and the ONLY
   * thing it offers is checking into THIS shop — a salesman standing outside
   * one shop is not about to set off for another, and letting him would leave
   * an arrival nobody ever closed.
   *
   * NOTHING checks him in on his own behalf. A check-in is his assertion that
   * he is in front of the customer, and a clock that made it for him would be
   * the app putting words in his mouth on the record his day is read from.
   */
  if (legLoaded && arrival && arrival.customerId === custId && arrival.checkedInAt == null) {
    const shopName = c?.name ?? arrival.customerName;
    return (
      <AppFrame
        title={shopName}
        activeTab="customers"
        onBack={() => router.back()}
        showTitle={false}
        heroTop={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text accessibilityRole="header" style={[{ fontSize: 20, lineHeight: 26, color: HERO.lavender.ink, flex: 1 }, weight(800)]}>
              Arrived
            </Text>
            <View
              accessible
              accessibilityLabel={'Arrived ' + hhmm(arrival.arrivedAt) + ', trip ended'}
              style={{ minHeight: 32, paddingVertical: 4, paddingHorizontal: 12, borderRadius: 16, backgroundColor: C.surface, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Icon name="clock" size={14} color={C.ink} strokeWidth={2.2} />
              <Text style={[{ fontSize: 13, lineHeight: 18, color: C.ink }, weight(700)]}>{hhmm(arrival.arrivedAt) + ' · trip ended'}</Text>
            </View>
          </View>
        }
        hero={
          <Text numberOfLines={2} style={[{ fontSize: 24, lineHeight: 30, letterSpacing: -0.48, color: HERO.lavender.ink, marginTop: 14 }, weight(800)]}>
            {shopName}
          </Text>
        }
        contentStyle={{ paddingHorizontal: 14, paddingTop: 16, paddingBottom: 24 }}>
        {/* The three phases of this screen are one card changing its mind —
            on the road, at the door, inside — so each sits in the same `Swap`
            slot, first child of the frame, and moving between them settles
            the new card in rather than cutting to it. */}
        <Swap id="arrived">
          <Panel>
            <Text style={[{ fontSize: 18, lineHeight: 25, color: C.ink }, weight(800)]}>Check in?</Text>
            {/* WHAT THE TWO ANSWERS COST, said before they are pressed. The whole
                reason this screen exists is the number underneath it, and a
                salesman who does not know the clock starts here will read his own
                dwell figures later and not recognise his day. */}
            <View
              style={{ marginTop: 4 }}
              accessible
              accessibilityLabel="Check in when you go inside the shop, not while you are parking. This starts your visit time.">
              <Fact icon="clock" text="Inside the shop, not while parking. Starts visit time." />
            </View>

            <Btn
              label={checkingIn ? 'One moment…' : 'Check in at the shop'}
              onPress={() => void checkIn()}
              disabled={checkingIn}
              hint={checkingIn ? 'Saving your check-in.' : undefined}
              height={60}
              style={{ marginTop: 14 }}
            />
            <Btn
              label="Not yet"
              look="grey"
              onPress={() => {
                notify('Check in when you go inside. The bar at the bottom brings you back.', 'info');
                router.replace('/journey');
              }}
              style={{ marginTop: 10 }}
            />
          </Panel>
        </Swap>
      </AppFrame>
    );
  }

  /*
   * ─────────────────────────────────────────── at the door, with no trip
   *
   * See `needsDoor`. The same gate the arrival runs, said in the same card
   * shape, and the same way past a distance refusal. Nothing is written until
   * it accepts him, and then he is in: with no trip there is nothing between
   * arriving and going in.
   */
  if (needsDoor) {
    return (
      <AppFrame
        title={c?.name ?? 'Check in'}
        activeTab="customers"
        onBack={() => router.back()}
        showTitle={false}
        heroTop={
          <Text accessibilityRole="header" style={[{ fontSize: 20, lineHeight: 26, color: HERO.lavender.ink }, weight(800)]}>
            Check in
          </Text>
        }
        hero={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16 }}>
            <Icon name="shop" size={22} color={C.primaryDeep} strokeWidth={2} />
            <Text numberOfLines={2} style={[{ fontSize: 26, lineHeight: 32, letterSpacing: -0.52, color: HERO.lavender.ink, flex: 1, minWidth: 0 }, weight(800)]}>
              {c?.name ?? ''}
            </Text>
          </View>
        }
        contentStyle={{ paddingHorizontal: 14, paddingTop: 16, paddingBottom: 24 }}>
        <Swap id="door">
          <Panel>
            <Text style={[{ fontSize: 16, lineHeight: 22, color: C.ink }, weight(700)]}>Check in when you are inside.</Text>
            <View
              style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginTop: 10 }}
              accessible
              accessibilityLabel="Your location is checked against the shop. This starts your visit time.">
              <Fact icon="locate" text="Checked against the shop" />
              <Fact icon="clock" text="Starts visit time" />
            </View>

            <Presence show={!!refused}>
              {refused ? <RefusalBox verdict={refused} radiusM={maxMetres} /> : null}
            </Presence>

            <Animated.View style={[{ marginTop: 14 }, refuseShake.style]}>
              <Btn
                label={arriving ? 'One moment…' : refused ? 'Check again' : 'Check in at the shop'}
                icon={refused && !arriving ? 'locate' : undefined}
                onPress={() => void arriveHere()}
                disabled={arriving}
                hint={arriving ? 'Checking where you are.' : undefined}
                height={60}
              />
            </Animated.View>
            {/* Only for a refusal on DISTANCE: a missing or weak reading is not a
                wrong pin, and there is no way past it but a reading. */}
            <Presence show={refused?.reason === 'too_far'}>
              <Btn
                label="I am here. Pin is wrong"
                a11y="I am here. Shop location is wrong"
                look="dashed"
                icon="pin"
                onPress={overrideRefusal}
                style={{ marginTop: 10 }}
              />
            </Presence>
          </Panel>
        </Swap>
      </AppFrame>
    );
  }

  /*
   * ─────────────────────────────────────────── still on the road
   *
   * THE VISIT SCREEN IS LOCKED UNTIL HE SAYS HE IS HERE, and that is the point
   * of asking how he travels at all. "Start visit" now means "I am setting
   * off", so opening the whole form at that moment would start the dwell
   * clock, ask for a GPS fix and offer a shop photograph while he is still on
   * the bike — and the dwell figure, which exists to say how long he spent
   * with the customer, would quietly become how long the ride took.
   *
   * Rendered INSTEAD of the form rather than over it: a modal on top of a
   * working screen invites somebody to dismiss it and carry on, and there is
   * nothing underneath to carry on with.
   */
  if (legLoaded && leg && leg.endedAt == null) {
    const prompt = arrivalPrompt({
      requiresOdometer: needsMeter,
      odometerStartKm: leg.odometerStartKm,
    });
    const shopPin = pinLat != null && pinLng != null ? { lat: pinLat, lng: pinLng } : null;
    const away = navigationLine({
      hasPin: !!shopPin,
      metresAway: roadFix && shopPin ? haversineMetres(roadFix, shopPin) : null,
      fixAgeSeconds: roadFix ? Math.round((now - roadFix.at) / 1000) : null,
      staleAfterSeconds: staleAfterS,
    });
    const distance = roadFix && shopPin ? distanceLabel(haversineMetres(roadFix, shopPin)) : null;
    const nav = HERO.navy;
    return (
      <AppFrame
        title={c?.name ?? leg.toLabel ?? 'On your way'}
        tone="navy"
        activeTab="customers"
        onBack={() => router.back()}
        showTitle={false}
        heroTop={
          <Text accessibilityRole="header" style={[{ fontSize: 20, lineHeight: 26, color: nav.ink }, weight(800)]}>
            On your way
          </Text>
        }
        hero={
          <View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16 }}>
              {/* Breathing while the leg is open: the one live thing on the card. */}
              <Pulse active>
                <Icon name="nav" size={22} color={C.lime} strokeWidth={2} />
              </Pulse>
              <Text numberOfLines={2} style={[{ fontSize: 26, lineHeight: 32, letterSpacing: -0.52, color: nav.ink, flex: 1, minWidth: 0 }, weight(800)]}>
                {c?.name ?? leg.toLabel ?? ''}
              </Text>
            </View>
            <View
              style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 16, marginTop: 10 }}
              accessible
              accessibilityLabel={
                legLine({ modeLabel: legMode?.label ?? leg.modeKey, odometerStartKm: null, odometerEndKm: null, ticketAmountPaise: null }) +
                ', travelling ' +
                travellingFor(leg.startedAt ?? Date.now(), now) +
                (leg.odometerStartKm != null ? ', meter at start ' + leg.odometerStartKm.toLocaleString('en-IN') + ' km' : '')
              }>
              <Fact
                icon={legMode?.requiresOdometer ? 'bike' : 'route'}
                color="#DCE3EE"
                text={legLine({
                  modeLabel: legMode?.label ?? leg.modeKey,
                  odometerStartKm: null,
                  odometerEndKm: null,
                  ticketAmountPaise: null,
                })}
              />
              <Fact icon="clock" color="#DCE3EE" text={travellingFor(leg.startedAt ?? Date.now(), now)} />
              {leg.odometerStartKm != null ? (
                <Fact icon="gauge" color="#DCE3EE" text={leg.odometerStartKm.toLocaleString('en-IN') + ' km'} />
              ) : null}
            </View>
          </View>
        }
        contentStyle={{ paddingHorizontal: 14, paddingTop: 16, paddingBottom: 24 }}>
        <Swap id="travelling">
          <View style={{ gap: 12 }}>
            {/*
              NAVIGATION SITS WITH THE JOURNEY, above the line about ending it.
              The ride he is on is read as he sets off; how it stops is read
              when he gets there, so the two halves sit in two cards.
            */}
            <Panel style={{ paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
              <NavigateButton
                variant="icon"
                look="round"
                size={48}
                lat={c?.gpsLat}
                lng={c?.gpsLng}
                name={c?.name ?? leg.toLabel}
                city={c?.area ?? c?.city}
              />
              <View style={{ flex: 1, minWidth: 0 }}>
                {distance ? (
                  <Text style={[{ fontSize: 22, lineHeight: 29, letterSpacing: -0.44, color: C.ink }, weight(800)]}>{distance}</Text>
                ) : (
                  <Text style={[{ fontSize: 16, lineHeight: 22, color: C.ink }, weight(700)]}>Navigate</Text>
                )}
                {/* `navigationLine` carries the age of a stale reading and the
                    no-pin sentence; nothing is shown while there is no reading
                    yet, because the header already says GPS is being found. */}
                <Text style={[{ fontSize: 13, lineHeight: 18, color: C.muted }, weight(500)]}>
                  {away ? (distance ? 'Navigate · ' + away : away) : 'Navigate to the shop'}
                </Text>
              </View>
            </Panel>

            <Panel>
              <Fact icon={needsMeter ? 'gauge' : 'pin'} text={prompt.line} color={C.body} />

              {/*
                THE REFUSAL, said with its number.
                It sits above the button rather than in a toast because a toast is
                gone before it has been read, and the one thing he needs from this
                screen is how far off he is — which tells him whether to walk
                twenty steps or whether the book has the shop in the wrong town.
              */}
              <Presence show={!!refused}>
                {refused ? <RefusalBox verdict={refused} radiusM={maxMetres} /> : null}
              </Presence>

              <Animated.View style={[{ marginTop: 14 }, refuseShake.style]}>
                <Btn
                  label={arriving ? 'One moment…' : refused ? 'Check again' : prompt.button}
                  icon={arriving ? undefined : refused ? 'locate' : needsMeter ? 'camera' : 'pin'}
                  onPress={() => void arriveHere()}
                  disabled={arriving}
                  hint={arriving ? 'Saving where you are.' : undefined}
                  height={60}
                />
              </Animated.View>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                {/*
                  OFFERED ONLY ONCE HE HAS BEEN REFUSED, and only on DISTANCE.
                  Drawn from the start it would be a way round the radius that
                  nobody had to be refused by first; and a missing reading is not
                  a wrong pin, so there is no way past it but a reading.
                */}
                {refused?.reason === 'too_far' ? (
                  <Btn
                    label="Here. Pin is wrong"
                    a11y="I am here. Shop location is wrong"
                    look="dashed"
                    onPress={overrideRefusal}
                    style={{ flex: 1 }}
                  />
                ) : null}
                {/*
                  CALLING IT OFF IS THE WAY OUT THAT IS NOT AN ARRIVAL, and it is
                  not a skip. The meter has already moved, so there is no version
                  of this where nothing happened — what he chooses is whether the
                  journey is recorded against a shop he reached or against a trip
                  he abandoned, and the second still needs a sentence or the next
                  departure's reading follows on from a gap.
                */}
                <Btn
                  label={refused?.reason === 'too_far' ? 'Not going' : 'I am not going after all'}
                  a11y="I am not going after all"
                  look="grey"
                  style={{ flex: 1 }}
                  onPress={() =>
                    askConfirm({
                      title: 'Cancel this trip?',
                      body:
                        'It stays on your record with your reason and 0 km. The meter has already moved, so removing the trip would leave a gap before your next one.',
                      reasonLabel: 'Why · needed',
                      confirmLabel: 'Cancel trip',
                      cancelLabel: 'Back',
                      tone: 'danger',
                      run: (reason) => {
                        void abandonLeg(leg.id, reason)
                          .then(() => {
                            setArrival(null);
                            void clearArrival();
                            notify('Trip cancelled');
                            router.replace('/journey');
                          })
                          .catch(() => notify('The trip could not be cancelled on this phone. Try again.', 'error'));
                      },
                    })
                  }
                />
              </View>
            </Panel>
          </View>
        </Swap>

        <OdometerCamera
          open={metering}
          title="Meter photo"
          subtitle="Arrived. The trip is measured up to this reading."
          cancelLabel="Cancel. I have not arrived"
          previousKm={leg.odometerStartKm}
          maxLegKilometres={maxLegKm}
          onDone={(result) => {
            setMetering(false);
            answerOdometer.current?.(result);
            answerOdometer.current = null;
          }}
        />
      </AppFrame>
    );
  }

  const left = verdict.failed.length;
  return (
    <AppFrame
      chipsBelowTitle
      title={c?.name ?? 'Visit'}
      activeTab="customers"
      onBack={() => router.back()}
      heroTop={
        visitStart != null ? (
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
            {/* CHECKED IN, and the clock says how long ago — the same figure
                as the check-out bar, so the hero never needs scrolling back to. */}
            <View
              accessible
              accessibilityLabel={'In the shop for ' + elapsedLabel(dwellSeconds)}
              style={{ minHeight: 36, paddingVertical: 6, paddingHorizontal: 14, borderRadius: 18, backgroundColor: C.navy, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Icon name="clock" size={16} color={C.lime} strokeWidth={2.2} />
              <Text style={[{ fontSize: 14, lineHeight: 20, color: C.lime }, weight(700)]}>{elapsedLabel(dwellSeconds)}</Text>
            </View>
          </View>
        ) : undefined
      }
      hero={
        c?.contactPerson || c?.city ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 14, marginTop: 8 }}>
            {c?.contactPerson ? <Fact icon="person" text={c.contactPerson} color={HERO.lavender.muted} /> : null}
            {c?.city ? <Fact icon="pin" text={c.city} color={HERO.lavender.muted} /> : null}
          </View>
        ) : null
      }
      contentStyle={{ paddingHorizontal: 14, paddingTop: 14, paddingBottom: 24 }}
      footerBg={C.canvas}
      footerInsetBg={C.navy}
      footer={
        <View style={{ backgroundColor: C.navy, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 18 }}>
          {/* `warning` rather than `firstFailure`: a visit whose check-in was
              overridden has nothing outstanding and is still not a clean one,
              and that line used to be blank — the bar said nothing while the
              panel above it said "Everything checks out". */}
          {verdict.warning ? (
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginBottom: 10 }}>
              <Icon name="warn" size={15} color={AMBER_ON_NAVY} strokeWidth={2} />
              <Text style={{ flex: 1, fontSize: 13, lineHeight: 18, color: AMBER_ON_NAVY }}>{verdict.warning}</Text>
            </View>
          ) : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            {/* CHECKED IN, and the clock says how long ago. The button beside
                it is the other end of the same pair — he checks in at the
                door and checks out at it, and calling that button "Save
                visit" named the filing rather than the act. */}
            <View
              accessible
              accessibilityLabel={'In the shop, ' + elapsedLabel(dwellSeconds)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Icon name="clock" size={20} color={C.lime} strokeWidth={2} />
              <Text style={[{ fontSize: 20, lineHeight: 26, letterSpacing: -0.4, color: '#FFFFFF' }, weight(800)]}>{elapsedLabel(dwellSeconds)}</Text>
            </View>
            {/* Live on `complete`, never on `verified`. An override is not a
                missing requirement, and greying the button on one would demand
                a second typed reason for a question already answered at the
                door. */}
            <Pressable
              onPress={() => (verdict.complete ? saveWhenDecided() : setAsking(true))}
              accessibilityRole="button"
              accessibilityLabel={verdict.complete ? 'Check out of the shop and save the visit' : verdict.firstFailure}
              style={({ pressed }) => ({
                flex: 1,
                minHeight: 56,
                paddingVertical: 8,
                borderRadius: 28,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: verdict.complete ? C.lime : 'rgba(255,255,255,0.14)',
                opacity: pressed ? 0.85 : 1,
              })}>
              <Text style={[{ fontSize: 16, lineHeight: 22, color: verdict.complete ? C.navy : C.onNavyMuted }, weight(700)]}>
                {saving ? 'Checking out…' : verdict.complete ? 'Check out' : 'Check out · ' + left + ' left'}
              </Text>
            </Pressable>
          </View>
        </View>
      }>
      <Swap id="in">
        <View style={{ gap: 12 }}>
        {/* ---- he walked out without checking out ----
            Said at the top, in words, because the button below now closes the
            visit at a time he did not press it — and he should know that before
            he does. */}
        <Presence show={leftAt != null}>
        {leftAt != null ? (
          <View style={{ backgroundColor: C.warnBg, borderRadius: 20, paddingVertical: 14, paddingHorizontal: 16, flexDirection: 'row', gap: 12 }}>
            <Icon name="warn" size={22} color={C.warnInk} strokeWidth={2} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[{ fontSize: 15, lineHeight: 21, color: C.ink }, weight(800)]}>You left without checking out</Text>
              <Text style={{ fontSize: 13, lineHeight: 18, color: C.body, marginTop: 2 }}>
                {'Seen ' +
                  hhmm(leftAt) +
                  (arrival?.leftShopMetres ? ', about ' + arrival.leftShopMetres + ' m away' : '') +
                  '. Check out from here, no need to go back. The visit closes at ' +
                  hhmm(leftAt) +
                  '.'}
              </Text>
            </View>
          </View>
        ) : null}
        </Presence>

        {/* ---- where you are ---- */}
        <View style={{ backgroundColor: C.surface, borderRadius: 20, paddingVertical: 12, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Icon
            name={gpsLocked ? 'shield' : gps === 'off' ? 'warn' : 'locate'}
            size={22}
            color={gpsLocked ? C.success : gps === 'off' ? C.warnInk : C.faint}
            strokeWidth={2}
          />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[{ fontSize: 14, lineHeight: 20, color: C.ink }, weight(700)]}>
              {gpsLocked ? 'Checked in here' : gps === 'off' ? 'No GPS' : 'Finding you…'}
            </Text>
            <Text style={{ marginTop: 2, fontSize: 13, lineHeight: 18, color: C.muted }}>
              {gpsLocked
                ? fixReason ?? verdictGeo.sentence
                : gps === 'off'
                  ? fixReason ?? 'The visit will be saved. Your manager will check it.'
                  : 'Inside a shop this can take a moment.'}
            </Text>
          </View>
          {gps === 'off' ? (
            <Pressable
              onPress={() => notify('Going on without location. At check-out, choose "Save as not checked" and say why. Your manager will see it had no location.', 'warn')}
              accessibilityRole="button"
              style={({ pressed }) => ({ height: HIT, paddingHorizontal: 14, borderRadius: HIT / 2, backgroundColor: pressed ? C.line : C.wash, alignItems: 'center', justifyContent: 'center' })}>
              <Text style={[{ fontSize: 14, lineHeight: 20, color: C.ink }, weight(700)]}>Carry on</Text>
            </Pressable>
          ) : null}
        </View>

        {/* ---- what was said last time ----
            Shown before the call, not found after it on the timeline. "Will
            pay" typed in a hurry three weeks ago reads exactly like a
            sentence that never named a date — the whole reason a note is
            worth reading back rather than trusted from memory. */}
        {lastTime ? (
          <View
            style={{ backgroundColor: C.surface, borderRadius: 20, paddingVertical: 12, paddingHorizontal: 16 }}
            accessible
            accessibilityLabel={'Last time, ' + pretty(isoDate(new Date(lastTime.checkInAt))) + (lastTime.outcome ? ', ' + outcomeLabel(lastTime.outcome) : '') + '. ' + lastTime.note}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Icon name="clock" size={15} color={C.muted} strokeWidth={2} />
              <Text style={[{ fontSize: 13, lineHeight: 18, color: C.muted, flex: 1 }, weight(700)]}>
                {'Last time · ' + pretty(isoDate(new Date(lastTime.checkInAt)))}
              </Text>
              {lastTime.outcome ? (
                <View style={{ flexShrink: 0, minHeight: 24, paddingVertical: 3, paddingHorizontal: 8, borderRadius: 12, backgroundColor: C.wash, justifyContent: 'center' }}>
                  <Text style={[{ fontSize: 12, lineHeight: 17, color: C.body }, weight(600)]}>{outcomeLabel(lastTime.outcome)}</Text>
                </View>
              ) : null}
            </View>
            <Text style={{ fontSize: 14, lineHeight: 20, color: C.ink, marginTop: 6 }} numberOfLines={3}>
              {lastTime.note}
            </Text>
          </View>
        ) : null}

        {/* ---- what was said ---- */}
        <Panel>
          <FieldLabel text="What was said" />

          {/*
            ONE MICROPHONE, and what it does depends on the signal.

            It used to be two things on this card: a "Hold to talk" recorder that
            queued the audio for the office to write out later, and a note box
            underneath it. The recorder had never been reachable — nothing on any
            path asked for the RECORD_AUDIO permission, so preparing threw and the
            screen reported a broken microphone — and the card carried a state
            called `done` that nothing ever set, so its "AI transcribed · edit
            before saving" badge could not appear and the salesman had no way to
            see the transcript at all. What he did see, after a recording that had
            uploaded perfectly, was "No signal to transcribe".

            Both halves answer the same question, so they are one control now.
            On signal it dictates: he speaks, reads the English, corrects it and
            it lands in this box before he saves. Off signal it does what the old
            recorder claimed to — the audio is queued and the office writes it out
            — which is the honest fallback rather than an apology, and it is the
            reason `keepAudio` exists at all.

            The audio is kept in BOTH cases, unlike everywhere else this box
            appears. A visit note is the one field where the recording is a record
            of what a customer said rather than a keyboard, and the office keeps
            it either way.
          */}
          <View style={{ marginTop: 10 }}>
            <VoiceField
              value={note}
              onChangeText={(v) => set({ note: v })}
              keepAudio="keep"
              onRecording={(uri, _seconds, mode) => void keepVoiceNote(uri, mode)}
              onHeard={setHeard}
            />
            {voiceNoteId ? (
              <View style={{ marginTop: 8 }}>
                <Fact icon="upload" text="The recording goes to the office with this visit." />
              </View>
            ) : null}
          </View>
        </Panel>

        {/* ---- what the assistant made of it ----
            Directly under the note, because the note is what it reads, and above
            the outcome chips, because those are the first thing it fills. */}
        {c ? (
          <VisitAssistant customerId={c.id} note={note} heard={heard} handlers={assistant} />
        ) : null}

        {/* ---- how it went ---- */}
        <View>
          <FieldLabel text="How did it go" style={{ paddingHorizontal: 4, paddingTop: 4, marginBottom: 8 }} />
          <OutcomeGrid value={outcome} onPick={pickOutcome} />
        </View>

        {/* ---- the follow-on the outcome implies ---- */}
        <Presence show={!!followOn}>
        {followOn ? (
          <Panel style={{ paddingVertical: 14, borderWidth: 1, borderColor: C.primaryEdge }}>
            {doneLine ? (
              <View
                style={{ alignSelf: 'flex-start', minHeight: 30, paddingHorizontal: 12, borderRadius: 15, backgroundColor: C.successBg, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Icon name="tick" size={14} color={C.success} strokeWidth={2.4} />
                <Text style={[{ fontSize: 13, lineHeight: 18, color: C.success, flexShrink: 1 }, weight(700)]}>{doneLine}</Text>
              </View>
            ) : (
              <View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <Icon name={outcome ? OUTCOME_ICON[outcome] ?? 'visit' : 'visit'} size={22} color={C.primary} strokeWidth={2} />
                  <Text style={{ flex: 1, fontSize: 14, lineHeight: 20, color: C.ink }}>{followOn.line}</Text>
                </View>
                <Btn
                  label={followOn.cta}
                  look="primary"
                  onPress={() => {
                    if (outcome === 'order') return router.push('/order?from=visit');
                    if (outcome === 'payment') return router.push('/pay?from=visit');
                    setDraft({});
                    setFormErr(null);
                    setForm(outcome === 'complaint' ? 'complaint' : 'sample');
                  }}
                  style={{ marginTop: 10 }}
                />
              </View>
            )}
          </Panel>
        ) : null}
        </Presence>

        {/* ---- §B · is this one going anywhere? ----
            Drawn only for a Suspect, and only once the count is worth mentioning.
            It is a QUESTION on the visit form, never a refusal of the visit: a
            salesman whose visit is blocked stops recording visits, and the
            company loses the GPS, the competitor note and the reason in order to
            stop a number reaching four. */}
        {/* `capLabel` in the guard costs nothing and buys the type: anything that
            makes `capState` something other than `ok` is a Suspect stage, which
            is the only thing `visitCapLabel` returns null for. */}
        {capState !== 'ok' && suspect && capLabel ? (
          <Panel style={{ borderLeftWidth: 4, borderLeftColor: capState === 'decide' ? C.warnInk : C.hairline }}>
            {/* The engine's own wording, counting the visit being MADE. Retyped
                here it read "Visit 2 / 3" on the third visit — one in hand,
                under a card demanding the decision. */}
            <PanelTitle
              icon="person"
              text="Suspect"
              right={
                <View
                  accessible
                  accessibilityLabel={capLabel + ', still a Suspect'}
                  style={{ minHeight: 28, paddingVertical: 4, paddingHorizontal: 10, borderRadius: 14, backgroundColor: C.warnBg, justifyContent: 'center' }}>
                  <Text style={[{ fontSize: 13, lineHeight: 18, color: C.warnInk }, weight(800)]}>{capLabel}</Text>
                </View>
              }
            />
            <Text style={{ fontSize: 13, lineHeight: 18, marginTop: 6, color: C.body }}>
              {capState === 'decide'
                ? 'Decide which way this lead goes before you close the visit. The visit saves either way.'
                : 'On the next visit you must decide. Think about it now.'}
            </Text>

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
              {[
                { v: 'qualified', label: 'A prospect', tint: { bg: C.successBg, fg: C.success } },
                { v: 'contacted', label: 'Keep trying' },
                { v: 'on_hold', label: 'On hold' },
                { v: 'still_suspect', label: 'Still a Suspect' },
                { v: 'lost', label: 'Lost', tint: { bg: C.dangerBg, fg: C.danger } },
              ].map((o) => (
                <Chip
                  key={o.v}
                  label={o.label}
                  tint={o.tint}
                  selected={decision === o.v}
                  onPress={() => {
                    setDecision(decision === o.v ? null : o.v);
                    setDecisionErr(null);
                  }}
                />
              ))}
            </View>

            {/* On hold and staying a Suspect both ask why, and for the same
                reason: somebody is going to look at this lead again and the
                sentence is what tells them when, or whether. Lost asks too —
                that one because nobody will. */}
            <Presence show={decision === 'still_suspect' || decision === 'on_hold' || decision === 'lost'}>
            {decision === 'still_suspect' || decision === 'on_hold' || decision === 'lost' ? (
              <TextInput
                value={decisionWhy}
                onChangeText={(v) => {
                  setDecisionWhy(v);
                  setDecisionErr(null);
                }}
                placeholder={
                  decision === 'lost'
                    ? 'Why we will not go back *'
                    : 'What we are waiting for *'
                }
                accessibilityLabel={decision === 'lost' ? 'Why we will not go back, needed' : 'What we are waiting for, needed'}
                placeholderTextColor={C.faint}
                multiline
                style={{
                  marginTop: 10,
                  minHeight: 56,
                  backgroundColor: C.wash,
                  borderRadius: 16,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  fontSize: 14,
                  color: C.ink,
                  textAlignVertical: 'top',
                }}
              />
            ) : null}
            </Presence>

            <Presence show={!!decisionErr}>
              <Text style={[{ fontSize: 13, lineHeight: 18, marginTop: 8, color: C.danger }, weight(700)]}>
                {decisionErr}
              </Text>
            </Presence>
          </Panel>
        ) : null}

        {/* ---- §G · what they actually need ----
            On a lead only. These overwrite the lead's own columns deliberately,
            unlike the validation call's answers: this is the same person asking
            the same question better informed, not a second party's account. */}
        {suspect ? (
          <Panel>
            <PanelTitle icon="list" text="What they need" />
            {/* §G's business rule, said on the screen where it applies rather
                than only refused at the server. */}
            <Text
              style={{ fontSize: 12, lineHeight: 16, marginTop: 2, color: C.muted }}
              accessibilityLabel="Fill it after you show the price list and ask them. Do not promise any price or delivery now. The Lead Manager handles price talk.">
              After the price list. Promise no price or delivery. The Lead Manager does price talk.
            </Text>

            <TextInput
              value={reqWhat}
              onChangeText={setReqWhat}
              placeholder="What they want, e.g. thinner for a spray booth"
              placeholderTextColor={C.faint}
              style={{ marginTop: 10, minHeight: 48, backgroundColor: C.wash, borderRadius: 16, paddingHorizontal: 14, fontSize: 14, color: C.ink }}
            />
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <View style={{ flex: 1, minHeight: 48, backgroundColor: C.wash, borderRadius: 16, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 6 }}>
                <TextInput
                  value={reqLitres}
                  onChangeText={(v) => setReqLitres(cleanDecimal(v, 2))}
                  placeholder="Litres"
                  accessibilityLabel="Litres a month"
                  placeholderTextColor={C.faint}
                  keyboardType="decimal-pad"
                  style={[{ flex: 1, minWidth: 0, minHeight: 48, fontSize: reqLitres ? 18 : 14, color: C.ink }, reqLitres ? weight(800) : null]}
                />
                <Text style={[{ fontSize: 12, lineHeight: 17, color: C.muted }, weight(700)]}>L / month</Text>
              </View>
              {/* Cans, because that is what an ORDER is counted in — the litres
                  beside it are what the shop says its consumption is. Two
                  different questions, and the units say which is which. */}
              <View style={{ flex: 1, minHeight: 48, backgroundColor: C.wash, borderRadius: 16, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 6 }}>
                <TextInput
                  value={reqCans}
                  onChangeText={(v) => setReqCans(cleanWhole(v))}
                  placeholder="to start"
                  accessibilityLabel="Cans to start"
                  placeholderTextColor={C.faint}
                  keyboardType="number-pad"
                  style={[{ flex: 1, minWidth: 0, minHeight: 48, fontSize: reqCans ? 18 : 14, color: C.ink }, reqCans ? weight(800) : null]}
                />
                <Text style={[{ fontSize: 12, lineHeight: 17, color: C.muted }, weight(700)]}>cans</Text>
              </View>
            </View>
            {wholeOnly(reqCans) ? (
              <Text style={{ fontSize: 12, lineHeight: 17, color: C.danger, marginTop: 4, textAlign: 'right' }}>Whole cans only.</Text>
            ) : null}
          </Panel>
        ) : null}

        {/* ---- photos ---- */}
        <View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {[
              { k: 'shop' as const, ic: 'shop' as IconName, on: 'Shop ✓', off: 'Shop photo' },
              { k: 'cust' as const, ic: 'person' as IconName, on: 'Owner ✓', off: 'Owner photo' },
            ].map((b) => {
              const has = !!shots[b.k];
              return (
                <PressableScale
                  key={b.k}
                  onPress={() => shoot(b.k)}
                  accessibilityRole="button"
                  accessibilityLabel={has ? b.on.replace(' ✓', ' photo taken, take again') : 'Take ' + b.off.toLowerCase()}
                  outerStyle={{ flex: 1 }}
                  style={{
                    minHeight: 88,
                    paddingVertical: 8,
                    borderRadius: 20,
                    borderWidth: has ? 2 : 1.5,
                    borderStyle: has ? 'solid' : 'dashed',
                    borderColor: has ? C.primary : '#B9A6FF',
                    backgroundColor: has ? '#F7F4FF' : C.surface,
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                  }}>
                  {/* Pops as the photograph comes back from the camera: the tile
                      turning purple is the only sign it was kept. */}
                  <Pop trigger={has}>
                    <Icon name={has ? 'tick' : 'camera'} size={22} color={has ? C.primaryDeep : C.ink} strokeWidth={2} />
                  </Pop>
                  <Text style={[{ fontSize: 13, lineHeight: 18, color: has ? C.primaryDeep : C.ink }, weight(700)]}>
                    {has ? b.on : b.off}
                  </Text>
                </PressableScale>
              );
            })}
          </View>
          <Presence show={!!(shots.shop || shots.cust)}>
            <View style={{ marginTop: 8, paddingHorizontal: 4 }}>
              <Fact icon="upload" text="Saved on this phone. Sends with signal." />
            </View>
          </Presence>
        </View>

        {/* ---- next contact: how, and when ----
            How is asked beside when because they are one promise — "I will
            ring you Thursday" is not "I will come by Thursday", and the task it
            raises is named by the answer. */}
        <Panel>
          <PanelTitle icon="cal" text="Next contact" />
          {noFollowUp ? null : (
          <>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }} accessibilityRole="radiogroup">
            {FOLLOW_UP_MODES.map((m) => {
              const on = nextMode === m.k;
              return (
                <Pressable
                  key={m.k}
                  onPress={() => {
                    if (nextMode !== m.k) feedback('select');
                    set({ nextMode: m.k });
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={m.label}
                  style={{
                    flex: 1,
                    height: HIT,
                    borderRadius: HIT / 2,
                    backgroundColor: on ? C.navy : C.wash,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                  }}>
                  <Icon name={m.k === 'call' ? 'call' : m.k === 'whatsapp' ? 'chat' : 'visit'} size={15} color={on ? C.lime : C.ink} strokeWidth={2} />
                  <Text style={[{ fontSize: 13, lineHeight: 18, color: on ? '#FFFFFF' : C.ink }, weight(700)]}>{m.label}</Text>
                </Pressable>
              );
            })}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }}>
            <Pressable
              onPress={() => setCalOpen('next')}
              accessibilityRole="button"
              accessibilityLabel={'Next contact on ' + pretty(nextDate) + ', change'}
              style={({ pressed }) => ({ height: HIT, borderRadius: HIT / 2, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.navy, opacity: pressed ? 0.85 : 1 })}>
              <Text style={[{ fontSize: 14, lineHeight: 20, color: '#FFFFFF' }, weight(700)]}>{pretty(nextDate)}</Text>
              <Icon name="cal" size={16} color={C.lime} strokeWidth={2} />
            </Pressable>
            <Text style={{ flex: 1, fontSize: 12, lineHeight: 16, color: C.muted }}>
              {outcome === 'closed' || outcome === 'closed_now'
                ? nextDatePicked
                  ? 'A task is set for this day.'
                  : 'No task is set for a shut shop unless you pick a day.'
                : c?.cycleDays
                  ? 'Set from their ' + c.cycleDays + '-day buying pattern. Change it if they said another day.'
                  : 'Change it if they said another day.'}
            </Text>
          </View>
          </>
          )}
          {/* "NONE" IS AN ANSWER. The day was filled from the cycle and there
              was no way to empty it, so every visit — a shut shop included —
              raised a follow-up task he had promised nobody. */}
          <Pressable
            onPress={() => {
              feedback('select');
              setForm2({ noFollowUp: !noFollowUp });
            }}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: noFollowUp }}
            accessibilityLabel="No follow-up needed"
            style={({ pressed }) => ({
              marginTop: 10,
              minHeight: HIT,
              borderRadius: HIT / 2,
              backgroundColor: noFollowUp ? C.primaryTint : C.wash,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              paddingHorizontal: 14,
              opacity: pressed ? 0.85 : 1,
            })}>
            <View
              style={{
                width: 20,
                height: 20,
                borderRadius: 10,
                borderWidth: 2,
                borderColor: noFollowUp ? C.primary : C.faint,
                backgroundColor: noFollowUp ? C.primary : 'transparent',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
              {noFollowUp ? <Icon name="tick" size={12} color="#FFFFFF" strokeWidth={3} /> : null}
            </View>
            <Text style={[{ fontSize: 14, lineHeight: 20, color: C.ink }, weight(600)]}>No follow-up needed</Text>
          </Pressable>
        </Panel>

        {/* ---- what is missing, and why the rule exists ----
            Drawn only while something is outstanding, and listing only that.
            A green checklist of everything already done repeated the save bar
            and pushed the one line that mattered below the fold. */}
        {/* Leaves as the last thing is answered, rather than vanishing from
            under the thumb that answered it. */}
        <Presence show={!verdict.verified}>
        <Panel>
          <Text accessibilityRole="header" style={[{ fontSize: 15, lineHeight: 21, color: C.ink }, weight(800)]}>
            {verdict.title + (left ? ' · ' + left : '')}
          </Text>

          <View style={{ marginTop: 2 }}>
            {verdict.failed.map((k, i) => (
              <View key={k.key} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', paddingVertical: 10, borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline }}>
                <View style={{ width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: k.ok ? C.successBg : C.dangerBg }}>
                  {k.ok ? (
                    <Icon name="tick" size={13} color={C.success} strokeWidth={2.4} />
                  ) : (
                    <Text style={[{ fontSize: 13, color: C.danger }, weight(800)]}>!</Text>
                  )}
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[{ fontSize: 14, lineHeight: 20, color: k.ok ? C.ink : C.danger }, weight(k.ok ? 400 : 700)]}>{k.line}</Text>
                  {!k.ok ? <Text style={{ fontSize: 12, lineHeight: 16, color: C.muted, marginTop: 2 }}>{k.why}</Text> : null}
                </View>
              </View>
            ))}
          </View>

          {/* The override is logged, not hidden. Nobody parks outside and fakes it. */}
          <SaveAsNotChecked
            onPress={() =>
              owed.length
                ? setAsking(true)
                : askConfirm({
                title: 'Save anyway?',
                body: verdict.overrideBody,
                reasonLabel: 'Why · needed',
                confirmLabel: 'Save as not checked',
                tone: 'navy',
                run: (reason) => saveWhenDecided(reason),
              })
            }
          />
        </Panel>
        </Presence>

        <View style={{ height: 96 }} />
        </View>
      </Swap>

      {/*
        ---- the shop's own pin, questioned by somebody standing at it ----

        A REQUEST AND NEVER A WRITE. The handset can already move a pin through
        `customer_update`, so letting the override move it directly would mean
        one override put the pin wherever he happened to be and the radius
        never refused him there again. A manager decides, on the visit's own
        row, from the check-in fix already stored on it — which is why nothing
        here sends a coordinate: what he is proposing IS the check-in, and a
        second copy of two numbers already in the record is a copy that can
        disagree with it.

        Backing out is No. It is a question about the book, asked of somebody
        who has a shopkeeper waiting, and a sheet that would not close until it
        was answered would be answered at random.
      */}
      {/*
        ---- BEFORE YOU CHECK OUT ----

        "Check out" with something still owed used to raise a toast naming the
        first missing thing and do nothing else, so a salesman on an older
        build — where nothing was owed at all — simply walked out, and one on
        this build learned to hunt up the page for whatever the toast meant.
        This asks every question in one place, with the controls to answer it
        right there, and the button at the bottom checks him out the moment
        the last one is answered. The evidence (GPS, time in the shop) is listed but
        cannot be typed into existence, so it offers the unverified save —
        which the answers still have to be given for.
      */}
      <BottomSheet open={asking} onClose={() => setAsking(false)} scroll>
        <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 20 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Text accessibilityRole="header" style={[{ flex: 1, fontSize: 22, lineHeight: 29, letterSpacing: -0.44, color: C.ink }, weight(800)]}>
              Before you check out
            </Text>
            <View
              style={{ flexShrink: 0, minHeight: 32, paddingVertical: 4, paddingHorizontal: 12, borderRadius: 16, justifyContent: 'center', backgroundColor: verdict.complete ? C.successBg : C.dangerBg }}
              accessible
              accessibilityLabel={verdict.complete ? 'All answered.' : `${left} ${left === 1 ? 'thing' : 'things'} left for this visit.`}>
              <Text style={[{ fontSize: 14, lineHeight: 20, color: verdict.complete ? C.success : C.danger }, weight(800)]}>
                {verdict.complete ? 'All answered' : left + ' left'}
              </Text>
            </View>
          </View>

          {!checks.find((k) => k.key === 'outcome')?.ok ? (
            <View style={{ marginTop: 14 }}>
              <FieldLabel text="How did it go" style={{ marginBottom: 8 }} />
              <OutcomeGrid value={outcome} onPick={pickOutcome} compact />
            </View>
          ) : null}

          {!checks.find((k) => k.key === 'note')?.ok ? (
            <View style={{ marginTop: 16 }}>
              <FieldLabel text="What happened" />
              <Text
                style={{ fontSize: 12, lineHeight: 16, color: C.muted, marginBottom: 8 }}
                accessibilityLabel="What you talked about, what they said, what happens next. You can speak instead of typing.">
                Talked about · they said · what’s next. Speak if easier.
              </Text>
              <VoiceField
                value={note}
                onChangeText={(v) => set({ note: v })}
                keepAudio="keep"
                onRecording={(uri, _seconds, mode) => void keepVoiceNote(uri, mode)}
                onHeard={setHeard}
              />
              <Text style={[{ fontSize: 13, lineHeight: 18, marginTop: 6, color: C.danger }, weight(700)]}>
                {checks.find((k) => k.key === 'note')?.line}
              </Text>
            </View>
          ) : null}

          {followOn && !checks.find((k) => k.key === 'followon')?.ok ? (
            <View style={{ marginTop: 16, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#F7F4FF', borderRadius: 20, paddingVertical: 10, paddingLeft: 14, paddingRight: 10 }}>
              <Icon name={outcome ? OUTCOME_ICON[outcome] ?? 'visit' : 'visit'} size={20} color={C.primary} strokeWidth={2} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[{ fontSize: 13, lineHeight: 18, color: C.ink }, weight(700)]}>{followOn.label}</Text>
                <Text style={{ marginTop: 2, fontSize: 13, lineHeight: 18, color: C.muted }}>{followOn.line}</Text>
              </View>
              <Btn
                label={followOn.cta}
                look="primary"
                height={44}
                onPress={() => {
                  setAsking(false);
                  if (outcome === 'order') return router.push('/order?from=visit');
                  if (outcome === 'payment') return router.push('/pay?from=visit');
                  setDraft({});
                  setFormErr(null);
                  setForm(outcome === 'complaint' ? 'complaint' : 'sample');
                }}
              />
            </View>
          ) : null}

          <View style={{ marginTop: 12, gap: 8 }}>
            {checks
              .filter((k) => !k.ok && (k.key === 'gps' || k.key === 'dwell'))
              .map((k) => (
                <View key={k.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Icon name={k.key === 'gps' ? 'locate' : 'clock'} size={20} color={C.danger} strokeWidth={2} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[{ fontSize: 13, lineHeight: 18, color: C.danger }, weight(700)]}>{k.line}</Text>
                    <Text style={{ marginTop: 2, fontSize: 13, lineHeight: 18, color: C.muted }}>{k.why}</Text>
                  </View>
                </View>
              ))}
          </View>

          <Pressable
            disabled={!verdict.complete || saving}
            onPress={() => {
              setAsking(false);
              saveWhenDecided();
            }}
            accessibilityRole="button"
            accessibilityState={{ disabled: !verdict.complete || saving }}
            style={({ pressed }) => ({
              marginTop: 18,
              minHeight: 60,
              paddingVertical: 10,
              borderRadius: 30,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: verdict.complete ? C.navy : C.line,
              opacity: pressed ? 0.85 : 1,
            })}>
            <Text style={[{ fontSize: 16, lineHeight: 22, color: verdict.complete ? '#FFFFFF' : C.muted }, weight(700)]}>
              {verdict.complete ? 'Check out' : owed.length ? 'Answer the questions above' : 'Some things are missing'}
            </Text>
          </Pressable>
          {!verdict.complete && owed.length === 0 ? (
            <SaveAsNotChecked
              onPress={() => {
                setAsking(false);
                askConfirm({
                  title: 'Save anyway?',
                  body: verdict.overrideBody,
                  reasonLabel: 'Why · needed',
                  confirmLabel: 'Save as not checked',
                  tone: 'navy',
                  run: (reason) => saveWhenDecided(reason),
                });
              }}
            />
          ) : null}
        </View>
      </BottomSheet>

      <BottomSheet open={pinAsk} onClose={() => void answerPin(false)}>
        <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 20 }}>
          <SheetHead icon="pin" title="Shop in the wrong place?" />
          {/* The distance, from the refusal where the fresh reading has none.
              `metresAway` comes off a SECOND acquisition taken at the save and
              can be null while the refusal that opened this sheet was measured
              — leaving the question reading "about ? m", which is the one
              number that makes it answerable. */}
          <View
            style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 10 }}
            accessible
            accessibilityLabel={
              'The saved location for ' + (c?.name ?? 'this shop') + ' is about ' + (metresAway ?? refusedMetres ?? 'an unknown number of') +
              ' metres from where you checked in. If the shop is here and the map is wrong, ask your manager to move it. Then no visit here will be stopped again.'
            }>
            <Text style={[{ fontSize: 26, lineHeight: 32, letterSpacing: -0.52, color: C.ink }, weight(800)]}>
              {'≈ ' + (metresAway ?? refusedMetres ?? '?') + ' m'}
            </Text>
            <Text style={{ flex: 1, fontSize: 13, lineHeight: 18, color: C.muted }}>
              {'from the saved pin of ' + (c?.name ?? 'this shop') + ' to where you checked in. If the map is wrong, your manager moves it and no visit here is stopped again.'}
            </Text>
          </View>

          <View style={{ marginTop: 14, gap: 8 }}>
            <Btn label="Yes, ask my manager to move it" height={56} onPress={() => void answerPin(true)} />
            <Btn label="No, leave it as it is" look="grey" onPress={() => void answerPin(false)} />
          </View>
        </View>
      </BottomSheet>

      {/* ---- complaint, logged without leaving the visit ---- */}
      <BottomSheet open={form === 'complaint'} onClose={() => setForm(null)} scroll>
        <SheetHead icon="alert" title="Complaint" sub={(c?.name ?? '') + ' · goes to the office today'} />

        <FieldLabel text="What is it about" style={{ marginTop: 14, marginBottom: 8 }} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityRole="radiogroup">
          {COMPLAINT_CATEGORIES.map((x) => (
            <Chip
              key={x}
              label={x}
              selected={draft.cat === x}
              onPress={() => { setDraft({ ...draft, cat: x }); setFormErr(null); }}
            />
          ))}
        </View>
        {formErr === 'cat' ? <Text style={{ fontSize: 13, lineHeight: 18, color: C.danger, marginTop: 6 }}>Pick what it is about.</Text> : null}

        {/* Laid out across rather than down: three short words fit one row,
            and a second scrolling list under the first would push the box he
            actually has to type in off the screen. */}
        <FieldLabel text="How urgent" style={{ marginTop: 12, marginBottom: 8 }} />
        <View style={{ flexDirection: 'row', gap: 6 }} accessibilityRole="radiogroup">
          {COMPLAINT_PRIORITIES.map((p) => (
            <Chip
              key={p.value}
              label={p.label}
              tint={p.value === 'high' ? { bg: C.warnBg, fg: C.warnInk } : p.value === 'critical' ? { bg: C.dangerBg, fg: C.danger } : undefined}
              selected={(draft.priority ?? 'medium') === p.value}
              onPress={() => setDraft({ ...draft, priority: p.value })}
              style={{ flex: 1, minHeight: 44, borderRadius: 22 }}
            />
          ))}
        </View>

        <FieldLabel text="In their words" style={{ marginTop: 12, marginBottom: 6 }} />
        <VoiceField
          value={draft.what ?? ''}
          onChangeText={(v) => { setDraft({ ...draft, what: v }); setFormErr(null); }}
          invalid={formErr === 'what'}
          placeholder="Two drums arrived dented and they refused them"
          style={{ minHeight: 90 }}
        />
        {formErr === 'what' ? (
          <Text style={{ fontSize: 13, lineHeight: 18, color: C.danger, marginTop: 6 }}>Write what the shop said.</Text>
        ) : null}

        {/* Said HERE and not in a toast: this sheet is a Modal and the toast
            lives underneath it, so a failure raised through `notify` while it
            is open is a sentence nobody ever sees. */}
        {formErr === 'save' ? (
          <Text style={{ fontSize: 13, lineHeight: 18, color: C.danger, marginTop: 10 }}>
            That could not be saved on this phone. Nothing was sent. Try again.
          </Text>
        ) : null}

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
          <Btn label="Cancel" look="grey" height={56} onPress={() => setForm(null)} style={{ flex: 1 }} />
          {/* ONE COMPLAINT PER PRESS. `submitComplaint` holds the ref guard —
              see the note beside it. Written inline here, a second tap on a
              slow write logged two complaints and kept only the second. */}
          <Btn
            label={formSaving ? 'Saving…' : 'Save'}
            look={formSaving ? 'off' : 'navy'}
            height={56}
            disabled={formSaving}
            onPress={() => void submitComplaint()}
            style={{ flex: 1.4 }}
          />
        </View>
      </BottomSheet>

      {/* ---- sample request ---- */}
      <BottomSheet open={form === 'sample'} onClose={() => setForm(null)} scroll>
        <SheetHead icon="sample" title="Sample" right={c?.name ?? ''} />

        <FieldLabel text="Which product" style={{ marginTop: 14, marginBottom: 8 }} />
        <View style={{ gap: 6 }} accessibilityRole="radiogroup">
          {products.map((x) => (
            <Chip
              key={x.id}
              block
              label={x.name}
              sub={skuText(x.sku) ?? undefined}
              selected={draft.sku === x.id}
              onPress={() => { setDraft({ ...draft, sku: x.id, skuName: x.name }); setFormErr(null); }}
            />
          ))}
        </View>
        {formErr === 'sku' ? <Text style={{ fontSize: 13, lineHeight: 18, color: C.danger, marginTop: 6 }}>Pick the product they want to try.</Text> : null}

        {/* A REAL FIGURE, because the godown picks stock against it. This was
            `cans: 1` in the handler with no box on the sheet, so a trial of six
            cans was requested as one and the salesman found out when it
            arrived. Digits only — a pack size is a count, and a keyboard that
            offers letters invites "one". The stepper is the quick way; the
            number between its buttons is still typed into. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 }}>
          <Text style={[{ flex: 1, fontSize: 13, lineHeight: 18, color: C.ink }, weight(700)]}>How many cans</Text>
          <StepButton
            label="One can fewer"
            glyph="−"
            onPress={() => {
              const n = parseWhole(draft.cans ?? '1') ?? 1;
              setDraft({ ...draft, cans: String(Math.max(1, n - 1)) });
              setFormErr(null);
            }}
          />
          <TextInput
            value={draft.cans ?? '1'}
            onChangeText={(v) => { setDraft({ ...draft, cans: cleanWhole(v) }); setFormErr(null); }}
            keyboardType="number-pad"
            accessibilityLabel="How many cans"
            style={[{ width: 48, minHeight: 44, textAlign: 'center', fontSize: 22, color: C.ink, padding: 0 }, weight(800)]}
          />
          <StepButton
            label="One can more"
            glyph="+"
            onPress={() => {
              const n = parseWhole(draft.cans ?? '1') ?? 0;
              setDraft({ ...draft, cans: String(n + 1) });
              setFormErr(null);
            }}
          />
        </View>
        {wholeOnly(draft.cans ?? '1') ? (
          <Text style={{ fontSize: 13, lineHeight: 18, color: C.danger, marginTop: 6, textAlign: 'right' }}>Whole cans only.</Text>
        ) : null}
        {formErr === 'cans' ? (
          <Text style={{ fontSize: 13, lineHeight: 18, color: C.danger, marginTop: 6, textAlign: 'right' }}>How many cans?</Text>
        ) : null}

        <FieldLabel text="What they will use it on" style={{ marginTop: 12, marginBottom: 6 }} />
        {/* Prose, so it gets the microphone: this is spoken far better than it
            is typed, one-handed, standing in a shop. It is the sample's own
            "why he wants it" made specific — a trial nobody can judge is a can
            given away. */}
        <VoiceField
          value={draft.application ?? ''}
          onChangeText={(v) => { setDraft({ ...draft, application: v }); setFormErr(null); }}
          invalid={formErr === 'application'}
          placeholder="Spray booth, furniture polish, wooden doors"
          style={{ minHeight: 80 }}
        />
        {formErr === 'application' ? (
          <Text style={{ fontSize: 13, lineHeight: 18, color: C.danger, marginTop: 6 }}>
            What will they use it on? Without this, no one can judge the trial.
          </Text>
        ) : null}

        <FieldLabel text="Why a trial" style={{ marginTop: 12, marginBottom: 6 }} />
        {/* A CODE AND NOT A SENTENCE — the same rule the lost reason and the
            hold reason follow. A sentence cannot be counted, so "how many
            trials did we give away on a price comparison this quarter" is a
            grep over free text; the list is configuration, so the office can
            reword one without an APK nobody can recall. */}
        {reasons.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityRole="radiogroup">
            {reasons.map((o) => (
              <Chip
                key={o.code}
                label={o.label}
                selected={draft.reasonCode === o.code}
                onPress={() => { setDraft({ ...draft, reasonCode: o.code }); setFormErr(null); }}
              />
            ))}
          </View>
        ) : (
          /* Said out loud rather than drawn as an empty space. The list is
             compiled into this build as well as published, so the only way it
             is empty is an office that emptied it — and a heading with nothing
             under it reads as a broken screen rather than as a decision
             somebody made. */
          <Text style={{ fontSize: 13, lineHeight: 18, color: C.muted }}>
            No trial reasons are set up yet. Ask the office to add them.
          </Text>
        )}
        {formErr === 'reason' ? (
          <Text style={{ fontSize: 13, lineHeight: 18, color: C.danger, marginTop: 6 }}>
            Say why they want a trial. Your manager decides on this.
          </Text>
        ) : null}

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 }}>
          <Icon name="cal" size={18} color={C.primaryDeep} strokeWidth={2} />
          <Text style={[{ flex: 1, fontSize: 13, lineHeight: 18, color: C.ink }, weight(700)]}>Come back on</Text>
          <Pressable
            onPress={() => setCalOpen('trial')}
            accessibilityRole="button"
            accessibilityLabel={'Trial follow-up on ' + pretty(draft.trial ?? trialDefault) + ', change'}
            style={({ pressed }) => ({ minHeight: 44, paddingVertical: 8, paddingHorizontal: 16, borderRadius: 22, backgroundColor: C.navy, justifyContent: 'center', opacity: pressed ? 0.85 : 1 })}>
            {/* `trialDefault`, the day worked out when the screen opened, and not
                a fresh clock read — the date shown here and the one `submitSample`
                stores have to be the same day on a screen open across midnight. */}
            <Text style={[{ fontSize: 14, lineHeight: 20, color: '#FFFFFF' }, weight(700)]}>{pretty(draft.trial ?? trialDefault)}</Text>
          </Pressable>
        </View>

        <View style={{ marginTop: 8 }}>
          <Fact icon="shield" text="Samples need your manager’s approval. The trial follow-up is set for you." />
        </View>

        {formErr === 'save' ? (
          <Text style={{ fontSize: 13, lineHeight: 18, color: C.danger, marginTop: 10 }}>
            That could not be saved on this phone. Nothing was sent. Try again.
          </Text>
        ) : null}

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
          <Btn label="Cancel" look="grey" height={56} onPress={() => setForm(null)} style={{ flex: 1 }} />
          {/* ONE SAMPLE PER PRESS, the same guard as the complaint above. */}
          <Btn
            label={formSaving ? 'Sending…' : 'Send request'}
            look={formSaving ? 'off' : 'navy'}
            height={56}
            disabled={formSaving}
            onPress={() => void submitSample()}
            style={{ flex: 1.4 }}
          />
        </View>
      </BottomSheet>

      {/* ---- the date picker both of the above share ---- */}
      <BottomSheet open={!!calOpen} onClose={() => setCalOpen(null)}>
        <Text accessibilityRole="header" style={[{ fontSize: 20, lineHeight: 26, letterSpacing: -0.4, color: C.ink, marginBottom: 10 }, weight(800)]}>
          {calOpen === 'trial' ? 'Trial follow-up' : 'Next contact on'}
        </Text>
        <Calendar
          selected={calOpen === 'trial' ? draft.trial ?? trialDefault : nextDate}
          onPick={(iso) => {
            if (calOpen === 'trial') setDraft({ ...draft, trial: iso });
            else {
              set({ nextDate: iso });
              setNextDatePicked(true);
            }
            setCalOpen(null);
          }}
        />
      </BottomSheet>
    </AppFrame>
  );
}

/** A week out — long enough to have tried it, short enough to still remember. */
function defaultTrial(): string {
  return isoDate(new Date(Date.now() + 7 * 86_400_000));
}

/* ═══════════════════════════════════════════ the Version 3 pieces, local */

/** The amber we use for a warning line on navy, where `warnInk` cannot be read. */
const AMBER_ON_NAVY = '#FFC24A';

/**
 * A pill button in the colours this screen's artboards draw — navy for the
 * act, the canvas grey for the way out, the dashed lavender for "the pin is
 * wrong". Local because the shared `PillButton` has no grey or dashed look and
 * puts its style on the wrapper, where a fill cannot reach.
 */
function Btn({
  label,
  onPress,
  look = 'navy',
  height = 52,
  icon,
  disabled = false,
  a11y,
  hint,
  style,
}: {
  label: string;
  onPress: () => void;
  look?: 'navy' | 'grey' | 'dashed' | 'primary' | 'lime' | 'off';
  height?: number;
  icon?: IconName;
  disabled?: boolean;
  a11y?: string;
  hint?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const bg =
    look === 'navy' ? C.navy : look === 'primary' ? C.primary : look === 'lime' ? C.lime : look === 'dashed' ? '#F7F4FF' : look === 'off' ? C.line : C.wash;
  const fg =
    look === 'navy' || look === 'primary' ? '#FFFFFF' : look === 'lime' ? C.navy : look === 'dashed' ? C.primaryDeep : look === 'off' ? C.muted : C.ink;
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={a11y ?? label}
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      outerStyle={style}
      style={{
        minHeight: height,
        borderRadius: height / 2,
        backgroundColor: bg,
        borderWidth: look === 'dashed' ? 1.5 : 0,
        borderStyle: look === 'dashed' ? 'dashed' : 'solid',
        borderColor: '#B9A6FF',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingHorizontal: 16,
        opacity: disabled ? 0.7 : 1,
      }}>
      {icon ? <Icon name={icon} size={height >= 56 ? 20 : 18} color={look === 'navy' ? C.lime : fg} strokeWidth={2} /> : null}
      <Text style={[{ fontSize: height >= 60 ? 17 : height >= 52 ? 15 : 14, color: fg, textAlign: 'center' }, weight(700)]}>{label}</Text>
    </PressableScale>
  );
}

/** A small icon and a short fact beside it — "Checked against the shop". */
function Fact({ icon, text, color = C.muted }: { icon: IconName; text: string; color?: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
      <Icon name={icon} size={16} color={color} strokeWidth={2} />
      <Text style={{ fontSize: 13, lineHeight: 18, color, flexShrink: 1 }}>{text}</Text>
    </View>
  );
}

/** A white card at Version 3's radius, padding and no border. */
function Panel({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ backgroundColor: C.surface, borderRadius: 22, padding: 16 }, style]}>{children}</View>;
}

/** A card's own heading: an icon and the 15/800 title. */
function PanelTitle({ icon, text, right }: { icon?: IconName; text: string; right?: React.ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      {icon ? <Icon name={icon} size={18} color={C.primaryDeep} strokeWidth={2} /> : null}
      <Text accessibilityRole="header" style={[{ fontSize: 15, lineHeight: 21, color: C.ink, flex: 1, minWidth: 0 }, weight(800)]}>
        {text}
      </Text>
      {right}
    </View>
  );
}

/**
 * THE REFUSAL, said with its number. A distance is drawn big — it tells him
 * whether to walk twenty steps or whether the book has the shop in the wrong
 * town — with the radius it was measured against beside it. A missing or weak
 * reading has no distance to show, so it is said in words instead.
 */
function RefusalBox({ verdict, radiusM }: { verdict: CheckInVerdict; radiusM: number }) {
  const far = verdict.reason === 'too_far' && verdict.metresAway != null;
  return (
    <View
      accessible
      accessibilityLiveRegion="polite"
      style={{ marginTop: 14, backgroundColor: C.warnBg, borderRadius: 18, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
      {far ? (
        <View style={{ alignItems: 'center' }}>
          <Text style={[{ fontSize: 30, lineHeight: 32, letterSpacing: -0.6, color: C.warnInk }, weight(800)]}>
            {distanceLabel(verdict.metresAway) ?? Math.round(verdict.metresAway ?? 0) + ' m'}
          </Text>
          <Text style={[{ fontSize: 12, lineHeight: 17, color: C.warnInk }, weight(700)]}>{'need ≤ ' + radiusM + ' m'}</Text>
        </View>
      ) : (
        <Icon name="locate" size={24} color={C.warnInk} strokeWidth={2} />
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[{ fontSize: 13, lineHeight: 18, color: C.body }, weight(far ? 400 : 600)]}>{verdict.sentence}</Text>
        <Text style={{ fontSize: 13, lineHeight: 18, color: C.body, marginTop: 2 }}>
          {verdict.reason === 'too_far'
            ? 'Walk to the shop and press again. Nothing is saved yet.'
            : 'Nothing is saved yet.'}
        </Text>
      </View>
    </View>
  );
}

/**
 * The seven outcome tiles: four across, each a glyph over its word. Drawn by
 * hand rather than with `Choice` so they tick the way `Choice` would — the
 * press goes through `pickOutcome`, which buzzes only when the answer moves.
 */
function OutcomeGrid({
  value,
  onPick,
  compact = false,
}: {
  value: string | null;
  onPick: (k: (typeof OUTCOMES)[number]['k']) => void;
  compact?: boolean;
}) {
  return (
    <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: compact ? 6 : 8 }}>
      {OUTCOMES.map((o) => {
        const on = value === o.k;
        return (
          <Pressable
            key={o.k}
            onPress={() => onPick(o.k)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={o.label}
            style={({ pressed }) => ({
              width: '23%',
              flexGrow: 1,
              maxWidth: '24%',
              height: compact ? 60 : 76,
              borderRadius: compact ? 16 : 18,
              borderWidth: on ? 2 : 0,
              borderColor: C.primary,
              backgroundColor: on ? (compact ? C.navy : '#F7F4FF') : compact ? C.wash : C.surface,
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              paddingHorizontal: 4,
              opacity: pressed ? 0.85 : 1,
            })}>
            {compact ? null : (
              <Icon name={OUTCOME_ICON[o.k] ?? 'visit'} size={20} color={on ? C.primary : C.ink} strokeWidth={2} />
            )}
            <Text
              numberOfLines={2}
              style={[{ fontSize: compact ? 11 : 12, lineHeight: 14, textAlign: 'center', color: on && compact ? '#FFFFFF' : C.ink }, weight(700)]}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A selectable pill: navy when chosen, a tint (or the canvas grey) when not. */
function Chip({
  label,
  sub,
  selected,
  onPress,
  tint,
  block = false,
  style,
}: {
  label: string;
  sub?: string;
  selected: boolean;
  onPress: () => void;
  tint?: { bg: string; fg: string };
  /** A full-width rounded row rather than a pill — the product list. */
  block?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      onPress={() => {
        if (!selected) feedback('select');
        onPress();
      }}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={sub ? label + ', ' + sub : label}
      style={({ pressed }) => [
        {
          minHeight: block ? 44 : 36,
          paddingHorizontal: block ? 14 : 12,
          paddingVertical: block ? 10 : 0,
          borderRadius: block ? 16 : 18,
          justifyContent: 'center',
          alignItems: block ? 'flex-start' : 'center',
          backgroundColor: selected ? C.navy : tint?.bg ?? C.wash,
          opacity: pressed ? 0.85 : 1,
        },
        style,
      ]}>
      <Text style={[{ fontSize: block ? 14 : 13, color: selected ? '#FFFFFF' : tint?.fg ?? C.ink }, weight(700)]}>
        {label}
        {sub ? (
          <Text style={[{ fontSize: 12, color: selected ? C.onNavyMuted : C.muted }, weight(400)]}>{' · ' + sub}</Text>
        ) : null}
      </Text>
    </Pressable>
  );
}

/** A Version 3 sheet's heading: an icon, the 22/800 title, and what it is for. */
function SheetHead({ icon, title, sub, right }: { icon: IconName; title: string; sub?: string; right?: string }) {
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Icon name={icon} size={22} color={C.primaryDeep} strokeWidth={2} />
        <Text accessibilityRole="header" style={[{ fontSize: 22, lineHeight: 29, letterSpacing: -0.44, color: C.ink, flex: 1 }, weight(800)]}>
          {title}
        </Text>
        {right ? (
          <Text numberOfLines={1} style={{ fontSize: 13, color: C.muted, maxWidth: '50%' }}>
            {right}
          </Text>
        ) : null}
      </View>
      {sub ? <Text style={{ fontSize: 13, lineHeight: 18, color: C.muted, marginTop: 2 }}>{sub}</Text> : null}
    </View>
  );
}

/** A label above a field, 13/700 ink as the artboards set them. */
function FieldLabel({ text, style }: { text: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={style}>
      <Text style={[{ fontSize: 13, lineHeight: 18, color: C.ink }, weight(700)]}>{text}</Text>
    </View>
  );
}

/** The way past an unmet checklist — dashed, quiet, and always saying the cost. */
function SaveAsNotChecked({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Cannot do these? Save as not checked. Your manager sees your reason."
      style={({ pressed }) => ({
        width: '100%',
        minHeight: 48,
        marginTop: 6,
        borderWidth: 1.5,
        borderStyle: 'dashed',
        borderColor: C.line,
        borderRadius: 24,
        backgroundColor: C.surface,
        paddingVertical: 8,
        paddingHorizontal: 12,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.7 : 1,
      })}>
      <Text style={[{ fontSize: 13, lineHeight: 18, color: C.muted, textAlign: 'center' }, weight(600)]}>
        Can’t? Save as not checked. Your manager sees why.
      </Text>
    </Pressable>
  );
}

/** A 44 round − / + beside a count. */
function StepButton({ label, glyph, onPress }: { label: string; glyph: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={() => {
        feedback('select');
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 22, backgroundColor: pressed ? C.line : C.wash, alignItems: 'center', justifyContent: 'center' })}>
      <Text style={{ fontSize: 20, color: C.ink }}>{glyph}</Text>
    </Pressable>
  );
}

