# witness-engine

An autonomous pipeline for generating, translating, distributing, and measuring gospel content across the internet — built so it can run without a human in the loop because its governance layer makes unverified publication *architecturally impossible*, not merely discouraged.

The motivating text is Matthew 24:14 — "this gospel of the kingdom shall be preached in all the world for a witness unto all nations." Translated into an engineering problem: reach every internet-connected people group with content that is doctrinally grounded, honestly translated, distributed inside platform rules, and measurable as to coverage.

This repository is also the first public external consumer of [pfc-connector-gateway-proof](https://github.com/danlevans1/pfc-connector-gateway-proof) — the PFC (Prime Form Calculus) delegation-chain governance layer. witness-engine imports it as a dependency the way an application imports TLS: governance is infrastructure here, not framework.

## Design principle: fail-closed

The system's default is **do not publish**. Content must earn its way to a channel by proving its claims trace back to a verified source. Anything that cannot prove this is quarantined, never published. This is the same principle that governs the PFC delegation chain: never trust an artifact's claim about its own validity — derive validity from the source, every time.

## How step 1 works

Step 1 builds the trust root and the verification gate — the foundation every later stage stands on.

### Canon Store (\`src/canon.ts\`, \`data/canon.jsonl\`)

The root of trust. Public-domain scripture (World English Bible, Matthew, 28 chapters) is ingested into a content-addressed store: every chapter document is hashed with SHA-256 over its NFC-normalized text. The store is append-only and committed to the repo, so the ground truth is reproducible and version-controlled. Change one character of the text and its hash changes completely. This is the sealed reference copy nothing downstream is permitted to contradict.

### Content Engine (\`src/engine.ts\`)

Produces content *units* — \`{ unit_id, source_refs[], body, format }\`. The LLM that will generate real content sits behind an \`LlmClient\` interface (\`StubLlm\` for now), so the model is swappable without touching the verification path. Every unit must stamp each \`source_ref\` with the canon \`doc_id\` it grounds against and the hash it grounded to.

### Verifier (\`src/verify.ts\`)

The gate. \`verifyUnit\` does **not** trust the hash a unit claims. It re-reads the canon text from the store and recomputes the hash from scratch, then compares. This defeats tampering even when both the text and its stored fingerprint have been altered, because truth is derived from the source rather than from the artifact's self-assertion.

\`processUnit\` routes the result: a verified unit goes to the publish queue; anything else goes to a quarantine JSONL. Failure modes that quarantine: a \`source_ref\` pointing to a passage not in the canon (\`UNRESOLVED_REF\`); a hash that doesn't match the recomputed canon hash (\`HASH_MISMATCH\`); a unit with zero \`source_refs\` (\`EMPTY_SOURCE_REFS\`).

### Tests (\`test/witness.test.ts\`)

Each guarantee is falsifiable and proven: a valid unit publishes; a fabricated citation quarantines; a tampered canon entry quarantines; a zero-reference unit quarantines. Plus seeded-canon integrity and the dependency-import smoke test. 6/6 passing.

## How step 2 works

Step 2 adds the first real external effect — publishing a page — and gates it
through the imported PFC gateway. witness-engine never writes a page directly;
it asks the gateway, and the gateway decides.

### Publishing modeled as a connector (`src/publish.ts`)

A page publish is a PFC `ConnectorCall`: action `publish`, target `site:<slug>`.
`publishPage` rejects any quarantined unit before the gateway is even called,
pulls only from the publish queue, then calls `ConnectorGateway.execute()` with
the delegation chain authorizing that exact action and target.

The page is written by `SitePublishAdapter` — and that adapter is the *only*
writer to `dist/site/`. It fires solely as the gateway's effect after a passing
pre-effect check. If the chain is missing, revoked, expired, or out of scope,
the gateway returns a refusal, the BoundaryReceipt status is `BLOCKED`, and
nothing is written. On success the gateway issues a `PRE_EFFECT` BoundaryReceipt,
runs the adapter, and emits an `ExecutionResultReceipt`.

The consequence: witness-engine *cannot* publish on its own authority. The
governance is enforced by infrastructure it imports, not by code it could
quietly weaken — the same credential-starvation logic PFC applies to API
calls, here applied to a file write.

### Falsifiable gating (`test/publish.test.ts`)

The point of Step 2 is that fail-closed is observable, not asserted:

- authorized chain → page written, `GatewayExecution`, `ExecutionResultReceipt` emitted
- revoked token → `TOKEN_REVOKED`, **no file on disk**
- out-of-scope target (chain authorizes `site:foo`, publish attempts `site:bar`) → refused, **no file**
- quarantined unit → rejected before the gateway is called, **no file**

The blocked cases assert file *absence* on disk (`existsSync === false`), not
just a return value. Clone the repo, revoke the token, run the tests, and watch
no page appear — that is the PFC-in-production claim, checkable by a stranger.
6/6 Step 1 tests stay green; 10/10 total.

## How step 3 works

Step 3 adds translation — and treats every translated page as its own gated
publish, so translation cannot bypass the Step 2 boundary.

### Each language is separately authorized (`src/translate.ts`, `src/publish.ts`)

A translated page is a distinct `ConnectorCall`: action `publish`, target
`site:<slug>:<lang>` (e.g. `site:matthew-5-9:es`). The delegation chain must
authorize that exact language; a chain that permits Spanish cannot publish
French. Tier 1 is Spanish, French, and Portuguese, behind a `Translator`
interface (`StubTranslator` by default, a real engine swappable in without
touching the gate).

### Honest gaps over bad coverage

Before publishing, each translation passes a back-translation quality gate:
translate forward, translate the result back to English, score the similarity
against the source. Below `QUALITY_THRESHOLD`, the translation does not publish —
it is recorded in `translation-quarantine.jsonl` with its numeric score and
reason. The system would rather publish nothing in a language than publish a bad
translation, and it records exactly how far below the bar it fell. This is the
data the witness ledger later reads to report a gap truthfully rather than
showing false coverage.

Falsifiable: a mangled translation produces no file and a scored quarantine
entry; an unauthorized-language attempt is refused at the gateway with no file.

## How step 4 works

Step 4 is the Witness Ledger — the "for a witness" measurement. It adds no new
gated effects; it reads the records the pipeline already produces and reports
honestly.

### Coverage as a report, not a claim of reach (`src/ledger.ts`)

`buildCoverageReport` is a pure function that joins the publication receipts
(proof of what actually published, derived from ExecutionResultReceipts — not
from files on disk), the content quarantine, and the translation quarantine into
a per-unit, per-language coverage map with rollups. Gaps are typed:
`NOT_ATTEMPTED` (no record at all) versus `BELOW_THRESHOLD` (in the translation
quarantine, carrying its score).

### Two claims kept separate

"Published in language X" and "engagement evidence from people-group Y" are
different claims and are never conflated. v0.1 has only publication data, so the
report shows published status with explicit reached/gap per language, and leaves
a visibly-empty "Engagement (not yet measured)" section — typed so it cannot be
backfilled from publication data. A quarantined unit never counts as published.

The dashboard (`dist/site/_coverage.html`) is a report *about* the system — an
operator artifact, not gospel content — so it is written directly, not through
the gateway. Gospel pages remain writable only by the gateway's adapter.

## Why this can run autonomously

An autonomous publishing system without governance is the well-known account-ban / spam / misinformation failure mode. witness-engine avoids it by construction rather than by policy:

1. **No unverified content can reach a channel.** The verifier is the only path to the publish queue, and it derives truth from the canon source, not from the content's own claims.
2. **Governance is an imported boundary, not in-repo code.** The delegation-chain verifier lives in \`pfc-connector-gateway-proof\` and is consumed here as a pinned dependency (\`v0.2.0\`). The application cannot quietly weaken its own governance, because the governance isn't part of the application.
3. **Every external effect will be receipt-gated.** As distribution channels are added, each publish action must present a valid BoundaryReceipt verified through the imported chain verifier before any real-world effect occurs. Rate limits and channel scopes become admission predicates, not config suggestions.
4. **Everything is auditable.** Actions append to a verifiable log. A third party can clone this repo, read the log, and check the governance claims against observable reality.

The result is a system whose autonomy is *earned*: it does only what its delegated authority permits, proves it did so, and fails closed when it can't.

## Roadmap

- **Step 1 — Canon Store + verification gate.** Done.
- **Step 2 — Static-site publisher.** Done. Publish action gated by a gateway BoundaryReceipt; English only; receipt-gated publish path proven end to end.
- **Step 3 — Translation, Tier 1.** Done. Spanish/French/Portuguese; each language separately authorized; back-translation quality gate records honest gaps over bad coverage.
- **Step 4 — Witness Ledger.** Done. Honest coverage report; "published in language X" kept separate from "engagement evidence from group Y" (engagement not yet measured).

## Honest limitations

- Roughly 2.6 billion people lack internet access, concentrated in the least-reached regions, so "entirely automated on the internet" asymptotically approaches but cannot complete the task.
- Whether automated proclamation constitutes *witness* (martys — personal testimony) or seed-scattering is a real theological question. The architecture hedges by making every published page an on-ramp to human contact and community, not the endpoint.

## Setup

```sh
npm install
npm test    # 10/10
```

witness-engine depends on
[pfc-connector-gateway-proof](https://github.com/danlevans1/pfc-connector-gateway-proof)
pinned to a git tag. **npm aggressively caches git dependencies**, so after the
gateway publishes a new tag a plain `npm install` may silently keep an older
build — symptoms are an unexpected `"version"` in
`node_modules/pfc-connector-gateway-proof/package.json` or import errors for
exports that exist on the tag (e.g. a missing `AGENT_A`). Force a clean fetch:

```sh
npm cache clean --force
rm -rf node_modules package-lock.json
npm install
```

Verify you got the intended build:

```sh
grep '"version"' node_modules/pfc-connector-gateway-proof/package.json
```

## Stack

TypeScript (ESM, Node >=22.18), strict mode. Scripture text via the \`world-english-bible\` package (public domain), giving a pinned, reproducible ingestion source.

## License

MIT.
