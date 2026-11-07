# Air Mouse release candidate

Owner authorized release publication on November 7, then selected Air Mouse, BG3 MOVE and cursor fling only, with a theme/polish audit before shipping. Subscriber sends remain separately approved.

## Scope and provenance

This branch starts at public v2.9.81 and applies the accepted Air Mouse feature delta from 464c1cb, plus release polish. It excludes the new OpenPuck/Ports candidate in PR664 and its phone UI. Baseline reconciliation found that public Decky v0.2.102 already bundled the older Ports catalog API, although the raw Linux v2.9.81 asset did not. That existing agent API and its catalog fixture are retained to avoid removing functionality from Decky users; none of the newer Ports verification/job changes are included. This release branch must not be merged into main as a Ports removal; those future changes remain on their own branches. Publish from the frozen reviewed release commit after its gates pass.

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

## November 7 release preparation

Scoped source 6c1da90 passed hosted CI and all 907 app tests. The six-test dependency guard also passes. Compact 360×800 light and dark preferences were visually reviewed, including selected-text contrast and wrapped controls. A narrow status-message layout in the AIR fan was corrected during the review; native smoke of that correction remains required.

Fresh candidate allocation: app 2.9.82, iOS 303, Play 132, Direct 67; Linux agent 2.9.138; Windows 0.4.17-win. These deliberately skip the separate held OpenPuck/Ports artifacts. Live Play production was 129 and App Store was 2.9.81; latest internal iPhone preview was 302. Allocated numbers are not proof of a completed build or publication.

Windows candidate source is tracked separately on codex/air-mouse-0.4.17, based on public v0.4.15-win with only the scoped agent delta. Its workflow builds private acceptance artifacts without a release tag. Installer acceptance and final package checks remain pending.

Public baseline reconciliation: raw Linux v2.9.81 matches its tag, but Decky v0.2.102 includes the older catalog API. The new Linux/Decky agent therefore preserves that published API while adding the Air Mouse delta. This is compatibility preservation, not integration of PR664. Both packages must carry the same reconciled agent bytes.

Windows installer 0.4.17 acceptance passed on the owner-approved PC: saved config, pairing and TLS hashes unchanged; normal-privilege startup task retained; installed executable matches the workflow artifact. Native key-delivery acceptance is pending because the Windows desktop session is disconnected. The test safely refused to send input without a foreground target.
