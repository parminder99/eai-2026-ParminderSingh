import { proxyActivities, ActivityFailure, ApplicationFailure, TimeoutFailure } from "@temporalio/workflow";
import type * as activities from "../activities";
import type { CanonicalOrder, CheckoutResult, TraceItem } from "../types";

const act = proxyActivities<typeof activities>({
  startToCloseTimeout: "2500 ms",
  retry: { maximumAttempts: 3, initialInterval: "200 ms", backoffCoefficient: 2 },
});

function failureCode(error: unknown): string {
  const cause = error instanceof ActivityFailure ? error.cause : error;
  if (cause instanceof TimeoutFailure) return "timeout";
  if (cause instanceof ApplicationFailure) return cause.type ?? "downstream_error";
  return "downstream_error";
}

function amountFor(order: CanonicalOrder): string {
  let cents = 0n;
  for (const item of order.items) {
    const negative = item.unitPrice.startsWith("-");
    const [whole, fraction] = item.unitPrice.replace(/^-/, "").split(".");
    const unit = BigInt(whole!) * 100n + BigInt(fraction!);
    cents += (negative ? -unit : unit) * BigInt(item.quantity);
  }
  const magnitude = cents < 0n ? -cents : cents;
  return `${cents < 0n ? "-" : ""}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, "0")}`;
}

export async function checkout(order: CanonicalOrder): Promise<CheckoutResult> {
  const trace: TraceItem[] = [];
  async function run(step: string, call: () => Promise<void>): Promise<void> {
    const start = Date.now();
    let status = "success";
    try { await call(); }
    catch (error) { status = failureCode(error) === "timeout" ? "timeout" : "failed"; throw error; }
    finally {
      const end = Date.now();
      trace.push({ step, status, startedAt: new Date(start).toISOString(),
        finishedAt: new Date(end).toISOString(), durationMs: Math.max(0, end - start) });
    }
  }
  let paid = false;
  let reserved = false;
  try {
    await run("payment", () => act.authorizePayment(order.orderId, amountFor(order)));
    paid = true;
    await run("inventory", () => act.reserveInventory(order.orderId, order.items));
    reserved = true;
    await run("shipping", () => act.createShipment(order.orderId));
    await run("notification", () => act.sendNotification(order.orderId, order.customer.email));
    return { orderId: order.orderId, status: "completed", trace };
  } catch (error) {
    const code = failureCode(error);
    let compensationFailed = false;
    if (reserved) {
      try { await run("inventory_release", () => act.releaseInventory(order.orderId)); }
      catch { compensationFailed = true; }
    }
    if (paid) {
      try { await run("payment_refund", () => act.refundPayment(order.orderId)); }
      catch { compensationFailed = true; }
    }
    return { orderId: order.orderId,
      status: compensationFailed ? "failed" : paid ? "compensated" : "failed",
      code: compensationFailed ? "compensation_failed" : code, trace };
  }
}
