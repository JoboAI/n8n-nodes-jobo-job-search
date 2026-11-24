# Changelog

## 0.7.0

Requires `@jobo-ai/connector-core` 0.8.0 (inlined at build time), and an API that has the stored order of
Hiring Signals (`sort=created_asc`).

### Changed

- **Jobo Hiring Signal Trigger reads each signal once.** It reads signals in the order Jobo stored them and
  asks only for those stored after the last one it delivered, so no signal is read, or billed, twice. In
  0.6.0 the poll just after new signals arrived read the newest of them again. When more signals are new than
  **Max Signals per Poll**, the next polls continue from the same position, oldest first.
- A trigger that last ran on 0.6.0 carries on from its saved starting point. If it had stopped at **Max
  Signals per Poll** with more to read, the signals it had already delivered from that backlog are delivered
  once more.

### Added

- **Sort** on Hiring Signal → Get Many and Get Many for Company: **Detected (Newest Day First)**, the
  default, or **Stored (Oldest First)**. In the stored order, with **Created After** set to the `created_at`
  of the last signal a run read, the next run continues exactly where that one stopped.

## 0.6.0

Requires `@jobo-ai/connector-core` 0.7.0 (inlined at build time).

### Added

- **Hiring Signals.** A signal is one event at one company, detected from its job postings: a hiring surge, a
  first job in a new country, a leadership search, a new technology, a slowdown. Each signal is billed at ten
  times the price of a job, and a signal read again is billed again.
  - **Jobo → Hiring Signal → Get Many** reads `GET /api/signals`, newest detection day first, with every filter
    of that endpoint in three collections: **Company Filters** (domains, IDs, headquarters country, size,
    industry, category, funding stage, founding year, staffing agencies), **Signal Filters** (signal type,
    function, role, seniority, technology, skill, technology category, job country, region and city) and
    **Thresholds and Dates** (strength, new jobs, days open, reposted jobs, detection day, created after).
  - **Jobo → Hiring Signal → Get Many for Company** reads one company's signals by its Jobo company ID, with
    the filters that endpoint takes: signal type, minimum strength, detection days and created after.
  - Both page up to 200 signals per request and never ask for more than **Limit** still wants. **Return All**
    stops at 1,000 signals and writes a warning to the n8n log when more matched.
  - Each item is the signal as the API returned it plus `summary` (one sentence, as Jobo's dashboard words it,
    e.g. "17 new jobs this week vs 3.1 a week normally"), `type_label` and `strength_band`. A signal type
    added after this release still gets a label and a summary.
- **Jobo Hiring Signal Trigger**, a new node. It starts a workflow for each new signal matching your filters,
  with the same rules as the Jobo Trigger: the first run records a starting point and reads nothing, it
  needs at least one narrowing filter, **Minimum Interval** decides how often it calls the API, and a failed
  poll keeps its place. **Max Signals per Poll** (default 50, at most 1,000) caps what one poll delivers and is
  billed for; the rest arrive on the next polls. A poll that finds nothing new costs nothing. Just after new
  signals arrive, one further poll may read the newest of them again, and bill them, without emitting them
  twice. A test run in the editor returns, and bills, up to 5 matching signals from the last 7 days.
- Clear errors for Hiring Signals: not enough included signals or wallet balance (402), a key that belongs
  to no account (403), a sandbox key (404) and the rate limit (429). A list value containing a comma, more
  than 100 values in one list, a number out of range, or a Company ID that is empty or not a GUID fails that
  item before any request.

Requires `@jobo-ai/connector-core` 0.6.0 (inlined at build time).

### Changed

- **A quiet trigger poll is free.** Once the newest matching job is more than five minutes old by the API's
  clock, the next poll starts just after it, so a poll that finds nothing new returns nothing and costs
  nothing. Right after new jobs arrive, one further poll still reads again, and bills, the matching jobs
  indexed in the minute up to the newest one, so a late-indexed job is not missed; they are not emitted
  twice. Before, every poll re-read and billed that minute.
- **A trigger with no narrowing filter fails when it is switched on**, not one interval later.
- **Get Many (Feed) waits up to 130 seconds for a page**, as the feed asks, instead of 30, and retries a page
  that timed out or lost its connection.
- **Search, Geocode and the trigger are not retried after a timeout, a dropped connection or a 500**, because
  the request may already have been billed. Search and Geocode are still retried on a 429, and all three on
  a 503 the API marks as temporary (the trigger leaves a 429 to its next poll, as before).
