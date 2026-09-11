import React from 'react';
import { View, Pressable } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, Choice, Input, PrimaryButton, SectionLabel, T } from '../src/components/ui/primitives';
import { Calendar } from '../src/components/ui/overlays';
import { Icon, type IconName } from '../src/components/ui/Icon';
import { color as C, radius, shadow, tabular, weight } from '../src/theme/tokens';
import { dmy, inr, isoDate, plural, pretty } from '../src/lib/format';
import { cashInHand, collectPayment, type PaymentMode } from '../src/data/payments';
import { customerBills, type Customer, type CustomerBill } from '../src/data/customers';
import { copyToClipboard, openWhatsApp, receiptMessage } from '../src/lib/messaging';
import { takePhoto } from '../src/native/capture';
import { useCustomer, useStore } from '../src/state/store';
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
 */

/* `IconName` rather than `string`: a glyph that is not in the map falls back to
   the three-dot "more" symbol without complaining, which is exactly how the
   ticked bill below came to draw an ellipsis. */
const MODES: { label: PaymentMode; glyph: IconName }[] = [
  { label: 'Cash', glyph: 'money' },
  { label: 'Cheque', glyph: 'note' },
  { label: 'UPI', glyph: 'spark' },
  { label: 'Bank transfer', glyph: 'route' },
];

const CHEQUE_PHOTO_LINE = 'Photograph the cheque before you hand it back.';

