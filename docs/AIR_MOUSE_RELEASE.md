# Air Mouse release candidate

Owner authorized release publication on November 7, then selected Air Mouse, BG3 MOVE and cursor fling only, with a theme/polish audit before shipping. Subscriber sends remain separately approved.

## Scope and provenance

This branch starts at public v2.9.81 and applies the accepted Air Mouse feature delta from 464c1cb, plus release polish. It excludes the new OpenPuck/Ports candidate in PR664 and its phone UI. Baseline reconciliation found that public Decky v0.2.102 already bundled the older Ports catalog API, although the raw Linux v2.9.81 asset did not. That existing agent API and its catalog fixture are retained to avoid removing functionality from Decky users; none of the newer Ports verification/job changes are included. This release branch must not be merged into main as a Ports removal; those future changes remain on their own branches. Publish from the frozen reviewed release commit after its gates pass.

Includes phone gyro pointing for boxes and LG TV remotes, four-target setup, BG3 keyboard/mouse-only MOVE, shared touchpad/gyro handoff, opt-in cursor fling with quick toggle and distance, and Back/handoff safe-area fixes. Linear response is standard; Pointing speed remains configurable. Fling stays OFF by default. Licenses, private administration and subscriber data are unchanged.

## Gates

- Theme review: match switches/selected text to existing palette tokens, inspect light/dark, accent, narrow/wide and larger text; verify fan/keyboard/safe-area placement. Source changes require final native smoke.
- Source: TypeScript and full app tests; agent security/protocol and exact release-head CI. The final app source d39474e passed exact-head hosted CI, including TypeScript and app/agent checks.
- Windows: actual new candidate keyboard/mouse-only handshake, leased WASD release and foreground-privilege refusal; guided setup/installer upgrade smoke. Preserve the existing unsigned installer policy and pairing/config/TLS identity. Signing experiments remain excluded.
- Allocate fresh versions/build numbers from live state. Build production iOS through EAS cloud; Play and Direct use separate sequences and existing production keys. Gandalf work stays under guarded /tank/build-storage.
- Verify signatures/package identities, Android maps/checksums, in-place upgrades and focused actual production-binary smoke. Preview 302 and Air QA do not certify newly built store artifacts.
- Bundle exact Linux source into Decky; verify offline-signed complete assets before public agent/Decky publication. Stage rollback.
- Publish approved channels in dependency order, then website and update checkers only after their downloads/channels are available. Track App Review, store processing and public availability separately. Never send subscriber emails as a release side effect.

Nothing has been published from this release branch yet.

## November 7 release preparation

Scoped source 6c1da90 passed hosted CI and all 907 app tests. The six-test dependency guard also passes. Compact 360×800 light and dark preferences were visually reviewed, including selected-text contrast and wrapped controls. A narrow status-message layout in the AIR fan was corrected during the review; native smoke of that correction remains required.

Fresh candidate allocation: app 2.9.82, iOS 305, Play 134, Direct 69; Linux agent 2.9.138; Windows 0.4.17-win. These deliberately skip the separate held OpenPuck/Ports artifacts. Live Play production was 129 and App Store was 2.9.81; latest internal iPhone preview was 302. Allocated numbers are not proof of a completed build or publication.

Windows candidate source is tracked separately on codex/air-mouse-0.4.17, based on public v0.4.15-win with only the scoped agent delta. Its workflow builds private acceptance artifacts without a release tag. The final installer artifact passed upgrade preservation and native input acceptance; see the checkpoint below.

Public baseline reconciliation: raw Linux v2.9.81 matches its tag, but Decky v0.2.102 includes the older catalog API. The new Linux/Decky agent therefore preserves that published API while adding the Air Mouse delta. This is compatibility preservation, not integration of PR664. Both packages must carry the same reconciled agent bytes.

Windows installer 0.4.17 acceptance passed on the owner-approved PC: saved config, pairing and TLS hashes unchanged; normal-privilege startup task retained; installed executable matches the workflow artifact. Native key-delivery acceptance subsequently passed against the final retry-safe executable, using a disposable foreground test window.

Final safety/polish follow-up: retain failed camera key-ups for retry rather than forgetting a held key, with fault/recovery and new-holder regression checks on both agents. Air Mouse preferences dismiss the search keyboard on entry. Phone 303/Direct 67 smoke established secure reconnection and preserved settings; the keyboard-dismissal correction and update introduction are in final 305/134/69 candidates. No public release precedes final artifact verification.

Update onboarding: a compact Air Mouse card on Console and Setup introduces pointing and links to preferences. Opening or dismissing retires it persistently; fresh installs are excluded after hydration. The card never occupies a controller/remote surface or changes pointing settings. Phone allocation 305/134/69 includes this owner-requested introduction.

## Final candidate acceptance checkpoint

Phone binaries were built from d39474e: iOS 305, Play 134 and Direct 69, all 2.9.82. Exact-head hosted CI passed. Actual package identities and existing signing identities were verified; Android Hermes maps and bytecode hashes are retained with the artifacts. Apple processed 305 successfully.

Direct 69 passed an in-place device update: saved boxes and secure reconnection survived, the compact update card appeared, and dismissing it persisted through a full app restart. Air Mouse settings dismiss the search keyboard and retain pointing/fling preferences. iPhone 305 installation and the new card's native link/dismissal smoke remain pending at this checkpoint; earlier 303 physical pointing, touchpad, Preferences and Home/resume checks passed with the same input implementation.

The final Windows 0.4.17 installer preserved config, pairing and TLS identity and retained normal-privilege startup. Its actual installed executable passed 13 native assertions, including simultaneous/independent camera-key releases, timeout and disconnect cleanup, and Unicode text. The temporary input-test task was removed. Windows remains unsigned under the existing release policy.

Linux 2.9.138's final retry-safe source passed live HTTPS/capability/WebSocket checks without injecting input. Decky 0.2.104 bundles exactly the same source. Complete Linux/Decky assets have verified offline signatures against the installer's trusted public keys. These are staged acceptance results, not a statement of publication. Subscriber emails remain separately approved.

## Android permission correction after Play validation

Play's release-specific validation detected ACTIVITY_RECOGNITION inherited from expo-sensors' pedometer manifest. Couchside uses gyroscope pointing, has no health features and does not use the pedometer. The Android config now blocks that permission using Expo's manifest-merger removal support. Rebuild Play 135 and Direct 70, verify the actual packaged manifests omit the permission, and repeat a focused Direct upgrade/gyro smoke before publishing those replacement Android builds. iOS 305 and the agent artifacts are unchanged. Public tags and previously published artifacts must retain their original provenance; do not rewrite or silently replace build 69.
