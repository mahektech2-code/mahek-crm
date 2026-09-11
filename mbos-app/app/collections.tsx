import React from 'react';
import { Pressable, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, ListCard, T } from '../src/components/ui/primitives';
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
 * confirms it on the statement. A bounce puts the amount back on the customer,
 * which is the one thing here that changes a balance — so it asks first, and
 * `markBounced` refuses to run twice.
 */

/** What the row is doing, in one word, and how to draw it. */
function stateOf(p: CollectedPayment): { label: string; tone: BadgeTone } {
  if (p.bounced) return { label: 'Bounced', tone: 'danger' };
  if (p.deposited) return { label: 'Banked', tone: 'success' };
  if (p.mode === 'Cash') return { label: 'On you', tone: 'amber' };
  /* A cheque is an instrument with somebody's name on it and a transfer was in
     the company's account before he left the shop. Neither is money he is
     carrying, so neither is chased — but a cheque can still come back. */
  return { label: 'Sent', tone: 'neutral' };
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

  const load = React.useCallback(() => {
    let live = true;
    if (!userId) return;
    void Promise.all([listPayments(), cashInHand(userId)]).then(([p, c]) => {
      if (!live) return;
      setNowMs(Date.now());
      setRows(p);
      setCash({ totalPaise: c.totalPaise, sentence: c.sentence });
    });
    return () => {
      live = false;
    };
  }, [userId]);

  useFocusEffect(load);

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
  const deposit = (p: CollectedPayment) => {
    askConfirm({
      title: 'Banked ' + inrFromPaise(p.amountPaise) + '?',
      body:
        'This says you have paid it in. The office still checks it against the bank statement — ' +
        'you are recording your half of it, not closing it.',
      confirmLabel: 'Yes, I banked it',
      run: () => {
        void (async () => {
          setBusy(p.id);
          try {
            const shot = await takePhoto({
              parentType: 'payment',
              parentId: p.id,
              kind: 'deposit_proof',
              source: 'camera',
            });
            const proofId = shot.ok ? shot.mediaId : null;
            await markDeposited([p.id], proofId);
            load();
            notify(
              proofId
                ? 'Banked · slip attached'
                : 'Banked · no slip attached, so the office has only your word for it',
            );
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
        inrFromPaise(p.amountPaise) +
        ' goes back onto ' +
        (p.customerName ?? 'the customer') +
        ", and you get a task to ring them. They believe they have already paid, so this is a call worth preparing for.",
      reasonLabel: 'What the bank said · required',
      confirmLabel: 'Yes, it bounced',
      run: (reason) => {
        void (async () => {
          setBusy(p.id);
          try {
            await markBounced(p.id, reason);
            load();
            notify('Recorded · ' + inrFromPaise(p.amountPaise) + ' is back on their account');
          } finally {
            setBusy(null);
          }
        })();
      },
    });
  };

  const today = isoDate(new Date(nowMs));

  return (
    <AppFrame title="MBOS" activeTab={null} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />
      <T s="h1">Money you collected</T>
      <T s="small" style={{ color: C.muted, marginTop: 2 }}>
        What you wrote down at the counter. The office confirms it against the bank separately.
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
        <T style={[{ fontSize: 26, lineHeight: 32, color: C.ink, marginTop: 2 }, weight(600), tabular]}>
          {inrFromPaise(cash?.totalPaise ?? 0)}
        </T>
        <T s="small" style={{ color: cash?.totalPaise ? C.warnInk : C.muted, marginTop: 2 }}>
          {cash?.sentence ?? 'Reading…'}
        </T>
      </Card>

      {rows === null ? (
        <T s="small" style={{ color: C.muted, marginTop: 16 }}>
          Reading…
        </T>
      ) : rows.length === 0 ? (
        <Card style={{ marginTop: 16, paddingVertical: 28 }}>
          <T style={{ fontSize: 15, lineHeight: 22, color: C.ink, textAlign: 'center' }}>
            You have not collected anything yet.
          </T>
          <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 6 }}>
            Money you take shows up here, and this is where you say you have banked it.
          </T>
        </Card>
      ) : (
        <ListCard style={{ marginTop: 16 }}>
          {rows.map((p, i) => {
            const state = stateOf(p);
            const late = !p.deposited && !p.bounced && p.depositSlaDueAt != null && p.depositSlaDueAt <= nowMs;
            /* Only a cheque can bounce, and only one that has not already. */
            const canBounce = p.mode === 'Cheque' && !p.bounced;
            const canDeposit = !p.deposited && !p.bounced && p.mode === 'Cash';

            return (
              <View
                key={p.id}
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
                    p.chequeNumber ? 'no. ' + p.chequeNumber : null,
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

                {late ? (
                  <T style={{ fontSize: 13, lineHeight: 19, color: C.danger, marginTop: 4 }}>
                    Past the deposit deadline — bank it today.
                  </T>
                ) : null}

                {p.bounced ? (
                  <T style={{ fontSize: 13, lineHeight: 19, color: C.danger, marginTop: 4 }}>
                    Came back{p.bouncedAt ? ' on ' + dmy(isoDate(new Date(p.bouncedAt))) : ''} · the amount is back on
                    their account
                  </T>
                ) : null}

                {p.deposited ? (
                  <T style={{ fontSize: 13, lineHeight: 19, color: C.muted, marginTop: 4 }}>
                    Banked{p.depositedAt ? ' on ' + dmy(isoDate(new Date(p.depositedAt))) : ''} · the office checks the
                    statement
                  </T>
                ) : null}

                {canDeposit || canBounce ? (
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                    {canDeposit ? (
                      <Pressable
                        accessibilityRole="button"
                        disabled={busy === p.id}
                        onPress={() => deposit(p)}
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
                        <T style={[{ fontSize: 14, color: C.primaryDeep }, weight(500)]}>I banked it</T>
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
              </View>
            );
          })}
        </ListCard>
      )}

      <T s="caption" style={{ marginTop: 12 }}>
        {'Showing what you have collected, newest first, as at ' + dmy(today) + '.'}
      </T>
    </AppFrame>
  );
}
