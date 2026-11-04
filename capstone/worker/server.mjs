import { Worker, NativeConnection } from "@temporalio/worker";
import { ApplicationFailure, Context } from "@temporalio/activity";
import { fileURLToPath } from "node:url";
import { Broker, env, sleep, provider, outcome, now } from "../shared/core.mjs";
const broker = new Broker("worker");
void broker.start();
async function mirror(route, body) {
  const r = await fetch(env("ORCHESTRATOR_URL") + route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw Error("orchestrator mirror failed");
}
const activities = {
  async perform(order, ctx, step) {
    ctx.attempt = Context.current().info.attempt;
    let hop;
    try {
      hop = await provider(broker, ctx, order, step);
      await mirror("/internal/progress", {
        cid: ctx.cid,
        entry: { step, status: "success", at: now() },
        compensation: step.includes("_"),
      });
      return { ...ctx, cause: hop };
    } catch (e) {
      if (e.hop) {
        await mirror("/internal/progress", {
          cid: ctx.cid,
          entry: { step, status: e.status, at: now(), code: e.code },
          compensation: step.includes("_"),
        });
        const detail = { hop: e.hop, code: e.code };
        if (!e.temporary)
          throw ApplicationFailure.nonRetryable(e.code, e.code, detail);
        throw ApplicationFailure.retryable(e.code, e.code, detail);
      }
      throw e;
    }
  },
  async complete(order, ctx, state, code) {
    while (!broker.ready) await sleep(100);
    const hop = broker.hop(ctx.cid, ctx.cause, "saga.outcome");
    const envelope = outcome(order, ctx, state, code);
    await mirror("/internal/outcome", { cid: ctx.cid, envelope, cause: hop });
    await broker.publish("orders.outcome", `order.${state}`, envelope, {
      correlationId: ctx.cid,
      causationId: hop,
      businessKey: ctx.businessKey,
    });
    return envelope;
  },
};
let connection;
for (;;) {
  try {
    connection = await NativeConnection.connect({
      address: env("TEMPORAL_ADDRESS"),
    });
    break;
  } catch {
    await sleep(500);
  }
}
while (!broker.ready) await sleep(100);
const worker = await Worker.create({
  connection,
  namespace: "default",
  taskQueue: "checkout",
  workflowsPath: fileURLToPath(new URL("./workflow.ts", import.meta.url)),
  activities,
});
await worker.run();
