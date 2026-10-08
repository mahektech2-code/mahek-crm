import React from 'react';
import { Pressable, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, ListCard, PrimaryButton, T } from '../src/components/ui/primitives';
import { Icon } from '../src/components/ui/Icon';
import {
  cashInHand,
  listPayments,
  markBounced,
  markDeposited,
  type CollectedPayment,
} from '../src/data/payments';
import { takePhoto } from '../src/native/capture';
import { dmy, inrFromPaise, isoDate } from '../src/lib/format';
import { useStore } from '../src/state/store';
import { useBoot } from '../src/state/boot';
import { color as C, radius, tabular, weight, type BadgeTone } from '../src/theme/tokens';
import { CountUp, Stagger, animateLayoutFor } from '../src/components/ui/motion';

/**
 * What he has collected, and the two things he can say about it afterwards.
 *
 * **THE MONEY WENT ONE WAY AND NEVER CAME BACK.** `collectPayment` has always
 * written the receipt and sent it; `markDeposited` and `markBounced` have
 * always existed, both complete, both talking to a server that validates and
 * records them — and nothing on any screen has ever called either one. So a
 * salesman could take cash and never say he had banked it, and take a cheque
 * and never say it had bounced. Cash in hand could only ever grow.
 *
 * The reason there was no button is that there was no LIST to put one on. The
 * customer record's Payments tab reads `customer_payments`, which is the
 * office's copy — what accounts have confirmed against a bank statement. This
 * reads `payments`, which is what he wrote down at the counter. The two are
 * meant to be able to differ, and a screen that showed only the office's copy
 * is a screen where he can never act on his own.
 *
 * NEITHER ACTION MOVES THE LEDGER. A deposit is the salesman's half of a
 * two-step: he says he banked it with a slip to prove it, and the back office
 * confirms it on the statement. A bounce tells the office and raises the call
 * to make; it does not touch what the shop owes, because a field receipt never
 * reduced that in the first place — see `markBounced`.
 */

/**
 * The office would not take it. Not money he is carrying and not money the
 * office has: the receipt never landed, so it has to be taken again — and it
 * says so here rather than sitting under "On you" for ever.
 */
function refused(p: CollectedPayment): boolean {
  return p.syncState === 'rejected' || p.syncState === 'blocked';
}

/** What the row is doing, in one word, and how to draw it. */
function stateOf(p: CollectedPayment): { label: string; tone: BadgeTone } {
  if (refused(p)) return { label: 'Not accepted', tone: 'danger' };
  if (p.bounced) return { label: 'Bounced', tone: 'danger' };
  if (p.deposited) return { label: p.mode === 'Cheque' ? 'Handed in' : 'Banked', tone: 'success' };
  if (p.mode === 'Cash') return { label: 'On you', tone: 'amber' };
  /* A cheque is paper in his bag until he hands it in or banks it — "Sent"
     said it had gone somewhere. A transfer was in the company's account
     before he left the shop. */
  if (p.mode === 'Cheque') return { label: 'With you', tone: 'neutral' };
  return { label: 'Paid to bank', tone: 'neutral' };
}

