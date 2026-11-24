import { beforeEach, describe, expect, it, vi } from "vitest";
import { NodeApiError, NodeOperationError, sleep } from "n8n-workflow";
import { DEFAULT_FEED_TIMEOUT_MS } from "@jobo-ai/connector-core";

import { Jobo, SEARCH_MAX_DEPTH, nextSearchPage } from "../nodes/Jobo/Jobo.node";
import { executeContext, job, searchPage, type Handler, type RecordedRequest } from "./fakes";

// The transport borrows n8n's `sleep` for retry backoff; a test must not wait on it.
vi.mock("n8n-workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("n8n-workflow")>()),
  sleep: vi.fn(async () => undefined),
}));

beforeEach(() => vi.mocked(sleep).mockClear());

async function run(items: Array<Record<string, unknown>>, handler: Handler, continueOnFail = false) {
  const fake = executeContext({ items, handler, continueOnFail });
  const result = await new Jobo().execute.call(fake.ctx);
  return { ...fake, out: result[0] };
}

async function runError(items: Array<Record<string, unknown>>, handler: Handler) {
  const fake = executeContext({ items, handler });
  const error = await new Jobo().execute.call(fake.ctx).then(
    () => undefined,
    (e: unknown) => e,
  );
  return { ...fake, error };
}

/**
 * Search as the API pages it: rows `j0`, `j1`… of `total`, and past
 * `maxOffset` rows the last page it allows, numbered as that page.
 */
function searchApi(total: number, maxOffset = SEARCH_MAX_DEPTH): Handler {
  return (req) => {
    const pageSize = Number(req.body?.page_size);
    const requested = Number(req.body?.page);
    const page = Math.min(requested, Math.max(1, Math.floor(maxOffset / pageSize)));
    const start = (page - 1) * pageSize;
    const jobs = [];
    for (let row = start; row < Math.min(total, start + pageSize); row++) jobs.push({ id: `j${row}` });
    return { body: searchPage({ jobs, page, pageSize, total }) };
  };
}

const SEARCH = { resource: "job", operation: "search", q: "nurse" };
const pages = (requests: RecordedRequest[]) => requests.map((r) => [r.body?.page, r.body?.page_size]);
const ids = (out: Array<{ json: Record<string, unknown> }>) => out.map((item) => item.json.id);

describe("nextSearchPage", () => {
  it("keeps every page aligned to the rows already read", () => {
    expect(nextSearchPage(0, 50)).toEqual({ page: 1, pageSize: 50 });
    expect(nextSearchPage(0, Number.POSITIVE_INFINITY)).toEqual({ page: 1, pageSize: 100 });
    expect(nextSearchPage(100, 50)).toEqual({ page: 3, pageSize: 50 });
    expect(nextSearchPage(100, 30)).toEqual({ page: 5, pageSize: 25 });
    expect(nextSearchPage(125, 5)).toEqual({ page: 26, pageSize: 5 });
  });

  it("never reaches past the API's depth", () => {
    expect(nextSearchPage(99_900, Number.POSITIVE_INFINITY)).toEqual({ page: 1000, pageSize: 100 });
    expect(nextSearchPage(99_950, Number.POSITIVE_INFINITY)).toEqual({ page: 2000, pageSize: 50 });
    expect(nextSearchPage(SEARCH_MAX_DEPTH, Number.POSITIVE_INFINITY)).toBeNull();
    expect(nextSearchPage(10, 0)).toBeNull();
  });
});