/**
 * How many bills are drawn before the rest are folded away.
 *
 * `customerBills` has no LIMIT, so every open bill for the shop sat between the
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
const CHEQUE_DATE_LINE = 'The date written on the cheque is needed.';

export default function PayScreen() {
  const back = useCameFrom('more');
  const c = useCustomer();
  const boot = useBoot();
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
  const [bills, setBills] = React.useState<CustomerBill[]>([]);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  /** One way: folding a ticked bill back out of sight is how a receipt gets
   *  named against something he can no longer see. */
  const [allBills, setAllBills] = React.useState(false);

  const userId = boot.session?.user.id ?? null;
  const customerId = c?.id ?? null;
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
      if (customerId) void customerBills(customerId).then((b) => live && setBills(b));
      return () => {
        live = false;
      };
    }, [userId, customerId]),
  );

  const amt = parseInt(payAmt || '0', 10);
  const needsCheque = payMode === 'Cheque';

  /*
   * The ticks that still match a bill on the list.
   *
   * Derived rather than stored, so a bill settled since the last pull — the
   * pull replaces this table wholesale — takes its own tick with it instead of
   * being sent to a server that would refuse the whole receipt with
   * `bill_settled`.
   */
  const chosen = bills.filter((b) => picked.has(b.id));

  /*
   * NEWEST FIRST, which is presentation and nothing else.
   *
   * `customerBills` reads them oldest first because that is the order the
   * automatic spread settles them in — and naming nothing still spreads oldest
   * first on the server, which the line under the list says. But the bill the
   * customer is actually paying against is the one he was just handed, and
   * oldest-first put it at the bottom of a list with no cap on it.
   */
  const newestFirst = React.useMemo(
    () => [...bills].sort((a, b) => (b.billDate ?? '').localeCompare(a.billDate ?? '')),
    [bills],
  );
  const shownBills = allBills ? newestFirst : newestFirst.slice(0, BILLS_SHOWN);

  const namedPaise = chosen.reduce((n, b) => n + (b.balancePaise ?? 0), 0);
  const onAccountPaise = Math.max(0, amt * 100 - namedPaise);
  /* A cheque with no number, no date and no photograph is a promise, not an
     instrument — all three are required before this one saves. The DATE is the
     one nobody was asked for: see `CHEQUE_DATE_LINE`. */
  const payOk =
    !!payMode &&
    amt > 0 &&
    (!needsCheque || (payChq.trim().length > 0 && !!chequeDate && !!chequePhotoId));

  const photographCheque = async () => {
    const shot = await takePhoto({ parentType: 'payment', parentId: 'pending', kind: 'cheque_photo' });
    if (!shot.ok) {
      if (shot.reason !== 'cancelled') notify(shot.reason);
      return;
    }
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
    if (busy) return notify('Still recording the last one…');
    if (!payMode) return notify('Pick how they are paying');
    if (!amt) return notify('Enter the amount');
    if (needsCheque && !payChq.trim()) return notify('Cheque number is needed');
    if (needsCheque && !chequeDate) return notify(CHEQUE_DATE_LINE);
    if (needsCheque && !chequePhotoId) return notify(CHEQUE_PHOTO_LINE);
    if (!c) return notify('Open a customer first');

    askConfirm({
      title: 'Take ' + inr(amt) + '?',
      body:
        `${inr(amt)} from ${c.name}, by ${payMode.toLowerCase()}` +
        (needsCheque ? ` — cheque ${payChq.trim()}, dated ${dmy(chequeDate)}` : '') +
        '. The receipt is written the moment you say yes, and nothing on this phone can edit it afterwards.',
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
    setBusy(true);
    let receiptRef: string;
    try {
      ({ receiptRef } = await collectPayment({
        customerId: cust.id,
        customerName: cust.name,
        userId: boot.session?.user.id ?? '',
        amountPaise: amt * 100,
        mode,
        chequeNumber: needsCheque ? payChq.trim() : null,
        /* The day written ACROSS the cheque, which is the only thing that says
           whether accounts can bank it this morning. `collectPayment` has taken
           it since it was written and no screen ever filled it. */
        chequeDate: needsCheque ? chequeDate : null,
        chequePhotoId: needsCheque ? chequePhotoId : null,
        /* Named bills, or nothing — in which case the server spreads it oldest
           first, exactly as it always has. */
        billRefs: chosen.length ? chosen.map((b) => b.id) : undefined,
      }));
    } finally {
      setBusy(false);
    }

    markVisitDone('payment', mode + ' · ' + inr(amt));

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
      amountRupees: inr(amt),
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

    /* Offered, never sent. Nothing goes out on the company's behalf, and the
       payment is not recorded as receipted until a human presses send. */
    askConfirm({
      title: 'Send the receipt?',
      body: phone
        ? `${inr(amt)} recorded for ${cust.name}. Your WhatsApp opens with the receipt written — you press send.`
        : `${inr(amt)} recorded for ${cust.name}. There is no number on this customer, so the receipt can only be copied.`,
      confirmLabel: phone ? 'Open WhatsApp' : 'Copy the receipt',
      run: async () => {
        const out = phone ? await openWhatsApp(phone, slip) : await copyToClipboard(slip);
        if (out.status !== 'handed_off') notify(out.reason);
      },
    });

    back.go();
  };

  const dues = c ? c.outstandingPaise / 100 : 0;

  return (
    <AppFrame title="Collect payment" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      <View
        style={{
          borderWidth: 1,
          borderColor: C.warnEdge,
          backgroundColor: C.warnBg,
          borderRadius: radius.card,
          padding: 16,
        }}>
        <T
          style={[
            { fontSize: 12, lineHeight: 16, letterSpacing: 0.48, textTransform: 'uppercase', color: C.warnInk },
            weight(500),
          ]}>
          Cash on you
        </T>
        {/* "₹0 · No cash on you" is a definite claim, and it was being made
            while `cashInHand` was still reading — so he took more cash without
            the reminder this card exists to give. Nothing is asserted until
            the read lands. */}
        <T style={[{ fontSize: 26, lineHeight: 32, letterSpacing: -0.65, color: C.ink, marginTop: 4 }, weight(600), tabular]}>
          {cash === null ? '—' : inr(cash.totalPaise / 100)}
        </T>
        <T style={{ fontSize: 15, color: C.warnInk, marginTop: 2 }}>
          {cash?.sentence ?? (cashFailed ? 'What you are carrying could not be read just now.' : 'Reading…')}
        </T>
      </View>

      <T style={{ fontSize: 15, color: C.body, marginTop: 16 }}>
        {c ? (dues ? 'They owe ' + inr(dues) : 'Nothing outstanding') : 'Open a customer first'}
      </T>

      {/*
        * WHICH BILLS, which is the question the outstanding figure above cannot
        * answer. Drawn only where there are bills to name: an empty list here
        * would read as "this shop has no invoices", which is a different fact
        * from "the office has not sent them down yet".
        */}
      {c && bills.length > 0 ? (
        <View style={{ marginTop: 16 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 12,
              marginBottom: 10,
            }}>
            <SectionLabel>What is this against</SectionLabel>
            <T s="caption">{plural(bills.length, 'open bill')}</T>
          </View>
          <View style={{ gap: 8 }}>
            {shownBills.map((b) => {
              const on = picked.has(b.id);
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
              return (
                <Pressable
                  key={b.id}
                  onPress={() =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (next.has(b.id)) next.delete(b.id);
                      else next.add(b.id);
                      return next;
                    })
                  }
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    borderRadius: radius.xl,
                    borderWidth: 1,
                    borderColor: on ? C.primary : C.hairline,
                    backgroundColor: on ? C.primaryTint : C.surface,
                    paddingVertical: 12,
                    paddingHorizontal: 14,
                  }}>
                  {/* `tick`, not `check` — there is no `check` in the glyph
                      map, and `Icon` falls back with `ICONS[name] ?? ICONS.dots`
                      without complaining, so the SELECTED state of a bill drew
                      the three-dot "more" glyph. Which bills the money is named
                      against is the one decision on this screen that changes
                      where the payment lands, and its affordance read as a
                      menu. */}
                  <Icon name={on ? 'tick' : 'note'} size={20} color={on ? C.primaryDeep : C.muted} />
                  <View style={{ flex: 1 }}>
                    <T style={[{ fontSize: 15, color: C.ink }, weight(on ? 600 : 500)]}>
                      {b.billNo ?? 'Bill'}
                    </T>
                    <T style={{ fontSize: 13, lineHeight: 18, color: overdue ? C.danger : C.muted, marginTop: 2 }}>
                      {b.billDate ? pretty(b.billDate) : 'No date'}
                      {overdue ? ` · ${b.overdueDays} days overdue` : ''}
                      {b.disputed ? ' · disputed' : ''}
                    </T>
                  </View>
                  {unstated ? (
                    <T style={{ fontSize: 13, color: C.muted, textAlign: 'right', maxWidth: 110 }}>
                      Not stated either way
                    </T>
                  ) : (
                    <T style={[{ fontSize: 15, color: C.ink }, weight(600), tabular]}>
                      {inr((b.balancePaise ?? 0) / 100)}
                    </T>
                  )}
                </Pressable>
              );
            })}
          </View>

          {!allBills && newestFirst.length > BILLS_SHOWN ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setAllBills(true)}
              hitSlop={8}
              style={{ paddingVertical: 12 }}>
              <T style={[{ fontSize: 15, color: C.primaryDeep }, weight(500)]}>
                {'Show the other ' + (newestFirst.length - BILLS_SHOWN)}
              </T>
            </Pressable>
          ) : null}

          {/* What naming nothing DOES, said rather than assumed — and what a
              remainder becomes, because money on account is a real outcome the
              salesman will be asked about. */}
          <T style={{ fontSize: 13, lineHeight: 18, color: C.muted, marginTop: 10 }}>
            {chosen.length === 0
              ? 'Name none and it goes against their oldest bills first.'
              : onAccountPaise > 0 && amt > 0
                ? `${chosen.length} named · ${inr(onAccountPaise / 100)} more than they cover, which sits on account.`
                : `${chosen.length} named.`}
          </T>
        </View>
      ) : null}

      <View style={{ marginTop: 16 }}>
        <SectionLabel style={{ marginBottom: 10 }}>How are they paying</SectionLabel>
        <View style={{ gap: 12 }}>
          {[MODES.slice(0, 2), MODES.slice(2)].map((row, ri) => (
            <View key={ri} style={{ flexDirection: 'row', gap: 12 }}>
              {row.map((m) => {
                const on = payMode === m.label;
                return (
                  <Pressable
                    key={m.label}
                    onPress={() => set({ payMode: m.label })}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    style={{
                      flex: 1,
                      minHeight: 72,
                      borderRadius: radius.xl,
                      borderWidth: 1,
                      borderColor: on ? C.primary : C.hairline,
                      backgroundColor: on ? C.primaryTint : C.surface,
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 6,
                      boxShadow: shadow.soft,
                    }}>
                    <Icon name={m.glyph} size={24} color={on ? C.primaryDeep : C.body} />
                    <T style={[{ fontSize: 15, color: on ? C.primaryDeep : C.ink }, weight(on ? 600 : 400)]}>
                      {m.label}
                    </T>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>
      </View>

      <Card style={{ marginTop: 16 }}>
        <SectionLabel style={{ marginBottom: 6 }}>Amount</SectionLabel>
        <Input
          value={payAmt}
          onChangeText={(v) => set({ payAmt: v.replace(/[^0-9]/g, '') })}
          placeholder="42500"
          keyboardType="number-pad"
          style={[{ borderRadius: radius.md, fontSize: 18 }, weight(600), tabular]}
        />
        {/* The digits read back as money, as he types them. An ungrouped string
            is where one extra zero hides: ₹42,500 and ₹4,25,000 are one
            keystroke apart and look alike in the box, and they do not look
            alike here. */}
        <T
          style={[
            { fontSize: 15, lineHeight: 20, marginTop: 8, color: amt > 0 ? C.ink : C.muted },
            weight(amt > 0 ? 600 : 400),
            tabular,
          ]}>
          {amt > 0 ? inr(amt) : 'Type what they handed over.'}
        </T>
        {needsCheque ? (
          <View style={{ marginTop: 16 }}>
            <SectionLabel style={{ marginBottom: 6 }}>Cheque number and bank</SectionLabel>
            <Input
              value={payChq}
              onChangeText={(v) => set({ payChq: v })}
              placeholder="448210 · HDFC"
              style={{ borderRadius: radius.md, fontSize: 15 }}
            />

            {/* THE DATE WRITTEN ACROSS IT, which nothing on this handset ever
                asked for — so every cheque reached the office looking bankable
                the day it was handed over, and a customer who had written next
                month's date got chased for money sitting in our own drawer. He
                is holding the cheque and can read it off the paper, which is
                why it is asked of everybody. */}
            <View style={{ marginTop: 16 }}>
              <SectionLabel style={{ marginBottom: 6 }}>Date on the cheque</SectionLabel>
              <Choice
                label={chequeDate ? dmy(chequeDate) : 'Pick the date'}
                selected={!!chequeDate}
                onPress={() => setPickingDate((v) => !v)}
                style={{ alignItems: 'flex-start', paddingHorizontal: 14, minHeight: 52 }}
              />
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
              {!chequeDate ? (
                <T s="caption" style={{ marginTop: 8 }}>
                  {CHEQUE_DATE_LINE}
                </T>
              ) : null}
            </View>

            {/* The design's own sentence, made the control that does it — the
                cheque leaves his hand in the next thirty seconds, so the
                instruction and the camera cannot be two separate things. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={CHEQUE_PHOTO_LINE}
              onPress={photographCheque}
              hitSlop={12}>
              <T s="caption" style={{ marginTop: 8, color: chequePhotoId ? C.success : undefined }}>
                {chequePhotoId ? 'Cheque photographed' : CHEQUE_PHOTO_LINE}
              </T>
            </Pressable>
          </View>
        ) : null}
      </Card>

      <PrimaryButton
        label={busy ? 'Recording it…' : 'Collect and make receipt'}
        onPress={collect}
        disabled={!payOk || busy}
        whyDisabled={
          busy
            ? 'The last one is still being recorded.'
            : needsCheque
              ? 'A cheque needs its number, the date written on it, and a photograph.'
              : 'Pick how they are paying and enter the amount first.'
        }
        style={{ marginTop: 16 }}
      />
      <View style={{ height: 8 }} />
    </AppFrame>
  );
}
