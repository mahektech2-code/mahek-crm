import React from 'react';
import { View, Pressable, ScrollView, FlatList, type ListRenderItemInfo } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Badge, Card, Choice, DashedButton, Divider, Input, PrimaryButton, SecondaryButton, SectionLabel, T } from '../ui/primitives';
import { BottomSheet, Calendar } from '../ui/overlays';
import { color as C, radius, weight, type BadgeTone } from '../../theme/tokens';
import {
  createLead,
  leadThresholds,
  listLeads,
  rungsInBook,
  visitCapThresholds,
  type Lead,
  type LeadBookFilter,
} from '../../data/leads';
import { leadSources } from '../../data/config';
import { takePhoto } from '../../native/capture';
import {
  CUSTOMER_TYPES,
  daysBetween,
  leadOwed,
  owedLabel,
  LEAD_VIEWS,
  LEAD_WHENS,
  OTHER_SOURCE,
  leadAlert,
  leadPriorityLabel,
  leadSourceLabel,
  viewOfLead,
  visitCapLabel,
  visitCapState,
  type DuplicateMatch,
  type LeadSource,
  type LeadThresholds,
  type LeadView,
  type LeadWhen,
  type VisitCapThresholds,
} from '../../engines/leads';
import {
  offeredSalesTypes,
  roleAction,
  salesTypeLabel,
  stageLabel,
  type LeadActionTone,
  type LeadSalesType,
  type LeadStage,
} from '../../engines/funnel';
import { dmy, inrFromPaise, isoDate, plural, pretty } from '../../lib/format';
import { useStore } from '../../state/store';

/**
 * Leads — shops that are not on the book yet.
 *
 * The list is ordered by what was promised: a follow-up date the salesman gave
 * somebody comes first, and a lead nobody promised anything sits under them
 * rather than off the bottom of the screen. Archived is a filter and never a
 * delete — a shop that said no in March is exactly who somebody wants to find
 * in September.
 *
 * The one thing the form does differently to every other form here is that it
 * checks the number against the customers as well as the leads, and when it
 * finds one it SHOWS the record. A refusal with nothing to open is how the
 * same shop gets typed in twice with a digit changed.
 */

/**
 * The badge's colour, keyed on the CHIP a lead answers to.
 *
 * It was keyed on `leads.stage`, the six-word column, which meant a lead
 * standing on any of the seventeen rungs the funnel added fell through to
 * neutral. The key is `viewOfLead` now, so the badge and the chip that caught
 * the row can never disagree — one lead, one word, one colour.
 */
const VIEW_TONE: Record<LeadView, BadgeTone> = {
  all: 'neutral',
  new: 'info',
  contacted: 'teal',
  qualified: 'amber',
  negotiation: 'amber',
  on_hold: 'neutral',
  converted: 'success',
  lost: 'danger',
  archived: 'neutral',
};

const VIEW_LABEL: Record<LeadView, string> = Object.fromEntries(
  LEAD_VIEWS.map((v) => [v.value, v.label]),
) as Record<LeadView, string>;

/**
 * §7's four tones as ink.
 *
 * `muted` is the one that earns its place — "Nothing operational pending" drawn
 * at the weight of "Payment follow-up" would be read as a task. See
 * `lead-role-action.ts`, which names the four and says why.
 */
const ACTION_INK: Record<LeadActionTone, string> = {
  brand: C.primaryDeep,
  warn: C.warnInk,
  danger: C.danger,
  muted: C.muted,
};

/** The gap between cards, which the wrapping `View`'s `gap: 12` used to give. */
function RowGap() {
  return <View style={{ height: 12 }} />;
}

/**
 * ONE LEAD, AND IT LEADS WITH A VERB.
 *
 * The card printed a rung NOUN — "Qualified" — which tells a salesman where the
 * lead stands and not one thing about what he is supposed to do with it this
 * morning. §7 is the specification's answer to that and `roleAction` is the one
 * place it lives: the same function the office reads for him, so the sentence
 * on his phone and the sentence on his manager's screen are the same sentence
 * about the same shop. It is asked from the `salesman` vantage and only that
 * one — his book is his own, and resolving a vantage on a phone would be a
 * second copy of `vantagesFor` deciding which hat somebody is wearing.
 *
 * `sampleAwaitingDispatch` is passed FALSE rather than derived. Nothing in the
 * salesman's own column of §7's table forks on it — it is the back office's
 * fact, read at `sample_trial` to tell them whether to pack a parcel — so
 * deriving it would be a query per row to change no word he reads.
 */