describe("Job → Search", () => {
  it("stops a Return All at 100,000 rows and says so, instead of re-reading the last page", async () => {
    const { requests, out, logged } = await run([{ ...SEARCH, returnAll: true }], searchApi(300_000));

    expect(requests).toHaveLength(1000);
    expect(requests.at(-1)?.body).toMatchObject({ page: 1000, page_size: 100 });
    expect(out).toHaveLength(100_000);
    expect(new Set(ids(out)).size).toBe(100_000);
    expect(logged.warn).toHaveLength(1);
    expect(logged.warn[0]).toMatch(/first 100,000 of 300,000 matching jobs/);
    expect(logged.warn[0]).toMatch(/Get Many \(Feed\)/);
  });

  it("stops when the API answers an earlier page than the one asked for", async () => {
    // An API that clamps sooner than the node expects still ends the walk.
    const { requests, out, logged } = await run([{ ...SEARCH, returnAll: true }], searchApi(2000, 500));

    expect(pages(requests)).toEqual([1, 2, 3, 4, 5, 6].map((p) => [p, 100]));
    expect(out).toHaveLength(500);
    expect(new Set(ids(out)).size).toBe(500);
    expect(logged.warn[0]).toMatch(/first 500 of 2,000 matching jobs/);
  });

  it("reads a Limit beyond one page without returning rows twice", async () => {
    const { requests, out } = await run([{ ...SEARCH, returnAll: false, limit: 150 }], searchApi(1000));

    expect(pages(requests)).toEqual([
      [1, 100],
      [3, 50],
    ]);
    expect(ids(out)).toEqual(Array.from({ length: 150 }, (_, row) => `j${row}`));
  });

  it("asks for exactly the jobs a Limit still wants", async () => {
    const { requests, out } = await run([{ ...SEARCH, returnAll: false, limit: 130 }], searchApi(1000));

    expect(pages(requests)).toEqual([
      [1, 100],
      [5, 25],
      [26, 5],
    ]);
    expect(ids(out)).toEqual(Array.from({ length: 130 }, (_, row) => `j${row}`));
  });

  it("stops at the last page, and on an empty page, without a warning", async () => {
    const short = await run([{ ...SEARCH, returnAll: true }], searchApi(250));
    expect(pages(short.requests)).toEqual([
      [1, 100],
      [2, 100],
      [3, 100],
    ]);
    expect(short.out).toHaveLength(250);
    expect(short.logged.warn).toEqual([]);

    const empty = await run([{ ...SEARCH, returnAll: true }], searchApi(0));
    expect(empty.requests).toHaveLength(1);
    expect(empty.out).toEqual([]);
  });

  it("logs the search's warnings once", async () => {
    const { logged } = await run([{ ...SEARCH, returnAll: false, limit: 5 }], () => ({
      body: {
        ...searchPage({ jobs: [job("a")], page: 1, pageSize: 5, total: 1 }),
        warnings: [{ code: "companies_unmatched", message: "Acme matched no company" }],
      },
    }));
    expect(logged.warn).toEqual(["Jobo: companies_unmatched: Acme matched no company"]);
  });

  it("does not replay a search whose connection dropped, since it may already be billed", async () => {
    const { requests, error } = await runError([{ ...SEARCH, returnAll: false, limit: 5 }], () => {
      throw new Error("socket hang up");
    });

    expect(requests).toHaveLength(1);
    expect(error).toBeInstanceOf(NodeApiError);
    expect((error as Error).message).toMatch(/socket hang up/);
  });
});