- **Get Expired reads 10,000 ids per request** instead of 1,000, so a long window takes a tenth of the
  requests.
- Location → Geocode now says that each successful lookup is billed.

### Fixed

- **Search with Return All stops at 100,000 jobs.** The API pages no deeper than that and answers any later
  page with its last page again, so a query matching more kept fetching, and paying for, the same 100 jobs
  until it ran out of pages. The walk now stops at that depth, or as soon as the API answers an earlier page
  than the one asked for, and writes a warning to the n8n log with the total that matched. Use Get Many
  (Feed) to read every match.
- **Search with a Limit above 100 no longer returns jobs twice.** A Limit of 150 asked for page 2 in pages
  of 50, which is jobs 51 to 100 again. Each page now starts where the previous one ended, and asks for no
  more jobs than the Limit still needs.
- **Get Many (Feed) refuses a location with a city or region but no country** before sending it, with a
  message naming the location. The API answered 400. Field help now says Country is required.
- **An empty Job ID or Company ID** (often an expression that resolved to nothing) fails that item with a
  clear message, and honours Continue On Fail. Before, a blank Job ID requested `/api/jobs/`, which is a
  billed search.

## 0.4.1

### Fixed

- **The Jobo Trigger no longer declares `usableAsTool`.** n8n's verification scan now rejects that property
  on trigger nodes, which cannot be called as AI tools. Nothing changes in a workflow: the property had no
  effect on a trigger. The Jobo node is still usable as an AI tool.

## 0.4.0

Requires `@jobo-ai/connector-core` 0.5.0 (inlined at build time).

### Added

- **Enhanced descriptions (beta).** Description Format has two new choices, **Enhanced Markdown (Beta)** and
  **Enhanced HTML (Beta)**, on Job → Search, Job → Get Feed and the Jobo Trigger. They return each job's
  description with the same words and a consistent layout: real headings, lists, key facts as
  `**Label:** value`, and the repeated title, buttons and tracking tags removed. The layout is automatic and
  not guaranteed to be perfect. A job without an enhanced description returns its standard one.

## 0.3.0

Requires `@jobo-ai/connector-core` 0.4.0 (inlined at build time) and the Jobo API's
`GET /api/connectors/companies/suggest`.

### Added

- **Every search filter.** Job → Search and the Jobo Trigger now call `POST /api/jobs/search`, so they take
  companies and the exclude half of each include/exclude filter, which `GET /api/jobs` lacks.
- **Companies** picker (include or exclude): a searchable list of real companies with their domain, country
  and live job count. A pick sends every Jobo company id of that company; **By Name or Domain** takes a
  company id, website domain or whole company name.
- **Occupations** picker (include or exclude) over `GET /api/occupations`, plus **Job Category** and
  **Job Subcategory** dropdowns with live job counts.
- **Skills** dropdown (most-asked-for skills, with job counts) on version 2 nodes; job counts in the Sources
  and Industries dropdowns.
- **Exclude** collections: skills, industries, company categories, job categories and subcategories on Search
  and the trigger; sources, work models, employment types, experience levels, languages, industries, company
  categories, sizes, revenues, primary industries, job categories and subcategories on Get Many (Feed).
- **Languages** and **Company Categories** filters.
- **Options**: Sort (relevance, discovered oldest or newest first), Description Format (Markdown or HTML),
  Fields to Include, and Simplify (core fields plus summary, for AI agents).
- Get Many (Feed): a place picker for Locations, Companies, Occupations, company size / revenue / primary
  industry, Agency Jobs, and Include Reactivated.
- Field descriptions list accepted values and ID formats for AI-agent tool use.
- Search warnings such as `companies_unmatched` are written to the n8n log.

### Changed

- **The trigger drains large windows instead of failing.** Polls read new jobs oldest first
  (`sort: discovered_asc`); a poll that reaches the 250-job cap saves where it stopped and the next poll
  carries on. It only stops when more than 250 matching jobs share one indexing second.
- More filters count as narrowing on the trigger: companies, occupations, job categories and subcategories.
- Nodes are versioned. New nodes are version 2 (Skills is a dropdown); workflows saved with 0.2.0 or earlier
  stay version 1, where Skills remains a free-entry list. Saved parameters keep their meaning in both.

## 0.2.0

- Minimum Interval on the trigger, and the `X-Jobo-Client: n8n` request header.
