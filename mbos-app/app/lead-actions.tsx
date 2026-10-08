import React from 'react';
import { ScrollView, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, Choice, SectionLabel, T } from '../src/components/ui/primitives';
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

  return (
    <AppFrame
      title="Lead actions"
      activeTab={null}
      onBack={back.go}
      scroll={false}
      contentStyle={{ padding: 0 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
        <BackLink label={back.label} onPress={back.go} />

        <SectionLabel>Pending actions</SectionLabel>
        <T s="small" style={{ color: C.muted, marginTop: 4 }}>
          Every open lead needs an action, a day and a person. Check these four lists.
        </T>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingVertical: 2, paddingRight: 8 }}
          style={{ marginHorizontal: -16, paddingHorizontal: 16, marginTop: 12 }}>
          {LEAD_ACTION_VIEWS.map((v) => (
            <Choice
              key={v}
              label={
                /* The count rides ON the chip. A strip of four words says
                   nothing about which of them has work in it, and the whole
                   point of this screen is that the shape of the morning is
                   legible before anything is tapped. A dash where the read has
                   not landed, never a nought. */
                VIEW_TEXT[v].chip + ' · ' + (counts ? String(counts[v]) : '—')
              }
              selected={view === v}
              onPress={() => {
                /* Another view is another worklist: the cards it shares with
                   this one slide to their places and the rest fade, rather
                   than the screen being swapped in one frame. */
                if (v !== view) animateLayoutFor(rows.length);
                setView(v);
              }}
              style={{ paddingHorizontal: 16 }}
            />
          ))}
        </ScrollView>

        <View style={{ marginTop: 16 }}>
          <T style={[{ fontSize: 17, lineHeight: 22, color: C.ink }, weight(600)]}>{text.title}</T>
          <T s="small" style={{ color: C.muted, marginTop: 2 }}>
            {text.sub}
          </T>
        </View>

        {!leads ? (
          <Card style={{ marginTop: 12, paddingVertical: 28 }}>
            <T s="small" style={{ color: C.muted, textAlign: 'center' }}>
              Loading…
            </T>
          </Card>
        ) : emptiness ? (
          <Card style={{ marginTop: 12, paddingHorizontal: 16, paddingVertical: 28 }} padded={false}>
            <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center' }, weight(600)]}>
              {emptiness.head}
            </T>
            <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 6 }}>
              {emptiness.body}
            </T>
          </Card>
        ) : (
          <View style={{ gap: 12, marginTop: 12 }}>
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
