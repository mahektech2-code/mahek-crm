import React from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Choice, ListCard, PrimaryButton, SecondaryButton, T } from '../src/components/ui/primitives';
import { VoiceField } from '../src/components/ui/dictate';
import { BottomSheet, Calendar } from '../src/components/ui/overlays';
import { Icon } from '../src/components/ui/Icon';
import { claimExpense, expenseTotals, expensesOn, listExpenses, type Expense } from '../src/data/requests';
import { getConfig } from '../src/data/config';
import { activePolicy, previewClaim, CLAIM_KINDS, type ClaimedLine, type LocalPolicy } from '../src/data/travel';
import type { ExpenseKind } from '../src/engines/generated/expense-policy';
import { takePhoto } from '../src/native/capture';
import { dmy, inr, isoDate } from '../src/lib/format';
import { useStore } from '../src/state/store';
import { useBoot } from '../src/state/boot';
import { color as C, radius, weight, tabular, type BadgeTone } from '../src/theme/tokens';

/**
 * Expenses — a claim, and the headroom it eats.
 *
 * The cap line is the design's own three sentences: what is left before he
 * types, what would be left after, and how far over he has gone. A claim that
 * needs the manager's indulgence says so while it can still be changed — and
 * it is still SENT. Exceeding a cap flags a claim; it never refuses one,
 * because the money is already spent and refusing to record it only means
 * nobody finds out.
 */

/* The rule under the Add button, built from the SAME configured number the
   calendar a few lines below it reads. It was a literal string carrying "30
   days", so an office that set 15 had two contradictory sentences on one
   screen — and he plans around the wrong one and the claim is refused. */
const exRule = (maxAgeDays: number) =>
  'Every claim needs a photograph of the bill or proof of payment. Claims older than ' +
  maxAgeDays +
  ' days are not accepted.';

/** How much of the history this screen mounts. See `listExpenses`. */
const EX_PAGE = 60;

type Draft = { kind: string; amt: string; note: string; when: string; whenIso: string; billMediaId: string | null; billLabel: string | null };

const EMPTY: Draft = { kind: '', amt: '', note: '', when: '', whenIso: '', billMediaId: null, billLabel: null };

/** The four things a claim has to carry, named the way he would say them. */
type FieldKey = 'amt' | 'bill' | 'when' | 'note';

const MISSING_WORDS: Record<FieldKey, string> = {
  amt: 'what you spent',
  bill: 'the bill',
  when: 'the day',
  note: 'what it was for',
};

