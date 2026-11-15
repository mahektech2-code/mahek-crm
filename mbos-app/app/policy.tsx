import React from 'react';
import { View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, T } from '../src/components/ui/primitives';
import { Stagger } from '../src/components/ui/motion';
import { dmy } from '../src/lib/format';
import { color as C, weight } from '../src/theme/tokens';
import { activePolicy, type LocalPolicy } from '../src/data/travel';
import { GLYPH, Glyph, HeroPill, type GlyphShape } from '../src/components/me/kit';

/**
 * What you are allowed.
 *
 * The whole policy, as sentences, on the phone of the person it applies to.
 *
 * **This screen is the answer to an argument.** A salesman who is paid less
 * than he expected has, until now, had no way to find out what the rule
 * actually was — he asks his manager, who asks accounts, and three days later
 * somebody reads a PDF. The sentences here are generated from the same rules
 * the money is computed from, so they cannot say something the payment does
 * not do.
 *
 * It shows the VERSION and the date it came into force, because the commonest
 * cause of a disagreement is a rule that changed and a phone that had not yet
 * heard.
 */
export default function PolicyScreen() {
  const back = useCameFrom('more');
  const [policy, setPolicy] = React.useState<LocalPolicy | null | undefined>(undefined);

  useFocusEffect(
    React.useCallback(() => {
      let live = true;
      void activePolicy().then((p) => {
        if (live) setPolicy(p);
      });
      return () => {
        live = false;
      };
    }, []),
  );

  const hero =
    policy ? (
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 14 }}>
        <HeroPill strong>Version {policy.versionNo}</HeroPill>
        <HeroPill icon={GLYPH.cal}>
          {`From ${dmy(policy.effectiveFrom)}`}
        </HeroPill>
        {policy.subject.grade ? (
          <HeroPill ink={C.primaryDeep}>{`Your grade: ${policy.subject.grade.replace(/_/g, ' ')}`}</HeroPill>
        ) : null}
      </View>
    ) : null;

  return (
    <AppFrame
      title="What you are allowed"
      activeTab={null}
      onBack={back.go}
      hero={hero}
      contentStyle={{ padding: 14, paddingBottom: 32 }}>
      <BackLink label={back.label} onPress={back.go} />

      {policy === undefined ? (
        <Card style={{ paddingVertical: 28 }}>
          <T s="small" style={{ color: C.muted, textAlign: 'center' }}>Loading…</T>
        </Card>
      ) : policy === null ? (
        <Card style={{ paddingVertical: 28 }}>
          <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center' }, weight(600)]}>
            No policy on this phone yet
          </T>
          <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 4 }}>
            The office has not sent one, or this phone has not got it yet. Everything you add is
            saved. The office will work out the amount when the policy comes.
          </T>
        </Card>
      ) : (
        <>
          {policy.sentences.length === 0 ? (
            <Card>
              <T s="small" style={{ color: C.muted }}>
                No rules in this version are for you.
              </T>
            </Card>
          ) : (
            /* The rules arrive one after another, so they read as a list of
               separate rules rather than one block of text. */
            policy.sentences.map((sentence, i) => {
              const g = ruleGlyph(sentence);
              return (
                <Stagger key={i} index={i}>
                  <Card style={{ marginBottom: 8, paddingVertical: 14, flexDirection: 'row', gap: 12 }}>
                    <Glyph shapes={g.shapes} size={20} color={g.color} />
                    <T s="small" style={{ color: C.ink, flex: 1 }}>{sentence}</T>
                  </Card>
                </Stagger>
              );
            })
          )}

          <View style={{ flexDirection: 'row', gap: 8, paddingTop: 6, paddingHorizontal: 6 }}>
            <Glyph shapes={GLYPH.shieldTick} size={16} color={C.success} />
            <T style={{ flex: 1, fontSize: 12, lineHeight: 17, color: C.muted }}>
              The same rules pay your day here and in the office. An amount looks wrong? Show these rules.
            </T>
          </View>
        </>
      )}
    </AppFrame>
  );
}

/**
 * The mark beside a rule. The sentences are generated on the server and carry
 * no kind, so the glyph is read off the words — and a sentence nothing matches
 * gets the plain receipt, never a wrong picture.
 */
function ruleGlyph(sentence: string): { shapes: GlyphShape[]; color: string } {
  const t = sentence.toLowerCase();
  if (/breakfast/.test(t)) return { shapes: GLYPH.breakfast, color: C.primaryDeep };
  if (/lunch|meal|food/.test(t)) return { shapes: GLYPH.bowl, color: C.primaryDeep };
  if (/dinner/.test(t)) return { shapes: GLYPH.moon, color: C.primaryDeep };
  if (/hotel|lodg/.test(t)) return { shapes: GLYPH.bed, color: C.primaryDeep };
  if (/dorm/.test(t)) return { shapes: GLYPH.bunk, color: C.primaryDeep };
  if (/bus|train|auto|taxi|travel|fare/.test(t)) return { shapes: GLYPH.bus, color: C.primaryDeep };
  if (/bike|car|kilomet|\bkm\b/.test(t)) {
    return { shapes: GLYPH.bike, color: /not paid/.test(t) ? C.faint : C.primaryDeep };
  }
  return { shapes: GLYPH.receipt, color: C.warnInk };
}