describe("Job → Get Many (Feed)", () => {
  const FEED = { resource: "job", operation: "feed" };

  it("follows the cursor until has_more is false", async () => {
    const { requests, out } = await run([{ ...FEED, returnAll: true }], (req) => {
      const cursor = req.body?.cursor;
      if (!cursor) return { body: { jobs: [job("a"), job("b")], next_cursor: "c1", has_more: true } };
      if (cursor === "c1") return { body: { jobs: [job("c")], next_cursor: "c2", has_more: false } };
      throw new Error("read past the end");
    });

    expect(requests.map((r) => [r.body?.cursor, r.body?.batch_size])).toEqual([
      [undefined, 1000],
      ["c1", 1000],
    ]);
    expect(requests[0]?.body?.stable_scan).toBe(true);
    expect(ids(out)).toEqual(["a", "b", "c"]);
  });

  it("asks for only what a Limit still wants, and stops there", async () => {
    let served = 0;
    const { requests, out } = await run([{ ...FEED, returnAll: false, limit: 1500 }], (req) => {
      const size = Number(req.body?.batch_size);
      const jobs = Array.from({ length: size }, () => job(`f${served++}`));
      return { body: { jobs, next_cursor: `c${served}`, has_more: true } };
    });

    expect(requests.map((r) => r.body?.batch_size)).toEqual([1000, 500]);
    expect(out).toHaveLength(1500);
  });

  it("gives a feed page the long feed timeout", async () => {
    const { requests } = await run([{ ...FEED, returnAll: false, limit: 1 }], () => ({
      body: { jobs: [job("a")], next_cursor: null, has_more: false },
    }));
    expect(requests[0]?.timeout).toBe(DEFAULT_FEED_TIMEOUT_MS);
    expect(DEFAULT_FEED_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
  });

  it("retries a feed page whose request timed out", async () => {
    let attempts = 0;
    const { requests, out } = await run([{ ...FEED, returnAll: false, limit: 1 }], () => {
      attempts++;
      if (attempts === 1) throw new Error("timeout of 130000ms exceeded");
      return { body: { jobs: [job("a")], next_cursor: null, has_more: false } };
    });

    expect(requests).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(ids(out)).toEqual(["a"]);
  });

  it("refuses a location with a city or region but no country, before any request", async () => {
    const { requests, error } = await runError(
      [
        {
          ...FEED,
          returnAll: false,
          limit: 10,
          feedFilters: { locations: { location: [{ country: "", region: "Bavaria", city: "Munich" }] } },
        },
      ],
      () => ({ body: { jobs: [], next_cursor: null, has_more: false } }),
    );

    expect(requests).toEqual([]);
    expect(error).toBeInstanceOf(NodeOperationError);
    expect((error as Error).message).toMatch(/"Munich, Bavaria" has no country/);
  });
});

describe("Job → Get Expired", () => {
  it("reads every page, 10,000 ids at a time", async () => {
    const { requests, out } = await run(
      [{ resource: "job", operation: "expired", expiredSince: "2026-11-22T00:00:00Z" }],
      (req) =>
        req.query.get("cursor") === "next"
          ? { body: { job_ids: ["c"], next_cursor: null, has_more: false } }
          : { body: { job_ids: ["a", "b"], next_cursor: "next", has_more: true } },
    );

    expect(requests.map((r) => [r.path, r.query.get("batch_size"), r.query.get("cursor")])).toEqual([
      ["/api/jobs/expired", "10000", null],
      ["/api/jobs/expired", "10000", "next"],
    ]);
    expect(requests[0]?.query.get("expired_since")).toBe("2026-11-22T00:00:00Z");
    expect(ids(out)).toEqual(["a", "b", "c"]);
  });
});

describe("empty ids", () => {
  const never: Handler = () => {
    throw new Error("no request expected");
  };

  it.each([
    ["job", { resource: "job", operation: "get", jobId: "" }, /job id is required/],
    ["company", { resource: "company", operation: "get", companyId: "  " }, /company id is required/],
  ])("refuses an empty %s id as an operation error for that item", async (_label, item, message) => {
    const { requests, error } = await runError([item], never);

    expect(requests).toEqual([]);
    expect(error).toBeInstanceOf(NodeOperationError);
    expect((error as Error).message).toMatch(message);
    expect((error as NodeOperationError).context.itemIndex).toBe(0);
  });

  it("carries on to the next item with Continue On Fail", async () => {
    const { requests, out } = await run(
      [
        { resource: "job", operation: "get", jobId: "" },
        { resource: "job", operation: "get", jobId: "3f2b8c1e" },
      ],
      (req) => ({ body: job(req.path.split("/").at(-1) ?? "") }),
      true,
    );

    expect(requests.map((r) => r.path)).toEqual(["/api/jobs/3f2b8c1e"]);
    expect(out).toEqual([
      { json: { error: expect.stringMatching(/job id is required/) }, pairedItem: { item: 0 } },
      { json: job("3f2b8c1e"), pairedItem: { item: 1 } },
    ]);
  });
});

describe("Location → Geocode", () => {
  it("says the lookup is billed", () => {
    const operation = new Jobo().description.properties.find(
      (p) => p.name === "operation" && p.displayOptions?.show?.resource?.includes("location"),
    );
    expect(operation?.options?.[0]).toMatchObject({ value: "geocode" });
    expect((operation?.options?.[0] as { description: string }).description).toMatch(/billed/);
  });
});
