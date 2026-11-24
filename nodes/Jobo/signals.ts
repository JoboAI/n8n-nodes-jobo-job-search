import { NodeApiError, type IDataObject, type INode } from "n8n-workflow";

import {
  InsufficientCreditsError,
  JoboApiError,
  RateLimitError,
  describeSignal,
  signalStrengthBand,
  signalTypeLabel,
  type HiringSignal,
} from "@jobo-ai/connector-core";

/**
 * What the Jobo node and the Jobo Hiring Signal Trigger share about hiring
 * signals: the item each signal becomes, and the API failures worth their own
 * wording.
 */

/**
 * The most signals Return All reads. A signal costs ten times a job and one
 * read again is billed again, so an unbounded read is a bill, not a
 * convenience: past this the node stops and says so in the n8n log.
 */
export const SIGNAL_RETURN_ALL_MAX = 1000;

/**
 * A signal as the API returned it, plus the words Jobo's dashboard uses for
 * it: `summary` ("17 new jobs this week vs 3.1 a week normally"),
 * `type_label` and `strength_band`. A type this version does not know still
 * gets a label and a summary (its type in words), never an error.
 */
export function signalItem(signal: HiringSignal): IDataObject {
  return {
    ...(signal as unknown as IDataObject),
    summary: describeSignal(signal),
    type_label: signalTypeLabel(signal.type),
    strength_band: typeof signal.strength === "number" ? signalStrengthBand(signal.strength) : null,
  };
}

const API_KEYS_URL = "https://enterprise.jobo.world/api-keys?src=n8n";

/**
 * The Hiring Signals failures a user can act on, as n8n errors that say how;
 * undefined for anything else, which the caller maps as it maps a job
 * operation's failure.
 */
export function signalApiError(node: INode, error: unknown, itemIndex?: number): NodeApiError | undefined {
  if (!(error instanceof JoboApiError)) return undefined;
  const response = { message: error.message } as never;

  if (error instanceof InsufficientCreditsError) {
    return new NodeApiError(node, response, {
      httpCode: "402",
      message: "Not enough included signals or wallet balance",
      description:
        "Jobo refused this page of signals before returning any, and charged nothing: your plan's included signals and your wallet together cannot cover it. Top up at https://enterprise.jobo.world/credits?src=n8n, lower Limit, or narrow the filters.",
      itemIndex,
    });
  }
  if (error.status === 403 && error.code === "account_key_required") {
    return new NodeApiError(node, response, {
      httpCode: "403",
      message: "Hiring Signals needs an account API key",
      description: `This API key belongs to no Jobo account, so there is no wallet to bill signals to. Create a key under Developers → API Keys at ${API_KEYS_URL} and use it in the Jobo API credential.`,
      itemIndex,
    });
  }
  if (error.status === 404 && error.code === "not_available_in_sandbox") {
    return new NodeApiError(node, response, {
      httpCode: "404",
      message: "Hiring Signals is not available with a sandbox key",
      description: `The Jobo API credential holds a sandbox key (jbe_test_…). Use a live key (jbe_live_…) from ${API_KEYS_URL}.`,
      itemIndex,
    });
  }
  if (error instanceof RateLimitError) {
    const wait = error.retryAfterSeconds != null ? ` Try again in ${error.retryAfterSeconds} seconds.` : "";
    return new NodeApiError(node, response, {
      httpCode: "429",
      message: "Jobo rate limit reached",
      description: `Too many Hiring Signals requests. Without a subscription the limit is 20 requests a minute, 200 an hour and 1,000 a day.${wait}`,
      itemIndex,
    });
  }
  return undefined;
}
