import React from 'react';
import { View, Pressable, Text, TextInput } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { T } from '../src/components/ui/primitives';
import { Disc } from '../src/components/ui/v3';
import { Calendar } from '../src/components/ui/overlays';
import { Icon, type IconName } from '../src/components/ui/Icon';
import { Presence, animateLayout, animateLayoutFor } from '../src/components/ui/motion';
import { feedback } from '../src/components/ui/feedback';
import { color as C, tabular, weight } from '../src/theme/tokens';
import { dmy, inrFromPaise, isoDate, plural, pretty } from '../src/lib/format';
import { cleanAmount, paiseFromTyped, typedFromPaise } from '../src/lib/money-input';
import { cashInHand, collectPayment, type PaymentMode } from '../src/data/payments';
import { FALLBACK_MODES, fieldModes } from '../src/engines/payment-modes';
import { getConfig } from '../src/data/config';
import {
  customersOwing,
  getCustomer,
  listCustomersPage,
  openCustomerBills,
  type Customer,
  type CustomerBill,
} from '../src/data/customers';
import { copyToClipboard, openWhatsApp, receiptMessage } from '../src/lib/messaging';
import { takePhoto } from '../src/native/capture';
import { useStore } from '../src/state/store';
import { useBoot } from '../src/state/boot';

/**
 * Collecting money.
 *
 * The amber card at the top is the reason this screen opens with something
 * other than a form: cash already collected today is the salesman's own
 * liability until it is deposited, and he should be reminded of it before he
 * takes more of it. The deadline on it is the oldest collection's, not an
 * average — a note from Monday that has been in his bag for five days is
 * exactly the one an average hides.
 *
 * What this screen records is money the CUSTOMER handed over. It is not money
 * the business has seen: outstanding does not move until accounts find it in
 * the bank, and nothing here pretends otherwise.
 *
 * WHICH BILLS IT IS AGAINST is asked here, and for a long time it could not be.
 * `collectPayment` has always taken `billRefs`, the server has always read
 * them as `billIds` and allocated in `settle` mode — and no screen ever filled
 * it, so every collection spread OLDEST FIRST however plainly the customer was
 * paying against the invoice in his hand. Naming nothing still spreads oldest
 * first, which is the right default and is now SAID rather than assumed.
 *
 * **IT IS THREE STEPS, IN THE ORDER THE COUNTER ASKS THEM.** Who is paying,
 * which of their unpaid bills, then how much and how. It used to be one form
 * over whichever customer the store last had open — so "Collect payment" from
 * the + button, opened on the Home screen, quietly took money against the last
 * shop he had looked at, with nothing on the screen asking whose it was. The
 * customer is now chosen here, unless he came from a visit, where it can only
 * be the shop he is standing in. The money questions appear only once there
 * is a customer and a bill to put them against.
 */

/* `IconName` rather than `string`: a glyph that is not in the map falls back to
   the three-dot "more" symbol without complaining, which is exactly how the
   ticked bill below came to draw an ellipsis. */
const GLYPHS: Record<string, IconName> = {
  Cash: 'money',
  Cheque: 'note',
  UPI: 'spark',
  'Bank transfer': 'route',
};

/**
 * THE MODES ARE THE OFFICE'S, read from `payments.modes` on the pull.
 *
 * They were four literals typed into this screen while accounts kept their own
 * list in configuration, so the two could only ever agree by accident — and a
 * mode accounts added was one no salesman could record. `fieldModes` drops
 * the two that are not money arriving (see `DESK_ONLY_MODES`) and falls back
 * to the old four when an older server sends nothing. A mode this screen has
 * no glyph for gets the cash one rather than the "more" ellipsis.
 */
function tilesFor(modes: string[]): { label: PaymentMode; glyph: IconName }[] {
  return modes.map((label) => ({ label, glyph: GLYPHS[label] ?? 'money' }));
}

const CHEQUE_PHOTO_LINE = 'Take a photo of the cheque before you give it back.';

/** Modes whose money arrives with a transaction id the bank statement shows. */
const TRANSFER_MODES: PaymentMode[] = ['UPI', 'Bank transfer'];

/**
 * How many bills are drawn before the rest are folded away.
 *
 * `openCustomerBills` has no LIMIT, so every open bill for the shop sat between the
 * outstanding line and the amount box: on an account with thirty of them that
 * is thirty rows to scroll past with money in his hand, and nothing on the
 * screen counting them.
 */
const BILLS_SHOWN = 5;
/**
 * A cheque has two dates and they answer different questions: the day it was
 * handed over, and the day written across it. A cheque given on the 3rd and
 * dated the 20th cannot be banked until the 20th however firmly it is in our
 * hands — so a post-dated one that reaches the office without its date looks
 * bankable this morning, and the customer gets chased for money sitting in our
 * own drawer. It is asked of everybody, because the man asking is holding the
 * cheque and can read it off the paper.
 */
const CHEQUE_DATE_LINE = 'Pick the date written on the cheque.';

/** How long a typed name waits before it becomes a query — the customers list's own pause. */
const SEARCH_PAUSE_MS = 250;

/** A step's number and name, so the three read as a sequence rather than three forms. */
function StepHead({ n, title, done, right }: { n: number; title: string; done: boolean; right?: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10, paddingHorizontal: 6 }}>
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={'Step ' + n + (done ? ', done' : '')}
        style={{
          width: 24,
          height: 24,
          borderRadius: 12,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: done ? C.primary : C.surface,
          borderWidth: done ? 0 : 1,
          borderColor: C.border,
        }}>
        {done ? (
          <Icon name="tick" size={14} color="#FFFFFF" strokeWidth={2.6} />
        ) : (
          <T style={[{ fontSize: 12, color: C.ink }, weight(800)]}>{String(n)}</T>
        )}
      </View>
      <T style={[{ flex: 1, fontSize: 15, lineHeight: 20, color: C.ink }, weight(800)]}>{title}</T>
      {right ? <T style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>{right}</T> : null}
    </View>
  );
}

