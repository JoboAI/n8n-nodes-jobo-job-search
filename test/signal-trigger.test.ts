import { beforeEach, describe, expect, it, vi } from "vitest";
import { NodeApiError, NodeOperationError, sleep } from "n8n-workflow";
import type { SignalPollState } from "@jobo-ai/connector-core";

import { JoboHiringSignalTrigger } from "../nodes/Jobo/JoboHiringSignalTrigger.node";
import { pollContext, signal, signalPage, type Handler } from "./fakes";

vi.mock("n8n-workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("n8n-workflow")>()),
  sleep: vi.fn(async () => undefined),
}));

beforeEach(() => vi.mocked(sleep).mockClear());

const FILTERS = { signalCompanyFilters: { domains: ["acme.com"] } };
// A created_at as the API sends it: microseconds, which a Date would drop.
const WATERMARK = "2026-11-23T10:00:00.412075Z";

async function tick(opts: Parameters<typeof pollContext>[0]) {
  const fake = pollContext(opts);
  const outcome = await new JoboHiringSignalTrigger().poll.call(fake.ctx).then(
    (result) => ({ result, error: undefined as unknown }),
    (error: unknown) => ({ result: undefined, error }),
  );
  return { ...fake, ...outcome };
}

const never: Handler = () => {
  throw new Error("no request expected");
};

const pollState = (staticData: Record<string, unknown>) =>
  staticData.joboSignalPollState as SignalPollState | undefined;

describe("Jobo Hiring Signal Trigger: description", () => {
  const description = new JoboHiringSignalTrigger().description;

  it("names the narrowing filters and the cost, without a price", () => {
    const notice = String(description.properties.find((p) => p.type === "notice")?.displayName);
    expect(notice).toMatch(/Company Domains/);
    expect(notice).toMatch(/Signal Types/);
    expect(notice).toMatch(/ten times the price of a job/);
    expect(notice).toMatch(/finds nothing new costs nothing/);
    expect(notice).toMatch(/Each signal is read, and billed, once/);
    expect(notice).not.toMatch(/read the newest of them again/);
    expect(notice).not.toMatch(/\$|credit/);
  });

  it("leaves created_after to the poller", () => {
    const names = description.properties.flatMap((p) => (p.options ?? []).map((o) => (o as { name: string }).name));
    expect(names).not.toContain("created_after");
    expect(names).toContain("detected_after");
  });
});

