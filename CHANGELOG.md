# Changelog

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
