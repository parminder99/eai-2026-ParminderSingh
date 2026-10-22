import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { CanonicalOrder } from "./canonical-order";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(process.cwd(), "public")));

interface Config {
  port: number;
  paymentUrl: string;
  inventoryUrl: string;
  shippingUrl: string;
  notificationUrl: string;
  requestTimeoutMs: number;
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function loadConfig(): Config {
  return {
    port: Number(process.env.ORCHESTRATOR_PORT || 3000),
    paymentUrl: readRequiredEnv("PAYMENT_URL"),
    inventoryUrl: readRequiredEnv("INVENTORY_URL"),
    shippingUrl: readRequiredEnv("SHIPPING_URL"),
    notificationUrl: readRequiredEnv("NOTIFICATION_URL"),
    requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 2500),
  };
}

const config = loadConfig();

const DATA_DIR = "/data";
const IDEMPOTENCY_STORE_PATH = path.join(DATA_DIR, "idempotency-store.json");
const SAGA_STORE_PATH = path.join(DATA_DIR, "saga-store.json");

// ---------------------------------------------------------------- contract --
// These shapes mirror grading/schema/*.json. Keep them in sync if you change
// either side — the tests validate persisted files against those schemas.

export interface TraceItem {
  step: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export type SagaState = "completed" | "failed" | "compensated";
export type IdempotencyState = "in_progress" | "completed" | "failed" | "compensated";

interface IdempotencyRecord {
  requestHash: string;
  state: IdempotencyState;
  httpStatus: number;
  response: unknown;
  updatedAt: string;
}

interface IdempotencyStore {
  records: Record<string, IdempotencyRecord>;
}

interface SagaRecord {
  idempotencyKey: string;
  state: SagaState;
  steps: TraceItem[];
  updatedAt: string;
}

interface SagaStore {
  sagas: Record<string, SagaRecord>;
}

function ensureJsonFile(filePath: string, initialData: unknown): void {
  const dirPath = path.dirname(filePath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(initialData, null, 2), "utf8");
  }
}

function readJsonFile<T>(filePath: string): T {
  ensureJsonFile(filePath, {});
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw || "{}") as T;
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.writeFileSync(`${filePath}.tmp`, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(`${filePath}.tmp`, filePath);
}

function nowIso(): string {
  return new Date().toISOString();
}

function payloadHash(payload: unknown): string {
  function stable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stable);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stable(child)]));
    }
    return value;
  }
  const normalized = JSON.stringify(stable(payload));
  const hash = crypto.createHash("sha256").update(normalized).digest("hex");
  return `sha256:${hash}`;
}

// The request body is a canonical order. docker-compose.yml mounts the
// course's canonical/ folder read-only at /canonical, so the orchestrator
// validates against the very file PA4's output was validated against.
const CANONICAL_SCHEMA_PATH = "/canonical/order.schema.json";

if (!fs.existsSync(CANONICAL_SCHEMA_PATH)) {
  throw new Error(
    `${CANONICAL_SCHEMA_PATH} not found. docker-compose.yml mounts ../canonical ` +
      "from your repository root: copy canonical/ from eai-2026 next to pa6/ " +
      '(root README, "Starting an assignment"), then run docker compose up again.',
  );
}

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validateCanonicalOrder = ajv.compile(JSON.parse(fs.readFileSync(CANONICAL_SCHEMA_PATH, "utf8")));

function validateCheckoutPayload(payload: unknown): string | null {
  if (validateCanonicalOrder(payload)) {
    if ((payload as CanonicalOrder).items.length > 100) return "At most 100 items are accepted";
    return null;
  }
  return `Request body is not a canonical order: ${ajv.errorsText(validateCanonicalOrder.errors, { dataVar: "body" })}`;
}

function bootstrapStores(): void {
  ensureJsonFile(IDEMPOTENCY_STORE_PATH, { records: {} });
  ensureJsonFile(SAGA_STORE_PATH, { sagas: {} });
}

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

app.get("/debug/trace/:orderId", (req: Request, res: Response) => {
  const orderIdParam = req.params.orderId ?? "";
  const sagaStore = readJsonFile<SagaStore>(SAGA_STORE_PATH);
  const saga = sagaStore?.sagas?.[orderIdParam];
  if (!saga) {
    res.status(404).json({ code: "not_found", message: "No saga found for this orderId" });
    return;
  }
  res.status(200).json(saga);
});

class StepFailure extends Error {
  constructor(public code: string, public timedOut = false) { super(code); }
}

function saveRecord(key: string, value: IdempotencyRecord): void {
  // Read fresh on every synchronous update so concurrent different keys
  // cannot overwrite one another with an earlier snapshot.
  const store = readJsonFile<IdempotencyStore>(IDEMPOTENCY_STORE_PATH);
  Object.defineProperty(store.records, key, { value, enumerable: true, writable: true, configurable: true });
  writeJsonFile(IDEMPOTENCY_STORE_PATH, store);
}

function amountFor(order: CanonicalOrder): string {
  let cents = 0n;
  for (const item of order.items) {
    const negative = item.unitPrice.startsWith("-");
    const [whole, fraction] = item.unitPrice.replace(/^-/, "").split(".");
    const unit = BigInt(whole!) * 100n + BigInt(fraction!);
    cents += (negative ? -unit : unit) * BigInt(item.quantity);
  }
  const magnitude = cents < 0n ? -cents : cents;
  return `${cents < 0n ? "-" : ""}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, "0")}`;
}