describe("Jobo Hiring Signal Trigger: manual run", () => {
  it("returns a small recent sample with the added fields, and saves nothing", async () => {
    const { requests, result, staticData } = await tick({
      mode: "manual",
      params: FILTERS,
      handler: () => ({ body: signalPage([signal("a"), signal("b")]) }),
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe("/api/signals");
    expect(requests[0]?.query.get("limit")).toBe("5");
    expect(requests[0]?.query.get("domains")).toBe("acme.com");
    const since = new Date(String(requests[0]?.query.get("created_after"))).getTime();
    expect(Math.abs(Date.now() - 7 * 86_400_000 - since)).toBeLessThan(60_000);
    expect(result?.[0]?.map((item) => item.json.id)).toEqual(["a", "b"]);
    expect(result?.[0]?.[0]?.json).toMatchObject({ summary: expect.any(String), type_label: "Hiring surge", strength_band: "Very strong" });
    expect(staticData).toEqual({});
  });

  it("explains an empty sample window", async () => {
    const { error } = await tick({ mode: "manual", params: FILTERS, handler: () => ({ body: signalPage([]) }) });
    expect(error).toBeInstanceOf(NodeOperationError);
    expect((error as Error).message).toMatch(/No hiring signals matching these filters were found in the last 7 days/);
  });

  it("refuses to sample without a narrowing filter", async () => {
    const { requests, error } = await tick({
      mode: "manual",
      params: { signalThresholds: { min_strength: 90 } },
      handler: never,
    });
    expect(requests).toEqual([]);
    expect(error).toBeInstanceOf(NodeOperationError);
  });
});

describe("Jobo Hiring Signal Trigger: production polls", () => {
  it("seeds a watermark on the first poll without a request or any output", async () => {
    const { requests, result, staticData } = await tick({ params: FILTERS, handler: never });

    expect(requests).toEqual([]);
    expect(result).toBeNull();
    expect(pollState(staticData)?.watermark).toEqual(expect.any(String));
    expect(staticData.joboLastPolledAt).toBeUndefined();
  });

  it("refuses to run without a narrowing filter, naming the ones that count", async () => {
    const { requests, error, staticData } = await tick({
      params: { signalThresholds: { min_strength: 90, detected_after: "2026-11-01" } },
      handler: never,
    });

    expect(requests).toEqual([]);
    expect(error).toBeInstanceOf(NodeOperationError);
    expect((error as Error).message).toMatch(/narrowing filter/);
    expect((error as NodeOperationError).description).toMatch(/Company Domains.*A strength or date bound alone does not count/);
    expect(pollState(staticData)).toBeUndefined();
  });

  it("refuses a list value with a comma before any request", async () => {
    const { requests, error } = await tick({
      params: { signalCompanyFilters: { industries: ["Banking, Financial Services"] } },
      staticData: { joboSignalPollState: { watermark: WATERMARK } },
      handler: never,
    });
    expect(requests).toEqual([]);
    expect(error).toBeInstanceOf(NodeOperationError);
    expect((error as Error).message).toMatch(/cannot be used in Industries/);
  });

  it("skips a tick that arrives before the minimum interval", async () => {
    const state: SignalPollState = { watermark: WATERMARK };
    const lastPolled = new Date(Date.now() - 60_000).toISOString();
    const { requests, result, staticData, logged } = await tick({
      params: { ...FILTERS, minIntervalMinutes: 60 },
      handler: never,
      staticData: { joboSignalPollState: state, joboLastPolledAt: lastPolled },
    });

    expect(requests).toEqual([]);
    expect(result).toBeNull();
    expect(staticData.joboLastPolledAt).toBe(lastPolled);
    expect(pollState(staticData)).toBe(state);
    expect(logged.debug[0]).toMatch(/skipping this tick/);
  });

  it("reads the stored order from the last signal delivered, and saves where it stopped", async () => {
    const older = "2026-11-23T10:30:00.837281Z";
    const newest = "2026-11-23T10:30:00.837282Z";
    const { requests, result, staticData, logged } = await tick({
      params: FILTERS,
      staticData: { joboSignalPollState: { watermark: WATERMARK } },
      handler: () => ({
        headers: {
          "X-Credits-Deducted": "60",
          "X-Credits-Balance": "440",
          "X-Quota-Limit": "100",
          "X-Quota-Remaining": "98",
        },
        body: signalPage([signal("first", { created_at: older }), signal("second", { created_at: newest })]),
      }),
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.query.get("sort")).toBe("created_asc");
    // The watermark itself, to the microsecond: no overlap, so nothing is read twice.
    expect(requests[0]?.query.get("created_after")).toBe(WATERMARK);
    expect(requests[0]?.query.get("limit")).toBe("50");
    expect(result?.[0]?.map((item) => item.json.id)).toEqual(["first", "second"]);
    expect(result?.[0]?.[0]?.json).toMatchObject({ summary: "17 new jobs this week vs 3.1 a week normally" });
    // The last signal's created_at as the API sent it. Through a Date it would
    // lose its last three digits and the signal would be billed again.
    expect(pollState(staticData)).toEqual({ watermark: newest });
    expect(staticData.joboLastPolledAt).toEqual(expect.any(String));
    expect(logged.info[0]).toMatch(
      /2 new hiring signal\(s\) over 1 request\(s\); 60 credits spent, wallet 440 credits, included signals 98\/100 remaining/,
    );
  });

  it("stops at Max Signals per Poll and carries the position over to the next poll", async () => {
    // Ten signals of one batch, a microsecond apart.
    const page = Array.from({ length: 10 }, (_, n) => signal(`s${n}`, { created_at: `2026-11-23T10:05:00.00000${n}Z` }));
    const first = await tick({
      params: { ...FILTERS, maxSignalsPerPoll: 10 },
      staticData: { joboSignalPollState: { watermark: WATERMARK } },
      handler: () => ({ body: signalPage(page, "c1") }),
    });

    expect(first.requests.map((r) => r.query.get("limit"))).toEqual(["10"]);
    expect(first.result?.[0]).toHaveLength(10);
    const carried = pollState(first.staticData);
    expect(carried).toEqual({
      watermark: "2026-11-23T10:05:00.000009Z",
      cursor: { value: "c1", since: WATERMARK },
    });
    expect(first.logged.info[0]).toMatch(/arrive on the next polls/);

    // The next poll reads on from the position, with the same created_after and order.
    const second = await tick({
      params: { ...FILTERS, maxSignalsPerPoll: 10 },
      staticData: { joboSignalPollState: carried },
      handler: () => ({ body: signalPage([signal("s10", { created_at: "2026-11-23T10:05:00.00001Z" })]) }),
    });
    expect(second.requests[0]?.query.get("cursor")).toBe("c1");
    expect(second.requests[0]?.query.get("created_after")).toBe(WATERMARK);
    expect(second.requests[0]?.query.get("sort")).toBe("created_asc");
    expect(second.result?.[0]?.map((item) => item.json.id)).toEqual(["s10"]);
    expect(pollState(second.staticData)).toEqual({ watermark: "2026-11-23T10:05:00.00001Z" });
  });

  it("carries on from a state saved by 0.6.0, without its cursor of the other order", async () => {
    const { requests, result, staticData } = await tick({
      params: FILTERS,
      staticData: {
        joboSignalPollState: {
          watermark: WATERMARK,
          seenIds: ["old"],
          settled: true,
          walk: { cursor: "detected-order", since: WATERMARK, startedAt: null, newest: null },
        },
      },
      handler: () => ({ body: signalPage([signal("next", { created_at: "2026-11-23T11:00:00.000001Z" })]) }),
    });

    expect(requests[0]?.query.get("cursor")).toBeNull();
    expect(requests[0]?.query.get("created_after")).toBe(WATERMARK);
    expect(result?.[0]?.map((item) => item.json.id)).toEqual(["next"]);
    expect(pollState(staticData)).toEqual({ watermark: "2026-11-23T11:00:00.000001Z" });
  });

  it("reads at most five pages of 200 in one poll, however high Max Signals per Poll is set", async () => {
    let served = 0;
    const { requests, result } = await tick({
      params: { ...FILTERS, maxSignalsPerPoll: 50_000 },
      staticData: { joboSignalPollState: { watermark: WATERMARK } },
      handler: (req) => {
        const limit = Number(req.query.get("limit"));
        const page = Array.from({ length: limit }, () => signal(`p${served++}`));
        return { body: signalPage(page, `c${served}`) };
      },
    });
    expect(requests.map((r) => r.query.get("limit"))).toEqual(["200", "200", "200", "200", "200"]);
    expect(result?.[0]).toHaveLength(1000);
  });

  it("keeps the state it had when a poll fails", async () => {
    const state: SignalPollState = { watermark: WATERMARK };
    const { requests, error, staticData } = await tick({
      params: FILTERS,
      staticData: { joboSignalPollState: state },
      handler: () => ({ status: 500, body: { title: "Internal Server Error" } }),
    });

    expect(requests).toHaveLength(1);
    expect(error).toBeInstanceOf(NodeApiError);
    expect(pollState(staticData)).toBe(state);
    expect(staticData.joboLastPolledAt).toEqual(expect.any(String));
  });

  it("gives up on a 429 at once, leaving the window for the next poll", async () => {
    const state: SignalPollState = { watermark: WATERMARK };
    const { requests, error, staticData } = await tick({
      params: FILTERS,
      staticData: { joboSignalPollState: state },
      handler: () => ({ status: 429, headers: { "Retry-After": "30" }, body: { detail: "Rate limit exceeded" } }),
    });

    expect(requests).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(NodeApiError);
    expect((error as NodeApiError).httpCode).toBe("429");
    expect(pollState(staticData)).toBe(state);
  });

  it.each([
    ["402", { status: 402, body: { detail: "Insufficient credits" } }],
    ["403", { status: 403, body: { code: "account_key_required", detail: "x" } }],
    ["404", { status: 404, body: { code: "not_available_in_sandbox", detail: "x" } }],
  ])("maps a %s the way the Jobo node does", async (httpCode, response) => {
    const state: SignalPollState = { watermark: WATERMARK };
    const { error, staticData } = await tick({
      params: FILTERS,
      staticData: { joboSignalPollState: state },
      handler: () => response,
    });
    expect(error).toBeInstanceOf(NodeApiError);
    expect((error as NodeApiError).httpCode).toBe(httpCode);
    expect(pollState(staticData)).toBe(state);
  });

  it("returns nothing from a quiet poll", async () => {
    const { result, logged } = await tick({
      params: FILTERS,
      staticData: { joboSignalPollState: { watermark: WATERMARK } },
      handler: () => ({ body: signalPage([]) }),
    });
    expect(result).toBeNull();
    expect(logged.info).toEqual([]);
  });
});
