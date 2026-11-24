import { beforeEach, describe, expect, it, vi } from "vitest";
import { NodeApiError, NodeOperationError, sleep } from "n8n-workflow";
import { HIRING_SIGNAL_FILTERS, toSignalsQuery, type HiringSignalFilters } from "@jobo-ai/connector-core";

import { Jobo } from "../nodes/Jobo/Jobo.node";
import { SIGNAL_FILTER_GROUPS } from "../nodes/Jobo/descriptions";
import { buildSignalFilters, signalCompanyId } from "../nodes/Jobo/params";
import { SIGNAL_RETURN_ALL_MAX } from "../nodes/Jobo/signals";
import { executeContext, signal, signalPage, type Handler } from "./fakes";

vi.mock("n8n-workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("n8n-workflow")>()),
  sleep: vi.fn(async () => undefined),
}));

beforeEach(() => vi.mocked(sleep).mockClear());

const COMPANY = "0d5f8b4e-1111-4c2a-9a55-2f6d1f0e7a10";
const GET_MANY = { resource: "hiringSignal", operation: "getAll" };
const FOR_COMPANY = { resource: "hiringSignal", operation: "getAllForCompany", companyId: COMPANY };

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

const never: Handler = () => {
  throw new Error("no request expected");
};

/** Signals `s0`, `s1`… of `total`, paged by `limit` with the cursor as the offset. */
function signalsApi(total: number): Handler {
  return (req) => {
    const start = Number(req.query.get("cursor") ?? 0);
    const limit = Number(req.query.get("limit"));
    const end = Math.min(total, start + limit);
    const page = Array.from({ length: end - start }, (_, n) => signal(`s${start + n}`));
    return { body: signalPage(page, end < total ? String(end) : null) };
  };
}

const ids = (out: Array<{ json: Record<string, unknown> }>) => out.map((item) => item.json.id);
const limits = (requests: Array<{ query: URLSearchParams }>) => requests.map((r) => Number(r.query.get("limit")));