async function runSaga(order: CanonicalOrder, key: string, requestHash: string) {
  const trace: TraceItem[] = [];
  async function callDownstream(step: string, base: string, route: string, body: object): Promise<void> {
    const start = Date.now();
    const signal = AbortSignal.timeout(config.requestTimeoutMs);
    let status = "success";
    try {
      const response = await fetch(`${base.replace(/\/$/, "")}${route}`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-correlation-id": key },
        body: JSON.stringify(body), signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        let data: { code?: unknown } = {};
        try { data = JSON.parse(raw) as { code?: unknown }; } catch { /* HTTP code still identifies failure. */ }
        throw new StepFailure(typeof data?.code === "string" ? data.code : "downstream_error");
      }
    } catch (error) {
      const failure = signal.aborted ? new StepFailure("timeout", true) :
        error instanceof StepFailure ? error : new StepFailure("downstream_error");
      status = failure.timedOut ? "timeout" : "failed";
      throw failure;
    } finally {
      const end = Date.now();
      trace.push({ step, status, startedAt: new Date(start).toISOString(), finishedAt: new Date(end).toISOString(),
        durationMs: Math.max(0, end - start) });
      saveRecord(key, { requestHash, state: "in_progress", httpStatus: 202,
        response: { orderId: order.orderId, status: "in_progress", trace }, updatedAt: nowIso() });
    }
  }
  let paid = false;
  let reserved = false;
  let state: SagaState = "completed";
  let code: string | undefined;
  let httpStatus = 200;
  try {
    await callDownstream("payment", config.paymentUrl, "/payment/authorize", { orderId: order.orderId, amount: amountFor(order) });
    paid = true;
    await callDownstream("inventory", config.inventoryUrl, "/inventory/reserve", { orderId: order.orderId, items: order.items });
    reserved = true;
    await callDownstream("shipping", config.shippingUrl, "/shipping/create", { orderId: order.orderId });
    await callDownstream("notification", config.notificationUrl, "/notification/send", { orderId: order.orderId, recipient: order.customer.email });
  } catch (error) {
    const failure = error instanceof StepFailure ? error : new StepFailure("downstream_error");
    code = failure.code;
    httpStatus = failure.timedOut ? 504 : 422;
    state = paid ? "compensated" : "failed";
    let compensationFailed = false;
    if (reserved) {
      try { await callDownstream("inventory_release", config.inventoryUrl, "/inventory/release", { orderId: order.orderId }); }
      catch { compensationFailed = true; }
    }
    if (paid) {
      try { await callDownstream("payment_refund", config.paymentUrl, "/payment/refund", { orderId: order.orderId }); }
      catch { compensationFailed = true; }
    }
    if (compensationFailed) { state = "failed"; code = "compensation_failed"; httpStatus = 422; }
  }
  const response = { orderId: order.orderId, status: state, ...(code ? { code } : {}), trace };
  const sagaStore = readJsonFile<SagaStore>(SAGA_STORE_PATH);
  Object.defineProperty(sagaStore.sagas, order.orderId, { enumerable: true, configurable: true, writable: true,
    value: { idempotencyKey: key, state, steps: trace, updatedAt: nowIso() } });
  writeJsonFile(SAGA_STORE_PATH, sagaStore);
  saveRecord(key, { requestHash, state, httpStatus, response, updatedAt: nowIso() });
  return { httpStatus, response };
}

app.post("/checkout", async (req: Request, res: Response) => {
  const key = req.header("Idempotency-Key");
  if (!key || key.length > 200) {
    res.status(400).json({ code: "validation_error", message: "Idempotency-Key must contain 1 to 200 characters" });
    return;
  }
  const validationError = validateCheckoutPayload(req.body);
  if (validationError) { res.status(400).json({ code: "validation_error", message: validationError }); return; }
  const requestHash = payloadHash(req.body);
  const store = readJsonFile<IdempotencyStore>(IDEMPOTENCY_STORE_PATH);
  const existing = Object.hasOwn(store.records, key) ? store.records[key] : undefined;
  if (existing) {
    if (existing.requestHash !== requestHash) {
      res.status(409).json({ code: "idempotency_payload_mismatch", message: "Key is associated with a different payload" });
    } else if (existing.state === "in_progress") {
      res.status(409).json({ code: "idempotency_conflict", message: "Checkout is in progress or requires reconciliation after an interrupted run" });
    } else { res.status(existing.httpStatus).json(existing.response); }
    return;
  }
  const order = req.body as CanonicalOrder;
  saveRecord(key, { requestHash, state: "in_progress", httpStatus: 202,
    response: { orderId: order.orderId, status: "in_progress" }, updatedAt: nowIso() });
  try {
    const { httpStatus, response } = await runSaga(order, key, requestHash);
    res.status(httpStatus).json(response);
  } catch (error) {
    // Storage failure must not cause an automatic second payment. Retain
    // the in-progress guard for manual reconciliation and fail the connection.
    console.error("Unable to persist checkout outcome", error);
    res.destroy();
  }
});

app.use((error: { status?: number }, _req: Request, res: Response, _next: express.NextFunction) => {
  res.status(error.status === 413 ? 413 : 400).json({ code: "validation_error", message: "Invalid JSON request body or transport size exceeded" });
});

bootstrapStores();

app.listen(config.port, () => {
  console.log(`[orchestrator] listening on port ${config.port}`);
  console.log("[orchestrator] downstream targets loaded from env", {
    paymentUrl: config.paymentUrl,
    inventoryUrl: config.inventoryUrl,
    shippingUrl: config.shippingUrl,
    notificationUrl: config.notificationUrl,
    requestTimeoutMs: config.requestTimeoutMs,
  });
});
