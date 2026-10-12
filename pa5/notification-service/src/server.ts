import type { ConsumeMessage } from "amqplib";
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import { connectWithRetry, getRetryCount } from "../../shared/rabbit";
import type { CanonicalOrder } from "../../shared/canonical-order";

const QUEUE = "notifications.queue";
const RESULTS_EXCHANGE = "results.notification";
const MAX_RETRIES = Number(process.env.MAX_RETRIES) || 3;
const IDS_FILE = "/data/processed-ids.json";
const LOG_FILE = "/data/notification.log";

async function main(): Promise<void> {
  mkdirSync("/data", { recursive: true });
  const saved: unknown = existsSync(IDS_FILE) ? JSON.parse(readFileSync(IDS_FILE, "utf8")) : [];
  if (!Array.isArray(saved) || saved.some(id => typeof id !== "string")) throw new Error("Invalid deduplication file");
  const processed = new Set<string>(saved);
  // Recover the append-before-ids crash window from the notification log.
  if (existsSync(LOG_FILE)) {
    for (const line of readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean)) {
      const entry = JSON.parse(line) as { correlationId: string };
      if (typeof entry.correlationId !== "string") throw new Error("Invalid notification log");
      processed.add(entry.correlationId);
    }
  }
  function persist(): void {
    writeFileSync(`${IDS_FILE}.tmp`, JSON.stringify([...processed]) + "\n");
    renameSync(`${IDS_FILE}.tmp`, IDS_FILE);
  }
  persist();
  const { channel } = await connectWithRetry(process.env.RABBITMQ_URL!);
  await channel.prefetch(1);
  await channel.consume(QUEUE, async (msg: ConsumeMessage | null) => {
    if (!msg) return;
    const correlationId = msg.properties.headers?.["correlationId"] as string | undefined;
    const retryCount = getRetryCount(msg);
    try {
      if (!correlationId) throw new Error("Missing correlation identifier");
      if (processed.has(correlationId)) {
        persist();
        channel.ack(msg);
        console.log(`[Notification] ${correlationId}: duplicate skipped`);
        return;
      }
      const order = JSON.parse(msg.content.toString()) as CanonicalOrder;
      if (!order.orderId || !order.customer?.email) throw new Error("Invalid notification order");
      const timestamp = new Date().toISOString();
      appendFileSync(LOG_FILE, JSON.stringify({ correlationId, orderId: order.orderId,
        customerEmail: order.customer.email, timestamp, message: "Order received" }) + "\n");
      processed.add(correlationId);
      persist();
      channel.publish(RESULTS_EXCHANGE, "", Buffer.from(JSON.stringify({
        correlationId, source: "notification", status: "success", timestamp,
        details: { message: "Order received" },
      })), { headers: { correlationId }, contentType: "application/json", persistent: true });
      channel.ack(msg);
      console.log(`[Notification] ${correlationId}: logged ${order.orderId}`);
    } catch (err) {
      // Retry / DLQ logic (provided as reference — study this for the other
      // two services). Do not modify.
      if (retryCount >= MAX_RETRIES - 1) {
        channel.publish(process.env.DLQ_EXCHANGE!, "", msg.content, {
          headers: msg.properties.headers,
        });
        channel.ack(msg);
        console.log(`[Notification] -> DLQ after ${retryCount + 1} attempts: ${(err as Error).message}`);
      } else {
        channel.nack(msg, false, false);
        console.log(`[Notification] -> Retry (attempt ${retryCount + 1}): ${(err as Error).message}`);
      }
    }
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
