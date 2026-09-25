/* ---------------------------------------------------------------------------
 * THE MODEL THAT LEARNS FROM OUR OWN CALLS.
 *
 * Every call ever logged in MahekOne is a labelled example: the note somebody
 * typed, and the outcome they chose for it. That is training data nobody had
 * to label, in the office's own shorthand — "NR", "rate jyada hai", "maal
 * pahuch gaya lekin dabba toota" — which no general-purpose model has seen.
 *
 * This is a multinomial Naive Bayes over words and word pairs. It is not
 * clever and it does not need to be: it is trained nightly from the calls
 * table in seconds, stored as a row, answers with no network and no key, and
 * its job is narrow. It VOTES on which outcome a call was. Where it confidently
 * disagrees with the language model the card asks the telecaller instead of
 * filling, and where no language model is configured at all it is what still
 * points the telecaller at the right form.
 *
 * What it cannot do is extract anything — no dates, no amounts, no products.
 * Those come from the language model and the rules, and this never pretends
 * otherwise.
 *
 * PURE: examples in, a JSON model out; a model and text in, a ranking out.
 * ------------------------------------------------------------------------- */

export type ClassifierModel = {
  version: 1;
  labels: string[];
  /** How many training notes carried each label. */
  docCounts: Record<string, number>;
  /** Per label, how often each kept token appeared. */
  tokenCounts: Record<string, Record<string, number>>;
  /** Per label, the total of its token counts — the NB denominator. */
  totalTokens: Record<string, number>;
  vocabularySize: number;
  trainedOn: number;
};

export type Example = { text: string; label: string };

export type Prediction = { label: string; probability: number };

/**
 * Words and adjacent pairs. Numbers collapse to `#` so "15 din baad" and
 * "10 din baad" teach the same thing; Devanagari is kept whole.
 */
export function tokenize(text: string): string[] {
  const words = text
    .normalize("NFC")
    .toLowerCase()
    .replace(/\d+(?:[.,]\d+)*/g, " # ")
    .split(/[^\p{L}\p{M}#]+/u)
    .filter((w) => w.length >= 2 || w === "#");
  const out = [...words];
  for (let i = 0; i + 1 < words.length; i++)
    out.push(`${words[i]}_${words[i + 1]}`);
  return out;
}

export function train(
  examples: Example[],
  { minTokenCount = 2 }: { minTokenCount?: number } = {},
): ClassifierModel {
  const labels = [...new Set(examples.map((e) => e.label))].sort();
  const docCounts: Record<string, number> = {};
  const raw: Record<string, Map<string, number>> = {};
  const overall = new Map<string, number>();
  for (const l of labels) {
    docCounts[l] = 0;
    raw[l] = new Map();
  }

  for (const e of examples) {
    docCounts[e.label]++;
    for (const t of tokenize(e.text)) {
      raw[e.label].set(t, (raw[e.label].get(t) ?? 0) + 1);
      overall.set(t, (overall.get(t) ?? 0) + 1);
    }
  }

  /* A token seen once in the whole book is a typo or a name: it cannot
     generalise, and keeping it makes the stored model grow with the book. */
  const kept = new Set(
    [...overall].filter(([, n]) => n >= minTokenCount).map(([t]) => t),
  );

  const tokenCounts: Record<string, Record<string, number>> = {};
  const totalTokens: Record<string, number> = {};
  for (const l of labels) {
    tokenCounts[l] = {};
    totalTokens[l] = 0;
    for (const [t, n] of raw[l]) {
      if (!kept.has(t)) continue;
      tokenCounts[l][t] = n;
      totalTokens[l] += n;
    }
  }

  return {
    version: 1,
    labels,
    docCounts,
    tokenCounts,
    totalTokens,
    vocabularySize: kept.size,
    trainedOn: examples.length,
  };
}

/** Every label, most likely first, probabilities summing to one. */
export function predict(model: ClassifierModel, text: string): Prediction[] {
  if (!model.labels.length) return [];
  const tokens = tokenize(text);
  const total = model.trainedOn || 1;
  const v = model.vocabularySize + 1;

  const logs = model.labels.map((label) => {
    let score = Math.log(
      (model.docCounts[label] + 1) / (total + model.labels.length),
    );
    const counts = model.tokenCounts[label];
    const denom = model.totalTokens[label] + v;
    for (const t of tokens) {
      /* Tokens the model never kept carry no evidence either way — scoring
         them would just penalise the larger labels for having more words. */
      if (!isKnown(model, t)) continue;
      score += Math.log(((counts[t] ?? 0) + 1) / denom);
    }
    return { label, score };
  });

  const max = Math.max(...logs.map((l) => l.score));
  const exps = logs.map((l) => ({
    label: l.label,
    e: Math.exp(l.score - max),
  }));
  const sum = exps.reduce((s, x) => s + x.e, 0);
  return exps
    .map((x) => ({ label: x.label, probability: x.e / sum }))
    .sort((a, b) => b.probability - a.probability);
}

function isKnown(model: ClassifierModel, token: string): boolean {
  for (const l of model.labels)
    if (model.tokenCounts[l][token] !== undefined) return true;
  return false;
}

export type Evaluation = {
  examples: number;
  accuracy: number;
  /** Accuracy counting only predictions at or above the confidence floor. */
  confidentAccuracy: number;
  /** Share of examples the model was confident enough to vote on. */
  coverage: number;
  perLabel: Record<
    string,
    { support: number; precision: number; recall: number }
  >;
  /** actual → predicted → count. */
  confusion: Record<string, Record<string, number>>;
};

/**
 * K-fold cross-validation, deterministic: fold membership is the example's
 * position, so the same book gives the same figure every night and a change
 * in the figure means a change in the book.
 */
export function crossValidate(
  examples: Example[],
  {
    folds = 5,
    confidentAt = 0.7,
  }: { folds?: number; confidentAt?: number } = {},
): Evaluation {
  const confusion: Record<string, Record<string, number>> = {};
  let right = 0;
  let confident = 0;
  let confidentRight = 0;

  for (let f = 0; f < folds; f++) {
    const trainSet = examples.filter((_, i) => i % folds !== f);
    const testSet = examples.filter((_, i) => i % folds === f);
    if (!trainSet.length || !testSet.length) continue;
    const model = train(trainSet);
    for (const e of testSet) {
      const [top] = predict(model, e.text);
      const got = top?.label ?? "(none)";
      confusion[e.label] ??= {};
      confusion[e.label][got] = (confusion[e.label][got] ?? 0) + 1;
      if (got === e.label) right++;
      if (top && top.probability >= confidentAt) {
        confident++;
        if (got === e.label) confidentRight++;
      }
    }
  }

  const labels = [...new Set(examples.map((e) => e.label))];
  const perLabel: Evaluation["perLabel"] = {};
  for (const l of labels) {
    const support = Object.values(confusion[l] ?? {}).reduce(
      (s, n) => s + n,
      0,
    );
    const tp = confusion[l]?.[l] ?? 0;
    const predicted = Object.values(confusion).reduce(
      (s, row) => s + (row[l] ?? 0),
      0,
    );
    perLabel[l] = {
      support,
      precision: predicted ? tp / predicted : 0,
      recall: support ? tp / support : 0,
    };
  }

  const n = examples.length || 1;
  return {
    examples: examples.length,
    accuracy: right / n,
    confidentAccuracy: confident ? confidentRight / confident : 0,
    coverage: confident / n,
    perLabel,
    confusion,
  };
}
