import type { IExecuteFunctions, ILoadOptionsFunctions, IPollFunctions } from "n8n-workflow";
import { JoboClient, type Transport, type TransportRequest, type TransportResponse } from "@jobo-ai/connector-core";

type JoboFunctions = IExecuteFunctions | IPollFunctions | ILoadOptionsFunctions;

/**
 * Bridge n8n's HTTP helper into connector-core's transport seam.
 *
 * Verified community nodes may not ship runtime dependencies, so the node must
 * route HTTP through `this.helpers.httpRequest` rather than a bundled client.
 * connector-core takes an injectable transport precisely so its retry, credit
 * accounting and watermark logic can be reused on top of whatever the host
 * provides.
 *
 * `returnFullResponse` is required: the credit and rate-limit headers are the
 * whole point of the wrapper, and they are lost with a body-only response.
 * `json: false` keeps the body a raw string so connector-core owns parsing and
 * error mapping for every connector identically.
 */
function n8nTransport(ctx: JoboFunctions): Transport {
  return {
    async request(req: TransportRequest): Promise<TransportResponse> {
      const response = await ctx.helpers.httpRequest({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body,
        json: false,
        returnFullResponse: true,
        // connector-core maps status codes to typed errors; letting n8n throw
        // first would discard the response body and the credit headers with it.
        ignoreHttpStatusErrors: true,
        timeout: req.timeoutMs,
      });

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(response.headers ?? {})) {
        headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
      }

      return {
        status: response.statusCode,
        headers,
        body: typeof response.body === "string" ? response.body : JSON.stringify(response.body ?? ""),
      };
    },
  };
}

export async function joboClient(ctx: JoboFunctions): Promise<JoboClient> {
  const credentials = await ctx.getCredentials("joboApi");
  const apiKey = String(credentials.apiKey ?? "");
  const baseUrl = String(credentials.baseUrl || "https://connect.jobo.world");

  return new JoboClient({
    apiKey,
    baseUrl,
    transport: n8nTransport(ctx),
    userAgent: "n8n-nodes-jobo/0.1.0",
  });
}
