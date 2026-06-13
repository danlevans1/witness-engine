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

## Why this can run autonomously

An autonomous publishing system without governance is the well-known account-ban / spam / misinformation failure mode. witness-engine avoids it by construction rather than by policy:

1. **No unverified content can reach a channel.** The verifier is the only path to the publish queue, and it derives truth from the canon source, not from the content's own claims.
2. **Governance is an imported boundary, not in-repo code.** The delegation-chain verifier lives in \`pfc-connector-gateway-proof\` and is consumed here as a pinned dependency (\`v0.2.0\`). The application cannot quietly weaken its own governance, because the governance isn't part of the application.
3. **Every external effect will be receipt-gated.** As distribution channels are added, each publish action must present a valid BoundaryReceipt verified through the imported chain verifier before any real-world effect occurs. Rate limits and channel scopes become admission predicates, not config suggestions.
4. **Everything is auditable.** Actions append to a verifiable log. A third party can clone this repo, read the log, and check the governance claims against observable reality.

The result is a system whose autonomy is *earned*: it does only what its delegated authority permits, proves it did so, and fails closed when it can't.

## Roadmap

- **Step 1 — Canon Store + verification gate.** Done (this release).
- **Step 2 — Static-site publisher.** First publish action gated by a gateway BoundaryReceipt; English only; proves the receipt-gated publish path end to end.
- **Step 3 — Translation, Tier 1.** ~5 languages with back-translation QA; honest coverage gaps over bad translations.
- **Step 4 — Witness Ledger.** Coverage measured against people-group data; "published in language X" reported separately from "engagement evidence from group Y."

## Honest limitations

- Roughly 2.6 billion people lack internet access, concentrated in the least-reached regions, so "entirely automated on the internet" asymptotically approaches but cannot complete the task.
- Whether automated proclamation constitutes *witness* (martys — personal testimony) or seed-scattering is a real theological question. The architecture hedges by making every published page an on-ramp to human contact and community, not the endpoint.

## Stack

TypeScript (ESM, Node >=22.18), strict mode. Scripture text via the \`world-english-bible\` package (public domain), giving a pinned, reproducible ingestion source.

## License

MIT.