function LeadRow({
  lead,
  today,
  cfg,
  capCfg,
  sources,
  onPress,
}: {
  lead: Lead;
  today: string;
  cfg: LeadThresholds | null;
  capCfg: VisitCapThresholds | null;
  sources: LeadSource[] | null;
  onPress: (id: string) => void;
}) {
  const view = viewOfLead(lead);
  /*
   * WHAT IS OWED, AND WHICH OF THE THREE DAYS IT IS.
   *
   * The same answer the chips cut by and the same one the sort used — said in
   * words here, which is what pays for the chip being wider than any one
   * column. "Late — you said you would go back on the 14th" and "Late — back
   * off hold since the 14th" are different mornings, and a chip that caught
   * both over a line naming neither would be a count nobody could act on.
   */
  const owed = leadOwed(lead, today);
  const owedLine = owedLabel(owed, pretty);
  const overdue = !!owed && owed.daysLate > 0 && view !== 'converted' && view !== 'lost';

  /*
   * The alert is dropped where the line above has already said it.
   *
   * `leadAlert`'s first branch is the follow-up running late, which is one of
   * the three days `leadOwed` answers about — drawn together they are the same
   * sentence twice, and the narrower one underneath reads as a second, smaller
   * problem. Its other branches are about the lead having gone QUIET, which is
   * a different fact and still worth saying.
   */
  const alert = cfg ? leadAlert(lead, today, cfg) : null;
  const quiet = owed && owed.source === 'promise' && owed.daysLate > 0 ? null : alert;

  const rung = (lead.funnelStage as LeadStage | null) ?? null;
  const facts = {
    stage: (rung ?? 'new') as LeadStage,
    salesType: lead.salesType as LeadSalesType | null,
    hasCommitment: lead.hasCommitment === 1,
    hasOrder: lead.hasOrder === 1,
    sampleAwaitingDispatch: false,
  };
  const action = roleAction(facts, 'salesman');

  /* How long it has sat where it is. `stageSince` is the day it reached this
     rung and is the office's own column, unlike `clientCreatedAt`, which is
     when THIS PHONE first saw the row — see the note on age in the book's own
     header. Said only once it has been a while: "0 days on this rung" on a lead
     somebody moved this morning is a line that costs a row of space to say
     nothing. */
  const held = rung ? daysBetween(lead.stageSince, today) : null;

  /*
   * HOW OLD THE LEAD IS, which this row could not honestly say until now.
   *
   * It was drawn off nothing, because the only creation date on the phone was
   * `clientCreatedAt` — the moment THIS HANDSET first pulled the row, bound to
   * `now` by `upsertLeads` and never updated on conflict. On every lead the
   * office raised it says today, and says something else again after a
   * reinstall, so an age read off it is a confident wrong number on exactly
   * the leads a manager would ask about. `createdAt` is the office's own, and
   * null where it has not arrived — drawn as nothing rather than as new, which
   * is the same mistake wearing a different column.
   *
   * It sits BESIDE the rung age rather than replacing it. "Ninety days old,
   * four days on this rung" and "ninety days old, eighty on this rung" are two
   * different shops and only the pair tells them apart: the first is moving,
   * the second is stuck, and the rung age alone cannot say which.
   */
  const age =
    lead.createdAt == null ? null : daysBetween(isoDate(new Date(lead.createdAt)), today);

  /*
   * NOBODY NAMED TO DO THE OPERATIONAL HALF, said only where there IS one.
   *
   * `backOfficeAmId` is a seat, and an empty one is why a sample sits undispatched
   * and a GST never gets validated — the task falls through to the Lead Manager
   * and the salesman assumes the parcel is on its way. Asked of `roleAction` from
   * the back office's vantage rather than guessed from the rung, so the rule is
   * §7's own: where they have nothing to do, an empty seat is not a problem and
   * saying so would be a warning on most of the book.
   */
  const backOfficeGap = !lead.backOfficeAmId && roleAction(facts, 'back_office').actionable;

  const marks = [
    leadPriorityLabel(lead.priority),
    lead.hasOrder === 1 ? 'Order placed' : lead.hasCommitment === 1 ? 'Committed' : null,
    lead.leadManagerName ? 'Lead manager ' + lead.leadManagerName : null,
  ].filter(Boolean);

  return (
    <Pressable onPress={() => onPress(lead.id)} accessibilityRole="button">
      <Card style={overdue ? { borderLeftWidth: 3, borderLeftColor: C.danger } : undefined}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T numberOfLines={1} style={[{ fontSize: 15, color: C.ink }, weight(500)]}>
              {lead.company?.trim() || lead.name}
            </T>
            <T s="caption" style={{ marginTop: 2 }}>
              {/* The ladder is named on the row, because which kind of sale
                  this is changes what the next call is about — and it is the
                  one fact about a lead that cannot be guessed from its name. */}
              {[
                lead.company?.trim() ? lead.name : null,
                lead.salesType ? salesTypeLabel(lead.salesType as LeadSalesType) : null,
                lead.city,
                leadSourceLabel(lead.source, sources ?? []),
              ]
                .filter(Boolean)
                .join(' \u00b7 ')}
            </T>
            {/* What "Other" actually was. It is the sentence that tells Mahek
                which eleventh channel is worth adding to the list, and until
                now it reached the phone and no screen drew it. */}
            {lead.sourceDetail ? (
              <T s="caption" style={{ marginTop: 2 }} numberOfLines={2}>
                {lead.sourceDetail}
              </T>
            ) : null}
          </View>
          <Badge tone={VIEW_TONE[view]}>{VIEW_LABEL[view]}</Badge>
        </View>

        {/* §7 — what he is supposed to DO, above everything the lead IS. */}
        <T style={[{ fontSize: 15, lineHeight: 21, marginTop: 10, color: ACTION_INK[action.tone] }, weight(600)]}>
          {action.label}
        </T>

        {rung ? (
          <T s="caption" style={{ marginTop: 2 }}>
            {[
              stageLabel(rung),
              age && age > 0 ? plural(age, 'day') + ' old' : null,
              held && held > 0 ? plural(held, 'day') + ' on this rung' : null,
            ]
              .filter(Boolean)
              .join(' \u00b7 ')}
          </T>
        ) : null}

        <T style={[{ fontSize: 15, marginTop: 10, color: lead.estimatedPotentialPaise ? C.ink : C.muted }, weight(500)]}>
          {lead.estimatedPotentialPaise
            ? inrFromPaise(lead.estimatedPotentialPaise) + ' a month, he reckons'
            : 'Worth not estimated yet'}
        </T>

        <T style={{ fontSize: 14, lineHeight: 20, marginTop: 4, color: overdue ? C.danger : C.muted }}>
          {owedLine ?? 'Nobody is waiting on anything'}
        </T>

        {quiet ? (
          <T style={[{ fontSize: 14, lineHeight: 20, marginTop: 4, color: C.warnInk }, weight(500)]}>{quiet}</T>
        ) : null}

        {/* "Visit 2 / 3" — §B. Drawn only where it means something: a
            qualified prospect visited a fourth time is a negotiation,
            not a stall, and carries no counter at all. */}
        {capCfg && visitCapLabel(lead.stage, lead.visitCount, capCfg) ? (
          <T
            style={[
              {
                fontSize: 14,
                lineHeight: 20,
                marginTop: 4,
                color:
                  visitCapState(lead.stage, lead.visitCount, capCfg) === 'decide' ? C.warnInk : C.muted,
              },
              weight(500),
            ]}>
            {visitCapLabel(lead.stage, lead.visitCount, capCfg)}
            {visitCapState(lead.stage, lead.visitCount, capCfg) === 'decide' ? ' \u00b7 a decision is due' : ''}
          </T>
        ) : null}

        {marks.length ? (
          <T s="caption" style={{ marginTop: 4 }} numberOfLines={2}>
            {marks.join(' \u00b7 ')}
          </T>
        ) : null}

        {backOfficeGap ? (
          <T style={[{ fontSize: 14, lineHeight: 20, marginTop: 4, color: C.warnInk }, weight(500)]}>
            No back office person named — the office half of this will land on your lead manager
          </T>
        ) : null}

        {/* Why it is not moving. On a held lead this is the whole point
            of the status — without it "On hold" reads as "forgotten". */}
        {lead.holdReason ? (
          <T s="caption" style={{ marginTop: 4 }} numberOfLines={2}>
            {'Waiting: ' + lead.holdReason}
          </T>
        ) : null}

        {lead.archived ? (
          <T s="caption" style={{ marginTop: 4 }}>Archived — still here, just out of the way</T>
        ) : null}
      </Card>
    </Pressable>
  );
}

