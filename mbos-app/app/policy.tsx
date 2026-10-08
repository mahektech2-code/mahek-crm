import React from 'react';
import { View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, T } from '../src/components/ui/primitives';
import { Stagger } from '../src/components/ui/motion';
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
    <AppFrame title="Expense policy" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 32 }}>
      <BackLink label={back.label} onPress={back.go} />
      <T s="h1">What you are allowed</T>

      {policy === undefined ? (
        <Card style={{ marginTop: 14, paddingVertical: 28 }}>
          <T s="small" style={{ color: C.muted, textAlign: 'center' }}>Loading…</T>
        </Card>
      ) : policy === null ? (
        <Card style={{ marginTop: 14, paddingVertical: 28 }}>
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
          <T s="small" style={{ color: C.muted, marginTop: 2, marginBottom: 14 }}>
            Version {policy.versionNo}, used from {dmy(policy.effectiveFrom)}
            {policy.subject.grade ? ` · your grade: ${policy.subject.grade.replace(/_/g, ' ')}` : ''}
          </T>

          {policy.sentences.length === 0 ? (
            <Card>
              <T s="small" style={{ color: C.muted }}>
                No rules in this version are for you.
              </T>
            </Card>
          ) : (
            /* The rules arrive one after another, so they read as a list of
               separate rules rather than one block of text. */
            policy.sentences.map((sentence, i) => (
              <Stagger key={i} index={i}>
                <Card style={{ marginBottom: 8 }}>
                  <T s="small" style={{ color: C.ink }}>{sentence}</T>
                </Card>
              </Stagger>
            ))
          )}

          <View style={{ marginTop: 14 }}>
            <T s="caption">
              Your day is paid using these same rules, on this phone and in the office.
              If an amount looks wrong, show these rules.
            </T>
          </View>
        </>
      )}
    </AppFrame>
  );
}
