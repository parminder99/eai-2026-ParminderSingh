import {
  Broker,
  Store,
  appFor,
  listen,
  express,
  randomUUID,
  num,
  env,
  now,
  schema,
  provider,
  outcome,
  failurePath,
  retries,
  quarantine,
} from "../shared/core.mjs";
const broker = new Broker("orchestrator"),
  store = new Store("saga-store.json", { sagas: {}, businessKeys: {} }),
  valid = schema("canonical"),
  owner = randomUUID(),
  active = new Map(),
  operators = new Set();
const temporal = env("SAGA_ENGINE") === "temporal";
let client;
async function temporalClient() {
  if (!client) {
    const { Client, Connection } = await import("@temporalio/client");
    client = new Client({
      connection: await Connection.connect({
        address: env("TEMPORAL_ADDRESS"),
      }),
    });
  }
  return client;
}
async function finish(r, ctx, state, code, duplicateOf) {
  r.state = state;
  r.code = code;
  r.updatedAt = now();
  const envelope = outcome(r.order, ctx, state, code, duplicateOf);
  r.outcome = { routingKey: `order.${state}`, envelope };
  r.lastHop = ctx.cause;
  store.save();
  await emit(r, ctx);
}
async function emit(r, ctx) {
  const h = broker.hop(
    ctx.cid,
    ctx.cause,
    "saga.outcome",
    "success",
    ctx.attempt,
  );
  await broker.publish(
    "orders.outcome",
    r.outcome.routingKey,
    r.outcome.envelope,
    { correlationId: ctx.cid, causationId: h, businessKey: r.businessKey },
  );
  ctx.cause = h;
  r.lastHop = h;
  store.save();
}
async function processing(r, ctx) {
  r.state = "processing";
  r.updatedAt = now();
  store.save();
  const h = broker.hop(
    ctx.cid,
    ctx.cause,
    "saga.outcome",
    "success",
    ctx.attempt,
  );
  await broker.publish(
    "orders.outcome",
    "order.processing",
    outcome(r.order, ctx, "processing"),
    { correlationId: ctx.cid, causationId: h, businessKey: r.businessKey },
  );
  ctx.cause = h;
}
async function step(r, ctx, name) {
  r.lastHop = ctx.cause;
  r.running = true;
  r.updatedAt = now();
  store.save();
  try {
    ctx.cause = await provider(broker, ctx, r.order, name);
    const entry = { step: name, status: "success", at: now() };
    (name.includes("_") ? r.compensations : r.steps).push(entry);
    r.running = false;
    r.lastHop = ctx.cause;
    r.updatedAt = now();
    store.save();
  } catch (e) {
    ctx.cause = e.hop;
    (name.includes("_") ? r.compensations : r.steps).push({
      step: name,
      status: e.status,
      at: now(),
      code: e.code,
    });
    r.running = false;
    r.lastHop = ctx.cause;
    r.updatedAt = now();
    store.save();
    throw e;
  }
}
async function compensate(r, ctx) {
  const successes = new Set(
    r.steps.filter((s) => s.status === "success").map((s) => s.step),
  );
  const undone = new Set(
    r.compensations.filter((s) => s.status === "success").map((s) => s.step),
  );
  for (const [forward, undo] of [
    ["inventory", "inventory_release"],
    ["payment", "payment_refund"],
  ]) {
    if (successes.has(forward) && !undone.has(undo)) {
      try {
        await step(r, ctx, undo);
      } catch (e) {
        await finish(r, ctx, "compensation_failed", e.code);
        return;
      }
    }
  }
  await finish(r, ctx, "compensated", r.failureCode ?? "operator_compensated");
}
async function handle(msg, ch) {
  let order;
  const headers = msg.properties.headers ?? {},
    cid = headers.correlationId,
    attempt = retries(msg) + 1;
  try {
    order = JSON.parse(msg.content);
    if (!cid || !valid(order)) throw Error("invalid");
  } catch {
    await quarantine(broker, msg, ch, headers.causationId);
    return;
  }
  const businessKey = `${order.source}:${order.orderId}`,
    ctx = { cid, businessKey, cause: headers.causationId, attempt };
  ctx.cause = broker.hop(cid, ctx.cause, "saga.consume", "success", attempt);
  ctx.consume = ctx.cause;
  let r = store.data.sagas[cid];
  const first = store.data.businessKeys[businessKey];
  if (first && first !== cid) {
    r ??= {
      order,
      businessKey,
      state: "duplicate",
      duplicateOf: first,
      steps: [],
      compensations: [],
      owner,
      updatedAt: now(),
    };
    store.data.sagas[cid] = r;
    ctx.cause = broker.hop(cid, ctx.cause, "saga.dedupe", "duplicate", attempt);
    if (!r.outcome) await finish(r, ctx, "duplicate", undefined, first);
    else await emit(r, ctx);
    ch.ack(msg);
    return;
  }
  if (r?.outcome && r.state !== "parked") {
    ctx.cause = broker.hop(cid, ctx.cause, "saga.dedupe", "skipped", attempt);
    await emit(r, ctx);
    ch.ack(msg);
    return;
  }
  if (
    !temporal &&
    r?.state === "processing" &&
    r.owner !== owner &&
    !r.retryPending
  ) {
    ctx.cause = broker.hop(cid, ctx.cause, "saga.stuck");
    await finish(r, ctx, "needs_attention");
    ch.ack(msg);
    return;
  }
  if (!r) {
    r = {
      order,
      businessKey,
      state: "processing",
      steps: [],
      compensations: [],
      owner,
      updatedAt: now(),
    };
    store.data.sagas[cid] = r;
    store.data.businessKeys[businessKey] = cid;
    store.save();
  }
  r.owner = owner;
  r.retryPending = false;
  delete r.outcome;
  ctx.cause = broker.hop(cid, ctx.cause, "saga.dedupe", "success", attempt);
  await processing(r, ctx);
  if (temporal) {
    const h = broker.hop(cid, ctx.cause, "workflow.start");
    ctx.cause = h;
    try {
      await (
        await temporalClient()
      ).workflow.start("checkout", {
        taskQueue: "checkout",
        workflowId: businessKey,
        args: [{ order, ctx }],
      });
    } catch (e) {
      if (e.name !== "WorkflowExecutionAlreadyStartedError") throw e;
    }
    ch.ack(msg);
    return;
  }
  const sequence =
    order.orderType === "b2b"
      ? ["inventory", "shipping", "notification"]
      : ["payment", "inventory", "shipping", "notification"];
  for (let i = 0; i < sequence.length; i++) {
    try {
      await step(r, ctx, sequence[i]);
    } catch (e) {
      if (i === 0 && e.temporary) {
        r.retryPending = true;
        store.save();
        const parked = await failurePath(
          broker,
          msg,
          ch,
          ctx.consume,
          e.code,
          ctx.cause,
        );
        if (parked) {
          ctx.cause = parked;
          await finish(r, ctx, "parked", e.code);
          ch.ack(msg);
        }
        return;
      }
      r.failureCode = e.code;
      if (i === 0) {
        await finish(r, ctx, "failed", e.code);
      } else await compensate(r, ctx);
      ch.ack(msg);
      return;
    }
  }
  await finish(r, ctx, "completed");
  ch.ack(msg);
}
broker.consume(
  "saga.queue",
  async (msg, ch) => {
    const cid = msg.properties.headers?.correlationId;
    if (active.has(cid)) {
      await active.get(cid);
      return handle(msg, ch);
    }
    const task = handle(msg, ch);
    active.set(cid, task);
    try {
      await task;
    } finally {
      active.delete(cid);
    }
  },
  num("SAGA_CONCURRENCY"),
);
const app = appFor(broker);
app.use(express.json());
app.get("/sagas/stuck", (_q, res) =>
  res.json({
    sagas: temporal
      ? []
      : Object.entries(store.data.sagas)
          .filter(([, r]) =>
            ["needs_attention", "compensation_failed"].includes(r.state),
          )
          .map(([correlationId, r]) => ({
            correlationId,
            businessKey: r.businessKey,
            state: r.state,
            completedSteps: r.steps
              .filter((x) => x.status === "success")
              .map((x) => x.step),
            compensatedSteps: r.compensations
              .filter((x) => x.status === "success")
              .map((x) => x.step),
            since: r.updatedAt,
          })),
  }),
);
app.post("/sagas/:cid/compensate", async (req, res) => {
  const cid = req.params.cid,
    r = store.data.sagas[cid];
  if (temporal) return res.status(409).json({ code: "saga_not_stuck" });
  if (!r) return res.sendStatus(404);
  if (operators.has(cid))
    return res.status(409).json({ code: "compensation_in_progress" });
  if (r.state === "compensated" && r.operatorCompensation?.response)
    return res.json(r.operatorCompensation.response);
  if (!["needs_attention", "compensation_failed"].includes(r.state))
    return res.status(409).json({ code: "saga_not_stuck" });
  operators.add(cid);
  try {
    const cause = r.outcome?.causationId ?? r.lastHop ?? randomUUID(),
      ctx = { cid, businessKey: r.businessKey, cause, attempt: 1 };
    ctx.cause = broker.hop(cid, ctx.cause, "saga.operator_compensate");
    r.operatorCompensation = { startedAt: now() };
    store.save();
    await compensate(r, ctx);
    const response = { correlationId: cid, state: r.state };
    r.operatorCompensation = {
      ...r.operatorCompensation,
      response,
      finishedAt: now(),
    };
    store.save();
    return res.json(response);
  } catch (e) {
    return res.status(503).json({ code: "broker_unavailable" });
  } finally {
    operators.delete(cid);
  }
});
// Temporal activities mirror their durable decisions here; the worker owns I/O and hops.
app.post("/internal/progress", (req, res) => {
  const { cid, entry, compensation } = req.body,
    r = store.data.sagas[cid];
  if (!r) return res.sendStatus(404);
  (compensation ? r.compensations : r.steps).push(entry);
  r.updatedAt = now();
  store.save();
  res.json({ ok: true });
});
app.post("/internal/outcome", (req, res) => {
  const { cid, envelope, cause } = req.body,
    r = store.data.sagas[cid];
  if (!r) return res.sendStatus(404);
  r.state = envelope.state;
  r.outcome = { routingKey: `order.${envelope.state}`, envelope };
  r.lastHop = cause;
  r.updatedAt = now();
  store.save();
  res.json({ ok: true });
});
listen(app);
void broker.start();
// Reconcile only runs interrupted between steps, never delayed-but-live work.
async function detect() {
  if (temporal || !broker.ready) return;
  for (const [cid, r] of Object.entries(store.data.sagas)) {
    if (r.state === "processing" && r.owner !== owner && !r.retryPending) {
      const ctx = {
        cid,
        businessKey: r.businessKey,
        cause: r.lastHop ?? randomUUID(),
        attempt: 1,
      };
      ctx.cause = broker.hop(cid, ctx.cause, "saga.stuck");
      await finish(r, ctx, "needs_attention");
    }
  }
}
setInterval(
  () => detect().catch(console.error),
  Math.min(1000, num("SAGA_STUCK_AFTER_MS")),
).unref();