/**
 * The lead book, drawn the same wherever it is opened.
 *
 * It was a screen and is now a component, because the same list has two doors:
 * the Customers tab, where a salesman chooses between the shop he sells to and
 * the shop he is still working on, and the More screen's own Leads row, which
 * is the door that already existed and is in people's hands. Two copies of a
 * list this dense is two lists that disagree about one lead within a release,
 * and the half that drifts is always the half somebody is reading.
 *
 * It owns its OWN ScrollView rather than sitting inside the frame's, so both
 * doors pass `scroll={false}`: a frame that scrolls around a component that
 * scrolls is the one way to get two scroll positions and neither of them
 * working.
 */
export function LeadsBook() {
  const notify = useStore((s) => s.notify);
  const sheet = useStore((s) => s.sheet);
  const set = useStore((s) => s.set);

  /*
   * THREE NARROWINGS, AND THE SECOND ONE IS THE POINT OF THIS SCREEN.
   *
   * `view` is where the lead stands and is the row of chips this book has
   * always had — the same eight words, selecting on the funnel's rungs now
   * rather than on the six-word column. `when` is what is OWED, which is the
   * question a man planning a Tuesday morning actually asks and which nothing
   * here could put. `rung` narrows a picked band to one of its rungs and is
   * offered only where the book holds more than one.
   */
  const [view, setView] = React.useState<LeadView>('all');
  const [when, setWhen] = React.useState<LeadWhen>('any');
  const [rung, setRung] = React.useState<string | null>(null);
  const [rungs, setRungs] = React.useState<{ rung: string; count: number }[]>([]);
  const [rows, setRows] = React.useState<Lead[]>([]);
  /* Null until the thresholds arrive from configuration. A default written in
     here would be a business rule living in a screen, and the sentence it
     produced would be wrong on any handset whose office had changed it. */
  const [cfg, setCfg] = React.useState<LeadThresholds | null>(null);
  /* Null until configuration arrives. A default typed here would be a business
     rule living in a screen, and it would disagree with the server the day the
     office changed it — which is the one disagreement this cap cannot afford,
     since the server is what refuses the visit. */
  const [capCfg, setCapCfg] = React.useState<VisitCapThresholds | null>(null);
  const [today] = React.useState(() => isoDate(new Date()));

  /* the form */
  const [formOpen, setFormOpen] = React.useState(false);
  /* See `save`. Not state: a second tap arrives before a re-render would. */
  const saving = React.useRef(false);
  const [name, setName] = React.useState('');
  const [company, setCompany] = React.useState('');
  const [mobile, setMobile] = React.useState('');
  const [city, setCity] = React.useState('');
  /**
   * THE CODE, NOT THE WORD, and the list is the office's.
   *
   * This held one of five labels typed into `engines/leads.ts`, which the wire
   * then translated down to four codes — three of which `leads.sources`, the
   * one authoritative list, has never contained. So every lead raised here was
   * filed under a channel nobody can count. What is stored now is the code, and
   * the words beside it are whatever the office last published.
   *
   * Null until the list has arrived and until he has answered. Defaulting to
   * the first chip is the app quietly answering a question about attribution on
   * a salesman's behalf, and "Salesman Prospecting" would then be the largest
   * bar on the chart by construction.
   */
  const [sources, setSources] = React.useState<LeadSource[] | null>(null);
  const [source, setSource] = React.useState<string | null>(null);
  /* §— what "Other" has to say. Only ever read when the source is `other`, and
     deliberately NOT cleared when the answer moves off it: the web form does
     the same, because it is a record of what somebody believed on the day. */
  const [sourceDetail, setSourceDetail] = React.useState('');
  /**
   * §2 — asked before anything else is typed, and null until it is answered.
   *
   * It picks the ladder, so it decides which questions the rest of the funnel
   * asks: a distributor answers thirty and a shop answers twelve. Defaulting
   * it to "Direct customer" would be the app quietly choosing, and every lead
   * anybody raised in a hurry would be on the wrong ladder with nothing on the
   * screen saying so.
   */
  const [salesType, setSalesType] = React.useState<LeadSalesType | null>(null);
  const [potential, setPotential] = React.useState('');
  const [followUp, setFollowUp] = React.useState<string | null>(null);
  const [cal, setCal] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [dup, setDup] = React.useState<DuplicateMatch | null>(null);
  /* §A and §C. All optional and all below a divider — a salesman outside a
     closed shop with a name and a number must still be able to save, and a
     fourteen-field form is how you get fourteen empty fields. */
  const [address, setAddress] = React.useState('');
  const [custType, setCustType] = React.useState<string | null>(null);
  const [requirement, setRequirement] = React.useState('');
  const [litres, setLitres] = React.useState('');
  const [decisionMaker, setDecisionMaker] = React.useState('');
  const [competitor, setCompetitor] = React.useState('');
  const [shopPhotoId, setShopPhotoId] = React.useState<string | null>(null);

  /* One object, so a caller that adds a fourth narrowing does not add a fourth
     argument to two functions. `today` travels with it rather than being read
     inside the query: the clock is read once, at the top of this component. */
  const filter: LeadBookFilter = React.useMemo(
    () => ({ view, rung, when, today }),
    [view, rung, when, today],
  );

  const load = React.useCallback(() => {
    let live = true;
    void Promise.all([
      listLeads(filter),
      /* The rungs under the picked band, counted in SQLite over the same
         narrowing. A separate grouped query rather than a pass over `rows`,
         because picking a rung shortens `rows` and counting from it would make
         every other rung read zero the moment one was chosen. */
      rungsInBook(filter),
      leadThresholds(),
      visitCapThresholds(),
      leadSources(),
    ]).then(([r, g, t, c, srcs]) => {
      if (!live) return;
      setRows(r);
      setRungs(g);
      setCfg(t);
      setCapCfg(c);
      setSources(srcs);
    });
    return () => {
      live = false;
    };
  }, [filter]);

  useFocusEffect(load);

  /*
   * WHAT HE TYPED SURVIVES A DISMISSAL, and it did not.
   *
   * `BottomSheet` closes on a scrim tap and on Android's back gesture, and the
   * only way back in is this button — which used to clear all fourteen fields
   * on the way IN. So one stray tap above the longest form in the app, filled
   * one-handed in the street, cost the whole shop the moment he pressed "+ Add
   * lead" again, with nothing asked and nothing said.
   *
   * Nothing is cleared now until something has been done with it: a save that
   * worked, or Cancel, which is somebody deliberately saying to throw it away.
   * Re-opening shows him exactly what he had.
   */
  const clearForm = React.useCallback(() => {
    setName('');
    setCompany('');
    setMobile('');
    setCity('');
    setSource(null);
    setSourceDetail('');
    setSalesType(null);
    setPotential('');
    setFollowUp(null);
    setAddress('');
    setCustType(null);
    setRequirement('');
    setLitres('');
    setDecisionMaker('');
    setCompetitor('');
    setShopPhotoId(null);
    setErr(null);
    setDup(null);
  }, []);

  const openForm = React.useCallback(() => setFormOpen(true), []);

  /* The + sheet on every screen offers "Add lead", which lands here with the
     form already asked for — the salesman is standing outside the shop. */
  React.useEffect(() => {
    if (sheet === 'leadForm') {
      set({ sheet: null });
      openForm();
    }
  }, [sheet, set, openForm]);

  const shootShop = async () => {
    /* `parentId: 'pending'` because the lead does not exist yet — the salesman
       shoots the shop while he is standing in front of it and types the rest
       afterwards. `handleLead` binds it the moment the row is written. */
    const shot = await takePhoto({ parentType: 'lead', parentId: 'pending', kind: 'shop_photo' });
    if (!shot.ok) {
      if (shot.reason !== 'cancelled') notify(shot.reason);
      return;
    }
    setShopPhotoId(shot.mediaId);
  };

  const save = async () => {
    /* One lead per press. `createLead` awaits a duplicate check, a GPS fix and
       a write, and a second tap inside that window is the ordinary way a shop
       ends up on the book twice — the duplicate check cannot catch it, because
       neither row is written yet when the other starts. A ref rather than
       state: state is a render away and the second tap is not. */
    if (saving.current) return;

    /* The ladder is asked FIRST and refused first, in that order, so the
       message somebody reads names the question at the top of the form rather
       than the one they have just finished typing. */
    if (!salesType) return setErr('Which kind of sale is this? It decides what the rest of the funnel asks.');
    if (!name.trim()) return setErr('Say who this is — a name or the shop.');
    if (mobile.replace(/\D/g, '').length < 10) return setErr('A ten-digit mobile, so somebody can ring them.');
    if (!source) return setErr('Say how you found them. It is the one question only you can answer.');
    /* Refused on the phone as well as in the office, because being told after
       the fact loses the sentence he had in mind while he was standing there. */
    if (source === OTHER_SOURCE && !sourceDetail.trim()) {
      return setErr('Say where this one actually came from — "Other" with nothing behind it is a source nobody can count later.');
    }

    saving.current = true;
    try {
      const rupees = Number(potential.replace(/[^\d]/g, ''));
      const result = await createLead({
        name,
        company,
        mobile,
        city,
        source,
        /* Where it actually came from, on its own column at both ends —
           `customers.lead_source_detail` on the server and `leads.sourceDetail`
           here. It used to ride in the note prefixed "Source details: ",
           because nothing carried it up: that put the answer he had just been
           refused for not giving where a person could read it and no report
           could count it. */
        sourceDetail: source === OTHER_SOURCE ? sourceDetail : null,
        /* Rupees on the screen, paise in the store — the only place the two meet. */
        estimatedPotentialPaise: rupees > 0 ? rupees * 100 : null,
        nextFollowUpDate: followUp,
        salesType,
        address,
        customerType: custType,
        requirement,
        monthlyVolumeLitres: Number(litres.replace(/[^\d]/g, '')) || null,
        decisionMaker,
        competitorName: competitor,
        shopPhotoId,
        today,
      });

      if (!result.ok) {
        setErr(result.message);
        setDup(result.duplicate ?? null);
        return;
      }

      setFormOpen(false);
      /* One of the two places anything is thrown away — this one and Cancel. The
         next "+ Add lead" is a different shop; this one is on the list behind
         the sheet. */
      clearForm();
      load();
      notify('Lead added · ' + (company.trim() || name.trim()));
    } finally {
      saving.current = false;
    }
  };

  const openDuplicate = () => {
    if (!dup) return;
    setFormOpen(false);
    if (dup.kind === 'customer') {
      set({ custId: dup.id, pTab: 0 });
      router.push('/customer');
    } else {
      router.push(`/lead?id=${dup.id}&from=leads`);
    }
  };

  const openLead = React.useCallback((id: string) => {
    router.push(`/lead?id=${id}&from=leads`);
  }, []);

  const renderRow = React.useCallback(
    ({ item }: ListRenderItemInfo<Lead>) => (
      <LeadRow
        lead={item}
        today={today}
        cfg={cfg}
        capCfg={capCfg}
        sources={sources}
        onPress={openLead}
      />
    ),
    [today, cfg, capCfg, sources, openLead],
  );

  /*
   * AN ELEMENT AND NEVER A FUNCTION — the trap the customers list carries its
   * own note about. An inline component would be a fresh type on every render,
   * so the header would unmount and remount and the chips would lose their
   * scroll position on every keystroke the parent makes.
   *
   * TWO CHIP ROWS AND NOT A MENU. Both change what the list IS rather than how
   * it is drawn, and a list whose subject is hidden behind a menu is one people
   * misread — the same rule the customers list follows for its Everything /
   * Customers / Leads chips.
   */
  const header = React.useMemo(
    () => (
      <View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingVertical: 2, paddingRight: 8 }}
          style={{ marginHorizontal: -16, paddingHorizontal: 16 }}>
          {LEAD_WHENS.map((w) => (
            <Choice
              key={w.value}
              label={w.label}
              selected={when === w.value}
              onPress={() => setWhen(w.value)}
              style={{ paddingHorizontal: 16 }}
            />
          ))}
        </ScrollView>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingVertical: 2, paddingRight: 8 }}
          style={{ marginHorizontal: -16, paddingHorizontal: 16, marginTop: 8 }}>
          {LEAD_VIEWS.map((v) => (
            <Choice
              key={v.value}
              label={v.label}
              selected={view === v.value}
              onPress={() => {
                setView(v.value);
                /* The rung belongs to the band it was picked under. Carried
                   across it would narrow the new band to a rung that band does
                   not carry, and the list would go empty with nothing on the
                   screen saying why. */
                setRung(null);
              }}
              style={{ paddingHorizontal: 16 }}
            />
          ))}
        </ScrollView>

        {/* THE RUNGS UNDER THE BAND, and only where there is a choice to make.
            Built from what is in the book rather than from the ladder — see
            `rungsInBook`. One rung draws nothing: a single option is not a
            choice, which is the same reason the launcher does not draw itself
            for somebody holding one app. */}
        {rungs.length > 1 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8, paddingVertical: 2, paddingRight: 8 }}
            style={{ marginHorizontal: -16, paddingHorizontal: 16, marginTop: 8 }}>
            <Choice
              label={'All of ' + VIEW_LABEL[view].toLowerCase()}
              selected={rung === null}
              onPress={() => setRung(null)}
              style={{ paddingHorizontal: 16 }}
            />
            {rungs.map((r) => (
              <Choice
                key={r.rung}
                label={stageLabel(r.rung as LeadStage) + ' ' + r.count}
                selected={rung === r.rung}
                onPress={() => setRung(r.rung)}
                style={{ paddingHorizontal: 16 }}
              />
            ))}
          </ScrollView>
        ) : null}

        <DashedButton label="+ Add lead" tone="primary" onPress={openForm} style={{ marginTop: 12 }} />

        {rows.length ? <T s="caption" style={{ marginTop: 12, marginBottom: 8 }}>{plural(rows.length, 'lead')}</T> : null}
      </View>
    ),
    [view, when, rung, rungs, rows.length, openForm],
  );

  /*
   * AN EMPTY LIST SAYS WHICH KIND OF EMPTY IT IS.
   *
   * Nothing at all, nothing at this rung, and nothing owed on these days are
   * three different facts and only one of them is about the book. A salesman
   * who has picked Overdue and sees "No leads yet" concludes his leads are
   * gone; what is true is that he owes nobody anything, which is the best news
   * on the screen.
   */
  const empty = React.useMemo(
    () => (
      <Card style={{ marginTop: 12, paddingHorizontal: 16, paddingVertical: 32 }} padded={false}>
        <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center' }, weight(600)]}>
          {when !== 'any'
            ? 'Nothing ' + LEAD_WHENS.find((w) => w.value === when)!.label.toLowerCase()
            : view === 'all'
              ? 'No leads yet'
              : 'Nothing at ' + VIEW_LABEL[view]}
        </T>
        <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 4 }}>
          {when !== 'any'
            ? 'Every lead is still here — this is only what you owe somebody.'
            : view === 'all'
              ? 'A shop you walk past and a name somebody gives you both start here.'
              : 'Every lead is still on All — nothing has been deleted.'}
        </T>
      </Card>
    ),
    [view, when],
  );

  return (
    <View style={{ flex: 1 }}>
      {/*
        * IT IS A `FlatList`, and for the reason the customers list next door
        * spells out: the rows were `rows.map()` inside a `ScrollView`, so every
        * lead was mounted at once — and this card is now a good deal heavier
        * than it was, carrying a verb, a rung, a counter and the marks. A few
        * hundred of those built on the JS thread is a screen that stutters
        * exactly when somebody is scrolling it looking for one shop.
        */}
      <FlatList
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 24 }}
        data={rows}
        keyExtractor={(x) => x.id}
        renderItem={renderRow}
        ItemSeparatorComponent={RowGap}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        windowSize={7}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      />

      {/* ------------------------------------------------------------ form */}
      <BottomSheet open={formOpen} onClose={() => setFormOpen(false)} scroll>
        <T style={[{ fontSize: 19, lineHeight: 25, letterSpacing: -0.285, color: C.ink }, weight(600)]}>New lead</T>
        <T s="caption" style={{ marginTop: 2 }}>
          The number is checked against your book before this saves.
        </T>

        {/* --------------------------------------------------- §2 the ladder
            First on the form, because it decides what the rest of the funnel
            asks — and changed afterwards only deliberately, from the record,
            with a reason. Three chips rather than a dropdown: the sentence
            under each is what somebody standing outside a shop reads to
            choose, and a dropdown hides two of the three. */}
        <View style={{ marginTop: 14 }}>
          <SectionLabel style={{ marginBottom: 6 }}>What kind of sale is this?</SectionLabel>
          <View style={{ gap: 8 }}>
            {/* OFFERED, not all three. Mahek does not appoint distributors
                through MahekOne, so that ladder is withdrawn for new leads —
                the note on `SALES_TYPES` in the funnel engine has the whole of
                it. The leads already on it keep everything they have. */}
            {offeredSalesTypes().map((t) => (
              <Choice
                key={t.code}
                label={t.label}
                sub={t.hint}
                selected={salesType === t.code}
                onPress={() => { setSalesType(t.code); setErr(null); }}
                style={{ alignItems: 'flex-start', paddingHorizontal: 14, paddingVertical: 10 }}
              />
            ))}
          </View>
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>Who you spoke to</SectionLabel>
          <Input value={name} onChangeText={(v) => { setName(v); setErr(null); }} placeholder="Suresh Patil" />
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>Shop name</SectionLabel>
          <Input value={company} onChangeText={setCompany} placeholder="Patil Hardware & Paints" />
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>Mobile</SectionLabel>
          <Input
            value={mobile}
            onChangeText={(v) => { setMobile(v); setErr(null); setDup(null); }}
            placeholder="98220 11001"
            keyboardType="phone-pad"
          />
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>City</SectionLabel>
          <Input value={city} onChangeText={setCity} placeholder="Nagpur" />
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>How you found them</SectionLabel>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {(sources ?? []).map((s) => (
              <Choice
                key={s.code}
                label={s.label}
                selected={source === s.code}
                onPress={() => setSource(s.code)}
                style={{ paddingHorizontal: 14 }}
              />
            ))}
          </View>
        </View>

        {/*
          * ONLY UNDER "OTHER", and required there — the same shape the web
          * intake form draws, for the same reason. "Other" is the cheapest
          * answer on any list: left free it becomes the biggest bar on the
          * chart with nothing behind it, and the sentences are what tell Mahek
          * which eleventh channel is worth adding to the list. A box that is
          * dead on nine answers in ten is furniture, and people stop reading
          * furniture, so it is drawn rather than disabled.
          */}
        {source === OTHER_SOURCE ? (
          <View style={{ marginTop: 12 }}>
            <SectionLabel style={{ marginBottom: 6 }}>Source details</SectionLabel>
            <Input
              value={sourceDetail}
              onChangeText={(v) => { setSourceDetail(v); setErr(null); }}
              placeholder="A builder on the site next door sent him"
            />
          </View>
        ) : null}

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>What they might buy a month</SectionLabel>
          <Input
            value={potential}
            onChangeText={setPotential}
            placeholder="40000"
            keyboardType="number-pad"
          />
          <T s="caption" style={{ marginTop: 6 }}>In rupees, roughly. Leave it empty if you would only be guessing.</T>
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>Go back to them on</SectionLabel>
          <Pressable
            onPress={() => setCal(true)}
            accessibilityRole="button"
            style={{
              minHeight: 52,
              borderWidth: 1,
              borderColor: C.border,
              borderRadius: radius.lg,
              backgroundColor: C.surface,
              justifyContent: 'center',
              paddingHorizontal: 14,
            }}>
            <T style={{ fontSize: 16, color: followUp ? C.ink : C.faint }}>
              {followUp ? dmy(followUp) : 'Pick a day'}
            </T>
          </Pressable>
        </View>

        <Divider style={{ marginTop: 20, marginBottom: 4 }} />
        <SectionLabel style={{ marginTop: 12 }}>What you learned in the shop</SectionLabel>
        <T s="caption" style={{ marginTop: 4 }}>
          All optional. Save what you have — you can add the rest from the lead later.
        </T>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>Where the shop is</SectionLabel>
          <Input value={address} onChangeText={setAddress} placeholder="Shop 4, Itwari Market, near the bus stand" />
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>What kind of business</SectionLabel>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {CUSTOMER_TYPES.map((t) => (
              <Choice
                key={t.value}
                label={t.label}
                selected={custType === t.value}
                onPress={() => setCustType(custType === t.value ? null : t.value)}
                style={{ paddingHorizontal: 14 }}
              />
            ))}
          </View>
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>What they want</SectionLabel>
          <Input value={requirement} onChangeText={setRequirement} placeholder="Thinner for a spray booth" />
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>How much a month</SectionLabel>
          <Input value={litres} onChangeText={setLitres} placeholder="200" keyboardType="number-pad" />
          {/* LITRES, not cans. There is no pack size agreed yet — a shop says
              "about two hundred litres" long before anybody knows what they
              will buy it as. */}
          <T s="caption" style={{ marginTop: 6 }}>In litres, as they say it.</T>
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>Who decides</SectionLabel>
          <Input value={decisionMaker} onChangeText={setDecisionMaker} placeholder="The proprietor, Mr Patil" />
          <T s="caption" style={{ marginTop: 6 }}>If that is not the person you spoke to.</T>
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>Who they buy from now</SectionLabel>
          <Input value={competitor} onChangeText={setCompetitor} placeholder="Asian Paints" />
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>The shop front</SectionLabel>
          <DashedButton
            label={shopPhotoId ? 'Photo taken \u2713 \u00b7 retake' : 'Take a photo'}
            onPress={shootShop}
          />
        </View>

        {err ? (
          <View style={{ marginTop: 12, backgroundColor: C.dangerBg, borderRadius: radius.lg, padding: 12 }}>
            <T style={[{ fontSize: 14, lineHeight: 20, color: C.danger }, weight(500)]}>{err}</T>
            {dup ? (
              <SecondaryButton
                label={dup.kind === 'customer' ? 'Open ' + dup.name : 'Open the lead'}
                onPress={openDuplicate}
                style={{ marginTop: 10 }}
              />
            ) : null}
          </View>
        ) : null}

        {/* Closing the sheet any other way — the scrim, the back gesture —
            keeps what he typed and brings it straight back. Cancel is the one
            gesture that means throw it away, so it is the one that clears. */}
        <T s="caption" style={{ marginTop: 18 }}>
          Close this by mistake and what you have typed will still be here. Cancel throws it away.
        </T>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
          <SecondaryButton
            label="Cancel"
            onPress={() => {
              setFormOpen(false);
              clearForm();
            }}
            style={{ flex: 1, borderRadius: radius.xl }}
          />
          <PrimaryButton label="Add lead" onPress={save} style={{ flex: 1, borderRadius: radius.xl }} />
        </View>
      </BottomSheet>

      {/* ------------------------------------------------------- follow-up */}
      <BottomSheet open={cal} onClose={() => setCal(false)}>
        <Calendar
          key={cal ? 'open' : 'shut'}
          selected={followUp ?? ''}
          disabledReason={(iso) => (iso < today ? 'That day has gone.' : null)}
          onPick={(iso) => {
            setFollowUp(iso);
            setCal(false);
          }}
        />
        <SecondaryButton label="Close" onPress={() => setCal(false)} style={{ minHeight: 48, height: 48, marginTop: 10 }} />
      </BottomSheet>
    </View>
  );
}