export default function PayScreen() {
  const back = useCameFrom('more');
  const boot = useBoot();
  const storeCustId = useStore((s) => s.custId);
  /*
   * WHOSE MONEY. From a visit it can only be the shop he is in, and it is
   * locked. From a customer's own record it starts on that customer, and can be
   * changed. From anywhere else it starts on NOBODY — the store's customer is
   * whichever one he last looked at, which is not a fact about who is paying.
   */
  const lockedToVisit = back.from === 'visit';
  const [custId, setCustId] = React.useState<string | null>(() =>
    (back.from === 'visit' || back.from === 'customer') && storeCustId ? storeCustId : null,
  );
  const [c, setC] = React.useState<Customer | null>(null);
  React.useEffect(() => {
    let live = true;
    if (!custId) return;
    void getCustomer(custId).then((row) => {
      if (live) setC(row);
    });
    return () => {
      live = false;
    };
  }, [custId]);
  /* `c` can trail `custId` for a frame while the row loads; nothing below may
     act on a customer that is not the one chosen. */
  const current = c && c.id === custId ? c : null;

  /* The customer search: what he typed, and what has been asked. */
  const [typed, setTyped] = React.useState('');
  const [asked, setAsked] = React.useState('');
  React.useEffect(() => {
    const t = setTimeout(() => setAsked(typed.trim()), SEARCH_PAUSE_MS);
    return () => clearTimeout(t);
  }, [typed]);
  const [results, setResults] = React.useState<Customer[] | null>(null);
  React.useEffect(() => {
    let live = true;
    if (custId) return;
    const read = asked
      ? listCustomersPage({ query: asked, view: 'customers', limit: 20 }).then((p) => p.rows)
      : customersOwing(20);
    void read.then((rows) => {
      if (live) setResults(rows);
    });
    return () => {
      live = false;
    };
  }, [asked, custId]);
  const payMode = useStore((s) => s.payMode);
  const payAmt = useStore((s) => s.payAmt);
  const payChq = useStore((s) => s.payChq);
  const set = useStore((s) => s.set);
  const notify = useStore((s) => s.notify);
  const markVisitDone = useStore((s) => s.markVisitDone);
  const askConfirm = useStore((s) => s.askConfirm);

  /** Null means the read has not landed yet, which is NOT the same fact as
   *  "no cash on you" — see the card below. */
  const [cash, setCash] = React.useState<{ totalPaise: number; sentence: string; nextDeadline: number | null } | null>(null);
  const [cashFailed, setCashFailed] = React.useState(false);
  const [chequePhotoId, setChequePhotoId] = React.useState<string | null>(null);
  /** The date written ACROSS the cheque. Screen state rather than store state,
   *  like the photograph beside it: both belong to the instrument in his hand
   *  and neither should follow him to the next counter. */
  const [chequeDate, setChequeDate] = React.useState('');
  const [pickingDate, setPickingDate] = React.useState(false);
  /**
   * The write is in flight.
   *
   * `collectPayment` awaits two config reads, a transaction and an enqueue, and
   * every call takes a fresh `stamp()` id — so two taps are two different
   * payloads and the queue's idempotency key cannot dedupe them. One ₹42,500
   * transfer, credited twice, found weeks later by accounts.
   */
  const [busy, setBusy] = React.useState(false);
  /* The office's modes and which of them carry a date written on the
     instrument — both configuration, both read once per visit to the form. */
  const [modes, setModes] = React.useState<{ label: PaymentMode; glyph: IconName }[]>(() => tilesFor([...FALLBACK_MODES]));
  const [datedModes, setDatedModes] = React.useState<string[]>(['Cheque']);
  React.useEffect(() => {
    let live = true;
    void Promise.all([
      getConfig<unknown>('payments.modes', null),
      getConfig<unknown>('payments.datedModes', ['Cheque']),
    ])
      .then(([m, d]) => {
        if (!live) return;
        setModes(tilesFor(fieldModes(m)));
        if (Array.isArray(d)) setDatedModes(d.filter((x): x is string => typeof x === 'string'));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  /* The lock itself — `busy` above is only what the button is drawn from.
     The confirm's "Yes, take it" calls `write` from a closure drawn before
     `busy` moved, so a double tap there wrote two receipts. */
  const busyRef = React.useRef(false);
  /** The UTR on a transfer — what accounts find the money by in the statement. */
  const [utr, setUtr] = React.useState('');
  /* Null until this customer's bills have been read — "none" is a fact only once they have. */
  const [bills, setBills] = React.useState<CustomerBill[] | null>(null);
  /* He said this money is not against any particular bill — advance, or
     "just take it off what we owe". It still spreads oldest first. */
  const [noBill, setNoBill] = React.useState(false);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  /** One way: folding a ticked bill back out of sight is how a receipt gets
   *  named against something he can no longer see. */
  const [allBills, setAllBills] = React.useState(false);

  const userId = boot.session?.user.id ?? null;
  const customerId = custId;
  useFocusEffect(
    React.useCallback(() => {
      let live = true;
      if (!userId) return;
      setCashFailed(false);
      void cashInHand(userId)
        .then((p) => {
          if (live) setCash({ totalPaise: p.totalPaise, sentence: p.sentence, nextDeadline: p.nextDeadline });
        })
        /* A card that says "Reading…" for ever reads as a broken handset. */
        .catch(() => {
          if (live) setCashFailed(true);
        });
      /* The office's open bills for this shop. No reset of `picked` here — a
         tick against a bill that is no longer on the list simply does not
         match one, which `chosen` below works out on every render. Clearing
         state in an effect is what the React Compiler rules forbid. */
      /* OPEN ones only, and that is a read of its own now. The bills channel
         carries settled bills too since the customer record grew a statement,
         and a settled bill on this picker is one the salesman names, the server
         refuses with `bill_settled`, and the refusal reads as the app being
         wrong rather than the phone being stale. */
      if (customerId) void openCustomerBills(customerId).then((b) => live && setBills(b));
      return () => {
        live = false;
      };
    }, [userId, customerId]),
  );

  /* PAISE, from the box. It was `parseInt` of a digits-only box, so a bill
     owing ₹10,450.60 could only be collected as 10,451 — forty paise put "on
     account" as an advance nobody paid. See `lib/money-input.ts`. */
  const amtPaise = paiseFromTyped(payAmt);
  /* A dated mode is an INSTRUMENT — a cheque, or whatever accounts add beside
     it (`payments.datedModes`): it has a number, a date written across it
     and a face worth photographing, and all three are asked for together. */
  const needsCheque = !!payMode && datedModes.includes(payMode);
  const isTransfer = !!payMode && TRANSFER_MODES.includes(payMode as PaymentMode);

  /*
   * The ticks that still match a bill on the list.
   *
   * Derived rather than stored, so a bill settled since the last pull — the
   * pull replaces this table wholesale — takes its own tick with it instead of
   * being sent to a server that would refuse the whole receipt with
   * `bill_settled`.
   */
  const openBills = React.useMemo(() => bills ?? [], [bills]);
  const chosen = openBills.filter((b) => picked.has(b.id));

  /*
   * NEWEST FIRST, which is presentation and nothing else.
   *
   * `openCustomerBills` reads them oldest first because that is the order the
   * automatic spread settles them in — and naming nothing still spreads oldest
   * first on the server, which the line under the list says. But the bill the
   * customer is actually paying against is the one he was just handed, and
   * oldest-first put it at the bottom of a list with no cap on it.
   */
  const newestFirst = React.useMemo(
    () => [...openBills].sort((a, b) => (b.billDate ?? '').localeCompare(a.billDate ?? '')),
    [openBills],
  );
  const shownBills = allBills ? newestFirst : newestFirst.slice(0, BILLS_SHOWN);

  const namedPaise = chosen.reduce((n, b) => n + (b.balancePaise ?? 0), 0);

  /* Step 3 opens once there is somebody paying and something to pay against —
     a bill, an explicit "not against a bill", or a shop with no unpaid bills
     on this phone at all. */
  const billsAnswered = !!current && bills !== null && (chosen.length > 0 || noBill || openBills.length === 0);

  const chooseCustomer = (id: string | null) => {
    setCustId(id);
    if (!id) setC(null);
    setBills(null);
    setPicked(new Set());
    setNoBill(false);
    setAllBills(false);
    set({ payAmt: '' });
  };

  /* Ticking bills fills the amount with what they owe on them. He can still
     change it — a part payment is ordinary, and the remainder stays owed. */
  const toggleBill = (b: CustomerBill) => {
    /* A tick moves where the money lands, and the lines under the list move
       with it — the "Not against a particular bill" option leaves as the first
       bill is named, and the summary line changes length. Those move rather
       than jump, and the tick is felt as a choice. */
    feedback('select');
    animateLayout();
    const next = new Set(picked);
    if (next.has(b.id)) next.delete(b.id);
    else next.add(b.id);
    setPicked(next);
    setNoBill(false);
    const owed = openBills.filter((x) => next.has(x.id)).reduce((n, x) => n + (x.balancePaise ?? 0), 0);
    /* To the paisa. Rounded to the rupee, the difference went on account. */
    set({ payAmt: typedFromPaise(owed) });
  };
  const onAccountPaise = Math.max(0, amtPaise - namedPaise);
  /* A cheque with no number, no date and no photograph is a promise, not an
     instrument — all three are required before this one saves. The DATE is the
     one nobody was asked for: see `CHEQUE_DATE_LINE`. */
  const payOk =
    !!payMode &&
    amtPaise > 0 &&
    (!needsCheque || (payChq.trim().length > 0 && !!chequeDate && !!chequePhotoId));

  const photographCheque = async () => {
    const shot = await takePhoto({ parentType: 'payment', parentId: 'pending', kind: 'cheque_photo' });
    if (!shot.ok) {
      if (shot.reason !== 'cancelled') notify(shot.reason, 'error');
      return;
    }
    /* The cheque is going back across the counter in the next few seconds;
       the buzz says the photograph is in, without him looking down to check. */
    feedback('tap');
    setChequePhotoId(shot.mediaId);
  };

  /**
   * THE FIGURE IS READ BACK AS MONEY BEFORE ANY OF IT IS WRITTEN.
   *
   * The amount box is a digit string, and "425000" is one keystroke from
   * "42500" with nothing between them to see. This used to write the receipt,
   * the timeline event and the queue item first and quote `inr(amt)` back at
   * him afterwards, in a dialog about sending a WhatsApp — so by the time the
   * screen said ₹4,25,000 there was no edit and no cancel anywhere on the
   * handset. It asks the way `deposit()` on the collections screen asks, which
   * is the shape every other money decision here already has.
   */
  const collect = () => {
    /* `whyDisabled` keeps this button pressable so the handler can refuse in
       words, which means the in-flight lock has to be checked here as well as
       drawn on the button. */
    if (busyRef.current) return notify('Still saving the last payment…', 'info');
    if (!payMode) return notify('Pick how they are paying', 'error');
    if (!amtPaise) return notify('Enter the amount', 'error');
    if (needsCheque && !payChq.trim()) return notify('Cheque number is needed', 'error');
    if (needsCheque && !chequeDate) return notify(CHEQUE_DATE_LINE, 'error');
    if (needsCheque && !chequePhotoId) return notify(CHEQUE_PHOTO_LINE, 'error');
    const c = current;
    if (!c) return notify('Pick the shop first', 'error');

    askConfirm({
      title: 'Take ' + inrFromPaise(amtPaise) + '?',
      body:
        `${inrFromPaise(amtPaise)} from ${c.name}, by ${payMode.toLowerCase()}` +
        (needsCheque ? ` — cheque ${payChq.trim()}, dated ${dmy(chequeDate)}` : '') +
        '. The receipt is made when you say yes. You cannot change it later on this phone.',
      confirmLabel: 'Yes, take it',
      run: () => void write(payMode as PaymentMode, c),
    });
  };

  /**
   * The write, once he has said yes.
   *
   * The mode and the customer are handed in rather than read again: what is
   * recorded has to be what was quoted in the confirm. `busy` is the in-flight
   * lock — see the state it is declared beside.
   */
  const write = async (mode: PaymentMode, cust: Customer) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const amtNow = amtPaise;
    /* This visit's money, where it is — named on the receipt from the moment
       it is taken. See `Arrival.visitId`. */
    const visitNow = lockedToVisit ? useStore.getState().arrival : null;
    const visitId = visitNow && visitNow.customerId === cust.id ? visitNow.visitId ?? null : null;
    let receiptRef: string;
    let paymentId: string;
    try {
      ({ receiptRef, paymentId } = await collectPayment({
        customerId: cust.id,
        customerName: cust.name,
        userId: boot.session?.user.id ?? '',
        visitId,
        amountPaise: amtNow,
        mode,
        chequeNumber: needsCheque ? payChq.trim() : null,
        reference: isTransfer ? utr.trim() || null : null,
        /* "Not against a particular bill" is what an advance is. */
        isAdvance: noBill && chosen.length === 0,
        /* The day written ACROSS the cheque, which is the only thing that says
           whether accounts can bank it this morning. `collectPayment` has taken
           it since it was written and no screen ever filled it. */
        chequeDate: needsCheque ? chequeDate : null,
        chequePhotoId: needsCheque ? chequePhotoId : null,
        /* Named bills, or nothing — in which case the server spreads it oldest
           first, exactly as it always has. */
        billRefs: chosen.length ? chosen.map((b) => b.id) : undefined,
      }));
    } catch {
      busyRef.current = false;
      setBusy(false);
      notify('The payment could not be saved on this phone. Nothing was recorded. Try again.', 'error');
      return;
    }
    busyRef.current = false;
    setBusy(false);

    /* Only a visit's own payment marks the visit. Money taken for another shop
       from the + button is not something the visit in progress did. */
    if (lockedToVisit) {
      markVisitDone('payment', mode + ' · ' + inrFromPaise(amtNow));
      if (visitId) {
        const linked = useStore.getState().visitLinked;
        set({ visitLinked: { ...linked, paymentIds: [...(linked.paymentIds ?? []), paymentId] } });
      }
    }

    /*
     * The receipt is written HERE, on the handset, so it can be shown and sent
     * with no signal at all — the customer has just handed over money and
     * wants something for it now, not when the phone next finds a tower.
     *
     * The reference is marked provisional: the office issues the real receipt
     * number on sync, and printing a temporary one as though it were final is
     * how a payment ends up with two numbers against it.
     */
    const slip = receiptMessage({
      customerName: cust.name,
      amountRupees: inrFromPaise(amtNow),
      mode,
      reference: receiptRef,
      confirmed: false,
      collectedBy: boot.session?.user.name ?? 'your salesman',
      when: pretty(isoDate(new Date())),
      chequeNumber: needsCheque ? payChq.trim() : null,
    });

    const phone = cust.phone;
    set({ payAmt: '', payChq: '', payMode: null });
    setChequePhotoId(null);
    setChequeDate('');
    setPickingDate(false);
    setPicked(new Set());
    setUtr('');

    /* Offered, never sent. Nothing goes out on the company's behalf, and the
       payment is not recorded as receipted until a human presses send. */
    askConfirm({
      title: 'Send the receipt?',
      body: phone
        ? `${inrFromPaise(amtNow)} saved for ${cust.name}. WhatsApp will open with the receipt ready. You press send.`
        : `${inrFromPaise(amtNow)} saved for ${cust.name}. This shop has no number saved, so you can only copy the receipt.`,
      confirmLabel: phone ? 'Open WhatsApp' : 'Copy the receipt',
      run: async () => {
        const out = phone ? await openWhatsApp(phone, slip) : await copyToClipboard(slip);
        if (out.status !== 'handed_off') notify(out.reason, phone ? 'warn' : 'success');
      },
    });

    back.go();
  };

  /* Where the three steps have got to, for the bar in the hero: a step is lit
     once it is done or is the one he is on. */
  const stepsLit = !current ? 1 : !billsAnswered ? 2 : 3;
  const whyOff = busy
    ? 'The last one is still being recorded.'
    : needsCheque
      ? 'A cheque needs its number, the date written on it, and a photograph.'
      : 'Pick how they are paying and enter the amount first.';
  /* What a cheque still needs, said under its two buttons. */
  const chequeMissing = [!chequeDate ? CHEQUE_DATE_LINE : null, !chequePhotoId ? CHEQUE_PHOTO_LINE : null]
    .filter(Boolean)
    .join(' ');

  const cashCard =
    !custId ? (
      <View style={{ marginTop: 14, backgroundColor: C.navy, borderRadius: 22, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Disc icon="wallet" size={44} bg={C.limeOnNavy} ink={C.lime} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T style={{ fontSize: 12, lineHeight: 16, color: C.onNavyMuted }}>Cash on you</T>
          {/* "₹0 · No cash on you" is a definite claim, and it was being made
              while `cashInHand` was still reading — so he took more cash without
              the reminder this card exists to give. Nothing is asserted until
              the read lands. */}
          <T style={[{ fontSize: 26, lineHeight: 32, letterSpacing: -0.52, color: '#FFFFFF' }, weight(800), tabular]}>
            {cash === null ? '—' : inrFromPaise(cash.totalPaise)}
          </T>
          <T style={{ fontSize: 13, lineHeight: 18, color: '#FCE3A6' }}>
            {cash?.sentence ?? (cashFailed ? 'What you are carrying could not be read just now.' : 'Reading…')}
          </T>
        </View>
      </View>
    ) : (
      <View style={{ marginTop: 14, backgroundColor: C.surface, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Icon name="wallet" size={22} color={C.warnInk} strokeWidth={2} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T style={[{ fontSize: 20, lineHeight: 25, color: C.ink }, weight(800), tabular]}>
            {cash === null ? '—' : inrFromPaise(cash.totalPaise)}
          </T>
          <T style={{ fontSize: 12, lineHeight: 17, color: C.warnInk }}>
            {'Cash on you · ' +
              (cash?.sentence ?? (cashFailed ? 'What you are carrying could not be read just now.' : 'Reading…'))}
          </T>
        </View>
      </View>
    );

  return (
    <AppFrame
      title={custId ? 'Collect payment' : 'Collect from?'}
      activeTab={null}
      onBack={back.go}
      showTitle={!custId}
      heroTop={<StepBar lit={stepsLit} />}
      hero={
        !custId ? <T style={{ fontSize: 12, lineHeight: 16, color: C.muted, marginTop: 2 }}>Step 1 · Shop</T> : undefined
      }
      footer={
        billsAnswered ? (
          <View style={{ backgroundColor: C.canvas, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 12 }}>
            <CollectButton
              amount={amtPaise > 0 ? inrFromPaise(amtPaise) : null}
              busy={busy}
              disabled={!payOk || busy}
              whyDisabled={whyOff}
              onPress={collect}
            />
            {!payOk || busy ? (
              <T style={{ fontSize: 12, lineHeight: 16, color: C.muted, textAlign: 'center', marginTop: 6 }}>
                {busy ? 'Recording it…' : whyOff}
              </T>
            ) : null}
          </View>
        ) : undefined
      }
      contentStyle={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      {/* ------------------------------------------------ 1 · the customer */}
      {custId ? (
        <View style={{ backgroundColor: C.surface, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View
            accessible
            accessibilityRole="image"
            accessibilityLabel={current ? 'Step 1, shop, done' : 'Step 1, shop'}
            style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: current ? C.primary : C.wash, alignItems: 'center', justifyContent: 'center' }}>
            {current ? <Icon name="tick" size={16} color="#FFFFFF" strokeWidth={2.6} /> : <T style={[{ fontSize: 12, color: C.body }, weight(800)]}>1</T>}
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T numberOfLines={1} style={[{ fontSize: 16, lineHeight: 21, color: C.ink }, weight(800)]}>
              {current?.name ?? 'Reading…'}
            </T>
            {current ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 10 }}>
                {current.area || current.city ? (
                  <T style={{ fontSize: 12, lineHeight: 17, color: C.muted }}>{[current.area, current.city].filter(Boolean).join(', ')}</T>
                ) : null}
                <T
                  style={[
                    { fontSize: 12, lineHeight: 17, color: current.outstandingPaise > 0 ? C.danger : C.muted },
                    weight(current.outstandingPaise > 0 ? 700 : 400),
                    tabular,
                  ]}>
                  {current.outstandingPaise > 0 ? 'Owes ' + inrFromPaise(current.outstandingPaise) : 'Nothing outstanding'}
                </T>
              </View>
            ) : null}
          </View>
          {/* From a visit the customer is the shop he is standing in. */}
          {lockedToVisit ? (
            <View accessible accessibilityRole="image" accessibilityLabel="The shop of this visit, cannot be changed">
              <Icon name="lock" size={18} color={C.faint} strokeWidth={2} />
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Change the shop"
              onPress={() => chooseCustomer(null)}
              hitSlop={6}
              style={({ pressed }) => ({
                height: 36,
                paddingHorizontal: 12,
                borderRadius: 18,
                backgroundColor: C.primaryTint,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.85 : 1,
              })}>
              <T style={[{ fontSize: 12, color: C.primaryDeep }, weight(700)]}>Change</T>
            </Pressable>
          )}
        </View>
      ) : (
        <View>
          <View style={{ height: 48, borderRadius: 24, backgroundColor: C.surface, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16 }}>
            <Icon name="search" size={18} color={C.muted} strokeWidth={2} />
            <TextInput
              value={typed}
              onChangeText={setTyped}
              placeholder="Name, phone or city"
              placeholderTextColor={C.faint}
              accessibilityLabel="Search name, phone or city"
              style={[{ flex: 1, height: 44, fontSize: 15, color: C.ink, paddingVertical: 0 }, weight(400)]}
            />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12, marginBottom: 8, marginHorizontal: 6 }}>
            <Icon name={asked ? 'search' : 'money'} size={14} color={C.muted} strokeWidth={2.2} />
            <Text
              accessibilityLabel={asked ? 'Matching “' + asked + '”' : 'Shops that owe money, most first'}
              style={[{ flex: 1, fontSize: 12, lineHeight: 16, color: C.muted }, weight(700)]}>
              {asked ? 'Matching “' + asked + '”' : 'Owe money, most first'}
            </Text>
          </View>
          {(results ?? []).length ? (
            <View style={{ backgroundColor: C.surface, borderRadius: 22, paddingHorizontal: 16 }}>
              {(results ?? []).map((r, i) => (
                <Pressable
                  key={r.id}
                  accessibilityRole="button"
                  accessibilityLabel={r.name + ', ' + (r.outstandingPaise > 0 ? 'owes ' + inrFromPaise(r.outstandingPaise) : 'owes nothing')}
                  onPress={() => chooseCustomer(r.id)}
                  style={({ pressed }) => ({
                    minHeight: 60,
                    paddingVertical: 10,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                    borderTopWidth: i ? 1 : 0,
                    borderTopColor: C.hairline,
                    opacity: pressed ? 0.8 : 1,
                  })}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T numberOfLines={1} style={[{ fontSize: 15, lineHeight: 20, color: C.ink }, weight(700)]}>{r.name}</T>
                    <T numberOfLines={1} style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>
                      {[r.area, r.city].filter(Boolean).join(', ') || ' '}
                    </T>
                  </View>
                  {r.outstandingPaise > 0 ? (
                    <T style={[{ fontSize: 16, color: C.danger }, weight(800), tabular]}>{inrFromPaise(r.outstandingPaise)}</T>
                  ) : (
                    <T style={[{ fontSize: 14, color: C.faint }, weight(700)]}>Nil</T>
                  )}
                </Pressable>
              ))}
            </View>
          ) : null}
          {results !== null && results.length === 0 ? (
            <T style={{ fontSize: 14, lineHeight: 19, color: C.muted, paddingVertical: 8, paddingHorizontal: 6 }}>
              {asked ? 'No shop on your book matches that.' : 'Nobody on your book owes anything. Search for the shop by name.'}
            </T>
          ) : null}
        </View>
      )}

      {/* ------------------------------------------------ 2 · the bill */}
      {current ? (
        <View style={{ marginTop: 14 }}>
          <StepHead
            n={2}
            title="Which bill"
            done={billsAnswered}
            right={openBills.length > 0 ? plural(openBills.length, 'unpaid bill') + ' · newest first' : undefined}
          />
          {bills === null ? (
            <T style={{ fontSize: 14, color: C.muted, paddingHorizontal: 6 }}>Reading their bills…</T>
          ) : openBills.length === 0 ? (
            <T style={{ fontSize: 14, lineHeight: 20, color: C.body, paddingHorizontal: 6 }}>
              No unpaid bills for {current.name} on this phone. What you take goes on their account.
            </T>
          ) : null}
        </View>
      ) : null}

      {current && openBills.length > 0 ? (
        <View>
          <View style={{ backgroundColor: C.surface, borderRadius: 22, padding: 6 }}>
            {shownBills.map((b, i) => {
              const on = picked.has(b.id);
              const prevOn = i > 0 && picked.has(shownBills[i - 1].id);
              /*
               * An `unstated` bill is NOT a debt. Its balance is the full
               * amount purely because nobody has recorded anything against it
               * either way, and the office keeps it out of the outstanding
               * figure above — so it says so in words rather than printing a
               * number beside real balances. It can still be named: money
               * recorded against it is what makes somebody speak for it.
               */
              const unstated = b.paymentPosition === 'unstated';
              const overdue = (b.overdueDays ?? 0) > 0;
              const when =
                (b.billDate ? pretty(b.billDate) : 'No date') +
                (overdue ? ` · ${b.overdueDays} d overdue` : '') +
                (b.disputed ? ' · disputed' : '');
              return (
                <Pressable
                  key={b.id}
                  onPress={() => toggleBill(b)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={
                    (b.billNo ?? 'Bill') +
                    ', ' +
                    (b.billDate ? pretty(b.billDate) : 'no date') +
                    (overdue ? `, ${b.overdueDays} days overdue` : '') +
                    (b.disputed ? ', disputed' : '') +
                    ', ' +
                    (unstated ? 'no payment info yet' : inrFromPaise(b.balancePaise ?? 0))
                  }
                  style={{
                    minHeight: 56,
                    borderRadius: 16,
                    backgroundColor: on ? C.primaryTint : C.surface,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    marginTop: i && on ? 4 : 0,
                    borderTopWidth: i && !on && !prevOn ? 1 : 0,
                    borderTopColor: C.hairline,
                  }}>
                  {/* `tick`, not `check` — there is no `check` in the glyph
                      map, and `Icon` falls back with `ICONS[name] ?? ICONS.dots`
                      without complaining, so the SELECTED state of a bill drew
                      the three-dot "more" glyph. Which bills the money is named
                      against is the one decision on this screen that changes
                      where the payment lands, and its affordance read as a
                      menu. */}
                  <Tick on={on} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T style={[{ fontSize: 14, lineHeight: 19, color: C.ink }, weight(700)]}>{b.billNo ?? 'Bill'}</T>
                    <T
                      style={[
                        { fontSize: 12, lineHeight: 16, color: overdue ? C.danger : C.muted },
                        weight(overdue ? 700 : 400),
                      ]}>
                      {when}
                    </T>
                  </View>
                  {unstated ? (
                    <T style={{ fontSize: 12, lineHeight: 16, color: C.faint, textAlign: 'right', maxWidth: 96 }}>
                      No payment info yet
                    </T>
                  ) : (
                    <T style={[{ fontSize: 15, color: C.ink }, weight(800), tabular]}>{inrFromPaise(b.balancePaise ?? 0)}</T>
                  )}
                </Pressable>
              );
            })}

            {!allBills && newestFirst.length > BILLS_SHOWN ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  animateLayoutFor(newestFirst.length);
                  setAllBills(true);
                }}
                style={{ height: 44, alignItems: 'center', justifyContent: 'center' }}>
                <T style={[{ fontSize: 14, color: C.primaryDeep }, weight(700)]}>
                  {'Show the other ' + (newestFirst.length - BILLS_SHOWN)}
                </T>
              </Pressable>
            ) : null}

            {chosen.length === 0 ? (
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: noBill }}
                accessibilityLabel="Not against a particular bill"
                accessibilityHint="It goes against their oldest bills first, and anything over sits on account."
                onPress={() => {
                  feedback('select');
                  animateLayout();
                  setNoBill((v) => !v);
                }}
                style={{
                  marginTop: 4,
                  minHeight: 52,
                  borderRadius: 16,
                  backgroundColor: noBill ? C.primaryTint : C.surface,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                }}>
                <Tick on={noBill} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T style={[{ fontSize: 14, lineHeight: 19, color: noBill ? C.primaryDeep : C.ink }, weight(700)]}>
                    Not against a bill
                  </T>
                  <Presence show={noBill}>
                    <T style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>Oldest bills first; any extra on account.</T>
                  </Presence>
                </View>
              </Pressable>
            ) : null}
          </View>

          {/* What naming nothing DOES, said rather than assumed — and what a
              remainder becomes, because money on account is a real outcome the
              salesman will be asked about. */}
          <T style={{ fontSize: 13, lineHeight: 18, color: C.muted, marginTop: 10, paddingHorizontal: 6 }}>
            {chosen.length === 0 ? (
              noBill ? null : 'Pick the bill they are paying.'
            ) : (
              <>
                <T style={[{ fontSize: 13, color: C.ink }, weight(700)]}>{chosen.length + ' picked'}</T>
                {onAccountPaise > 0 && amtPaise > 0 ? ` · ${inrFromPaise(onAccountPaise)} extra kept as advance on the account.` : '.'}
              </>
            )}
          </T>
        </View>
      ) : null}

      {/* ------------------------------------------------ 3 · the money */}
      {/* Step 3 opens under step 2 once the bill question is answered — the
          form growing a step, rather than a block of fields landing at once. */}
      <Presence show={billsAnswered} distance={8}>
      {billsAnswered ? (
        <View>
          <View style={{ marginTop: 16 }}>
            <StepHead n={3} title="Payment · how?" done={false} />
          </View>
          <View accessibilityRole="radiogroup" accessibilityLabel="How are they paying" style={{ gap: 8 }}>
            {chunk(modes, 4).map((row, ri) => (
              <View key={ri} style={{ flexDirection: 'row', gap: 8 }}>
                {row.map((m) => {
                  const on = payMode === m.label;
                  return (
                    <Pressable
                      key={m.label}
                      onPress={() => {
                        /* These tiles are hand-drawn rather than `Choice`, so
                           they tick here; picking the one already picked is
                           not a choice moving. */
                        if (!on) feedback('select');
                        set({ payMode: m.label });
                      }}
                      accessibilityRole="radio"
                      accessibilityLabel={m.label}
                      accessibilityState={{ selected: on }}
                      style={{
                        flex: 1,
                        height: 76,
                        borderRadius: 20,
                        borderWidth: on ? 2 : 0,
                        borderColor: C.primary,
                        backgroundColor: on ? '#F7F4FF' : C.surface,
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6,
                        paddingHorizontal: 4,
                      }}>
                      <Icon name={m.glyph} size={22} color={on ? C.primaryDeep : C.ink} strokeWidth={2} />
                      <T numberOfLines={1} style={[{ fontSize: 12, color: on ? C.primaryDeep : C.ink }, weight(700)]}>
                        {SHORT_MODE[m.label] ?? m.label}
                      </T>
                    </Pressable>
                  );
                })}
                {/* A short last row keeps the tiles their width. */}
                {Array.from({ length: 4 - row.length }).map((_, k) => (
                  <View key={'gap' + k} style={{ flex: 1 }} />
                ))}
              </View>
            ))}
          </View>

          <View style={{ marginTop: 10, backgroundColor: C.surface, borderRadius: 22, padding: 16 }}>
            <FieldTitle>Amount</FieldTitle>
            <TextInput
              value={payAmt}
              onChangeText={(v) => set({ payAmt: cleanAmount(v) })}
              placeholder="42500"
              placeholderTextColor={C.faint}
              keyboardType="decimal-pad"
              accessibilityLabel="Amount"
              style={[
                { marginTop: 6, height: 56, borderRadius: 16, backgroundColor: C.canvas, paddingHorizontal: 14, fontSize: 24, color: C.ink },
                weight(800),
                tabular,
              ]}
            />
            {/* The digits read back as money, as he types them. An ungrouped string
                is where one extra zero hides: ₹42,500 and ₹4,25,000 are one
                keystroke apart and look alike in the box, and they do not look
                alike here. */}
            <T
              style={[
                { fontSize: amtPaise > 0 ? 15 : 13, lineHeight: 20, marginTop: 6, color: amtPaise > 0 ? C.ink : C.muted },
                weight(amtPaise > 0 ? 800 : 400),
                tabular,
              ]}>
              {amtPaise > 0 ? inrFromPaise(amtPaise) : 'Type what they handed over.'}
            </T>
            {/* THE UTR, asked and never demanded. It is the string accounts
                match against the bank statement, and a transfer recorded
                without it is money somebody has to go looking for — but he
                rarely has it, and refusing the save over it would lose the
                receipt rather than improve it. */}
            <Presence show={isTransfer}>
            {isTransfer ? (
              <View style={{ marginTop: 14 }}>
                <FieldTitle>
                  UTR <T style={[{ fontSize: 12, color: C.faint }, weight(500)]}>· if they have it</T>
                </FieldTitle>
                <TextInput
                  value={utr}
                  onChangeText={setUtr}
                  placeholder="From their payment message"
                  placeholderTextColor={C.faint}
                  autoCapitalize="characters"
                  accessibilityLabel="Transaction ID (UTR) · if they have it"
                  style={[boxInput, weight(600)]}
                />
              </View>
            ) : null}
            </Presence>
            {/* A cheque needs three more answers, and they open under the
                amount when Cheque is picked — and fold away if he changes his
                mind — rather than the form jumping by three fields. */}
            <Presence show={needsCheque}>
            {needsCheque ? (
              <View style={{ marginTop: 14 }}>
                <FieldTitle>Cheque no. and bank</FieldTitle>
                <TextInput
                  value={payChq}
                  onChangeText={(v) => set({ payChq: v })}
                  placeholder="448210 · HDFC"
                  placeholderTextColor={C.faint}
                  accessibilityLabel="Cheque number and bank"
                  style={[boxInput, weight(600)]}
                />

                {/* THE DATE WRITTEN ACROSS IT, which nothing on this handset ever
                    asked for — so every cheque reached the office looking bankable
                    the day it was handed over, and a customer who had written next
                    month's date got chased for money sitting in our own drawer. He
                    is holding the cheque and can read it off the paper, which is
                    why it is asked of everybody.

                    And the PHOTOGRAPH beside it: the design's own sentence, made
                    the control that does it — the cheque leaves his hand in the
                    next thirty seconds, so the instruction and the camera cannot
                    be two separate things. */}
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                  <DashedPill
                    icon="cal"
                    label={chequeDate ? dmy(chequeDate) : 'Date on it'}
                    a11y={chequeDate ? 'Date on the cheque, ' + dmy(chequeDate) : 'Date on the cheque. Pick the date'}
                    done={!!chequeDate}
                    onPress={() => setPickingDate((v) => !v)}
                  />
                  <DashedPill
                    icon="camera"
                    label={chequePhotoId ? 'Photographed' : 'Photo'}
                    a11y={chequePhotoId ? 'Cheque photographed' : CHEQUE_PHOTO_LINE}
                    done={!!chequePhotoId}
                    onPress={photographCheque}
                  />
                </View>
                <Presence show={pickingDate}>
                {pickingDate ? (
                  <View style={{ marginTop: 10 }}>
                    {/* Neither bounded: a cheque handed over today can be dated
                        last week or next month, and both are ordinary. */}
                    <Calendar
                      selected={chequeDate}
                      onPick={(iso) => {
                        setChequeDate(iso);
                        setPickingDate(false);
                      }}
                    />
                  </View>
                ) : null}
                </Presence>
                {chequeMissing ? (
                  <T style={{ fontSize: 12, lineHeight: 17, color: C.muted, marginTop: 8 }}>{chequeMissing}</T>
                ) : (
                  <T style={[{ fontSize: 12, lineHeight: 17, color: C.success, marginTop: 8 }, weight(700)]}>
                    Cheque photographed
                  </T>
                )}
              </View>
            ) : null}
            </Presence>
          </View>
        </View>
      ) : null}
      </Presence>

      {/* What he is already carrying, so he is reminded before he takes more. */}
      {cashCard}
      <View style={{ height: 8 }} />
    </AppFrame>
  );
}

