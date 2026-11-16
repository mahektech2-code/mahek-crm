import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { AppFrame, useCameFrom } from '../src/components/shell/AppFrame';
import { HERO } from '../src/components/shell/Chrome';
import { feedback } from '../src/components/ui/feedback';
import { LeadActionCard } from '../src/components/leads/lead-action-card';
import {
  LEAD_ACTION_VIEWS,
  VIEW_TEXT,
  countLeads,
  dayOf,
  parked,
  rowsFor,
  type LeadActionCounts,
  type LeadActionView,
} from '../src/engines/lead-worklist';
import { color as C, weight } from '../src/theme/tokens';
import { listLeads, type Lead } from '../src/data/leads';
import { daysSince } from '../src/data/customers';
import { currentSession } from '../src/data/session';
import { lastPullAt } from '../src/sync/api';
import { HOLD_REASONS, labelOf } from '../src/engines/funnel';
import { dmy, isoDate, plural } from '../src/lib/format';
import { Stagger, animateLayoutFor } from '../src/components/ui/motion';

/**
 * §24 on a phone — the four questions a salesman's morning is made of.
 *
 * What is owed today, what is late, what is parked and due back, and what has
 * nothing promised on it at all. The office has four screens for these; this
 * is ONE screen with four views, and the reason is the width of a handset: a
 * bottom tab per question would spend a quarter of the app's navigation on one
 * module, and four separate routes would mean four back journeys to answer a
 * question that is really one question asked four ways. The chips carry their
 * counts, so the shape of the morning is legible before anything is tapped.
 *
 * A VIEW IS IN THE URL (`?view=overdue`), like the office's. That is what lets
 * Home's stat row open the right list rather than the first one and then make
 * somebody tap again — and it is what makes the back gesture mean what it
 * looks like it means.
 *
 * ---------------------------------------------------------------------------
 * IT IS NOT A SECOND TASKS SYSTEM, and the two are deliberately not merged.
 * An MBOS task is a ROW with a life of its own: the office raises it, it has a
 * priority and a due date, it is completed or snoozed with a reason, and doing
 * so writes to `tasks`. A lead's next action is FOUR COLUMNS ON THE LEAD —
 * what will be done, when, by whom and what they come back with — and it is
 * answered by working the lead, on the lead's own screen, not by ticking
 * anything. Folding them into one list would have put rows with a Done button
 * beside rows where Done means nothing, and a park — which nobody promised and
 * which returns because a date arrived — belongs to neither vocabulary.
 *
 * ---------------------------------------------------------------------------
 * ONE READ, NO NETWORK. The whole book comes off SQLite in a single query and
 * every view is a filter over it, so this works with one bar in a market lane,
 * which is where it is read. It is also what keeps the chip counts and the
 * list under them honest: they are the same rows, counted once.
 */

function headlineFor(lead: Lead, view: LeadActionView, today: string): string | null {
  const day = dayOf(lead);
  const late = daysSince(day, today) ?? 0;

  switch (view) {
    case 'today':
      /* A park reading back today is not a promise falling due, and reading
         them as one sentence is how a salesman treats a lead that has just
         returned as one he had already agreed to ring. */
      return parked(lead) ? 'Off hold today. Work on it again.' : 'Pending today';

    case 'overdue':
      return parked(lead)
        ? 'Was due back ' + dmy(day) + '. ' + plural(late, 'day') + ' ago'
        : 'Was due ' + dmy(day) + '. ' + plural(late, 'day') + ' late';

    case 'parked': {
      /*
       * THE RESUME DATE AND HOW FAR PAST IT, which is the whole of this view.
       * A park with no date on the screen reads as a lead somebody forgot, and
       * one whose day went a fortnight ago with nothing saying so is exactly
       * the lead this register exists to surface. The reason is the other
       * half — "back after Diwali" is what tells the next reader whether the
       * day is still a real one.
       */
      /* The CODE first and the remarks only where there is no code —
         `labelOf` answers "—" for a missing one, which would print an em-dash
         into the sentence and read as a reason nobody gave. A park made before
         the codes existed has only the sentence somebody typed. */
      const reason = lead.holdReasonCode
        ? labelOf(HOLD_REASONS, lead.holdReasonCode)
        : lead.holdReason?.trim() || null;
      const when = !day
        ? 'No return day set'
        : day < today
          ? 'Was due back ' + dmy(day) + '. ' + plural(late, 'day') + ' ago'
          : day === today
            ? 'Comes back today'
            : 'Comes back ' + dmy(day);
      return reason ? when + ' · ' + reason : when;
    }

    case 'none':
      return lead.lastActivityDate
        ? 'Nothing pending · last worked on ' + dmy(lead.lastActivityDate)
        : 'Nothing pending. Nothing done on it yet.';
  }
}

