# AIR hold-to-center preview

Tap AIR to open or close its fan. Hold for 550 ms to center the box cursor and re-align the phone, with preference-aware haptic feedback. The fan crosshair offers the same action. Air Mouse's ON/OFF intent is preserved; centering also works while it is OFF. Fling momentum and queued relative moves are cancelled, and gyro is held during the operation and long press.

The first implementation supports SteamOS Game Mode through the existing authenticated holder-only `gm` absolute-pointer command. It probes the current session, checks target/focus/ownership again after that asynchronous probe, and sends one normalized `(0.5, 0.5)` movement with no click or replay. Older/unsupported box sessions fail explicitly. LG TV controls only re-align the phone; the TV pointer interface is relative and does not provide absolute centering. Desktop/Windows centering is not claimed.

Backend movement-only validation on the Steam Machine's 3840 by 2160 display observed the cursor at exactly 1920 by 1080. Unit checks cover the center coordinate, unsupported sessions, probe failures, inactive surfaces, and target/ownership loss during a probe. Existing Air Mouse, gesture/intent and cursor-fling checks plus TypeScript passed.

This is included in internal TestFlight preview 309, after installed iPhone 308. Native acceptance must verify short-tap versus hold, haptics, OFF-state centering, no fan toggle after a hold, continued gyro/touchpad handoff, and cancellation on navigation/background/ownership changes. Nothing is released.
