import { beforeEach, describe, expect, it, vi } from "vitest";
import { NodeApiError, NodeOperationError, sleep } from "n8n-workflow";
import type { PollState } from "@jobo-ai/connector-core";

import { JoboTrigger } from "../nodes/Jobo/JoboTrigger.node";
import { job, pollContext, searchPage, type Handler } from "./fakes";

vi.mock("n8n-workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("n8n-workflow")>()),
  sleep: vi.fn(async () => undefined),
}));

beforeEach(() => vi.mocked(sleep).mockClear());

const FILTERS = { q: "nurse" };
const WATERMARK = "2026-11-23T10:00:00.000Z";

async function tick(opts: Parameters<typeof pollContext>[0]) {
  const fake = pollContext(opts);
  const outcome = await new JoboTrigger().poll.call(fake.ctx).then(
    (result) => ({ result, error: undefined as unknown }),
    (error: unknown) => ({ result: undefined, error }),
  );
  return { ...fake, ...outcome };
}

const never: Handler = () => {
  throw new Error("no request expected");
};

const pollState = (staticData: Record<string, unknown>) => staticData.joboPollState as PollState | undefined;

describe("Jobo Trigger: manual run", () => {
  it("returns a recent sample, newest first, and saves nothing", async () => {
    const { requests, result, staticData } = await tick({
      mode: "manual",
      params: FILTERS,
      handler: () => ({ body: searchPage({ jobs: [job("a"), job("b")], page: 1, pageSize: 25, total: 2 }) }),
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({ queries: ["nurse"], sort: "discovered_desc", page: 1, page_size: 25 });
    const since = new Date(String(requests[0]?.body?.discovered_after)).getTime();
    expect(Math.abs(Date.now() - 3600_000 - since)).toBeLessThan(60_000);
    expect(result).toEqual([[{ json: job("a") }, { json: job("b") }]]);
    expect(staticData).toEqual({});
  });

  it("explains an empty sample window", async () => {
    const { error } = await tick({
      mode: "manual",
      params: FILTERS,
      handler: () => ({ body: searchPage({ jobs: [], page: 1, pageSize: 25, total: 0 }) }),
    });
    expect(error).toBeInstanceOf(NodeOperationError);
    expect((error as Error).message).toMatch(/indexed in the last hour/);
  });
});

describe("Jobo Trigger: production polls", () => {
  it("seeds a watermark on the first poll without a request or any output", async () => {
    const { requests, result, staticData } = await tick({ params: FILTERS, handler: never });

    expect(requests).toEqual([]);
    expect(result).toBeNull();
    expect(pollState(staticData)?.watermark).toEqual(expect.any(String));
    // Seeding is exempt from the interval, so the next tick polls for real.
    expect(staticData.joboLastPolledAt).toBeUndefined();
  });

  it("refuses to seed without a narrowing filter", async () => {
    const { requests, error, staticData } = await tick({ params: {}, handler: never });

    expect(requests).toEqual([]);
    expect(error).toBeInstanceOf(NodeOperationError);
    expect((error as Error).message).toMatch(/narrowing filter/);
    expect(pollState(staticData)).toBeUndefined();
  });

  it("skips a tick that arrives before the minimum interval", async () => {
    const state: PollState = { watermark: WATERMARK, seenIds: [] };
    const lastPolled = new Date(Date.now() - 60_000).toISOString();
    const { requests, result, staticData, logged } = await tick({
      params: { ...FILTERS, minIntervalMinutes: 60 },
      handler: never,
      staticData: { joboPollState: state, joboLastPolledAt: lastPolled },
    });

    expect(requests).toEqual([]);
    expect(result).toBeNull();
    expect(staticData.joboLastPolledAt).toBe(lastPolled);
    expect(pollState(staticData)).toBe(state);
    expect(logged.debug[0]).toMatch(/skipping this tick/);
  });

  it("emits new jobs, then saves the advanced state", async () => {
    const { requests, result, staticData, logged } = await tick({
      params: FILTERS,
      staticData: { joboPollState: { watermark: WATERMARK, seenIds: ["old"] } },
      handler: () => ({
        headers: { Date: "Mon, 23 Nov 2026 12:00:00 GMT", "X-Credits-Deducted": "2" },
        body: searchPage({
          jobs: [job("old", WATERMARK), job("new", "2026-11-23T10:30:00Z")],
          page: 1,
          pageSize: 25,
          total: 2,
        }),
      }),
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({ sort: "discovered_asc", page_size: 25 });
    // The first poll after a seed laps back a minute over the watermark.
    expect(requests[0]?.body?.discovered_after).toBe("2026-11-23T09:59:00.000Z");
    expect(result).toEqual([[{ json: job("new", "2026-11-23T10:30:00Z") }]]);
    // The API's clock is 90 minutes past the newest job, so the next poll starts after it.
    expect(pollState(staticData)).toEqual({
      watermark: "2026-11-23T10:30:00Z",
      seenIds: ["old", "new"],
      settled: true,
    });
    expect(staticData.joboLastPolledAt).toEqual(expect.any(String));
    expect(logged.info[0]).toMatch(/1 new job\(s\) over 1 request\(s\); 2 credits spent/);
  });

  it("keeps the state it had when a poll fails", async () => {
    const state: PollState = { watermark: WATERMARK, seenIds: ["old"], settled: true };
    const { requests, error, staticData } = await tick({
      params: FILTERS,
      staticData: { joboPollState: state },
      handler: () => ({ status: 500, body: { title: "Internal Server Error" } }),
    });

    // A billed search is not replayed after a 500.
    expect(requests).toHaveLength(1);
    expect(error).toBeInstanceOf(NodeApiError);
    expect(pollState(staticData)).toBe(state);
    // The interval stamp survives the failure, so an erroring trigger does not poll every minute.
    expect(staticData.joboLastPolledAt).toEqual(expect.any(String));
  });

  it("reports an empty wallet as a 402 with its own wording", async () => {
    const { error } = await tick({
      params: FILTERS,
      staticData: { joboPollState: { watermark: WATERMARK, seenIds: [] } },
      handler: () => ({ status: 402, body: { detail: "Insufficient credits" } }),
    });

    expect(error).toBeInstanceOf(NodeApiError);
    expect((error as NodeApiError).httpCode).toBe("402");
    expect((error as Error).message).toBe("Jobo wallet balance too low");
  });

  it("gives up on a 429 at once, leaving the window for the next poll", async () => {
    const state: PollState = { watermark: WATERMARK, seenIds: [] };
    const { requests, error, staticData } = await tick({
      params: FILTERS,
      staticData: { joboPollState: state },
      handler: () => ({ status: 429, headers: { "Retry-After": "30" }, body: { detail: "Rate limit exceeded" } }),
    });

    expect(requests).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(NodeApiError);
    expect((error as NodeApiError).httpCode).toBe("429");
    expect(pollState(staticData)).toBe(state);
  });

  it("stops loudly when one indexing second holds more jobs than a poll can read", async () => {
    const seen = Array.from({ length: 250 }, (_, n) => `s${n}`);
    const state: PollState = { watermark: WATERMARK, seenIds: seen, backlog: true };
    const { requests, error, staticData } = await tick({
      params: FILTERS,
      staticData: { joboPollState: state },
      handler: (req) => {
        const page = Number(req.body?.page);
        const jobs = seen.slice((page - 1) * 25, page * 25).map((id) => job(id, WATERMARK));
        return { body: searchPage({ jobs, page, pageSize: 25, total: 1000 }) };
      },
    });

    expect(requests).toHaveLength(10);
    expect(error).toBeInstanceOf(NodeOperationError);
    expect((error as Error).message).toMatch(/indexed in the same second/);
    expect((error as NodeOperationError).description).toMatch(/Outbound Feed/);
    expect(pollState(staticData)).toBe(state);
  });
});
