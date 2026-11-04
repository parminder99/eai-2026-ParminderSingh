import amqp from "amqplib";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import Ajv from "ajv";
import addFormats from "ajv-formats";
export { express, randomUUID, fs };
export const env = (key) => {
  if (!process.env[key]) throw Error(`Missing ${key}`);
  return process.env[key];
};
export const num = (key) => Number(env(key));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => new Date().toISOString();
export class Store {
  constructor(name, initial) {
    this.file = path.join(env("DATA_DIR"), name);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.data = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : initial;
    this.save();
  }
  save() {
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.data, null, 2));
    fs.renameSync(this.file + ".tmp", this.file);
  }
}
export const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
export const schema = (name) =>
  ajv.compile(
    JSON.parse(
      fs.readFileSync(
        name === "canonical"
          ? "/canonical/order.schema.json"
          : `/app/grading/schema/${name}.schema.json`,
        "utf8",
      ),
    ),
  );
export const retries = (msg) =>
  (msg.properties.headers?.["x-death"] ?? [])
    .filter((x) => x.reason === "rejected")
    .reduce((a, x) => a + Number(x.count), 0);
export const withoutRetryHistory = (headers) =>
  Object.fromEntries(
    Object.entries(headers ?? {}).filter(
      ([k]) =>
        k !== "x-death" &&
        !k.startsWith("x-first-death-") &&
        !k.startsWith("x-last-death-"),
    ),
  );