/* ------------------------------------------------------------------ parts */

/** A shorter word for a tile a quarter of the screen wide. */
const SHORT_MODE: Record<string, string> = { 'Bank transfer': 'Bank' };

/** The office's modes, four to a row. */
function chunk<X>(xs: X[], n: number): X[][] {
  const out: X[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

const boxInput = {
  marginTop: 6,
  height: 48,
  borderRadius: 16,
  backgroundColor: C.canvas,
  paddingHorizontal: 14,
  fontSize: 15,
  color: C.ink,
} as const;

/** The 12/700 label over a box inside the amount card. */
function FieldTitle({ children }: { children: React.ReactNode }) {
  return <T style={[{ fontSize: 12, lineHeight: 16, color: C.muted }, weight(700)]}>{children}</T>;
}

/** The square tick a bill is picked with. */
function Tick({ on }: { on: boolean }) {
  return (
    <View
      style={{
        width: 24,
        height: 24,
        borderRadius: 7,
        backgroundColor: on ? C.primary : 'transparent',
        borderWidth: on ? 0 : 2,
        borderColor: '#C7D0DE',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
      {on ? <Icon name="tick" size={14} color="#FFFFFF" strokeWidth={2.8} /> : null}
    </View>
  );
}

/** The cheque's two dashed buttons — its date and its photograph. */
function DashedPill({
  icon,
  label,
  a11y,
  done,
  onPress,
}: {
  icon: IconName;
  label: string;
  a11y: string;
  done: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      style={({ pressed }) => ({
        flex: 1,
        height: 52,
        borderRadius: 26,
        borderWidth: 1.5,
        borderStyle: done ? 'solid' : 'dashed',
        borderColor: done ? C.success : '#B9A6FF',
        backgroundColor: done ? C.successBg : '#F7F4FF',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        opacity: pressed ? 0.85 : 1,
      })}>
      <Icon name={done ? 'tick' : icon} size={16} color={done ? C.success : C.primaryDeep} strokeWidth={2.2} />
      <T numberOfLines={1} style={[{ fontSize: 14, color: done ? C.success : C.primaryDeep }, weight(700)]}>
        {label}
      </T>
    </Pressable>
  );
}

/**
 * The one button, pinned. Off it stays pressable while there is a reason, so
 * `collect` refuses in words — `PrimaryButton`'s `whyDisabled` contract.
 */
function CollectButton({
  amount,
  busy,
  disabled,
  whyDisabled,
  onPress,
}: {
  amount: string | null;
  busy: boolean;
  disabled: boolean;
  whyDisabled: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={() => {
        if (disabled) feedback('warning');
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={busy ? 'Recording it…' : 'Collect' + (amount ? ' ' + amount : '') + ' and make receipt'}
      accessibilityState={{ disabled, busy }}
      accessibilityHint={disabled ? whyDisabled : undefined}
      style={({ pressed }) => ({
        height: 60,
        borderRadius: 30,
        backgroundColor: disabled ? 'rgba(15,27,51,0.45)' : C.navy,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        paddingHorizontal: 18,
        opacity: pressed && !disabled ? 0.88 : 1,
      })}>
      <T numberOfLines={1} style={[{ flexShrink: 1, fontSize: 17, color: '#FFFFFF' }, weight(700)]}>
        {busy ? 'Recording it…' : 'Collect' + (amount ? ' ' + amount : '')}
      </T>
      {busy ? null : (
        <View style={{ height: 28, paddingHorizontal: 10, borderRadius: 14, backgroundColor: C.lime, alignItems: 'center', justifyContent: 'center' }}>
          <T style={[{ fontSize: 13, color: C.navy }, weight(700)]}>Receipt</T>
        </View>
      )}
    </Pressable>
  );
}

/** The three steps as a bar across the hero, lit up to where he is. */
function StepBar({ lit }: { lit: number }) {
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={'Step ' + lit + ' of 3'}
      style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 4 }}>
      {[1, 2, 3].map((i) => (
        <View key={i} style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: i <= lit ? C.primary : C.primaryEdge }} />
      ))}
    </View>
  );
}