export default function LeadActionsScreen() {
  const back = useCameFrom('home');
  const params = useLocalSearchParams<{ view?: string }>();

  const [view, setView] = React.useState<LeadActionView>(() =>
    (LEAD_ACTION_VIEWS as readonly string[]).includes(params.view ?? '')
      ? (params.view as LeadActionView)
      : 'today',
  );

  /* Undefined is still reading and an empty array is a book with nothing in
     it. They are two different sentences at the bottom of this screen, and
     collapsing them is how a handset mid-read reads as a handset with no
     work. */
  const [leads, setLeads] = React.useState<Lead[] | undefined>(undefined);
  const [neverPulled, setNeverPulled] = React.useState(false);
  const [readErr, setReadErr] = React.useState(false);
  const [meId, setMeId] = React.useState<string | null>(null);
  const [today] = React.useState(() => isoDate(new Date()));

  const load = React.useCallback(() => {
    let live = true;
    void Promise.all([listLeads({}), lastPullAt(), currentSession()])
      .then(([rows, pulledAt, session]) => {
        if (!live) return;
        setReadErr(false);
        setLeads(rows);
        setNeverPulled(pulledAt === 0);
        setMeId(session?.user.id ?? null);
      })
      .catch(() => {
        if (!live) return;
        /* Left as a read that FAILED rather than as an empty book: a spinner
           that never stops and a list that is genuinely empty are the two
           states people misread, and this is neither. */
        setReadErr(true);
        setLeads([]);
      });
    return () => {
      live = false;
    };
  }, []);

  useFocusEffect(load);

  const counts: LeadActionCounts | null = leads ? countLeads(leads, today) : null;
  const rows = leads ? rowsFor(leads, view, today) : [];
  const text = VIEW_TEXT[view];

  /*
   * AN EMPTY LIST SAYS WHICH EMPTINESS IT IS, and there are four of them here.
   *
   * Nothing has ever reached this phone; the read failed; his book has no live
   * leads at all; and this particular view is clear. The last is good news and
   * the first is a support call, and a screen that draws them alike is one
   * people stop trusting — the same failure as the handset with no territory
   * reading as a handset with no work.
   */
  const emptiness = !leads
    ? null
    : readErr
      ? {
          head: 'Could not open your leads',
          body: 'Something went wrong on this phone. Close MBOS and open it again.',
        }
      : neverPulled
        ? {
            head: 'Your leads have not come yet',
            body: 'Nothing has come from the office to this phone yet. Go where there is signal. Keep MBOS open for a minute.',
          }
        : counts && counts.working === 0
          ? {
              head: 'No open leads',
              body: 'All your leads are converted, lost or closed. Add a new shop you visit as a lead.',
            }
          : rows.length === 0
            ? {
                head:
                  view === 'none'
                    ? 'Every lead has a pending action'
                    : view === 'parked'
                      ? 'Nothing is on hold'
                      : view === 'overdue'
                        ? 'Nothing is late'
                        : 'Nothing pending today',
                body:
                  view === 'none'
                    ? 'Each one has a day and a person set. Good.'
                    : view === 'parked'
                      ? 'Put a lead on hold until a day you choose. It comes back here by itself.'
                      : 'Other lists may still have work. See the counts on the buttons above.',
              }
            : null;

  const hero = (
    <View>
      <Text
        accessibilityLabel="Pending actions. Every open lead needs an action, a day and a person. Check these four lists."
        style={[{ fontSize: 13, lineHeight: 18, color: HERO.lavender.muted, marginTop: 2 }, weight(400)]}>
        Every open lead: an action, a day, a person
      </Text>
      {/* The four lists, each with its count. The count is the point: the
          shape of the morning is legible before anything is tapped. A dash
          where the read has not landed, never a nought. */}
      <View accessibilityRole="tablist" style={{ flexDirection: 'row', gap: 6, marginTop: 14 }}>
        {LEAD_ACTION_VIEWS.map((v) => {
          const on = view === v;
          const n = counts ? counts[v] : null;
          return (
            <Pressable
              key={v}
              onPress={() => {
                /* The rows that stay in this one slide to their places and
                   the rest fade, rather than the screen being swapped in one
                   frame. */
                if (v !== view) {
                  feedback('select');
                  animateLayoutFor(rows.length);
                }
                setView(v);
              }}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={VIEW_TEXT[v].chip + ', ' + (n == null ? 'not counted yet' : String(n))}
              style={{
                flex: 1,
                minWidth: 0,
                minHeight: 64,
                borderRadius: 18,
                backgroundColor: on ? C.navy : C.surface,
                paddingHorizontal: 6,
                paddingVertical: 10,
                alignItems: 'center',
                justifyContent: 'center',
              }}>
              <Text style={[{ fontSize: 22, lineHeight: 27, color: on ? C.lime : v === 'overdue' && n ? C.danger : C.ink }, weight(800)]}>
                {n == null ? '—' : String(n)}
              </Text>
              <Text numberOfLines={2} style={[{ fontSize: 11, lineHeight: 14, color: on ? '#FFFFFF' : C.ink, textAlign: 'center' }, weight(600)]}>
                {VIEW_TEXT[v].chip}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );

  return (
    <AppFrame
      title="Lead actions"
      tone="lavender"
      hero={hero}
      activeTab={null}
      onBack={back.go}
      scroll={false}
      contentStyle={{ padding: 0 }}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 16, paddingBottom: 32 }}>
        <View style={{ paddingHorizontal: 6 }}>
          <Text accessibilityRole="header" style={[{ fontSize: 17, lineHeight: 22, color: C.ink }, weight(800)]}>{text.title}</Text>
          <Text style={[{ fontSize: 12, lineHeight: 17, color: C.muted }, weight(400)]}>{text.sub}</Text>
        </View>

        {!leads ? (
          <View style={{ marginTop: 12, paddingVertical: 28, borderRadius: 22, backgroundColor: C.surface, alignItems: 'center' }}>
            <Text style={[{ fontSize: 13, color: C.muted, textAlign: 'center' }, weight(400)]}>Loading…</Text>
          </View>
        ) : emptiness ? (
          <View style={{ marginTop: 12, paddingHorizontal: 16, paddingVertical: 26, borderRadius: 22, backgroundColor: C.surface }}>
            <Text style={[{ fontSize: 16, lineHeight: 21, color: C.ink, textAlign: 'center' }, weight(800)]}>{emptiness.head}</Text>
            <Text style={[{ fontSize: 13, lineHeight: 19, color: C.muted, textAlign: 'center', marginTop: 4 }, weight(400)]}>
              {emptiness.body}
            </Text>
          </View>
        ) : (
          <View style={{ gap: 10, marginTop: 12 }}>
            {rows.map((lead, i) => (
              <Stagger key={lead.id} index={i}>
                <LeadActionCard
                  lead={lead}
                  meId={meId}
                  headline={headlineFor(lead, view, today)}
                  from="lead-actions"
                />
              </Stagger>
            ))}
          </View>
        )}
      </ScrollView>
    </AppFrame>
  );
}
