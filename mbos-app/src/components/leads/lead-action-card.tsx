import React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Badge, Card, SecondaryButton, T } from '../ui/primitives';
import { NavigateButton } from '../ui/navigate';
import { color as C, weight, type BadgeTone } from '../../theme/tokens';
import {
  roleAction,
  stageLabel,
  type LeadActionTone,
  type LeadSalesType,
} from '../../engines/funnel';
import type { Lead } from '../../data/leads';
import { dayOf, missingAnswers, rungOf } from '../../engines/lead-worklist';
import { dmy } from '../../lib/format';

/**
 * One lead, as a thing to do about it.
 *
 * ONE CARD, TWO SCREENS. Home draws up to six of these and the worklist draws
 * all of them under four views, and they are the same component because they
 * are the same question — a salesman glancing at Home and a salesman working
 * the Overdue list are looking at one shop and must not be told two different
 * things about it. Two copies of a card this dense disagree inside a release,
 * and the half that drifts is always the half somebody is reading.
 *
 * ---------------------------------------------------------------------------
 * THE HEADLINE IS THE VERB, AND IT COMES FROM §7's ENGINE.
 *
 * `roleAction` is the office's own function, compiled here byte for byte —
 * `engines/funnel/index.ts` explains why the four files are copies — so the
 * sentence a salesman reads on his phone is the sentence the console reads
 * about the same lead on the same afternoon. A rung NOUN is the state of a
 * lead; what he needs at half past eight is what he is supposed to DO about
 * it, and re-deriving that from the stage on a screen is how the two come to
 * disagree about one shop.
 *
 * THE VANTAGE IS ALWAYS `salesman` AND IS NOT RESOLVED HERE. On the office
 * side a person can hold several seats on one row and `vantagesFor` works out
 * which job they are doing on it; on a handset there is nothing to work out.
 * This app is the field salesman's, his book is his own, and inventing a
 * resolution on the phone would be a second opinion about a question the
 * server has already answered — with no seats on the wire to answer it from.
 *
 * ---------------------------------------------------------------------------
 * A LEGACY LEAD GETS NO VERB, AND SAYS SO RATHER THAN BORROWING ONE. A lead
 * raised before the funnel existed carries no rung at all, and `roleAction`
 * switches on the rung: handed a stage it has never heard of it would fall
 * through to "No action for you on this lead", which is a sentence about a
 * ladder rather than about this shop and reads as the app having written the
 * lead off. Its own six-word stage is drawn instead, which is what every other
 * screen in this app has always shown it as.
 */

/** The four tones §7 names, in this app's own colours. */
const TONE: Record<LeadActionTone, string> = {
  brand: C.primaryDeep,
  warn: C.warnInk,
  danger: C.danger,
  muted: C.muted,
};

/** The legacy stage words, as the leads book has always drawn them. */
const LEGACY_TONE: Record<string, BadgeTone> = {
  New: 'info',
  Contacted: 'teal',
  Qualified: 'amber',
  Negotiation: 'amber',
  'On hold': 'neutral',
  Converted: 'success',
  Lost: 'danger',
};

