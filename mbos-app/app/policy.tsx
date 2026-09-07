import React from 'react';
import { View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, T } from '../src/components/ui/primitives';
import { dmy } from '../src/lib/format';
import { color as C, weight } from '../src/theme/tokens';
import { activePolicy, type LocalPolicy } from '../src/data/travel';

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

  return (
    <AppFrame title="MBOS" activeTab={null} contentStyle={{ padding: 16, paddingBottom: 32 }}>
      <BackLink label={back.label} onPress={back.go} />
      <T s="h1">What you are allowed</T>

      {policy === undefined ? null : policy === null ? (
        <Card style={{ marginTop: 14, paddingVertical: 28 }}>
          <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center' }, weight(600)]}>
            No policy on this phone yet
          </T>
          <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 4 }}>
            Either the office has not published one, or this phone has not synced since it did.
            Everything you record is kept meanwhile — the office works out what it is worth when it
            arrives.
          </T>
        </Card>
      ) : (
        <>
          <T s="small" style={{ color: C.muted, marginTop: 2, marginBottom: 14 }}>
            Version {policy.versionNo}, in force since {dmy(policy.effectiveFrom)}
            {policy.subject.grade ? ` · your grade: ${policy.subject.grade.replace(/_/g, ' ')}` : ''}
          </T>

          {policy.sentences.length === 0 ? (
            <Card>
              <T s="small" style={{ color: C.muted }}>
                This version has no rules that apply to you.
              </T>
            </Card>
          ) : (
            policy.sentences.map((sentence, i) => (
              <Card key={i} style={{ marginBottom: 8 }}>
                <T s="small" style={{ color: C.ink }}>{sentence}</T>
              </Card>
            ))
          )}

          <View style={{ marginTop: 14 }}>
            <T s="caption">
              These are the same rules your day is priced against — on this phone and in the office.
              If a figure looks wrong, this is what to quote.
            </T>
          </View>
        </>
      )}
    </AppFrame>
  );
}
