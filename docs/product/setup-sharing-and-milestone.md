# Setup sharing and the 1,000-unlock celebration

Status: implementation branch only; no deployment, release, email, entry collection or prize commitment.

## First sharing slice

Entry: Setup → Account → Share your Couchside story. Also reachable at `/share-setup`.

- Three optional written prompts: favorite part, most-used purpose, and desired future additions. At least one answer is required to share.
- Preview the exact answers before opening the native share sheet, or copy them. Web uses clipboard. Answers stay in screen state until the user chooses to share; no automatic submission.
- Showcase/feedback action opens an email composer to taylor@couchside.tv. Users review and send themselves; contact before publication is requested. No newsletter opt-in implied.
- No saved boxes, hostnames, IPs, pairing links, tokens, activity, contacts or analytics are read. Remind users to omit personal details from their own answers.
- No referral claims, share counters or unlock-attribution claims. Android share-sheet completion does not prove a message was sent.
- No dependency, agent or purchase changes. Native phone acceptance remains pending.

## Proposed milestone promotion — NOT ACTIVE

Recommendation: celebrate reaching 1,000 verified paid unlocks by opening a separate, fixed-duration, free-entry giveaway. A Steam gift card is a possible prize; amount, currency and delivery region are undecided. No public prize promise or progress count exists in this slice.

Purchases and referrals must not be entry requirements or improve the odds. Keep showcase participation and newsletter consent independent of entry. Do not automatically enter purchasers or existing newsletter subscribers. Do not award chances for reviews, ratings, Share taps, link clicks or friend purchases. Referral bonuses are a separate proposal below, not implemented or approved.

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

## Referral entry proposal — NOT IMPLEMENTED

User asked about tracking friend sharing on November 10. Track verified free-entry referrals, not alleged shares:

- One base free entry per eligible verified person. Optional capped bonus: one entry per eligible friend who voluntarily confirms a free entry through an opaque random invite code; suggested maximum three, subject to rules review.
- Sharing copy must clearly disclose the possible bonus. No positive endorsement required; no store ratings/reviews involved.
- Provide an alternative free route to the same maximum entry allowance, with its terms reviewed for the actual jurisdictions. Neither purchases nor newsletter subscription affect entries.
- Inviter codes contain no email or purchase identifier. No phone contact upload, automated friend messages or device fingerprinting. Friend enters and confirms their own information.
- Server validates campaign dates, eligibility, verified email, no self-referral, duplicate referrals and bonus cap. A unique campaign/referrer/referred-person credit and transaction-safe ledger prevent replay or concurrent double credit. Email verification alone does not prove a unique human: suspicious patterns need review before drawing.
- Owner dashboard separates invitations opened, verified referrals and eligible drawing entries. Do not label clicks as shares or confirmations as purchases.
- Server-only winner selection uses a frozen eligible-entry ledger, secure randomness and a recorded review step. No automatic launch, draw, send or prize payment.
- Keep feedback answers separate from entry eligibility and consent. Neither positive feedback nor publication permission buys an entry.

Still decisions, not a legality determination: eligible locations/age, exact prize, dates, alternative free entry, fraud appeals and retention. Store policy review remains required before exposing promotional entry mechanics in the app.