export function LeadActionCard({
  lead,
  meId,
  headline,
  from,
}: {
  lead: Lead;
  /**
   * Who is reading. Only ever used to turn the next action's owner id into the
   * word "you" — this phone holds no user table, so a person who is neither
   * the reader nor the named lead manager can only be described rather than
   * named. See `ownerLine`.
   */
  meId: string | null;
  /**
   * The view's own sentence about this row — how late it is, when it comes
   * back. It belongs to the caller because it is the only part of this card
   * that differs between the screens, and a card computing it would need to
   * know which list it was sitting in.
   */
  headline?: string | null;
  /** Where Open goes back to, so the record's back link says the true thing. */
  from: string;
}) {
  const rung = rungOf(lead);
  const action = rung
    ? roleAction(
        {
          stage: rung,
          salesType: (lead.salesType as LeadSalesType | null) ?? null,
          hasCommitment: !!lead.hasCommitment,
          hasOrder: !!lead.hasOrder,
          /*
           * FALSE, AND IT CHANGES NOTHING. This fact forks the BACK OFFICE's
           * line at `sample_trial` — whether there is a parcel of theirs to
           * pack — and no other vantage reads it. There is no back office on a
           * handset and nothing on the wire carries it, so the honest value is
           * the one that asserts nothing. If a vantage is ever drawn here that
           * does read it, this has to come down the pull first: a screen that
           * guessed would tell somebody stock had gone out on nobody's say-so.
           */
          sampleAwaitingDispatch: false,
        },
        'salesman',
      )
    : null;

  const missing = missingAnswers(lead);
  const day = dayOf(lead);
  const shop = lead.company?.trim() || lead.name;

  /*
   * WHO IS HOLDING THIS ONE THING, in the only words this phone can honestly
   * use. §24's whole point is that a next action belongs to a named person,
   * and that person is routinely the lead manager on a lead the salesman goes
   * on visiting — so "yours" and "his" are genuinely different mornings and
   * the card must not imply the first.
   *
   * There is no user table on a handset. Two ids can be resolved to words —
   * the reader's own and the lead manager, whose name rides on the row for
   * exactly this reason — and anybody else is described rather than named. A
   * wrong name is worse than an honest description: it sends him to the wrong
   * person.
   */
  const ownerLine = !lead.nextActionOwnerId
    ? null
    : lead.nextActionOwnerId === meId
      ? 'Yours to do'
      : lead.nextActionOwnerId === lead.leadManagerId
        ? (lead.leadManagerName ?? 'Your lead manager') + ' is holding this'
        : 'Somebody at the office is holding this';

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T numberOfLines={1} style={[{ fontSize: 15, color: C.ink }, weight(500)]}>
            {shop}
          </T>
          <T s="caption" style={{ marginTop: 2 }} numberOfLines={1}>
            {[lead.company?.trim() ? lead.name : null, lead.city].filter(Boolean).join(' · ') ||
              'No town recorded'}
          </T>
        </View>
        {rung ? (
          <Badge tone={action?.tone === 'danger' ? 'danger' : action?.tone === 'warn' ? 'amber' : 'neutral'}>
            {stageLabel(rung)}
          </Badge>
        ) : (
          <Badge tone={LEGACY_TONE[lead.stage] ?? 'neutral'}>{lead.stage}</Badge>
        )}
      </View>

      {/* The instruction, at the weight of an instruction. A muted one is a
          real answer — "awaiting manager verification" is worth knowing and is
          not a thing to go and do — so it is drawn as the engine tones it. */}
      {action ? (
        <T style={[{ fontSize: 15, lineHeight: 21, marginTop: 10, color: TONE[action.tone] }, weight(600)]}>
          {action.label}
        </T>
      ) : null}

      {headline ? (
        <T style={{ fontSize: 14, lineHeight: 20, marginTop: 4, color: C.body }}>{headline}</T>
      ) : null}

      {/*
        §24's four answers, drawn as four answers.
        The action and the day on one line because that is how somebody reads
        a diary; the person on the next, because "who is holding this" is the
        question the rule was written for and it is routinely not the salesman.
      */}
      {lead.nextAction?.trim() ? (
        <T style={{ fontSize: 14, lineHeight: 20, marginTop: 6, color: C.ink }} numberOfLines={2}>
          {lead.nextAction.trim() + (day ? ' · ' + dmy(day) : '')}
        </T>
      ) : null}
      {ownerLine ? (
        <T s="caption" style={{ marginTop: 2 }}>{ownerLine}</T>
      ) : null}
      {lead.nextActionOutcome?.trim() ? (
        <T s="caption" style={{ marginTop: 2 }} numberOfLines={2}>
          {'Comes back with: ' + lead.nextActionOutcome.trim()}
        </T>
      ) : null}

      {/* What is absent, NAMED. A lead owed something today with nobody
          against it is the most urgent shape on this screen, and a blank where
          a name should be says nothing at all. */}
      {missing.length ? (
        <T style={[{ fontSize: 13, lineHeight: 19, marginTop: 6, color: C.warnInk }, weight(500)]}>
          {'Nobody has said ' + missing.join(', ') + '.'}
        </T>
      ) : null}

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
        {/* THE DEEP LINK, and the one control that does it. A shop with no pin
            still gets the button — `openMaps` searches the name and the town,
            which lands him near a name rather than on a doorway and is a
            better answer than no button at all on a book where roughly half
            the pins are missing. */}
        <NavigateButton
          lat={lead.gpsLat}
          lng={lead.gpsLng}
          name={shop}
          city={lead.city}
          variant="button"
          style={{ flex: 1 }}
        />
        <SecondaryButton
          label="Open"
          onPress={() => router.push(`/lead?id=${lead.id}&from=${from}`)}
          style={{ flex: 1 }}
        />
      </View>
    </Card>
  );
}
