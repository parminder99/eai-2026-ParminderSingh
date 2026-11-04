import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import {
  Broker,
  Store,
  appFor,
  listen,
  express,
  randomUUID,
  env,
  num,
  now,
  schema,
  withoutRetryHistory,
  retries,
} from "../shared/core.mjs";
const broker = new Broker("intake"),
  orders = new Store("orders.json", {}),
  keys = new Store("idempotency-store.json", {}),
  valid = schema("canonical");
const allowed = {
  accepted: [
    "processing",
    "parked",
    "completed",
    "failed",
    "compensated",
    "compensation_failed",
    "needs_attention",
    "duplicate",
  ],
  processing: [
    "parked",
    "completed",
    "failed",
    "compensated",
    "compensation_failed",
    "needs_attention",
  ],
  parked: [
    "processing",
    "completed",
    "failed",
    "compensated",
    "compensation_failed",
    "needs_attention",
  ],
  compensation_failed: ["compensated", "compensation_failed"],
  needs_attention: ["compensated", "compensation_failed"],
};
broker.setup.push(async (ch) => {
  await ch.assertQueue("intake.lifecycle", { durable: true });
  await ch.bindQueue("intake.lifecycle", "orders.outcome", "#");
});
broker.consume("intake.lifecycle", async (msg, ch) => {
  try {
    const e = JSON.parse(msg.content);
    const current = orders.data[e.correlationId];
    if (
      current &&
      (current.state === e.state || allowed[current.state]?.includes(e.state))
    ) {
      orders.data[e.correlationId] = {
        ...current,
        state: e.state,
        updatedAt: e.occurredAt,
        ...(e.code ? { code: e.code } : {}),
        ...(e.duplicateOf ? { duplicateOf: e.duplicateOf } : {}),
      };
      orders.save();
    }
  } catch {}
  ch.ack(msg);
});
const app = appFor(broker);
app.use(express.raw({ type: () => true, limit: "2mb" }));
const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
});
function translate(bytes, content) {
  let a, source;
  if (content.startsWith("application/xml") || content.startsWith("text/xml")) {
    const ascii = bytes.subarray(0, 250).toString("ascii");
    const encoding =
      content.match(/charset=["']?([^;"' ]+)/i)?.[1] ??
      ascii.match(/encoding=["']([^"']+)/i)?.[1] ??
      "utf-8";
    a = xml.parse(
      new TextDecoder(encoding, { fatal: true }).decode(bytes),
    ).PurchaseOrder;
    source = "b2b";
  } else if (content.startsWith("application/json")) {
    a = JSON.parse(bytes.toString("utf8"));
    source =
      a?.orderId && typeof a.customer === "object"
        ? "web"
        : a?.oid
          ? "mobile"
          : undefined;
    if (!source) throw Error("Unrecognized order shape");
  } else throw Object.assign(Error("unsupported media type"), { status: 415 });
  let order, lines;
  if (source === "web") {
    const d = a.customer.address;
    order = {
      orderId: a.orderId,
      orderType: a.orderType,
      orderDate: new Date(a.orderDate).toISOString(),
      customer: {
        name: a.customer.name,
        email: a.customer.email,
        address: {
          street: d.street,
          city: d.city,
          postalCode: d.postalCode,
          country: d.country,
        },
      },
      currency: a.currency,
      status: a.status,
    };
    lines = a.items.map((i) => ({
      productId: i.productId,
      productName: i.productName,
      quantity: i.quantity,
    }));
  }
  if (source === "mobile") {
    const parts = a.addr.split(",").map((x) => x.trim());
    if (parts.length !== 4) throw Error("Address requires four parts");
    const [street, city, postalCode, country] = parts;
    order = {
      orderId: a.oid,
      orderType: a.ot,
      orderDate: new Date(a.ts * 1000).toISOString(),
      customer: {
        name: a.cust_name,
        email: a.cust_email,
        address: { street, city, postalCode, country },
      },
      currency: { 978: "EUR", 840: "USD", 826: "GBP" }[a.cur] ?? String(a.cur),
      status: { 1: "new", 2: "processing", 3: "shipped", 4: "delivered" }[a.st],
    };
    lines = a.items.map((i) => ({
      productId: `PROD-${i.pid}`,
      productName: i.pname,
      quantity: i.qty,
    }));
  }
  if (source === "b2b") {
    const b = a.BuyerParty,
      d = b.ShipToAddress;
    order = {
      orderId: a["@_orderId"],
      orderType: a["@_orderType"],
      orderDate: new Date(a["@_orderDate"]).toISOString(),
      customer: {
        name: b.Name,
        email: b.ContactEmail,
        address: {
          street: d.Street,
          city: d.City,
          postalCode: d.PostalCode,
          country: d["@_country"],
        },
      },
      currency: a.LineItems["@_currency"],
      status: a.Status.toLowerCase(),
    };
    const raw = a.LineItems.LineItem;
    lines = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((i) => ({
      productId: i["@_sku"].replace(/^SKU-/, ""),
      productName: i.Description,
      quantity: Number(i["@_quantity"]),
    }));
  }
  if (
    !lines.length ||
    lines.length > num("ORDER_ITEMS_MAX") ||
    lines.some(
      (i) =>
        typeof i.productId !== "string" ||
        !i.productId.match(/^PROD-\d+$/) ||
        typeof i.productName !== "string" ||
        !i.productName ||
        !Number.isInteger(i.quantity) ||
        i.quantity < 1,
    )
  )
    throw Error("Invalid items");
  // Validate required translated fields before spending pricing requests.
  const provisional = {
    ...order,
    source,
    receivedAt: now(),
    items: lines.map((i) => ({
      ...i,
      unitPrice: "0.00",
      currency: order.currency,
      taxRate: 0,
    })),
  };
  if (!valid(provisional)) throw Error("Invalid canonical fields");
  return { order: provisional, lines };
}
app.post("/orders", async (req, res) => {
  const key = req.header("Idempotency-Key");
  if (!key || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))
    return res
      .status(400)
      .json({ code: "validation_error", message: "Invalid Idempotency-Key" });
  const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    hash = createHash("sha256").update(bytes).digest("hex");
  const old = Object.hasOwn(keys.data, key) ? keys.data[key] : null;
  if (old) {
    if (old.bodySha256 !== hash)
      return res.status(409).json({ code: "idempotency_payload_mismatch" });
    if (old.state === "in_flight")
      return res.status(409).json({ code: "idempotency_conflict" });
    return res.status(old.response.status).json(old.response.body);
  }
  Object.defineProperty(keys.data, key, {
    enumerable: true,
    configurable: true,
    writable: true,
    value: { bodySha256: hash, state: "in_flight", createdAt: now() },
  });
  keys.save();
  const cid = randomUUID();
  let cause = broker.hop(cid, null, "intake.receive");
  const clear = () => {
    delete keys.data[key];
    keys.save();
  };
  try {
    let parsed;
    const start = Date.now();
    try {
      parsed = translate(bytes, req.header("Content-Type") ?? "");
      cause = broker.hop(
        cid,
        cause,
        "intake.translate",
        "success",
        1,
        undefined,
        start,
      );
    } catch (e) {
      clear();
      return res
        .status(e.status ?? 400)
        .json({
          code:
            e.status === 415 ? "unsupported_media_type" : "validation_error",
          message: "Order cannot be translated or validated",
        });
    }
    const pricingStart = Date.now(),
      unknown = [];
    let outage = false;
    const items = await Promise.all(
      parsed.lines.map(async (line) => {
        try {
          const r = await fetch(
            env("PRICING_URL") +
              "/pricing/" +
              encodeURIComponent(line.productId),
            {
              headers: { "X-API-Key": env("PRICING_API_KEY") },
              signal: AbortSignal.timeout(num("REQUEST_TIMEOUT_MS")),
            },
          );
          if (r.status === 404) {
            unknown.push(line.productId);
            return null;
          }
          if (!r.ok) throw Error("pricing");
          const p = await r.json();
          if (
            typeof p.unitPrice !== "number" ||
            !Number.isFinite(p.unitPrice) ||
            typeof p.currency !== "string" ||
            typeof p.taxRate !== "number" ||
            p.taxRate < 0 ||
            p.taxRate > 1
          )
            throw Error("pricing");
          return {
            ...line,
            unitPrice: p.unitPrice.toFixed(2),
            currency: p.currency,
            taxRate: p.taxRate,
          };
        } catch {
          outage = true;
          return null;
        }
      }),
    );
    cause = broker.hop(
      cid,
      cause,
      "intake.enrich",
      outage || unknown.length ? "failed" : "success",
      1,
      undefined,
      pricingStart,
    );
    if (outage) {
      clear();
      return res
        .status(503)
        .set("Retry-After", "1")
        .json({ code: "pricing_unavailable" });
    }
    if (unknown.length) {
      const body = {
        code: "unknown_product",
        productIds: [...new Set(unknown)],
      };
      keys.data[key] = {
        ...keys.data[key],
        state: "done",
        response: { status: 422, body },
      };
      keys.save();
      return res.status(422).json(body);
    }
    const order = { ...parsed.order, items };
    if (!valid(order)) {
      clear();
      return res
        .status(400)
        .json({
          code: "validation_error",
          message: "Enriched order is not canonical",
        });
    }
    const businessKey = `${order.source}:${order.orderId}`;
    orders.data[cid] = {
      correlationId: cid,
      businessKey,
      orderId: order.orderId,
      source: order.source,
      orderType: order.orderType,
      state: "accepted",
      updatedAt: now(),
    };
    orders.save();
    cause = broker.hop(cid, cause, "intake.publish");
    try {
      await broker.publish("orders.exchange", "", order, {
        correlationId: cid,
        causationId: cause,
        businessKey,
      });
    } catch {
      delete orders.data[cid];
      orders.save();
      clear();
      return res
        .status(503)
        .set("Retry-After", "1")
        .json({ code: "broker_unavailable" });
    }
    const body = { correlationId: cid, status: "accepted" };
    keys.data[key] = {
      ...keys.data[key],
      state: "done",
      correlationId: cid,
      response: { status: 202, body },
    };
    keys.save();
    return res.status(202).json(body);
  } catch (e) {
    console.error("intake", e);
    clear();
    return res
      .status(503)
      .set("Retry-After", "1")
      .json({ code: "broker_unavailable" });
  }
});
app.get("/orders/:cid", (req, res) => {
  const o = orders.data[req.params.cid];
  return o ? res.json(o) : res.sendStatus(404);
});
// Each DLQ operation owns a channel; nacking a peek returns exactly its original delivery.
let dlqBusy = false;
async function dlq(req, res, replay) {
  if (replay && dlqBusy) return res.status(409).json({ code: "dlq_busy" });
  if (replay) dlqBusy = true;
  let ch;
  const held = [];
  try {
    if (!broker.ready) throw Error("broker");
    ch = await broker.connection.createConfirmChannel();
    ch.on("error", () => {});
    const count = (await ch.checkQueue("orders.dlq")).messageCount;
    let selected;
    try {
      selected = JSON.parse(
        req.body?.length ? req.body.toString() : "{}",
      ).correlationId;
    } catch {
      return res.status(400).json({ code: "validation_error" });
    }
    const entries = [];
    let replayed = 0;
    for (let i = 0; i < count; i++) {
      const m = await ch.get("orders.dlq", { noAck: false });
      if (!m) break;
      held.push(m);
      const h = m.properties.headers ?? {};
      if (replay && (!selected || h.correlationId === selected)) {
        if (!["saga.queue", "notifications.queue"].includes(h.originQueue))
          throw Error("Unknown origin");
        const hop = broker.hop(h.correlationId, h.causationId, "dlq.replay");
        await broker.publish(
          "orders.return.exchange",
          h.originQueue,
          m.content,
          { ...withoutRetryHistory(h), causationId: hop },
        );
        ch.ack(m);
        held.pop();
        replayed++;
      } else
        entries.push({
          messageId: m.properties.messageId ?? "",
          correlationId: h.correlationId ?? "",
          originQueue: h.originQueue ?? "unknown",
          attempts: h.attempts ?? Math.max(1, retries(m)),
          lastError: h.lastError ?? "unknown",
          deadLetteredAt: h.deadLetteredAt ?? now(),
        });
    }
    for (const m of held) ch.nack(m, false, true);
    held.length = 0;
    return res.json(
      replay
        ? { replayed, remaining: count - replayed }
        : { count: entries.length, entries },
    );
  } catch (e) {
    return res.status(503).json({ code: "broker_unavailable" });
  } finally {
    try {
      await ch?.close();
    } catch {}
    if (replay) dlqBusy = false;
  }
}
app.get("/dlq", (q, s) => dlq(q, s, false));
app.post("/dlq/replay", (q, s) => dlq(q, s, true));
// An interrupted enrichment can be retried; publishing ambiguity remains at-least-once.
for (const [key, r] of Object.entries(keys.data))
  if (r.state === "in_flight") delete keys.data[key];
keys.save();
listen(app);
void broker.start();
