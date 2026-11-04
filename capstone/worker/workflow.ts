import {
  proxyActivities,
  ActivityFailure,
  ApplicationFailure,
  TimeoutFailure,
} from "@temporalio/workflow";
type Context = {
  cid: string;
  businessKey: string;
  cause: string;
  attempt: number;
};
type Activity = {
  perform(order: any, ctx: Context, step: string): Promise<Context>;
  complete(
    order: any,
    ctx: Context,
    state: string,
    code?: string,
  ): Promise<any>;
};
const act = proxyActivities<Activity>({
  startToCloseTimeout: "2500 ms",
  retry: {
    maximumAttempts: 3,
    initialInterval: "200 ms",
    backoffCoefficient: 2,
  },
});
export async function checkout({
  order,
  ctx,
}: {
  order: any;
  ctx: Context;
}): Promise<any> {
  const done: string[] = [];
  let code = "unreachable";
  try {
    for (const step of order.orderType === "b2b"
      ? ["inventory", "shipping", "notification"]
      : ["payment", "inventory", "shipping", "notification"]) {
      ctx = await act.perform(order, ctx, step);
      done.push(step);
    }
    return await act.complete(order, ctx, "completed");
  } catch (error) {
    const cause = error instanceof ActivityFailure ? error.cause : error;
    code =
      cause instanceof TimeoutFailure
        ? "timeout"
        : cause instanceof ApplicationFailure
          ? (cause.type ?? "unreachable")
          : "unreachable";
    if (cause instanceof ApplicationFailure) {
      const detail = cause.details?.[0] as any;
      if (detail?.hop) ctx = { ...ctx, cause: detail.hop };
    }
    for (const [forward, undo] of [
      ["inventory", "inventory_release"],
      ["payment", "payment_refund"],
    ]) {
      if (done.includes(forward!)) {
        try {
          ctx = await act.perform(order, ctx, undo!);
        } catch (e) {
          const c = e instanceof ActivityFailure ? e.cause : e;
          const detail =
            c instanceof ApplicationFailure ? (c.details?.[0] as any) : null;
          if (detail?.hop) ctx = { ...ctx, cause: detail.hop };
          return await act.complete(
            order,
            ctx,
            "compensation_failed",
            c instanceof TimeoutFailure
              ? "timeout"
              : c instanceof ApplicationFailure
                ? (c.type ?? "unreachable")
                : "unreachable",
          );
        }
      }
    }
    return await act.complete(
      order,
      ctx,
      done.length ? "compensated" : "failed",
      code,
    );
  }
}