describe("Hiring Signal → Get Many", () => {
  it("sends each filter in its query form", async () => {
    const { requests } = await run(
      [
        {
          ...GET_MANY,
          returnAll: false,
          limit: 10,
          signalCompanyFilters: { domains: ["stripe.com", "acme.com"], exclude_agencies: true, founded_after: 0 },
          signalFocusFilters: { types: ["hiring_surge", "new_country"], roles: "data engineer, analytics engineer" },
          signalThresholds: {
            min_strength: 60,
            detected_after: "2026-11-01T00:00:00.000+02:00",
            reposted_only: false,
          },
        },
      ],
      () => ({ body: signalPage([]) }),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe("/api/signals");
    expect(Object.fromEntries(requests[0]?.query ?? [])).toEqual({
      domains: "stripe.com,acme.com",
      exclude_agencies: "true",
      types: "hiring_surge,new_country",
      roles: "data engineer,analytics engineer",
      min_strength: "60",
      // The day the date picker was set to, as the API takes it.
      detected_after: "2026-11-01",
      limit: "10",
    });
  });

  it("adds a summary, a type label and a strength band to each signal as returned", async () => {
    const unknown = signal("u", { type: "board_shakeup", details: {}, strength: 12 });
    const { out } = await run([{ ...GET_MANY, returnAll: false, limit: 5 }], () => ({
      body: signalPage([signal("a"), unknown]),
    }));

    expect(out[0]).toEqual({
      json: {
        ...signal("a"),
        summary: "17 new jobs this week vs 3.1 a week normally",
        type_label: "Hiring surge",
        strength_band: "Very strong",
      },
      pairedItem: { item: 0 },
    });
    // A type added after this version: worded from its name, never an error.
    expect(out[1]?.json).toMatchObject({ type: "board_shakeup", summary: "Board shakeup", type_label: "Board shakeup", strength_band: "Mild" });
  });

  it("follows the cursor and asks for no more than the Limit still wants", async () => {
    const { requests, out } = await run([{ ...GET_MANY, returnAll: false, limit: 250 }], signalsApi(1000));

    expect(limits(requests)).toEqual([200, 50]);
    expect(requests.map((r) => r.query.get("cursor"))).toEqual([null, "200"]);
    expect(ids(out)).toEqual(Array.from({ length: 250 }, (_, n) => `s${n}`));
  });

  it("asks for the stored order on every page when Sort says so, and for no order by default", async () => {
    const stored = await run(
      [{ ...GET_MANY, returnAll: false, limit: 250, signalSort: "created_asc", signalThresholds: { created_after: "2026-11-24T13:53:55.837281Z" } }],
      signalsApi(250),
    );
    // A cursor continues the order it was issued under: the second page must name it too.
    expect(stored.requests.map((r) => r.query.get("sort"))).toEqual(["created_asc", "created_asc"]);
    // Created After reaches the API as it was typed, microseconds and all.
    expect(stored.requests[0]?.query.get("created_after")).toBe("2026-11-24T13:53:55.837281Z");

    const byDefault = await run([{ ...GET_MANY, returnAll: false, limit: 10 }], signalsApi(10));
    expect(byDefault.requests[0]?.query.get("sort")).toBeNull();
  });

  it("stops when has_more is false, without a warning", async () => {
    const { requests, out, logged } = await run([{ ...GET_MANY, returnAll: true }], signalsApi(230));

    expect(limits(requests)).toEqual([200, 200]);
    expect(out).toHaveLength(230);
    expect(logged.warn).toEqual([]);
  });

  it(`stops a Return All at ${SIGNAL_RETURN_ALL_MAX} signals and says so`, async () => {
    const { requests, out, logged } = await run([{ ...GET_MANY, returnAll: true }], signalsApi(5000));

    expect(limits(requests)).toEqual([200, 200, 200, 200, 200]);
    expect(out).toHaveLength(SIGNAL_RETURN_ALL_MAX);
    expect(new Set(ids(out)).size).toBe(SIGNAL_RETURN_ALL_MAX);
    expect(logged.warn).toHaveLength(1);
    expect(logged.warn[0]).toMatch(/stopped at 1,000 signals/);
  });

  it("does not warn when a Return All ends exactly at the ceiling", async () => {
    const { out, logged } = await run([{ ...GET_MANY, returnAll: true }], signalsApi(SIGNAL_RETURN_ALL_MAX));
    expect(out).toHaveLength(SIGNAL_RETURN_ALL_MAX);
    expect(logged.warn).toEqual([]);
  });

  it("refuses a list value with a comma before any request, as an operation error for the item", async () => {
    const { requests, error } = await runError(
      [{ ...GET_MANY, returnAll: false, limit: 5, signalCompanyFilters: { industries: ["Banking, Financial Services"] } }],
      never,
    );

    expect(requests).toEqual([]);
    expect(error).toBeInstanceOf(NodeOperationError);
    expect((error as Error).message).toMatch(/"Banking, Financial Services" cannot be used in Industries/);
    expect((error as NodeOperationError).context.itemIndex).toBe(0);
  });

  it("refuses an out-of-range number before any request", async () => {
    const { requests, error } = await runError(
      [{ ...GET_MANY, returnAll: false, limit: 5, signalThresholds: { min_strength: 150 } }],
      never,
    );
    expect(requests).toEqual([]);
    expect(error).toBeInstanceOf(NodeOperationError);
    expect((error as Error).message).toMatch(/Minimum Strength must be from 1 to 100/);
  });

  it("is not replayed after a dropped connection, since the page may be billed", async () => {
    const { requests, error } = await runError([{ ...GET_MANY, returnAll: false, limit: 5 }], () => {
      throw new Error("socket hang up");
    });
    expect(requests).toHaveLength(1);
    expect(error).toBeInstanceOf(NodeApiError);
  });
});

describe("Hiring Signal → Get Many for Company", () => {
  it("puts the company in the path and sends only the filters that endpoint takes", async () => {
    const { requests, out } = await run(
      [
        {
          ...FOR_COMPANY,
          returnAll: false,
          limit: 3,
          // Collections left over from Get Many: their company-wide filters are not sent.
          signalCompanyFilters: { domains: ["stripe.com"] },
          signalFocusFilters: { types: ["leadership_hire"], roles: ["cto"] },
          signalThresholds: { min_strength: 40, min_new_jobs: 5, created_after: "2026-11-20T08:00:00.1234567Z" },
        },
      ],
      () => ({ body: signalPage([signal("a")]) }),
    );

    expect(requests[0]?.path).toBe(`/api/companies/${COMPANY}/signals`);
    expect(Object.fromEntries(requests[0]?.query ?? [])).toEqual({
      types: "leadership_hire",
      min_strength: "40",
      created_after: "2026-11-20T08:00:00.1234567Z",
      limit: "3",
    });
    expect(out[0]?.json).toMatchObject({ id: "a", summary: expect.any(String) });
  });

  it("pages with the cursor like Get Many", async () => {
    const { requests, out } = await run([{ ...FOR_COMPANY, returnAll: true }], signalsApi(300));
    expect(limits(requests)).toEqual([200, 200]);
    expect(requests.every((r) => r.path === `/api/companies/${COMPANY}/signals`)).toBe(true);
    expect(out).toHaveLength(300);
  });

  it.each([
    ["empty", "  ", /company id is required/],
    ["not a GUID", "stripe.com", /not a Jobo company ID/],
  ])("refuses a company id that is %s before any request", async (_label, companyId, message) => {
    const { requests, error } = await runError([{ ...FOR_COMPANY, companyId, returnAll: false, limit: 5 }], never);

    expect(requests).toEqual([]);
    expect(error).toBeInstanceOf(NodeOperationError);
    expect((error as Error).message).toMatch(message);
  });

  it("carries on to the next item with Continue On Fail", async () => {
    const { requests, out } = await run(
      [
        { ...FOR_COMPANY, companyId: "", returnAll: false, limit: 5 },
        { ...FOR_COMPANY, returnAll: false, limit: 5 },
      ],
      () => ({ body: signalPage([signal("a")]) }),
      true,
    );
    expect(requests).toHaveLength(1);
    expect(out[0]).toEqual({ json: { error: expect.stringMatching(/company id is required/) }, pairedItem: { item: 0 } });
    expect(out[1]).toMatchObject({ json: { id: "a" }, pairedItem: { item: 1 } });
  });
});

describe("Hiring Signal errors", () => {
  const item = [{ ...GET_MANY, returnAll: false, limit: 5 }];

  it.each([
    ["402", { status: 402, body: { detail: "Insufficient credits" } }, "Not enough included signals or wallet balance", /included signals/],
    [
      "403",
      { status: 403, body: { code: "account_key_required", detail: "Call it with an account API key." } },
      "Hiring Signals needs an account API key",
      /belongs to no Jobo account/,
    ],
    [
      "404",
      { status: 404, body: { code: "not_available_in_sandbox", detail: "Not available in the sandbox." } },
      "Hiring Signals is not available with a sandbox key",
      /jbe_live_/,
    ],
  ])("maps a %s to its own wording", async (httpCode, response, message, description) => {
    const { error } = await runError(item, () => response);

    expect(error).toBeInstanceOf(NodeApiError);
    expect((error as NodeApiError).httpCode).toBe(httpCode);
    expect((error as Error).message).toBe(message);
    expect((error as NodeApiError).description).toMatch(description);
  });

  it("maps a 429 that outlasts the retries, with the limits and the wait", async () => {
    const { error } = await runError(item, () => ({
      status: 429,
      headers: { "Retry-After": "30" },
      body: { detail: "Rate limit exceeded" },
    }));

    expect(error).toBeInstanceOf(NodeApiError);
    expect((error as NodeApiError).httpCode).toBe("429");
    expect((error as NodeApiError).description).toMatch(/20 requests a minute.*Try again in 30 seconds/);
  });

  it("leaves the job operations' wording alone", async () => {
    const { error } = await runError([{ resource: "job", operation: "search", q: "nurse", returnAll: false, limit: 5 }], () => ({
      status: 402,
      body: { detail: "Insufficient credits" },
    }));
    expect((error as Error).message).toBe("Jobo wallet balance too low");
  });
});

describe("signal parameters", () => {
  it("places every core filter in a collection, and every collection shows only core filters", () => {
    expect(Object.keys(SIGNAL_FILTER_GROUPS).sort()).toEqual(HIRING_SIGNAL_FILTERS.map((f) => f.key).sort());
  });

  it("leaves untouched fields out, and keeps only the keys asked for", () => {
    const filters = buildSignalFilters(
      [{ domains: [], founded_after: 0, exclude_agencies: false, detected_before: "" }, { types: ["new_city"] }],
      ["types"],
    );
    expect(filters).toEqual<HiringSignalFilters>({ types: ["new_city"] });
  });

  it("refuses a comma with the same words connector-core uses", () => {
    const values = { categories: ["Agency, Staffing"] };
    const core = (() => {
      try {
        toSignalsQuery(values);
      } catch (error) {
        return (error as Error).message;
      }
      return "";
    })();
    expect(core).not.toBe("");
    expect(() => buildSignalFilters([values])).toThrow(core);
  });

  it("refuses more list values than the API takes, and a date that is not one", () => {
    const many = Array.from({ length: 101 }, (_, n) => `d${n}.com`);
    expect(() => buildSignalFilters([{ domains: many }])).toThrow(/at most 100/);
    expect(() => buildSignalFilters([{ detected_after: "last week" }])).toThrow(/yyyy-MM-dd/);
  });

  it("accepts a GUID company id in any case", () => {
    expect(signalCompanyId(` ${COMPANY.toUpperCase()} `)).toBe(COMPANY.toUpperCase());
  });
});

describe("Hiring Signal operations as an AI tool", () => {
  it("say what they return and that each signal is billed", () => {
    const node = new Jobo();
    expect(node.description.usableAsTool).toBe(true);
    const operation = node.description.properties.find(
      (p) => p.name === "operation" && p.displayOptions?.show?.resource?.includes("hiringSignal"),
    );
    const options = (operation?.options ?? []) as Array<{ value: string; description: string }>;
    expect(options.map((o) => o.value)).toEqual(["getAll", "getAllForCompany"]);
    for (const option of options) expect(option.description).toMatch(/billed|costs ten times/);
  });
});
