# Firestore rules tests

`firestore.rules` is the tenant boundary. If a rule there is wrong, one customer
can read or rewrite another customer's inventory, orders and billing — so it does
not get changed without these tests going green.

    cd tests/rules
    npm ci
    npm test

## Why this doesn't use the Firestore emulator

The emulator is the usual way to test rules, and it is the better way when you can
get it: `firebase emulators:exec --only firestore`. It needs to download
`cloud-firestore-emulator-*.jar` from `storage.googleapis.com` at first run. On a
network that blocks that host the download fails and there is no offline fallback,
which is where this harness came from.

If you can reach that host, the emulator remains the ground truth. This suite is
the thing that runs everywhere else, including CI.

## What it actually does

`syntaxcheck.js` parses the rules with `@firebase/eslint-plugin-security-rules`,
which wraps the same ANTLR grammar Firebase uses, so a syntax error fails here
rather than at `firebase deploy`.

`rulesengine.js` walks that parse tree and evaluates the rules against fixture
documents — a small CEL interpreter covering the subset this file uses. Two
deliberate choices:

- **Unknown grammar nodes throw.** It never guesses. If someone adds a construct
  the engine cannot model, the suite fails loudly instead of quietly reporting
  "allowed".
- **Errors deny, strictly left to right.** Real CEL absorbs some errors
  commutatively (`error || true` is `true`). This engine does not, so it is
  pessimistic: anything that passes here passes under the real evaluator too.

`rules_test.js` holds the fixtures and the cases.

## How the engine was checked

An evaluator that always answers "denied" would pass a suite of deny-cases and
prove nothing. So the engine was first run against the *previous* version of
`firestore.rules`, where the behaviour was known:

- 51 of the 79 cases agreed between old and new rules
- all 28 disagreements were the specific holes being closed — a signed-in user
  minting `orgMembers/<anyOrg>_<theirUid>` at `role: 'admin'`, off-boarded staff
  still reading, invite codes listable platform-wide, billing fields client-writable

It reproduces the old bugs. That is what makes a pass on the new rules mean
something. Keep that property: when you change the rules, add the case that fails
on the old file first.

## Watch the access-call budget

The suite prints the worst-case `get()`/`exists()` count per request. Firestore
allows 10 per rule set evaluation and bills every one of them, and the docs promise
only that "some" repeated reads are cached — so the count is treated as if nothing
is deduplicated. It currently peaks at 7. If a change pushes that toward 10,
legitimate requests start failing with permission-denied in production and the bill
goes up on every read.
