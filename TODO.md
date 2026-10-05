# TODO: migrate pi-jev to pi's built-in classifier support

pi already knows how to call a TypeSafe-compatible System One endpoint. Instead of
each extension talking to `/v1/systemone` through `src/client.ts`, register the local
endpoint once as a classifier provider and let extensions call
`ctx.modelRegistry.classify(model, { state, questions })`.

- First step: `extensions/provider.ts` registers provider `local-jev` and one
  classifier model pointed at the configured endpoint.
- Migrate the extensions off `systemOne()` from `src/client.ts`: `bash-gate`,
  `dropper`, `file-relevance`, `ask-jev`, `model-router`. Delete the client once
  nothing imports it.
- Gotcha: the classifier `baseUrl` must include `/v1` (the transport appends
  `/systemone`), so a url ending in `/v1` must not get a second one.
- Gotcha: the transport requires a non-empty apiKey. A local open-jev server ignores
  it, so a dummy value like `local` is fine.
- Note: pi adds classifier usage to the session cost when the model has a catalog
  cost. The local model is registered at zero, so a local run stays free.
