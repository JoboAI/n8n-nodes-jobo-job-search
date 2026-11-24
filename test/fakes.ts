/**
 * Small stand-ins for the n8n function contexts, so `execute` and `poll` run
 * against a real `JoboClient` and the real n8n transport, with only
 * `helpers.httpRequest` faked. A test scripts the API by URL path.
 */
import type { IHttpRequestOptions, INode } from "n8n-workflow";

/** Matches connector-core's key shape check: jbe_test_{21}_{43}. */
export const API_KEY = `jbe_test_${"a".repeat(21)}_${"b".repeat(43)}`;

export interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | undefined;
  timeout: number | undefined;
}

/** What the fake API does for one request: answer, or throw as a dropped connection would. */
export type Handler = (req: RecordedRequest) => FakeResponse | Promise<FakeResponse>;

export const NODE: INode = {
  id: "node-1",
  name: "Jobo",
  type: "n8n-nodes-jobo-job-search.jobo",
  typeVersion: 2,
  position: [0, 0],
  parameters: {},
};

export interface Logged {
  warn: string[];
  info: string[];
  debug: string[];
}

function fakeHttp(handler: Handler, requests: RecordedRequest[]) {
  return async (options: IHttpRequestOptions) => {
    const url = new URL(String(options.url));
    const req: RecordedRequest = {
      method: String(options.method),
      path: url.pathname,
      query: url.searchParams,
      body: typeof options.body === "string" ? JSON.parse(options.body) : undefined,
      timeout: options.timeout,
    };
    requests.push(req);
    const res = await handler(req);
    return {
      statusCode: res.status ?? 200,
      headers: res.headers ?? {},
      body: res.body === undefined ? "" : JSON.stringify(res.body),
    };
  };
}

function logger(logged: Logged) {
  return {
    warn: (m: string) => logged.warn.push(m),
    info: (m: string) => logged.info.push(m),
    debug: (m: string) => logged.debug.push(m),
    error: () => undefined,
    verbose: () => undefined,
  };
}

/** A fake `IExecuteFunctions`: one entry in `items` per input item, each its own parameters. */
export function executeContext(opts: {
  items: Array<Record<string, unknown>>;
  handler: Handler;
  continueOnFail?: boolean;
}) {
  const requests: RecordedRequest[] = [];
  const logged: Logged = { warn: [], info: [], debug: [] };
  const ctx = {
    getInputData: () => opts.items.map(() => ({ json: {} })),
    getNodeParameter: (name: string, i: number, fallback?: unknown) => {
      const params = opts.items[i] ?? {};
      return name in params ? params[name] : fallback;
    },
    getNode: () => NODE,
    continueOnFail: () => opts.continueOnFail === true,
    getCredentials: async () => ({ apiKey: API_KEY, baseUrl: "https://api.test" }),
    logger: logger(logged),
    helpers: { httpRequest: fakeHttp(opts.handler, requests) },
  };
  return { ctx: ctx as never, requests, logged };
}

/** A fake `IPollFunctions` over one shared static-data object, as n8n hands every tick. */
export function pollContext(opts: {
  params: Record<string, unknown>;
  handler: Handler;
  mode?: "manual" | "trigger";
  staticData?: Record<string, unknown>;
}) {
  const requests: RecordedRequest[] = [];
  const logged: Logged = { warn: [], info: [], debug: [] };
  const staticData = opts.staticData ?? {};
  const ctx = {
    getNodeParameter: (name: string, fallback?: unknown) => (name in opts.params ? opts.params[name] : fallback),
    getWorkflowStaticData: () => staticData,
    getMode: () => opts.mode ?? "trigger",
    getNode: () => ({ ...NODE, name: "Jobo Trigger", type: "n8n-nodes-jobo-job-search.joboTrigger" }),
    getCredentials: async () => ({ apiKey: API_KEY, baseUrl: "https://api.test" }),
    logger: logger(logged),
    helpers: { httpRequest: fakeHttp(opts.handler, requests) },
  };
  return { ctx: ctx as never, requests, logged, staticData };
}

/** A job as the API returns it, trimmed to what the nodes read. */
export function job(id: string, createdAt = "2026-11-23T10:00:00Z") {
  return { id, title: `Job ${id}`, created_at: createdAt };
}

/** A `POST /api/jobs/search` response body. */
export function searchPage(opts: { jobs: unknown[]; page: number; pageSize: number; total: number }) {
  return {
    jobs: opts.jobs,
    total: opts.total,
    page: opts.page,
    page_size: opts.pageSize,
    total_pages: Math.ceil(opts.total / opts.pageSize),
    facets: {},
  };
}
