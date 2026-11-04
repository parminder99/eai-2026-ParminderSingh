import { Broker, appFor, listen, fs, env, num, now } from "../shared/core.mjs";
import path from "node:path";
const broker = new Broker("observer"),
  file = path.join(env("DATA_DIR"), "trace-store.jsonl");
fs.mkdirSync(env("DATA_DIR"), { recursive: true });
if (!fs.existsSync(file)) fs.writeFileSync(file, "");
const ids = new Set();
for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
  try {
    ids.add(JSON.parse(line).hopId);
  } catch {}
}
broker.consume(
  "trace.store",
  async (msg, ch) => {
    try {
      const hop = JSON.parse(msg.content);
      if (hop.hopId && !ids.has(hop.hopId)) {
        fs.appendFileSync(file, JSON.stringify(hop) + "\n");
        ids.add(hop.hopId);
      }
    } catch {}
    ch.ack(msg);
  },
  100,
);
const app = appFor(broker);
app.get("/trace/:cid", (req, res) => {
  const hops = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    })
    .filter((h) => h.correlationId === req.params.cid)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return hops.length
    ? res.json({ correlationId: req.params.cid, hops })
    : res.sendStatus(404);
});
app.get("/ops/metrics", async (_req, res) => {
  try {
    const auth =
      "Basic " +
      Buffer.from(
        env("MANAGEMENT_USER") + ":" + env("MANAGEMENT_PASSWORD"),
      ).toString("base64");
    const all = await (
      await fetch(env("MANAGEMENT_URL") + "/api/queues/%2F", {
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(2000),
      })
    ).json();
    const queues = {};
    for (const q of [
      "saga.queue",
      "notifications.queue",
      "orders.dlq",
      "orders.invalid",
      "trace.store",
    ]) {
      const exact = await broker.channel.checkQueue(q),
        m = all.find((x) => x.name === q);
      queues[q] = {
        ready: exact.messageCount,
        unacked: m?.messages_unacknowledged ?? 0,
        consumers: exact.consumerCount,
      };
    }
    const stuck = await (
      await fetch(env("ORCHESTRATOR_URL") + "/sagas/stuck", {
        signal: AbortSignal.timeout(2000),
      })
    ).json();
    const dlqDepth = queues["orders.dlq"].ready + queues["orders.dlq"].unacked,
      invalidDepth =
        queues["orders.invalid"].ready + queues["orders.invalid"].unacked,
      stuckSagas = stuck.sagas.length;
    const alerts = [
      ["dlq_not_empty", dlqDepth, null, "gt"],
      ["invalid_not_empty", invalidDepth, null, "gt"],
      ["saga_consumer_missing", queues["saga.queue"].consumers, null, "eq"],
      [
        "notifier_consumer_missing",
        queues["notifications.queue"].consumers,
        null,
        "eq",
      ],
      [
        "saga_consumer_lag",
        queues["saga.queue"].ready,
        num("SAGA_LAG_THRESHOLD"),
        "gt",
      ],
      [
        "notifier_consumer_lag",
        queues["notifications.queue"].ready,
        num("NOTIFIER_LAG_THRESHOLD"),
        "gt",
      ],
      ["stuck_sagas", stuckSagas, null, "gt"],
    ].map(([key, value, threshold, op]) => ({
      key,
      value,
      threshold,
      firing: op === "eq" ? value === 0 : value > (threshold ?? 0),
    }));
    res.json({
      generatedAt: now(),
      queues,
      dlqDepth,
      invalidDepth,
      stuckSagas,
      alerts,
    });
  } catch {
    res.status(503).json({ code: "metrics_unavailable" });
  }
});
listen(app);
void broker.start();
