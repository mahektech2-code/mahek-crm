import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { answerLanguageKey, answerLanguageNote, languageName, voiceSchema } from "./ask-voice";

describe("languageName", () => {
  it("reads Sarvam's tags and OpenAI's words alike", () => {
    assert.equal(languageName("hi-IN"), "Hindi");
    assert.equal(languageName("mr-IN"), "Marathi");
    assert.equal(languageName("gu"), "Gujarati");
    assert.equal(languageName("hindi"), "Hindi");
    assert.equal(languageName("MARATHI"), "Marathi");
  });
  it("answers null rather than inventing a language", () => {
    assert.equal(languageName(null), null);
    assert.equal(languageName(""), null);
    assert.equal(languageName("12-34"), null);
  });
});

describe("answerLanguageNote", () => {
  it("is empty for a typed question", () => {
    assert.equal(answerLanguageNote(null), "");
    assert.equal(answerLanguageNote({ spoken: "  ", language: "hi-IN" }), "");
  });
  it("is empty for English speech — the model already answers English in English", () => {
    assert.equal(answerLanguageNote({ spoken: "who owes the most", language: "en-IN" }), "");
    assert.equal(answerLanguageNote({ spoken: "who owes the most", language: "english" }), "");
  });
  it("names the language and carries what was actually said", () => {
    const note = answerLanguageNote({ spoken: "सबसे ज़्यादा बकाया किसका है?", language: "hi-IN" });
    assert.match(note, /in Hindi/);
    assert.match(note, /सबसे ज़्यादा बकाया किसका है\?/);
    assert.match(note, /not in English/);
  });
  it("still asks for the spoken language when the provider did not name it", () => {
    assert.match(answerLanguageNote({ spoken: "kitna stock hai", language: null }), /the language they spoke/);
  });
});

describe("answerLanguageKey", () => {
  it("keeps a Hindi answer from being served to an English asker", () => {
    assert.equal(answerLanguageKey(null), "");
    assert.notEqual(answerLanguageKey({ spoken: "x", language: "hi-IN" }), answerLanguageKey({ spoken: "x", language: "mr-IN" }));
  });
});

describe("voiceSchema", () => {
  it("accepts a missing voice and a real one", () => {
    assert.equal(voiceSchema.parse(undefined), undefined);
    assert.deepEqual(voiceSchema.parse({ spoken: " हाँ ", language: "hi-IN" }), { spoken: "हाँ", language: "hi-IN" });
  });
});
