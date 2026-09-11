import React from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, Choice, DashedButton, Divider, Input, PrimaryButton, SecondaryButton, SectionLabel, T } from '../src/components/ui/primitives';
import { BottomSheet, Calendar } from '../src/components/ui/overlays';
import { color as C, radius, weight, type BadgeTone } from '../src/theme/tokens';
import { createLead, leadThresholds, listLeads, visitCapThresholds, type Lead } from '../src/data/leads';
import { takePhoto } from '../src/native/capture';
import { CUSTOMER_TYPES, LEAD_FILTERS, LEAD_SOURCES, leadAlert, visitCapLabel, visitCapState, type DuplicateMatch, type LeadFilter, type LeadThresholds, type VisitCapThresholds } from '../src/engines/leads';
import { SALES_TYPES, salesTypeLabel, type LeadSalesType } from '../src/engines/funnel';
import { dmy, inr, isoDate, plural, pretty } from '../src/lib/format';
import { useStore } from '../src/state/store';

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

const STAGE_TONE: Record<string, BadgeTone> = {
  New: 'info',
  Contacted: 'teal',
  Qualified: 'amber',
  Negotiation: 'amber',
  Converted: 'success',
  Lost: 'danger',
};

export default function LeadsScreen() {
  const back = useCameFrom('more');
  const notify = useStore((s) => s.notify);
  const sheet = useStore((s) => s.sheet);
  const set = useStore((s) => s.set);

  const [filter, setFilter] = React.useState<LeadFilter>('All');
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
  const [name, setName] = React.useState('');
  const [company, setCompany] = React.useState('');
  const [mobile, setMobile] = React.useState('');
  const [city, setCity] = React.useState('');
  const [source, setSource] = React.useState<string>(LEAD_SOURCES[0]);
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

  const load = React.useCallback(() => {
    let live = true;
    void Promise.all([listLeads(filter), leadThresholds(), visitCapThresholds()]).then(
      ([r, t, c]) => {
        if (!live) return;
        setRows(r);
        setCfg(t);
        setCapCfg(c);
      },
    );
    return () => {
      live = false;
    };
  }, [filter]);

  useFocusEffect(load);

  const openForm = React.useCallback(() => {
    setName('');
    setCompany('');
    setMobile('');
    setCity('');
    setSource(LEAD_SOURCES[0]);
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
    setFormOpen(true);
  }, []);

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
    /* The ladder is asked FIRST and refused first, in that order, so the
       message somebody reads names the question at the top of the form rather
       than the one they have just finished typing. */
    if (!salesType) return setErr('Which kind of sale is this? It decides what the rest of the funnel asks.');
    if (!name.trim()) return setErr('Say who this is — a name or the shop.');
    if (mobile.replace(/\D/g, '').length < 10) return setErr('A ten-digit mobile, so somebody can ring them.');

    const rupees = Number(potential.replace(/[^\d]/g, ''));
    const result = await createLead({
      name,
      company,
      mobile,
      city,
      source,
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
    load();
    notify('Lead added · ' + (company.trim() || name.trim()));
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

  return (
    <AppFrame title="Leads" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, paddingVertical: 2, paddingRight: 8 }}
        style={{ marginHorizontal: -16, paddingHorizontal: 16 }}>
        {LEAD_FILTERS.map((f) => (
          <Choice key={f} label={f} selected={filter === f} onPress={() => setFilter(f)} style={{ paddingHorizontal: 16 }} />
        ))}
      </ScrollView>

      <DashedButton label="+ Add lead" tone="primary" onPress={openForm} style={{ marginTop: 12 }} />

      {rows.length === 0 ? (
        <Card style={{ marginTop: 12, paddingHorizontal: 16, paddingVertical: 32 }} padded={false}>
          <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center' }, weight(600)]}>
            {filter === 'All' ? 'No leads yet' : 'Nothing at ' + filter}
          </T>
          <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 4 }}>
            {filter === 'All'
              ? 'A shop you walk past and a name somebody gives you both start here.'
              : 'Every lead is still on All — nothing has been deleted.'}
          </T>
        </Card>
      ) : (
        <T s="caption" style={{ marginTop: 12 }}>{plural(rows.length, 'lead')}</T>
      )}

      <View style={{ gap: 12, marginTop: 8 }}>
        {rows.map((x) => {
          const alert = cfg ? leadAlert(x, today, cfg) : null;
          const overdue = !!x.nextFollowUpDate && x.nextFollowUpDate < today && x.stage !== 'Converted' && x.stage !== 'Lost';
          return (
            <Pressable
              key={x.id}
              onPress={() => router.push(`/lead?id=${x.id}&from=leads`)}
              accessibilityRole="button">
              <Card style={overdue ? { borderLeftWidth: 3, borderLeftColor: C.danger } : undefined}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T numberOfLines={1} style={[{ fontSize: 15, color: C.ink }, weight(500)]}>
                      {x.company?.trim() || x.name}
                    </T>
                    <T s="caption" style={{ marginTop: 2 }}>
                      {/* The ladder is named on the row, because which kind of
                          sale this is changes what the next call is about —
                          and it is the one fact about a lead that cannot be
                          guessed from its name. */}
                      {[x.company?.trim() ? x.name : null, x.salesType ? salesTypeLabel(x.salesType as LeadSalesType) : null, x.city, x.source]
                        .filter(Boolean)
                        .join(' · ')}
                    </T>
                  </View>
                  <Badge tone={STAGE_TONE[x.stage] ?? 'neutral'}>{x.stage}</Badge>
                </View>

                <T style={[{ fontSize: 15, marginTop: 10, color: x.estimatedPotentialPaise ? C.ink : C.muted }, weight(500)]}>
                  {x.estimatedPotentialPaise
                    ? inr(x.estimatedPotentialPaise / 100) + ' a month, he reckons'
                    : 'Worth not estimated yet'}
                </T>

                <T style={{ fontSize: 14, lineHeight: 20, marginTop: 4, color: overdue ? C.danger : C.muted }}>
                  {x.nextFollowUpDate ? 'Next ' + pretty(x.nextFollowUpDate) : 'No follow-up set'}
                </T>

                {alert ? (
                  <T style={[{ fontSize: 14, lineHeight: 20, marginTop: 4, color: C.warnInk }, weight(500)]}>{alert}</T>
                ) : null}

                {/* "Visit 2 / 3" — §B. Drawn only where it means something: a
                    qualified prospect visited a fourth time is a negotiation,
                    not a stall, and carries no counter at all. */}
                {capCfg && visitCapLabel(x.stage, x.visitCount, capCfg) ? (
                  <T
                    style={[
                      {
                        fontSize: 14,
                        lineHeight: 20,
                        marginTop: 4,
                        color:
                          visitCapState(x.stage, x.visitCount, capCfg) === 'decide'
                            ? C.warnInk
                            : C.muted,
                      },
                      weight(500),
                    ]}>
                    {visitCapLabel(x.stage, x.visitCount, capCfg)}
                    {visitCapState(x.stage, x.visitCount, capCfg) === 'decide'
                      ? ' · a decision is due'
                      : ''}
                  </T>
                ) : null}

                {/* Why it is not moving. On a held lead this is the whole point
                    of the status — without it "On hold" reads as "forgotten". */}
                {x.holdReason ? (
                  <T s="caption" style={{ marginTop: 4 }} numberOfLines={2}>
                    {'Waiting: ' + x.holdReason}
                  </T>
                ) : null}

                {x.archived ? <T s="caption" style={{ marginTop: 4 }}>Archived — still here, just out of the way</T> : null}
              </Card>
            </Pressable>
          );
        })}
      </View>

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
            {SALES_TYPES.map((t) => (
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
            {LEAD_SOURCES.map((s) => (
              <Choice key={s} label={s} selected={source === s} onPress={() => setSource(s)} style={{ paddingHorizontal: 14 }} />
            ))}
          </View>
        </View>

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

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
          <SecondaryButton label="Cancel" onPress={() => setFormOpen(false)} style={{ flex: 1, borderRadius: radius.xl }} />
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
    </AppFrame>
  );
}