export default function CollectionsScreen() {
  const back = useCameFrom('more');
  const notify = useStore((s) => s.notify);
  const askConfirm = useStore((s) => s.askConfirm);
  const boot = useBoot();
  const userId = boot.session?.user.id ?? null;

  const [rows, setRows] = React.useState<CollectedPayment[] | null>(null);
  const [cash, setCash] = React.useState<{ totalPaise: number; sentence: string } | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  /**
   * ONE reading of the clock per load, rather than one per render.
   *
   * `Date.now()` in the component body is impure and the React Compiler rules
   * forbid it — and the consequence here was real rather than theoretical: the
   * "past the deposit deadline" line was decided at whatever moment React
   * happened to re-render, so it could flip on an unrelated state change and
   * never flip on its own. Taken with the rows, the deadline line and the "as
   * at" date below cannot disagree about what time it is either.
   */
  const [nowMs, setNowMs] = React.useState(() => Date.now());

  /* `animate` after banking or a bounce: the row grows a line and loses its
     buttons, and the rows under it should slide rather than jump. */
  const load = React.useCallback((animate?: boolean) => {
    let live = true;
    if (!userId) return;
    void Promise.all([listPayments(), cashInHand(userId)]).then(([p, c]) => {
      if (!live) return;
      if (animate === true) animateLayoutFor(p.length);
      setNowMs(Date.now());
      setRows(p);
      setCash({ totalPaise: c.totalPaise, sentence: c.sentence });
    });
    return () => {
      live = false;
    };
  }, [userId]);

  useFocusEffect(React.useCallback(() => load(), [load]));

  /**
   * Banking it, with the slip.
   *
   * The photograph is asked for and NOT required, which is the ordinary rule
   * here rather than an exception to it: a deposit slip is a picture OF
   * something, and the record — he says he banked it, the office checks the
   * statement — stands without it. The two photographs this app does insist on
   * are the attendance selfie and the odometer, and both are insisted on
   * because they ARE the record rather than evidence attached to one.
   *
   * Refusing the mark over a cancelled camera would leave him carrying money
   * on every screen in the app because a permission dialog went the wrong way.
   */
  /*
   * ONE SLIP FOR MANY ROWS, because that is how cash is banked.
   *
   * A day's cash goes in on one deposit slip, and the screen offered a button
   * per collection with a slip photograph each — five photographs of the same
   * slip, or four rows left "On you" because he gave up. `markDeposited` has
   * always taken a list. A cheque handed to the office is the same act for a
   * cheque: it leaves his bag, and the label says which.
   */
  const deposit = (ps: CollectedPayment[]) => {
    if (!ps.length) return;
    const total = ps.reduce((n, p) => n + p.amountPaise, 0);
    const cheque = ps.every((p) => p.mode === 'Cheque');
    askConfirm({
      title: cheque
        ? 'Handed in the cheque for ' + inrFromPaise(total) + '?'
        : 'Banked ' + inrFromPaise(total) + (ps.length > 1 ? ' on one slip?' : '?'),
      body: cheque
        ? 'This says the cheque has left you — banked, or given to the office. The office still checks it with the bank.'
        : 'This says you have put it in the bank. Take a photo of the slip next. The office will still check it with the bank.',
      confirmLabel: cheque ? 'Yes, handed in' : 'Yes, I banked it',
      run: () => {
        void (async () => {
          setBusy(ps[0].id);
          try {
            const shot = await takePhoto({
              parentType: 'payment',
              parentId: ps[0].id,
              kind: 'deposit_proof',
              source: 'camera',
            });
            const proofId = shot.ok ? shot.mediaId : null;
            await markDeposited(ps.map((p) => p.id), proofId);
            load(true);
            notify(
              proofId
                ? (cheque ? 'Handed in' : 'Banked') + ' · slip photo added'
                : (cheque ? 'Handed in' : 'Banked') + ' · no slip photo. The office has only your word.',
              proofId ? 'success' : 'warn',
            );
          } catch {
            notify('That could not be saved on this phone. Try again.', 'error');
          } finally {
            setBusy(null);
          }
        })();
      },
    });
  };

  /**
   * A cheque that came back.
   *
   * The only thing on this screen that moves a number: the amount goes back
   * onto the customer's outstanding, a High task is raised to ring them, and
   * everybody involved is told. That is why it asks first — and why it asks
   * for a REASON, which is what the salesman will be reading out when he makes
   * that call.
   */
  const bounce = (p: CollectedPayment) => {
    askConfirm({
      title: 'Did this cheque bounce?',
      body:
        'The office is told, and you get a task to call ' +
        (p.customerName ?? 'the shop') +
        '. They think they have paid, so be ready for that call.',
      reasonLabel: 'What the bank said · needed',
      confirmLabel: 'Yes, it bounced',
      run: (reason) => {
        void (async () => {
          setBusy(p.id);
          try {
            await markBounced(p.id, reason);
            load(true);
            notify('Saved · the office is told, and a call is on your tasks');
          } catch {
            notify('That could not be saved on this phone. Try again.', 'error');
          } finally {
            setBusy(null);
          }
        })();
      },
    });
  };

  const today = isoDate(new Date(nowMs));
  /* The cash he can bank in one go — the rows the per-row button would have
     banked one slip at a time. */
  const cashOnHim = (rows ?? []).filter(
    (p) => p.mode === 'Cash' && !p.deposited && !p.bounced && !refused(p),
  );

  return (
    <AppFrame title="Money you collected" activeTab={null} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />
      <T s="h1">Money you collected</T>
      <T s="small" style={{ color: C.muted, marginTop: 2 }}>
        What you noted at the shop. The office will check it with the bank.
      </T>

      {/* ---- what he is carrying ----

          Cash only, and it says so. Cheques and transfers are on the list
          below and are deliberately not in this figure: the engine behind it
          exists to keep them out, and until now the number it produced counted
          every mode alike. */}
      <Card
        style={{
          marginTop: 14,
          borderLeftWidth: 3,
          borderLeftColor: cash?.totalPaise ? C.warn : C.border,
        }}>
        <T s="label">Cash on you</T>
        {/* Mounted only once the figure is read, so opening the screen shows
            it standing still; banking cash then counts it DOWN, which is the
            moment the number is actually news. */}
        {cash ? (
          <CountUp
            value={cash.totalPaise}
            format={(n) => inrFromPaise(Math.round(n))}
            style={[{ fontSize: 26, lineHeight: 32, color: C.ink, marginTop: 2 }, weight(600), tabular]}
          />
        ) : (
          <T style={[{ fontSize: 26, lineHeight: 32, color: C.ink, marginTop: 2 }, weight(600), tabular]}>
            {inrFromPaise(0)}
          </T>
        )}
        <T s="small" style={{ color: cash?.totalPaise ? C.warnInk : C.muted, marginTop: 2 }}>
          {cash?.sentence ?? 'Loading…'}
        </T>
        {cashOnHim.length > 1 ? (
          <PrimaryButton
            label={'Bank all ' + cashOnHim.length + ' on one slip'}
            onPress={() => deposit(cashOnHim)}
            disabled={busy != null}
            whyDisabled="Still saving the last one."
            style={{ marginTop: 12 }}
          />
        ) : null}
      </Card>

      {rows === null ? (
        <T s="small" style={{ color: C.muted, marginTop: 16 }}>
          Loading…
        </T>
      ) : rows.length === 0 ? (
        <Card style={{ marginTop: 16, paddingVertical: 28 }}>
          <T style={{ fontSize: 15, lineHeight: 22, color: C.ink, textAlign: 'center' }}>
            You have not collected anything yet.
          </T>
          <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 6 }}>
            Money you collect shows here. Mark it here when you bank it.
          </T>
        </Card>
      ) : (
        <ListCard style={{ marginTop: 16 }}>
          {rows.map((p, i) => {
            const state = stateOf(p);
            const late = !p.deposited && !p.bounced && p.depositSlaDueAt != null && p.depositSlaDueAt <= nowMs;
            /* Only a cheque can bounce, and only one that has not already. */
            const no = refused(p);
            const canBounce = p.mode === 'Cheque' && !p.bounced && !no;
            const canDeposit = !p.deposited && !p.bounced && !no && (p.mode === 'Cash' || p.mode === 'Cheque');

            return (
              <Stagger
                key={p.id}
                index={i}
                style={{ paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: i ? 1 : 0, borderTopColor: C.wash }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <T
                    numberOfLines={1}
                    style={[{ flex: 1, minWidth: 0, fontSize: 15, lineHeight: 20, color: C.ink }, weight(500)]}>
                    {p.customerName ?? 'Unknown customer'}
                  </T>
                  <T style={[{ fontSize: 15, color: C.ink }, weight(600), tabular]}>
                    {inrFromPaise(p.amountPaise)}
                  </T>
                  <Badge tone={state.tone}>{state.label}</Badge>
                </View>

                <T s="caption" style={{ marginTop: 3 }}>
                  {[
                    p.mode,
                    dmy(isoDate(new Date(p.collectedAt))),
                    p.chequeNumber ? (p.mode === 'Cheque' ? 'no. ' : 'ref ') + p.chequeNumber : null,
                    /* The date written ACROSS a cheque, which decides when it
                       can be banked at all — not the day it was handed over. */
                    p.chequeDate ? 'dated ' + dmy(p.chequeDate) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </T>

                {/* The receipt he read out to the customer. It is provisional
                    until the office issues the real one, and saying so here is
                    cheaper than being asked. */}
                <T s="caption">
                  {p.localReceiptRef}
                  {p.syncState === 'queued' ? ' · not sent yet' : ''}
                </T>

                {no ? (
                  <Pressable accessibilityRole="button" onPress={() => router.push('/rejections?from=collections')}>
                    <T style={{ fontSize: 13, lineHeight: 19, color: C.danger, marginTop: 4 }}>
                      {(p.syncMessage ?? 'The office did not accept this receipt.') +
                        ' It is not counted as collected. Open Not accepted to take it again.'}
                    </T>
                  </Pressable>
                ) : null}

                {late && !no ? (
                  <T style={{ fontSize: 13, lineHeight: 19, color: C.danger, marginTop: 4 }}>
                    Bank deadline is over. Bank it today.
                  </T>
                ) : null}

                {p.bounced ? (
                  <T style={{ fontSize: 13, lineHeight: 19, color: C.danger, marginTop: 4 }}>
                    Bounced{p.bouncedAt ? ' on ' + dmy(isoDate(new Date(p.bouncedAt))) : ''} · the office is told
                  </T>
                ) : null}

                {p.deposited ? (
                  <T style={{ fontSize: 13, lineHeight: 19, color: C.muted, marginTop: 4 }}>
                    {p.mode === 'Cheque' ? 'Handed in' : 'Banked'}
                    {p.depositedAt ? ' on ' + dmy(isoDate(new Date(p.depositedAt))) : ''} · the office will check it
                    with the bank
                  </T>
                ) : null}

                {canDeposit || canBounce ? (
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                    {canDeposit ? (
                      <Pressable
                        accessibilityRole="button"
                        disabled={busy === p.id}
                        onPress={() => deposit([p])}
                        style={({ pressed }) => ({
                          flexDirection: 'row',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 6,
                          flex: 1,
                          minHeight: 48,
                          borderRadius: radius.sm,
                          borderWidth: 1,
                          borderColor: C.primary,
                          backgroundColor: pressed ? C.wash : C.primaryTint,
                          opacity: busy === p.id ? 0.6 : 1,
                        })}>
                        <Icon name="camera" size={17} color={C.primaryDeep} />
                        <T style={[{ fontSize: 14, color: C.primaryDeep }, weight(500)]}>
                          {p.mode === 'Cheque' ? 'I handed it in' : 'I banked it'}
                        </T>
                      </Pressable>
                    ) : null}

                    {canBounce ? (
                      <Pressable
                        accessibilityRole="button"
                        disabled={busy === p.id}
                        onPress={() => bounce(p)}
                        style={({ pressed }) => ({
                          alignItems: 'center',
                          justifyContent: 'center',
                          flex: 1,
                          minHeight: 48,
                          borderRadius: radius.sm,
                          borderWidth: 1,
                          borderColor: C.border,
                          backgroundColor: pressed ? C.wash : C.surface,
                          opacity: busy === p.id ? 0.6 : 1,
                        })}>
                        <T style={[{ fontSize: 14, color: C.body }, weight(500)]}>It bounced</T>
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}
              </Stagger>
            );
          })}
        </ListCard>
      )}

      <T s="caption" style={{ marginTop: 12 }}>
        {'Your collections, newest first, as on ' + dmy(today) + '.'}
      </T>
    </AppFrame>
  );
}
