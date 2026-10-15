import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runs32BitOnly, updateVerdict } from './app-update';

const ok = { version: '1.5.0', versionCode: 6, url: 'https://one.mahekindia.com/downloads/mbos.apk' };

describe('whether to offer an update', () => {
  it('offers a genuinely newer build', () => {
    const v = updateVerdict(ok, 5);
    assert.equal(v.kind, 'available');
    assert.equal(v.kind === 'available' && v.version, '1.5.0');
  });

  /* `versionCode` is what Android compares, and the name sorts wrong the
     moment there is a 1.10.0 to hold against a 1.9.0. */
  it('compares the code and not the name', () => {
    assert.equal(updateVerdict({ ...ok, version: '1.9.0', versionCode: 9 }, 10).kind, 'current');
    assert.equal(updateVerdict({ ...ok, version: '1.10.0', versionCode: 11 }, 10).kind, 'available');
  });

  it('says nothing about the build it is already running', () => {
    assert.equal(updateVerdict(ok, 6).kind, 'current');
  });

  /* Almost always a handset newer than what is published — somebody testing,
     or a publish part way through. Offering to take him backwards would be
     wrong even if he accepted. */
  it('never offers a downgrade', () => {
    assert.equal(updateVerdict(ok, 7).kind, 'current');
  });

  /*
   * A CARD THAT APPEARS ON A BAD READ IS ONE PEOPLE LEARN TO DISMISS, and
   * this card has exactly one job: to be read the first time.
   */
  it('says nothing on anything it cannot trust', () => {
    for (const bad of [
      null,
      undefined,
      'not json',
      {},
      { version: '1.5.0', url: ok.url },
      { ...ok, versionCode: '6' },
      { ...ok, versionCode: Number.NaN },
      { ...ok, url: 'http://one.mahekindia.com/downloads/mbos.apk' },
      { ...ok, url: 42 },
    ]) {
      assert.equal(updateVerdict(bad, 5).kind, 'current', JSON.stringify(bad));
    }
  });

  /* Plain http is an APK over a link anybody on the same wifi can rewrite,
     which is a worse outcome than not updating at all. */
  it('refuses a plain-http download outright', () => {
    assert.equal(updateVerdict({ ...ok, url: 'http://x/mbos.apk' }, 1).kind, 'current');
  });

  it('cannot know it is behind when it cannot say what it is', () => {
    assert.equal(updateVerdict(ok, null).kind, 'current');
  });

  it('falls back to the code where the name is missing', () => {
    const v = updateVerdict({ versionCode: 6, url: ok.url }, 5);
    assert.equal(v.kind === 'available' && v.version, '6');
  });
});

describe('which APK a phone is handed', () => {
  const both = { ...ok, url32: 'https://one.mahekindia.com/downloads/mbos-32bit.apk' };

  it('reads a 32-bit-only Android from the ABIs it reports', () => {
    assert.equal(runs32BitOnly(['arm64-v8a', 'armeabi-v7a', 'armeabi']), false);
    assert.equal(runs32BitOnly(['armeabi-v7a', 'armeabi']), true);
    assert.equal(runs32BitOnly([]), false);
    assert.equal(runs32BitOnly(null), false);
    assert.equal(runs32BitOnly(['x86_64']), false);
  });

  it('gives a 64-bit phone the 64-bit build', () => {
    const v = updateVerdict(both, 5, false);
    assert.equal(v.kind === 'available' && v.url, ok.url);
  });

  it('gives a 32-bit phone the 32-bit build', () => {
    const v = updateVerdict(both, 5, true);
    assert.equal(v.kind === 'available' && v.url, both.url32);
  });

  /* The 64-bit file would download, fail to install, and teach him the card is broken. */
  it('offers a 32-bit phone nothing when no 32-bit build is published', () => {
    assert.equal(updateVerdict(ok, 5, true).kind, 'current');
    assert.equal(updateVerdict({ ...ok, url32: 'http://x/mbos-32bit.apk' }, 5, true).kind, 'current');
  });
});
