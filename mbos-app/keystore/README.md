# The MBOS release signing key

`mbos-release.keystore` is the one and only key MBOS release builds are
signed with, from 2026-09-05 onward. Android can only upgrade an app in
place when the new APK is signed with the exact same key as the one already
on the phone; a different key means every update is a fresh install, wiping
the salesman's local data and session first.

Before this existed, every release build was signed with whatever ambient
`~/.android/debug.keystore` happened to be on the machine that ran the
build — a per-machine, easily-regenerated file with no connection to this
repo. Two builds from two different machines (or one machine after that file
was ever deleted) would silently produce two APKs Android treats as two
different apps.

**The keystore file is committed. Its password is not.** `mbos-release.keystore.properties`
(storePassword / keyPassword / keyAlias) lives only on the machine that
generated it — `.gitignore` keeps it out. A signing key in a private repo is
a reasonable trade for a sideloaded internal app; a live password sitting in
git history forever is a different kind of risk for no real benefit here, so
it stays local. **Save a copy of that file somewhere durable yourself** — a
password manager, a secrets vault, wherever your team keeps things that must
never be lost — because losing it means every future MBOS release has to be
a fresh install for everyone who already has the app, exactly the problem
this whole setup exists to avoid.

**`plugins/withReleaseSigning.js`** is what makes this stick: `android/` is
gitignored and rebuilt from scratch by `expo prebuild` every time, which
would otherwise erase any signing config edited by hand. The plugin
re-applies the signing config to the freshly generated `android/app/build.gradle`
on every prebuild, pointing at this same keystore file and reading its
password from the local `.properties` file — so the signature is stable no
matter how many times the app gets rebuilt, on any machine that has both the
keystore and its password.

**Do not delete or regenerate this keystore.** If its password is ever lost,
the least-bad recovery is telling the field team to uninstall and reinstall
once, then treating whatever new key is generated as the new permanent one.
