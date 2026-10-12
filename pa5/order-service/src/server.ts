import express from "express";
import { randomUUID } from "node:crypto";
import { connectWithRetry, withoutRetryHistory } from "../../shared/rabbit";
import type { CanonicalOrder } from "../../shared/canonical-order";

const orders = new Map<string, CanonicalOrder>();
const PORT = Number(process.env.PORT ?? "3000");

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fields(value: unknown, keys: string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).every(key => keys.includes(key)) &&
    keys.every(key => Object.hasOwn(value, key));
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function isOrder(value: unknown): value is CanonicalOrder {
  if (!fields(value, ["orderId", "orderType", "source", "receivedAt", "orderDate", "customer", "items", "currency", "status"])) return false;
  if (!text(value.orderId) || !text(value.currency) ||
    !["standard", "express", "b2b"].includes(String(value.orderType)) ||
    !["web", "mobile", "b2b"].includes(String(value.source)) ||
    !["new", "processing", "shipped", "delivered"].includes(String(value.status))) return false;
  for (const date of [value.receivedAt, value.orderDate]) {
    if (!text(date) || !Number.isFinite(Date.parse(date))) return false;
  }
  if (!fields(value.customer, ["name", "email", "address"]) ||
    !text(value.customer.name) || !text(value.customer.email) ||
    !fields(value.customer.address, ["street", "city", "postalCode", "country"]) ||
    !Object.values(value.customer.address).every(text)) return false;
  return Array.isArray(value.items) && value.items.length > 0 && value.items.every(item =>
    fields(item, ["productId", "productName", "quantity", "unitPrice", "currency", "taxRate"]) &&
    text(item.productId) && /^PROD-[0-9]+$/.test(item.productId) && text(item.productName) &&
    typeof item.quantity === "number" && Number.isInteger(item.quantity) && item.quantity >= 1 &&
    text(item.unitPrice) && /^-?[0-9]+\.[0-9]{2}$/.test(item.unitPrice) && text(item.currency) &&
    typeof item.taxRate === "number" && Number.isFinite(item.taxRate) && item.taxRate >= 0 && item.taxRate <= 1);
}

async function main(): Promise<void> {
  const { connection, channel: initialChannel } = await connectWithRetry(process.env.RABBITMQ_URL!);
  const channel = await connection.createConfirmChannel();
  await initialChannel.close();
  await channel.assertExchange("orders.dlq.exchange", "fanout", { durable: true });
  await channel.assertQueue("orders.dlq", { durable: true });
  await channel.bindQueue("orders.dlq", "orders.dlq.exchange", "");
  const app = express();
  app.use(express.json());
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/orders/:correlationId", (req, res) => {
    const order = orders.get(req.params.correlationId);
    if (!order) { res.status(404).json({ error: "Order not found" }); return; }
    res.json({ correlationId: req.params.correlationId, order });
  });
  app.post("/orders", async (req, res) => {
    if (!isOrder(req.body)) { res.status(400).json({ error: "Expected a canonical order" }); return; }
    const order = req.body;
    const correlationId = randomUUID();
    try {
      await new Promise<void>((resolve, reject) => {
        channel.publish("orders.exchange", "", Buffer.from(JSON.stringify(order)), {
          headers: { correlationId }, contentType: "application/json", persistent: true,
        }, error => error ? reject(error) : resolve());
      });
      orders.set(correlationId, order);
      console.log(`[Order] Accepted ${correlationId} for ${order.orderId}`);
      res.status(201).json({ correlationId, status: "accepted" });
    } catch {
      res.status(503).json({ error: "Broker publication failed" });
    }
  });
  let replaying = false;
  app.post("/dlq/replay", async (_req, res) => {
    if (replaying) { res.status(409).json({ error: "Replay already in progress" }); return; }
    replaying = true;
    let replayed = 0;
    let replayChannel: Awaited<ReturnType<typeof connection.createConfirmChannel>> | undefined;
    try {
      replayChannel = await connection.createConfirmChannel();
      // Drain the current batch only, so a still-failing consumer cannot
      // turn one HTTP request into an unbounded replay loop.
      const { messageCount } = await replayChannel.checkQueue("orders.dlq");
      for (let index = 0; index < messageCount; index++) {
        const msg = await replayChannel.get("orders.dlq", { noAck: false });
        if (!msg) break;
        const origin = msg.properties.headers?.originQueue;
        if (!["payments.queue", "inventory.queue", "notifications.queue"].includes(origin)) {
          replayChannel.nack(msg, false, true);
          throw new Error("Unknown DLQ origin queue");
        }
        const currentChannel = replayChannel;
        await new Promise<void>((resolve, reject) => {
          currentChannel.publish("orders.return.exchange", origin, msg.content, {
            headers: withoutRetryHistory(msg.properties.headers),
            contentType: msg.properties.contentType, persistent: true,
          }, error => error ? reject(error) : resolve());
        });
        replayChannel.ack(msg);
        replayed++;
      }
      res.json({ replayed });
    } catch {
      res.status(503).json({ error: "Replay failed", replayed });
    } finally {
      if (replayChannel) await replayChannel.close().catch(() => {});
      replaying = false;
    }
  });
  app.listen(PORT, () => console.log(`[Order] Listening on ${PORT}`));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
