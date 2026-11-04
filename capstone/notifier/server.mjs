import {
  Broker,
  Store,
  appFor,
  listen,
  fs,
  env,
  num,
  now,
  retries,
  failurePath,
  quarantine,
  schema,
  randomUUID,
} from "../shared/core.mjs";
import path from "node:path";
const broker = new Broker("notifier"),
  processed = new Store("processed-ids.json", []),
  valid = schema("outcome-event");
broker.consume("notifications.queue", async (msg, ch) => {
  const h = msg.properties.headers ?? {},
    attempt = retries(msg) + 1;
  let e;
  try {
    e = JSON.parse(msg.content);
    if (!valid(e) || !h.correlationId) throw Error("invalid");
  } catch {
    await quarantine(broker, msg, ch, h.causationId);
    return;
  }
  const cid = h.correlationId,
    consume = broker.hop(
      cid,
      h.causationId,
      "notify.consume",
      "success",
      attempt,
    );
  if (processed.data.includes(cid)) {
    broker.hop(cid, consume, "notify.duplicate", "duplicate", attempt);
    ch.ack(msg);
    return;
  }
  const id = randomUUID(),
    start = Date.now();
  let failure;
  try {
    const r = await fetch(env("NOTIFICATION_URL") + "/notification/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-Id": cid,
        "X-Causation-Id": id,
      },
      body: JSON.stringify({
        orderId: e.orderId,
        recipient: e.recipient,
        kind: "order_not_completed",
        reason: e.code,
      }),
      signal: AbortSignal.timeout(num("REQUEST_TIMEOUT_MS")),
    });
    await r.text();
    if (!r.ok) throw Error(`notification ${r.status}`);
  } catch (error) {
    failure = error.name === "TimeoutError" ? "timeout" : error.message;
  }
  broker.hop(
    cid,
    consume,
    "notify.send",
    failure ? (failure === "timeout" ? "timeout" : "failed") : "success",
    attempt,
    failure ? { code: failure } : undefined,
    start,
    id,
  );
  if (failure) {
    if (await failurePath(broker, msg, ch, consume, failure, id)) ch.ack(msg);
    return;
  }
  fs.appendFileSync(
    path.join(env("DATA_DIR"), "notification.log"),
    JSON.stringify({
      correlationId: cid,
      orderId: e.orderId,
      customerEmail: e.recipient,
      timestamp: now(),
      message: "Order not completed",
      reason: e.code,
    }) + "\n",
  );
  processed.data.push(cid);
  processed.save();
  ch.ack(msg);
});
listen(appFor(broker));
void broker.start();
