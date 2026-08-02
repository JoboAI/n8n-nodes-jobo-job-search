# n8n-nodes-jobo-job-search

n8n community node for [Jobo](https://jobo.world) — search and sync millions of live job listings
collected from employer career sites and 100+ applicant tracking systems.

Full setup and filter docs: [jobo.world/docs/connectors/n8n](https://jobo.world/docs/connectors/n8n).

## Nodes

**Jobo** — Job (Search, Get, Get Many/Feed, Get Expired), Company (Get), Location (Geocode).

**Jobo Trigger** — polls for newly indexed jobs matching your filters.

## Installation

In n8n, go to **Settings → Community nodes → Install**, enter the package name, and confirm:

```
n8n-nodes-jobo-job-search
```

Self-hosted n8n only — community nodes cannot be installed on n8n Cloud unless the node is verified.

## Example workflow

Post newly discovered remote Rust jobs to Slack, checked every 15 minutes:

1. **Jobo Trigger** — set *Poll Times* to every 15 minutes, then under *Filters* set
   **Query** to `rust engineer` and **Work Model** to `Remote`. The trigger records a
   `discovered_after` watermark, so each run returns only jobs that are new since the last one;
   the first run returns nothing and simply establishes the starting point.
2. **Slack → Send Message** — map `{{ $json.title }}` and `{{ $json.apply_url }}` into the message.

At least one narrowing filter (query, location, sources, skills or industries) is required on the
trigger. Without one it matches every job Jobo indexes and fails loudly rather than running up a bill.

## Credentials

One field: your Jobo API key (`jbe_live_…` or `jbe_test_…`), from
[enterprise.jobo.world/api-keys](https://enterprise.jobo.world/api-keys). The credential test issues a
`page_size=1` search — deliberately, because the balance precheck prices the *requested* page size, so a
larger probe would demand a bigger balance just to verify a key.

## Cost, and the one mistake to avoid

Search is billed per job **returned**; an empty poll costs nothing. With a correctly persisted watermark,
**cost does not depend on how often the trigger polls** — roughly $3 per 1,000 new jobs. Filter breadth is
what drives the bill.

The failure mode worth engineering against is a watermark that never advances. It looks correct in testing
(the results are right) and multiplies the bill by the lookback-to-interval ratio. The trigger therefore
persists its watermark in workflow static data rather than recomputing a relative window, and refuses to
run without at least one narrowing filter.

Two behaviours that follow from this and may surprise you:

- **The first run returns nothing.** It records a starting point. n8n treats a trigger's first run as a
  sample, and backfilling the whole index would be both surprising and expensive.
- **A too-broad filter fails loudly** rather than quietly. `GET /api/jobs` is relevance-ordered with no
  sort parameter, so a partial page walk is an arbitrary subset — advancing past it would drop jobs
  silently, and holding the watermark would re-bill the same window forever. The trigger stops and tells
  you to narrow the filter.

For high volume or genuine real-time delivery, use a Jobo Outbound Feed **webhook** instead: flat
subscription, no per-job credits.

## Why there are no runtime dependencies

n8n verification forbids them. `@jobo-ai/connector-core` — which carries the shared filter definitions,
retry policy, credit accounting and watermark logic used by every Jobo connector — is a `devDependency`
inlined at build time (`tsup --noExternal`). HTTP goes through `this.helpers.httpRequest`, bridged into
connector-core's injectable transport, so the node uses n8n's own HTTP stack while still sharing behaviour
with the WordPress, Sheets and MCP connectors.

`n8n-workflow` stays external — it is a peer supplied by the host.

## Development

```bash
npm install && npm run build && npm run verify
```

`npm run verify` asserts the verification constraints locally: zero runtime dependencies, no `overrides`,
MIT, the discovery keyword, a public repo, a valid `n8n` manifest, and no filesystem / child-process /
env-var access **in the built bundle** (source-only checks would miss anything arriving through an inlined
dependency).

The official scanner resolves packages by name from the npm registry, so it only runs post-publish:

```bash
npm run scan
```

## Publishing

Since 1 May 2026 n8n rejects locally published community nodes: releases must come from GitHub Actions
with npm provenance — never `npm publish` from a laptop.

This subtree doesn't publish itself. It's mirrored one-way into the public
[`JoboAI/n8n-nodes-jobo-job-search`](https://github.com/JoboAI/n8n-nodes-jobo-job-search) repo by the monorepo's
`connectors-mirror.yml`, and that mirror's own `.github/workflows/release.yml` is the actual publish path —
cutting a GitHub release (`vX.Y.Z`) there builds, verifies, and `npm publish --provenance`s. `@jobo-ai/connector-core`
must already be on npm before that release runs, since the mirror resolves it from the registry rather than
a workspace link. See [`../RELEASING.md`](../RELEASING.md) for the full sequencing and the verification-form
step that follows a publish.

## Licence

MIT. `nodes/Jobo/jobo.svg` is the official Jobo mark, byte-identical to `brand-kit/favicon.svg` in the
monorepo.
