import * as Sentry from "@sentry/nextjs";
import type { Instrumentation } from "next";
import { initSentry } from "@/lib/telemetry/sentry-init";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    initSentry("node");
  } else if (process.env.NEXT_RUNTIME === "edge") {
    initSentry("edge");
  }
}

export const onRequestError: Instrumentation.onRequestError = (
  err,
  request,
  context,
) => {
  Sentry.captureRequestError(err, request, context);
};
