/**
 * PA5 inventory-service — the reference consumer. Connection, consume setup,
 * and retry/DLQ logic are given below and work as-is; only the TODO in the
 * `try` block is yours. Study this file, then replicate the pattern in
 * inventory-service and notification-service.
 */

import type { ConsumeMessage } from "amqplib";
import { connectWithRetry, getRetryCount } from "../../shared/rabbit";
import type { CanonicalOrder } from "../../shared/canonical-order";

const QUEUE = "inventory.queue";
const RESULTS_EXCHANGE = "results.inventory";
const MAX_RETRIES = Number(process.env.MAX_RETRIES) || 3;
const FAIL_RATE = Number(process.env.INVENTORY_FAIL_RATE ?? "10");

async function main(): Promise<void> {
  const { channel } = await connectWithRetry(process.env.RABBITMQ_URL!);
  await channel.prefetch(1);

  console.log(`[Inventory] Consuming from ${QUEUE}, fail rate: ${FAIL_RATE}%`);

  await channel.consume(QUEUE, async (msg: ConsumeMessage | null) => {
    if (!msg) return;

    const correlationId = msg.properties.headers?.["correlationId"] as string | undefined;
    const retryCount = getRetryCount(msg);

    console.log(`[Inventory] Processing ${correlationId} (attempt ${retryCount + 1})`);

    try {
      const order = JSON.parse(msg.content.toString()) as CanonicalOrder;
      if (!correlationId || !order.orderId) throw new Error("Missing order or correlation identifier");
      if (Math.random() * 100 < FAIL_RATE) throw new Error("Simulated inventory failure");
      channel.publish(RESULTS_EXCHANGE, "", Buffer.from(JSON.stringify({
        correlationId, source: "inventory", status: "success",
        timestamp: new Date().toISOString(), details: { message: `Inventory accepted for ${order.orderId}` },
      })), { headers: { correlationId }, contentType: "application/json", persistent: true });
      channel.ack(msg);
    } catch (err) {
      // Retry / DLQ logic (provided as reference — study this for the other
      // two services). Do not modify.
      if (retryCount >= MAX_RETRIES - 1) {
        channel.publish(process.env.DLQ_EXCHANGE!, "", msg.content, {
          headers: msg.properties.headers,
        });
        channel.ack(msg);
        console.log(`[Inventory] -> DLQ after ${retryCount + 1} attempts: ${(err as Error).message}`);
      } else {
        channel.nack(msg, false, false);
        console.log(`[Inventory] -> Retry (attempt ${retryCount + 1}): ${(err as Error).message}`);
      }
    }
  });
}

main().catch(console.error);
