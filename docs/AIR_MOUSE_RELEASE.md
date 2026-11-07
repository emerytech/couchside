# Air Mouse release candidate

Owner authorized release publication on November 7, then selected Air Mouse, BG3 MOVE and cursor fling only, with a theme/polish audit before shipping. Subscriber sends remain separately approved.

## Scope and provenance

This branch starts at public v2.9.81 and applies the accepted Air Mouse feature delta from 464c1cb, plus release polish. It excludes main's unreleased Ports catalog commit 6bc40e2 and the OpenPuck/Ports candidate in PR664. This release branch must not be merged into main as a Ports removal; those future changes remain on their own branches. Publish from the frozen reviewed release commit after its gates pass.

Includes phone gyro pointing for boxes and LG TV remotes, four-target setup, BG3 keyboard/mouse-only MOVE, shared touchpad/gyro handoff, opt-in cursor fling with quick toggle and distance, and Back/handoff safe-area fixes. Linear response is standard; Pointing speed remains configurable. Fling stays OFF by default. Licenses, private administration and subscriber data are unchanged.

## Gates

- Theme review: match switches/selected text to existing palette tokens, inspect light/dark, accent, narrow/wide and larger text; verify fan/keyboard/safe-area placement. Source changes require final native smoke.
- Source: TypeScript and full app tests; agent security/protocol and exact release-head CI. Current pre-version scope passed TypeScript, 907 app tests and selected agent checks; hosted release-head CI pending.
- Windows: actual new candidate keyboard/mouse-only handshake, leased WASD release and foreground-privilege refusal; guided setup/installer upgrade smoke. Preserve the existing unsigned installer policy and pairing/config/TLS identity. Signing experiments remain excluded.
- Allocate fresh versions/build numbers from live state. Build production iOS through EAS cloud; Play and Direct use separate sequences and existing production keys. Gandalf work stays under guarded /tank/build-storage.
- Verify signatures/package identities, Android maps/checksums, in-place upgrades and focused actual production-binary smoke. Preview 302 and Air QA do not certify newly built store artifacts.
- Bundle exact Linux source into Decky; verify offline-signed complete assets before public agent/Decky publication. Stage rollback.
- Publish approved channels in dependency order, then website and update checkers only after their downloads/channels are available. Track App Review, store processing and public availability separately. Never send subscriber emails as a release side effect.

Nothing has been published from this release branch yet.
