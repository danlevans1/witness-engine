# witness-engine

Canon-grounded content pipeline. Step 1: a content-addressed Canon Store,
a Content Engine scaffold, and a fail-closed verification pass that routes
every generated unit to either the publish queue or quarantine.

## Architecture (step 1)

```
Canon Store (data/canon.jsonl)          append-only, content-addressed
  {doc_id, hash, version, lang, text}   hash = sha256(NFC(text))
        │
        ▼ grounding
Content Engine (src/engine.ts)          LLM behind LlmClient interface
  generateUnit → {unit_id, source_refs[], body, format}
  every source_ref = {doc_id, hash}
        │
        ▼
Verification pass (src/verify.ts)       FAIL-CLOSED
  every ref must resolve AND hash-match (recomputed, never trusted)
  zero refs → refusal
        │
   ┌────┴─────┐
   ▼          ▼
publish     quarantine JSONL
queue       {unit, errors[], quarantinedAt}
```

## Canon

Seeded with the Gospel of Matthew, World English Bible (public domain),
chapter granularity (`web/matthew/1` … `web/matthew/28`), rebuilt
deterministically from the `world-english-bible` npm package.

```sh
npm install
npm run seed   # idempotent; conflicting re-ingestion throws
npm test       # 6 tests: pass / fabricated / tampered / uncited / canon integrity / dep import
```

Requires Node >= 22.18 (runs TypeScript directly via type stripping).

## Dependency

`pfc-connector-gateway-proof` (git tag v0.2.0) — PFC v0.13 chain verifier;
its `verifyChain` / error-code vocabulary will govern connector calls in a
later step.