export class Broker {
  constructor(service) {
    this.service = service;
    this.handlers = [];
    this.setup = [];
    this.ready = false;
  }
  consume(queue, handler, prefetch = 1) {
    this.handlers.push({ queue, handler, prefetch });
  }
  async start() {
    for (;;) {
      let connection;
      try {
        connection = await amqp.connect(env("RABBITMQ_URL"), { timeout: 2000 });
        connection.on("error", () => {});
        const closed = new Promise((r) =>
          connection.once("close", () => {
            this.ready = false;
            this.channel = null;
            r();
          }),
        );
        const channel = await connection.createConfirmChannel();
        channel.on("error", () => {});
        this.channel = channel;
        this.connection = connection;
        for (const setup of this.setup) await setup(channel);
        for (const x of this.handlers) {
          const consumer = await connection.createChannel();
          consumer.on("error", () => {});
          await consumer.prefetch(x.prefetch);
          await consumer.consume(x.queue, (msg) => {
            if (!msg) return;
            Promise.resolve(x.handler(msg, consumer)).catch((error) => {
              console.error(this.service, "handler", error.message);
              try {
                consumer.nack(msg, false, true);
              } catch {}
            });
          });
        }
        this.ready = true;
        await closed;
      } catch (error) {
        console.error(this.service, "broker", error.message);
        this.ready = false;
        this.channel = null;
        try {
          await connection?.close();
        } catch {}
      }
      await sleep(500);
    }
  }
  async publish(exchange, key, body, headers = {}, properties = {}) {
    if (!this.ready || !this.channel) throw Error("broker_unavailable");
    const channel = this.channel;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("broker_unavailable")), 2500);
      try {
        channel.publish(
          exchange,
          key,
          Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)),
          {
            persistent: true,
            contentType: "application/json",
            messageId: randomUUID(),
            headers,
            ...properties,
          },
          (error) => {
            clearTimeout(timer);
            error ? reject(error) : resolve();
          },
        );
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  }
  hop(
    correlationId,
    causationId,
    operation,
    status = "success",
    attempt = 1,
    detail,
    started = Date.now(),
    hopId = randomUUID(),
  ) {
    const end = Date.now();
    const hop = {
      hopId,
      correlationId,
      causationId,
      service: this.service,
      operation,
      status,
      attempt,
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(end).toISOString(),
      durationMs: end - started,
      ...(detail ? { detail } : {}),
    };
    // Best-effort wire tap: never await it from the business flow.
    if (this.ready && this.channel) {
      try {
        this.channel.publish(
          "trace.events",
          "",
          Buffer.from(JSON.stringify(hop)),
          {
            persistent: true,
            messageId: randomUUID(),
            contentType: "application/json",
          },
          () => {},
        );
      } catch {}
    }
    return hopId;
  }
  async health() {
    const consumers = {};
    if (this.ready) {
      try {
        for (const x of this.handlers)
          consumers[x.queue] = (
            await this.channel.checkQueue(x.queue)
          ).consumerCount;
      } catch {
        this.ready = false;
      }
    }
    const ok = this.ready && this.handlers.every((x) => consumers[x.queue] > 0);
    return {
      status: ok ? "ok" : "degraded",
      checks: { broker: this.ready ? "up" : "down", consumers },
    };
  }
}
export function appFor(broker) {
  const app = express();
  app.get("/health", async (_q, res) => {
    const h = await broker.health();
    res.status(h.status === "ok" ? 200 : 503).json(h);
  });
  return app;
}
export function listen(app) {
  app.listen(num("PORT"), "0.0.0.0");
}
export async function quarantine(broker, msg, ch, cause) {
  const cid = msg.properties.headers?.correlationId;
  const hop = cid
    ? broker.hop(cid, cause, "invalid.quarantine", "quarantined")
    : cause;
  await broker.publish(
    "orders.invalid.exchange",
    "",
    msg.content,
    msg.properties.headers ?? {},
  );
  ch.ack(msg);
  return hop;
}
export async function failurePath(broker, msg, ch, consumeHop, error, lastHop) {
  const h = msg.properties.headers ?? {},
    attempt = retries(msg) + 1,
    prefix = broker.service === "notifier" ? "notify" : "saga";
  if (attempt < num("MAX_RETRIES")) {
    broker.hop(
      h.correlationId,
      consumeHop,
      `${prefix}.retry`,
      "retried",
      attempt,
      { code: error },
    );
    ch.nack(msg, false, false);
    return false;
  }
  const hop = broker.hop(
    h.correlationId,
    lastHop ?? consumeHop,
    `${prefix}.dead_letter`,
    "dead_lettered",
    attempt,
    { code: error },
  );
  await broker.publish("orders.dlq.exchange", "", msg.content, {
    ...h,
    causationId: hop,
    originQueue:
      broker.service === "notifier" ? "notifications.queue" : "saga.queue",
    lastError: error,
    attempts: attempt,
    deadLetteredAt: now(),
  });
  return hop;
}
export class CallError extends Error {
  constructor(code, temporary = false, status = "failed") {
    super(code);
    this.code = code;
    this.temporary = temporary;
    this.status = status;
  }
}
export function amountFor(order) {
  let cents = 0n;
  for (const i of order.items) {
    const neg = i.unitPrice.startsWith("-");
    const [w, f] = i.unitPrice.replace(/^-/, "").split(".");
    cents +=
      (neg ? -1n : 1n) * (BigInt(w) * 100n + BigInt(f)) * BigInt(i.quantity);
  }
  const a = cents < 0n ? -cents : cents;
  return `${cents < 0n ? "-" : ""}${a / 100n}.${String(a % 100n).padStart(2, "0")}`;
}
export const routeFor = {
  payment: ["PAYMENT_URL", "/payment/authorize", "authorize"],
  inventory: ["INVENTORY_URL", "/inventory/reserve", "reserve"],
  shipping: ["SHIPPING_URL", "/shipping/create"],
  notification: ["NOTIFICATION_URL", "/notification/send"],
  payment_refund: ["PAYMENT_URL", "/payment/refund", "refund"],
  inventory_release: ["INVENTORY_URL", "/inventory/release", "release"],
};
export async function provider(broker, ctx, order, step, extra = {}) {
  const id = randomUUID(),
    start = Date.now(),
    [url, route, key] = routeFor[step];
  const body = {
    orderId: order.orderId,
    ...(step === "payment"
      ? { amount: amountFor(order) }
      : step === "inventory"
        ? { items: order.items }
        : step === "notification"
          ? { recipient: order.customer.email }
          : {}),
    ...extra,
  };
  const headers = {
    "Content-Type": "application/json",
    "X-Correlation-Id": ctx.cid,
    "X-Causation-Id": id,
    ...(key ? { "Idempotency-Key": `${key}:${ctx.businessKey}` } : {}),
  };
  let failure;
  try {
    const r = await fetch(env(url) + route, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(num("REQUEST_TIMEOUT_MS")),
    });
    const data = await r.json();
    if (!r.ok)
      throw new CallError(data.code ?? `${step}_${r.status}`, r.status >= 500);
  } catch (e) {
    failure =
      e instanceof CallError
        ? e
        : new CallError(
            e.name === "TimeoutError" || e.name === "AbortError"
              ? "timeout"
              : "unreachable",
            true,
            e.name === "TimeoutError" || e.name === "AbortError"
              ? "timeout"
              : "failed",
          );
  }
  const hop = broker.hop(
    ctx.cid,
    ctx.cause,
    step,
    failure?.status ?? "success",
    ctx.attempt ?? 1,
    failure ? { code: failure.code } : undefined,
    start,
    id,
  );
  if (failure) {
    failure.hop = hop;
    throw failure;
  }
  return hop;
}
export function outcome(order, ctx, state, code, duplicateOf) {
  return {
    correlationId: ctx.cid,
    businessKey: ctx.businessKey,
    orderId: order.orderId,
    source: order.source,
    orderType: order.orderType,
    recipient: order.customer.email,
    state,
    ...(code ? { code } : {}),
    ...(duplicateOf ? { duplicateOf } : {}),
    occurredAt: now(),
  };
}
