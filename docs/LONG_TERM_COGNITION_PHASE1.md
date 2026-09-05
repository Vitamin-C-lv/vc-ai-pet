# Long-term cognition — phase 1

## Delivered boundary

This stage closes owner statement → durable original → current understanding →
bounded retrieval → source-backed answer, and exposes Dream/Reflection as a
read-only inner-life timeline. It does not implement Gomoku, initiative,
Android background notifications, or archive-wide visual search. Existing
visual working sessions, Local Brain API v1, desktop art and Android native
code remain compatible.

## Storage and truth

- `conversation-archive.db` is an independent sandbox-local SQLite append-only
  archive. It imports every surviving legacy JSON message before the recent
  cache is trimmed, then preserves new messages verbatim. The JSON file remains
  a 500-message cache, normal UI history remains 50, and normal context remains
  12 turns. Existing image files and metadata stay in place. Already-pruned
  pre-upgrade records cannot be recovered.
- Pet-owned side tables in `pet-memory.db` hold immutable belief assertions,
  an indexed topic lookup and a replaceable current projection. Each assertion
  retains its original quote, message ID and observation time. Old PetMemory
  rows are not rewritten or automatically classified into new beliefs.
- The same Local Brain text completion emits at most two literal belief
  proposals in addition to the established reply/memory fields. The host checks
  role, source message, literal inclusion, user opt-out, sensitivity and change
  cues. Visual turns and assistant messages cannot use this write path.
- The old MemoryGate now stores its verified evidence quote as new memory
  content. Previously it marked model-written summaries confirmed merely
  because the response also contained a valid quote; a summary could reverse
  the quote's meaning. Existing summaries remain unchanged and new provenance
  additionally retains the source quote/message ID.

## Belief lifecycle

`assert` establishes a supported state. A different ordinary assertion creates
`contested`, with up to four current alternatives. Explicit `change` and
`correction` supersede the current projection while keeping all assertions.
`uncertain`/`retract` return to `unknown`. Temporary statements expire into
unknown, never silently resurrecting an old preference. The initial policy is
24 hours for today/this-time wording and seven days for this-week wording;
these are conservative elapsed-time windows, not a full calendar parser.

Confidence is a policy bound (supported 0.9, temporary 0.7, contested 0.4,
unknown 0), not a statistical probability. Repeating a statement cannot raise
it. Concurrent completions arriving out of order rebuild only the affected
topic in source-time order. Duplicate processing of the same message/topic is
idempotent.

Topic selection is model-assisted and lexical, not a universal natural
language reasoner. Arbitrary aliases, multilingual paraphrases, subtle quoted
speech and multiple independent attributes remain limitations. Unsupported or
question/conditional/quoted proposals are skipped conservatively. No silent
retroactive extraction runs against production history.

## Retrieval and answer authority

Ordinary text gets at most four topic projections; explicit history questions
also get a bounded recent assertion page and the earliest record. Internal
history/source APIs allow further pages without injecting the whole archive.
Dates mean "when the owner said this", not inferred event dates. An ordinary
greeting does not load assertion history or Dream logs.

The real local model initially ignored a correctly retrieved white-color
belief and produced an unrelated answer. Direct questions about a tracked
current state, uncertainty or its source now use a small evidence renderer
after the ordinary completion: it returns the actual quote, a conflict, or
unknown, instead of letting style generation replace known evidence. Multiple
matched topics ask for clarification. This does not affect free conversation
or add another inference. It is an explicit truth guarantee for this narrow
query path, not a claim of universal hallucination prevention.

## Dream / Reflection and Self

Dream remains a deep pass (24 new rows + up to 24 related per batch, up to three
derivations); Reflection remains a light pass (four new + four related, at most
one derivation, no soul). Both require actual new raw evidence. Explicit
provenance outranks a session label, so assistant/derived rows disguised under
the old raw session cannot become raw input.

Confidence is computed from distinct raw roots, starting at 0.45 and capped at
0.8. Derived context does not increase root count. One event can support a
weak first-person Self hypothesis; three or more roots permit `evolving`,
which is still inferred. Source roots and confidence are persisted and current
Self reads preserve provenance. The old high-confidence-only Soul admission
was deliberately replaced; chat/Reflection still cannot write Soul.

One derivation per level and identical root set is allowed across
Dream/Reflection, even when wording changes. This conservative rule can also
suppress a different useful interpretation of exactly the same evidence;
semantic hypothesis revision and a fully temporal Self projection are deferred.
Legacy source-session-only rows retain their existing compatibility fallback;
their lost original subtype is not invented.

## Inner-life UI

Play has a top "🌙 花花的梦境" entry. Its subpage shows seven-day and total Dream
counts, last Dream time, paginated Dream/"💭 小思考" entries, safe short summaries,
new-understanding counts and an honest no-conclusion message. Read-only
`GET /api/inner-life` never runs Dream. Only whitelisted DTO fields leave the
server; raw changes, source bodies, prompts and reasoning do not. Legacy
free-text summaries use the existing safe-text filter plus credential checks;
this is not a semantic guarantee about all arbitrary historical prose.

## Audit and validation (2026-09-05)

Baseline: `feat/visual-working-session`, `50789e0`, clean source checkout.
An independent worktree/branch protects that checkout.

Production audit found two DSH processes opening the same Pet DB. LAN Host
started at 02:48, while runtime/conversation source mtimes were 14:01/13:50;
source equality cannot be claimed. No production service was restarted or
repointed. Only schema/counts and read-only health/state were inspected.

`npm run test:long-life` uses only disposable sandboxes and covers day
1/7/30/100+ changes, corrections, conflicts, unknown, expiry, out-of-order
completion, exact evidence, assistant exclusion, repeated Dream/Reflection,
retention beyond 500, restart, prompt bounds and timeline/API pagination.
The 25 pre-existing test programs were exercised; Dream and historical tests
were updated for intentional evidence/weak-Self contract changes. Client
build/verification remains required before commit.

`npm run test:cognition-live` explicitly uses the existing loopback Local Brain
with a temporary Pet sandbox. It checks a real preference change, reuse of its
topic and a subsequent current-state answer. It neither uses production Pet
HTTP write endpoints nor runs production Dream.

The headless Chromium check could attach through CDP but timed out navigating
to the fixture LAN page. UI API/static/navigation tests passed; a rendered
narrow-screen screenshot and Android device acceptance are not claimed.

## Next stage

Build persistent visual-experience retrieval over the preserved archive and
existing real image re-opening path, then connect those experiences to the
same evidence lifecycle. Keep visual inference separate from owner statements.
Resolve which production Host owns the sandbox before activating new code.
