# Optional news and manual release digest

`app/components/NewsletterCard.tsx` owns the signup entry points. Setup > Boxes
shows a non-modal invitation after the welcome flow is exited and a box is paired
or a direct TV is saved. It waits for saved device state. The onboarding preference
also gates first presentation so an existing dismissed preference cannot flash
while preferences hydrate. Setup > Account always has the signup link, regardless
of dismissal, purchase state, or whether a device is configured.

“No thanks” and successfully opening signup set `newsletterInviteDismissed` in the
existing local preferences. Replaying onboarding does not reset that choice.
Opening the browser does not subscribe anyone: the website still requires explicit
consent and email confirmation. There are no email fields or automatic network
requests in the card. Storage-unavailable sessions retain the choice in memory.
Browser failure leaves the card available with a readable fallback URL.

## Release checklist: optional, separate operator step

After app-store/direct/agent/website availability is verified, offer to bundle the
published changes into the next newsletter. The tooling is in the ETS3D website
repository: `scripts/newsletter-digest.mjs` and `docs/couchside-release-digest.md`.
Never call its `test` or `send` commands from builds, GitHub Actions, release hooks,
or a scheduled task. “Release the app” does **not** authorize an email campaign.

1. Add reviewed, actually published release highlights to the pending digest.
2. Generate the HTML/text preview and report the confirmed audience count.
3. Ask Taylor to approve a test email to the configured operator address.
4. Present the test result and final content, and obtain a **separate explicit
   approval** to send that digest to confirmed subscribers.
5. Record the campaign receipt. New improvements accumulate for a later digest;
   the sender enforces seven days between completed campaigns.

This change does not publish a new app binary or enable campaign sending.