export default function ExpensesScreen() {
  const back = useCameFrom('more');
  const notify = useStore((s) => s.notify);
  const boot = useBoot();

  const [rows, setRows] = React.useState<Expense[]>([]);
  /* What the capped list cannot say for itself: how many claims there are in
     all, and what is genuinely outstanding. Totalling the pending ones off
     `rows` would drop a claim that has sat with a manager for two months —
     the one most worth chasing — out of the headline as it aged past the
     window. */
  const [totals, setTotals] = React.useState<{ count: number; pendingPaise: number } | null>(null);
  /* What he is allowed comes from the POLICY, not from configuration.
     This screen used to read `mbos.expenses.categoryCapsPaise` and show a
     monthly headroom off it — a different number, from a different source,
     that the office does not pay on. Two answers to "what am I allowed" and
     the one he read here was the wrong one. */
  const [policy, setPolicy] = React.useState<LocalPolicy | null>(null);
  const [maxAgeDays, setMaxAgeDays] = React.useState(30);
  /* What is ALREADY on the day he is claiming for. The policy caps a day, not a
     claim, so a preview priced without these reports the whole cap however much
     of it has gone — and he finds out at approval. */
  const [dayLines, setDayLines] = React.useState<ClaimedLine[]>([]);

  const [open, setOpen] = React.useState(false);
  const [fixing, setFixing] = React.useState(false);
  /* The line he reopened, held so it can be left OUT of the day's total:
     correcting a ₹300 claim must not read as ₹300 already spent. */
  const [fixingId, setFixingId] = React.useState<string | null>(null);
  const [ex, setEx] = React.useState<Draft>(EMPTY);
  /* EVERY failing field, not the first one. See `send`. */
  const [err, setErr] = React.useState<FieldKey[]>([]);
  const [cal, setCal] = React.useState(false);

  const bad = (k: FieldKey) => err.includes(k);

  const load = React.useCallback(() => {
    let live = true;
    void Promise.all([
      listExpenses(EX_PAGE),
      expenseTotals(),
      activePolicy(),
      getConfig<number>('mbos.expenses.maxClaimAgeDays', 30),
    ]).then(([e, t, p, age]) => {
      if (!live) return;
      setRows(e);
      setTotals(t);
      setPolicy(p);
      setMaxAgeDays(age);
    });
    return () => {
      live = false;
    };
  }, []);

  useFocusEffect(load);

  const patch = (p: Partial<Draft>) => {
    setEx((d) => ({ ...d, ...p }));
    setErr([]);
  };

  const pending = totals?.pendingPaise ?? 0;

  const kinds = CLAIM_KINDS;
  const kind = ex.kind || kinds[0]!.key;
  const exAmtPaise = (parseInt(ex.amt.replace(/[^0-9]/g, ''), 10) || 0) * 100;

  /* The clock is read ONCE, in a state initialiser rather than during render —
     and it is what the sheet falls back to before he has picked a day. */
  const [todayIso] = React.useState(() => isoDate(new Date()));
  const claimDay = ex.whenIso || todayIso;

  /* Re-read on `rows` as well as on the day, because sending a claim reloads
     the list and the day it landed on now has one more line on it. */
  React.useEffect(() => {
    let live = true;
    void expensesOn(claimDay).then((l) => {
      if (live) setDayLines(l);
    });
    return () => {
      live = false;
    };
  }, [claimDay, rows]);

  /* `expensesOn` already leaves out refused claims, which is every line `fix`
     can reopen — but which states count towards a day is that function's rule
     to change, and this screen must not silently double-count the moment it
     widens. */
  const alreadyClaimed = React.useMemo(
    () => dayLines.filter((l) => l.id !== fixingId),
    [dayLines, fixingId],
  );

  /* The same engine the office prices the day with, run on the real day. A
     second reading of the rules here is how a salesman is told one figure and
     paid another.

     MEMOISED, because it was called in the component body and so re-ran on
     every keystroke in the NOTE field as well as the amount box, and while the
     sheet was shut — and where the chosen kind has no per-day cap its probe
     loop never converges, so each of those runs priced a stack of synthetic
     lines. Typing on a mid-range Android stuttered on a form he is filling in
     with a shop owner waiting. */
  const preview = React.useMemo(
    () =>
      previewClaim({
        policy,
        kind: kind as ExpenseKind,
        claimedPaise: exAmtPaise,
        hasBill: ex.billMediaId != null,
        day: claimDay,
        alreadyClaimed,
      }),
    [policy, kind, exAmtPaise, ex.billMediaId, claimDay, alreadyClaimed],
  );
  const exOver = preview.excessPaise > 0;
  const capLine = preview.line;

  const add = () => {
    setFixing(false);
    setFixingId(null);
    setErr([]);
    const today = new Date();
    setEx({ ...EMPTY, kind: kinds[0]!.key, when: dmy(isoDate(today)), whenIso: isoDate(today) });
    setOpen(true);
  };

  const fix = (x: Expense) => {
    setFixing(true);
    setFixingId(x.id);
    setErr([]);
    setEx({
      kind: x.category,
      amt: String(Math.round(x.amountPaise / 100)),
      note: x.remarks ?? '',
      when: dmy(x.spentOn),
      whenIso: x.spentOn,
      billMediaId: null,
      billLabel: null,
    });
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    setEx(EMPTY);
    setErr([]);
    setFixing(false);
    setFixingId(null);
    setCal(false);
  };

  /* The photograph is taken when the bill is in his hand, and queued straight
     away — the claim it belongs to does not exist yet and does not need to. */
  const attach = async (source: 'camera' | 'library') => {
    const shot = await takePhoto({ parentType: 'expense', parentId: 'pending', kind: 'bill_photo', source });
    if (!shot.ok) {
      if (shot.reason !== 'cancelled') notify(shot.reason);
      return;
    }
    patch({ billMediaId: shot.mediaId, billLabel: source === 'camera' ? 'Photo attached' : 'File attached' });
  };

  const send = async () => {
    /* EVERY failing field at once, and a summary above the button.
       Returning on the first one meant a claim missing both a bill and a note
       took press → fix → press → fix → press — and with the keyboard up the
       sheet's scroll area is barely half the screen, so the amount error at
       the top of it is off-screen from the button at the bottom and the press
       appeared to do nothing at all. `BottomSheet` owns its own ScrollView and
       hands out no ref, so the list of what is still missing goes where his
       thumb already is rather than the sheet scrolling to the first mark. */
    const missing: FieldKey[] = [];
    if (!exAmtPaise) missing.push('amt');
    if (!ex.billMediaId) missing.push('bill');
    if (!ex.whenIso.trim()) missing.push('when');
    if (!ex.note.trim()) missing.push('note');
    if (missing.length) return setErr(missing);

    const { overCap } = await claimExpense({
      userId: boot.session?.user.id ?? '',
      spentOn: ex.whenIso,
      category: kinds.find((k) => k.key === kind)?.category ?? 'other',
      kind,
      amountPaise: exAmtPaise,
      billPhotoId: ex.billMediaId,
      remarks: ex.note.trim(),
      /* Requirement 43 — asking for something outside policy takes a reason,
         and it is the note he has already written rather than a second box. */
      exceptionReason: exOver ? ex.note.trim() : null,
    });

    close();
    load();
    notify(
      overCap
        ? 'Claimed ' + inr(exAmtPaise / 100) + ' · over the cap, your manager has to allow it'
        : 'Claimed ' + inr(exAmtPaise / 100) + ' · with your manager',
    );
  };

  /* The two refusals the design writes out, so a greyed day always says why. */
  const oldestIso = React.useMemo(() => {
    const o = new Date();
    o.setDate(o.getDate() - maxAgeDays);
    return isoDate(o);
  }, [maxAgeDays]);
  const refuse = (iso: string) =>
    iso < oldestIso
      ? 'Older than ' + maxAgeDays + ' days — this cannot be claimed'
      : iso > todayIso
        ? 'That day has not happened yet'
        : null;

  return (
    <AppFrame title="MBOS" activeTab={null} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />
      <T s="h1">Expenses</T>
      <T s="small" style={{ color: C.muted, marginTop: 2 }}>
        {inr(pending / 100) + ' waiting on your manager'}
      </T>

      <PrimaryButton label="Add an expense" style={{ marginTop: 12, borderRadius: radius.xl }} onPress={add} />
      <T s="caption" style={{ marginTop: 10 }}>
        {exRule(maxAgeDays)}
      </T>

      <ListCard style={{ marginTop: 16 }}>
        {rows.map((e, i) => {
          const tone: BadgeTone = e.state === 'Approved' ? 'success' : e.state === 'Pending' ? 'amber' : 'danger';
          return (
            <View
              key={e.id}
              style={{ paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: i ? 1 : 0, borderTopColor: C.wash }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <T style={[{ flex: 1, minWidth: 0, fontSize: 15, lineHeight: 20, color: C.ink }, weight(500)]}>
                  {e.category + ' · ' + inr(e.amountPaise / 100)}
                </T>
                <Badge tone={tone}>{e.state}</Badge>
              </View>
              <T s="caption" style={{ marginTop: 3 }}>
                {dmy(e.spentOn) + ' · ' + (e.remarks ?? '')}
              </T>
              <T style={{ fontSize: 13, lineHeight: 19, color: e.billPhotoId ? C.muted : C.warn }}>
                {e.billPhotoId ? 'Bill attached' : 'No bill — may be rejected'}
              </T>
              {e.state === 'Rejected' ? (
                <>
                  {/* A rejection with no reason is NOT a missing bill. That
                      guess was printed in danger red, sometimes directly under
                      a row reading "Bill attached", and it sent him to
                      photograph a bill that was never the problem. */}
                  <T style={{ fontSize: 13, lineHeight: 19, color: C.danger, marginTop: 4 }}>
                    {e.rejectionReason ?? 'Sent back — your manager has not said why'}
                  </T>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => fix(e)}
                    style={{ minHeight: 48, justifyContent: 'center', marginTop: 2 }}>
                    <T style={[{ fontSize: 14, color: C.primary }, weight(600)]}>Correct it and send again</T>
                  </Pressable>
                </>
              ) : null}
            </View>
          );
        })}
      </ListCard>

      {/* A capped list says what it is a slice of — a screen showing sixty of
          seven hundred claims with nothing saying so is a screen that has lost
          the one he is looking for. */}
      {totals && totals.count > rows.length ? (
        <T s="caption" style={{ marginTop: 10 }}>
          {'The ' + rows.length + ' most recent of ' + totals.count + ' claims. The office holds them all.'}
        </T>
      ) : null}

      {/* ------------------------------------------------------ claim sheet */}
      <BottomSheet open={open} onClose={close} scroll>
        <T s="h2">{fixing ? 'Correct this claim' : 'Claim an expense'}</T>

        <View style={{ marginTop: 14 }}>
          <T s="label">What for</T>
          {/* WRAPPED, not four equal columns. At `flex: 1` inside a sheet
              padded 20 either side, each chip is about 74dp less 24dp of its
              own padding — some 50dp of text at 14px — and "Local transport"
              broke mid-word inside a 48dp chip. The travel screen has always
              done it this way. */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
            {kinds.map((k) => (
              <Choice
                key={k.key}
                label={k.label}
                selected={kind === k.key}
                onPress={() => patch({ kind: k.key })}
              />
            ))}
          </View>
        </View>

        <View style={{ marginTop: 14 }}>
          <T s="label" style={{ marginBottom: 6 }}>
            How much
          </T>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              height: 52,
              paddingHorizontal: 12,
              borderWidth: 1,
              borderColor: bad('amt') ? C.danger : C.border,
              borderRadius: radius.lg,
              backgroundColor: C.surface,
            }}>
            <T style={[{ fontSize: 18, color: C.muted }, weight(600)]}>₹</T>
            <TextInput
              value={ex.amt}
              onChangeText={(v) => patch({ amt: v.replace(/[^0-9]/g, '') })}
              keyboardType="number-pad"
              placeholder="0"
              placeholderTextColor={C.faint}
              style={[{ flex: 1, minWidth: 0, alignSelf: 'stretch', fontSize: 18, color: C.ink, padding: 0 }, weight(600), tabular]}
            />
          </View>
          {bad('amt') ? <T style={{ fontSize: 13, color: C.danger, marginTop: 6 }}>Enter what you spent.</T> : null}
          <T style={{ fontSize: 14, lineHeight: 20, marginTop: 6, color: exOver ? C.warnInk : C.muted }}>{capLine}</T>
        </View>

        <View style={{ marginTop: 14 }}>
          <T s="label" style={{ marginBottom: 6 }}>
            Bill
          </T>
          {ex.billLabel ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                minHeight: 52,
                paddingLeft: 14,
                paddingRight: 6,
                borderWidth: 1,
                borderColor: C.success,
                borderRadius: radius.lg,
                backgroundColor: C.successBg,
              }}>
              <Icon name="tick" size={16} color={C.success} strokeWidth={2.4} />
              <T style={[{ fontSize: 15, color: C.success }, weight(500)]}>{ex.billLabel}</T>
              <Pressable
                accessibilityRole="button"
                onPress={() => patch({ billMediaId: null, billLabel: null })}
                style={{ marginLeft: 'auto', minHeight: 48, minWidth: 48, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 10 }}>
                <T style={[{ fontSize: 14, color: C.primary }, weight(600)]}>Change</T>
              </Pressable>
            </View>
          ) : (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {[
                { glyph: 'camera', label: 'Photograph it', source: 'camera' as const },
                { glyph: 'clip', label: 'Upload a file', source: 'library' as const },
              ].map((b) => (
                <Pressable
                  key={b.label}
                  accessibilityRole="button"
                  onPress={() => attach(b.source)}
                  style={{
                    flex: 1,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    minHeight: 52,
                    borderWidth: 1,
                    borderStyle: 'dashed',
                    borderColor: bad('bill') ? C.danger : C.faint,
                    borderRadius: radius.lg,
                    backgroundColor: C.surface,
                  }}>
                  <Icon name={b.glyph} size={18} color={C.body} />
                  <T style={[{ fontSize: 15, color: C.body }, weight(500)]}>{b.label}</T>
                </Pressable>
              ))}
            </View>
          )}
          <T style={{ fontSize: 13, lineHeight: 19, marginTop: 6, color: bad('bill') ? C.danger : C.muted }}>
            Required on every claim — photo, PDF or a payment screenshot.
          </T>
          {bad('bill') ? (
            <T style={{ fontSize: 13, color: C.danger, marginTop: 6 }}>Attach the bill or proof of payment.</T>
          ) : null}
        </View>

        <View style={{ marginTop: 14 }}>
          <T s="label" style={{ marginBottom: 6 }}>
            When you spent it
          </T>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setErr([]);
              setCal(true);
            }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              width: '100%',
              minHeight: 52,
              paddingHorizontal: 14,
              borderWidth: 1,
              borderColor: bad('when') ? C.danger : cal ? C.primary : C.border,
              borderRadius: radius.lg,
              backgroundColor: C.surface,
            }}>
            <T style={{ fontSize: 16, color: ex.when ? C.ink : C.muted }}>{ex.when || 'Pick the day'}</T>
            <T style={{ fontSize: 18, color: C.muted }}>▾</T>
          </Pressable>
          {bad('when') ? (
            <T style={{ fontSize: 13, color: C.danger, marginTop: 6 }}>Pick the day you spent it.</T>
          ) : null}
        </View>

        <View style={{ marginTop: 14 }}>
          <T s="label" style={{ marginBottom: 6 }}>
            What it was for
          </T>
          <VoiceField
            value={ex.note}
            onChangeText={(v) => patch({ note: v })}
            invalid={bad('note')}
            placeholder="Nagpur – Kamptee – Nagpur, 84 km"
            style={{ minHeight: 72 }}
          />
          {bad('note') ? (
            <T style={{ fontSize: 13, color: C.danger, marginTop: 6 }}>
              Say what it was for — your manager approves on this.
            </T>
          ) : null}
        </View>

        {/* Everything still missing, beside the button that refused. The marks
            above are on the fields and the fields are off-screen behind the
            keyboard; this is the half he can actually read at the moment he
            presses. */}
        {err.length ? (
          <T style={{ fontSize: 13, lineHeight: 19, color: C.danger, marginTop: 16 }}>
            {'Still needed: ' + err.map((k) => MISSING_WORDS[k]).join(', ') + '.'}
          </T>
        ) : null}

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
          <SecondaryButton label="Cancel" onPress={close} style={{ flex: 1 }} />
          <PrimaryButton label={fixing ? 'Send it again' : 'Send the claim'} onPress={send} style={{ flex: 1 }} />
        </View>
      </BottomSheet>

      {/* --------------------------------------------------- when calendar */}
      <BottomSheet open={cal} onClose={() => setCal(false)}>
        <Calendar
          key={cal ? 'open' : 'shut'}
          selected={ex.whenIso}
          disabledReason={refuse}
          onPick={(iso) => {
            patch({ when: dmy(iso), whenIso: iso });
            setCal(false);
          }}
        />
        {/* BOTH refusals, because `Calendar` computes the sentence for a greyed
            day and never renders it — so the only place either rule can be read
            is here, and this line covered one of the two. */}
        <T s="caption" style={{ marginTop: 10 }}>
          {'Anything older than ' +
            maxAgeDays +
            ' days cannot be claimed, and neither can a day that has not happened yet.'}
        </T>
        <SecondaryButton label="Close" onPress={() => setCal(false)} style={{ minHeight: 48, height: 48, marginTop: 10 }} />
      </BottomSheet>
    </AppFrame>
  );
}
