# n8n-nodes-jobo-job-search

n8n community node for [Jobo](https://jobo.world) — search and sync millions of live job listings
collected from employer career sites and 200+ applicant tracking systems.

Full setup and filter docs: [jobo.world/docs/connectors/n8n](https://jobo.world/docs/connectors/n8n).

## Nodes

**Jobo** — Job (Search, Get, Get Many/Feed, Get Expired), Company (Get), Location (Geocode).

**Jobo Trigger** — polls for newly indexed jobs matching your filters.

Search and the trigger take every filter of `POST /api/jobs/search`; Get Many takes every filter of
`POST /api/jobs/feed`:

- **Companies** — a searchable picker (sends every Jobo company id of the company you pick), or a typed
  company id, website domain or whole name. Include or exclude.
- **Occupations** — searchable by occupation, subcategory or category name; plus Job Category and Job
  Subcategory dropdowns with live job counts. Include or exclude.
- **Skills, industries, sources, company categories** — dropdowns with live job counts. Include or exclude.
- Location, languages, work model, employment type, experience level, salary, posted / discovered dates,
  title-only matching; on the feed also company size, revenue, primary industry and agency jobs.
- **Options** — sort (relevance or by discovery time), description format (Markdown, HTML, or the beta Enhanced and Enhanced HTML), which heavy
  fields to return, and **Simplify** (core fields plus the summary — the setting to use when an AI agent
  calls the node as a tool).

Every field description lists its accepted values and ID formats, so an AI agent using the node as a
tool can fill them in.

### Node versions

New nodes are version 2, where Skills is a dropdown. Workflows saved with 0.2.0 or earlier keep version 1:
Skills stays a free-entry list and every saved parameter means what it did. Everything else new appears in
both versions.

## Installation

In n8n, go to **Settings → Community nodes → Install**, enter the package name, and confirm:

```
n8n-nodes-jobo-job-search
```

Self-hosted n8n only — community nodes cannot be installed on n8n Cloud unless the node is verified.

## Example workflow

Post newly discovered remote Rust jobs to Slack, checked hourly:

1. **Jobo Trigger** — leave *Minimum Interval* at **Every Hour**, then under *Filters* set
   **Query** to `rust engineer` and **Work Model** to `Remote`. The trigger records a
   `discovered_after` watermark, so each run returns only jobs that are new since the last one;
   the first run returns nothing and simply establishes the starting point.
2. **Slack → Send Message** — map `{{ $json.title }}` and `{{ $json.apply_url }}` into the message.

At least one narrowing filter (query, location, companies, occupations, sources, skills, industries, job
categories or job subcategories) is required on the trigger. Without one it matches every job Jobo indexes and fails loudly rather than running up a bill.

## Poll Times vs Minimum Interval

n8n adds its own *Poll Times* field to every polling node and hard-codes the default to **Every
Minute** — a node cannot narrow that list or change that default. Left alone, that is 1,440 API
calls a day per workflow, for a trigger nobody deliberately configured.

So the trigger carries its own **Minimum Interval** (default *Every Hour*, floor 15 minutes), and
that is the one that decides. A tick arriving sooner is skipped without any HTTP request at all.
Setting *Poll Times* faster than *Minimum Interval* therefore changes nothing; setting it slower
does work, since n8n simply never fires the tick.

Nothing is missed either way. A poll returns everything indexed since the previous one, however
long ago that was — which is also why the cost is unchanged: search is metered per job returned,
not per request.

## Credentials

One field: your Jobo API key (`jbe_live_…` or `jbe_test_…`), from
[enterprise.jobo.world/api-keys](https://enterprise.jobo.world/api-keys?src=n8n). No Jobo account yet?
[Sign up free](https://enterprise.jobo.world/register?src=n8n) first — the $5 free starting balance is
enough to try the node. The credential test issues a
`page_size=1` search — deliberately, because the balance precheck prices the *requested* page size, so a
larger probe can require more remaining shared allowance or wallet cover just to verify a key.

## Cost, and the one mistake to avoid

Search is metered per job **returned**; an empty poll settles at zero jobs. A Job Search plan uses its
shared allowance first, then its normal job rate. Without that plan, Search uses the signed-in direct
rate (public list $3 per 1,000 jobs); The Unlimited plan does not cover Search. With a correctly persisted
watermark, **cost does not depend on how often the trigger polls**. Filter breadth is what drives the bill.

The failure mode worth engineering against is a watermark that never advances. It looks correct in testing
(the results are right) and multiplies the bill by the lookback-to-interval ratio. The trigger therefore
persists its watermark in workflow static data rather than recomputing a relative window, and refuses to
run without at least one narrowing filter.

Two behaviours that follow from this and may surprise you:

- **The first run returns nothing.** It records a starting point. n8n treats a trigger's first run as a
  sample, and backfilling the whole index would be both surprising and expensive.
- **A burst arrives over several polls.** One poll returns at most 250 jobs. Polls read new jobs oldest
  first (`sort: discovered_asc`, keyed on the immutable first-indexed time), so a poll that stops at that
  cap leaves a clean resume point, and the next poll carries on from it. The only window that cannot be
  resumed — more than 250 matching jobs indexed in the same second — fails loudly rather than skipping
  jobs.

For high volume or push-style delivery, use a Jobo Outbound Feed instead. It uses the same
shared allowance/normal job pricing, or has no per-job charge on Unlimited.

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
