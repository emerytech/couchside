# Setup sharing and the 1,000-unlock celebration

Status: implementation branch only; no deployment, release, email, entry collection or prize commitment.

## First sharing slice

Entry: Setup → Account → Share your Couchside setup. Also reachable at `/share-setup`.

- Select one broad setup type and the Couchside features used.
- Review the exact text before opening the native share sheet, or copy it. Web uses clipboard.
- A separate introduction lets users recommend the app without composing a setup story.
- The showcase action opens an email composer to taylor@couchside.tv. Users add their own story/photos and send themselves. This is not an automatic submission or public gallery.
- No saved box objects, hostnames, IPs, pairing links, tokens, game history, contacts or analytics are read. No purchase or entitlement gate.
- Email explicitly asks for contact before publication and does not imply newsletter signup. Photo attachments are manual; remind users to check for personal details.
- No referral claims, share-success counters or unlock-attribution claims. Android share-sheet completion does not prove a message was sent.
- This slice adds no dependency and makes no agent or purchase changes. Form selections are ephemeral and reset when the screen is recreated.

## Proposed milestone promotion — NOT ACTIVE

Recommendation: celebrate reaching 1,000 verified paid unlocks by opening a separate, fixed-duration, free-entry giveaway. A Steam gift card is a possible prize; amount, currency and delivery region are undecided. No public prize promise or progress count exists in this slice.

Purchases and referrals must not be entry requirements or improve the odds. Keep showcase participation and newsletter consent independent of entry. Do not automatically enter purchasers or existing newsletter subscribers. Do not award chances for reviews, ratings, social shares or friend purchases.

Before implementation or announcement:

1. Choose sponsor identity, prize value/currency, eligible regions and age, start/end dates, selection and notification method, claim period and unclaimed-prize handling. Set a firm end date after opening; do not leave entries waiting indefinitely on sales.
2. Obtain appropriate review of the official rules for those jurisdictions. Apple requires developer sponsorship, rules in the app and a statement that Apple is not involved. Clearly avoid implying Valve/Steam or Google sponsorship too.
3. Define what counts toward 1,000: reconcile paid Apple/Google transactions and Direct licenses, exclude restores, renewals, test/sandbox transactions, promo/free licenses and refunds; account for cross-channel duplication where verifiable. Do not count downloads or installations as paid unlocks. Record report coverage and uncertainty; never invent a live count.
4. Build a private admin draft → verified → approved → open → closed → draw reviewed → awarded lifecycle. No threshold-triggered launch, automatic email, draw or prize purchase. Keep aggregate milestone reporting separate from entrant personal data.
5. Add a free entry route with clear rules/privacy notice, minimal data, duplicate/abuse controls and deletion/retention policy. Newsletter consent is optional and separate. No public entrant list.
6. Review actual Google Play treatment before putting entry mechanics inside a gaming companion app. Default proposal is a separate website celebration; that is not an exemption from store or sweepstakes rules.
7. Test close-time enforcement, duplicate entries, consent separation, access control, audit trail, winner eligibility and manual approval. Publish only after owner authorization.

## Policy references reviewed November 10, 2026

- FTC small-business advertising FAQ, contests/sweepstakes: https://www.ftc.gov/business-guidance/resources/advertising-faqs-guide-small-business
- Apple App Review Guidelines §5.3: https://developer.apple.com/app-store/review/guidelines/
- Google Play Real-Money Gambling, Games, and Contests / loyalty policy: https://support.google.com/googleplay/android-developer/answer/9877032

These references inform the design; they are not a legal eligibility determination or store approval.
