# pi-jev classifier migration

Done. The extensions no longer call `systemOne()` from `src/client.ts`; they call
`ctx.modelRegistry.classify()` on the `local-jev` provider registered by
`extensions/provider.ts`.

## What changed

- `src/classifier.ts` holds the classifier vocabulary, the `providerClassify`
  implementation `extensions/provider.ts` registers, and a `classify(ctx, ...)`
  wrapper the extensions use.
- The model carries api `local-jev-system-one`, not pi's `typesafe-system-one`.
  pi's built-in parser normalizes score answers to `{ score, confidence }` and
  drops `legend` and per-level probabilities, which `bash-gate` reads for its
  block/ask/allow bands and `model-router` reads for depth and length. Upstream
  still drops them on `main` and in `1.0.4`; there is no issue open for it.
- Migrated: `ask-jev`, `bash-gate`, `file-relevance`, `model-router`.
- `test/load.mjs` routes its stub registries through `providerClassify`.

## What stayed

- `extensions/dropper.ts` and `src/drop.ts` still use `src/client.ts`, as agreed.
  `src/shared.ts`'s `assessCommand` is dead code and also stayed; that keeps
  `client.ts` in the tree.
- pi-om's dropper was migrated separately, onto the same provider, in
  `pi-observational-memory`.
