/**
 * PA4 — three sources to one canonical order model.
 *
 * Three systems you do not control each send you an order in their own
 * shape:
 *
 *   data/web-order.json      nested JSON, web store
 *   data/mobile-order.json   flat JSON, abbreviated field names, mobile app
 *   data/b2b-order.xml       EDI-style XML, CP1257 ("windows-1257"), B2B partner
 *
 * Your job is the message translator, content enricher and content filter
 * patterns from this week's session, applied together:
 *
 *   1. Translator  — map each source's shape onto ../../canonical/order.schema.json.
 *      That schema is fixed. You conform to it; you do not adjust it.
 *   2. Enricher    — the sources do not carry a trustworthy price. Normalize
 *      each line item's product id to the pricing API's PROD-XXX format, call
 *      the API, and use ITS price, currency and tax rate. A price you typed
 *      into this file yourself is a hardcoded price, and a public test
 *      changes a price in the mock catalog specifically to catch that.
 *   3. Filter      — all three sources carry payment details (a card number,
 *      or an IBAN). The canonical schema has no field for any of it.
 *      Whatever you do with it, it must not reach the object you return.
 *
 * Everything you need to call the pricing API is in the Node standard
 * library (global fetch). The one dependency here, fast-xml-parser, exists
 * because hand-rolling an XML tokenizer is not this week's lesson — reading
 * the object it gives you back correctly is.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { XMLParser } from "fast-xml-parser";

// ---------------------------------------------------------------- contract --
// The grader calls translateWeb / translateMobile / translateB2B directly,
// with its own fixture paths and its own pricingBaseUrl (a mock-pricing
// instance it controls, not necessarily the one from docker-compose.yml).
// Do not hardcode a file path or a pricing URL anywhere in this file — take
// them as arguments, exactly as these signatures already do. That is what
// lets the grader run your code against fixtures you have never seen.

export interface Address {
  street: string;
  city: string;
  postalCode: string;
  country: string;
}

export interface CanonicalCustomer {
  name: string;
  email: string;
  address: Address;
}

export interface CanonicalItem {
  productId: string;
  productName: string;
  quantity: number;
  /** Decimal STRING, e.g. "24.99" — see toDecimalAmount() below. Never a number. */
  unitPrice: string;
  currency: string;
  taxRate: number;
}

export type OrderStatus = "new" | "processing" | "shipped" | "delivered";

export interface CanonicalOrder {
  orderId: string;
  orderType: "standard" | "express" | "b2b";
  source: "web" | "mobile" | "b2b";
  /** When this translator produced the record — new Date().toISOString(), or options.now(). */
  receivedAt: string;
  /** The order's own timestamp, normalized to ISO-8601 UTC. */
  orderDate: string;
  customer: CanonicalCustomer;
  items: CanonicalItem[];
  currency: string;
  status: OrderStatus;
}

export type TransformWarningCode = "UNKNOWN_PRODUCT" | "PRICING_API_ERROR";

export interface TransformWarning {
  code: TransformWarningCode;
  productId: string;
  message: string;
}

export interface TransformResult {
  /**
   * null when every line item failed enrichment (so there is nothing left
   * that would validate against the schema's `minItems: 1`). Otherwise a
   * schema-valid order — possibly with fewer items than the source, if some
   * of them could not be priced. See warnings for what happened to each one.
   */
  order: CanonicalOrder | null;
  warnings: TransformWarning[];
}

export interface TranslateOptions {
  /** e.g. "http://localhost:4100" (docker-compose's host port mapping). */
  pricingBaseUrl: string;
  /** Defaults to the key docker-compose.yml sets for the mock-pricing container. */
  apiKey?: string;
  /** Injectable clock, for deterministic tests. Defaults to () => new Date(). */
  now?: () => Date;
}

export const DEFAULT_PRICING_API_KEY = "pa4-pricing-key-2026";

// ------------------------------------------------------------------- paths --

const PA4_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const DEFAULT_WEB_ORDER_PATH = path.join(PA4_ROOT, "data", "web-order.json");
export const DEFAULT_MOBILE_ORDER_PATH = path.join(PA4_ROOT, "data", "mobile-order.json");
export const DEFAULT_B2B_ORDER_PATH = path.join(PA4_ROOT, "data", "b2b-order.xml");
export const DEFAULT_PRICING_BASE_URL = "http://localhost:4100";

const OUT_DIR = path.join(PA4_ROOT, "out");

// ------------------------------------------------------------- raw shapes --
// What actually arrives on the wire. Note that every one of these carries a
// payment field the canonical schema does not have room for — that is
// deliberate, and it is the content-filter half of this assignment.

export interface WebOrderInput {
  orderId: string;
  orderType: string;
  customer: {
    name: string;
    email: string;
    address: Address;
    payment: {
      method: string;
      cardHolder: string;
      cardNumber: string;
      expiryMonth: number;
      expiryYear: number;
    };
  };
  items: Array<{ productId: string; productName: string; quantity: number }>;
  orderDate: string;
  status: string;
  currency: string;
}

export interface MobileOrderInput {
  oid: string;
  ot: string;
  cust_name: string;
  cust_email: string;
  /** "Street, City, PostalCode, Country" — one comma-separated string. */
  addr: string;
  items: Array<{ pid: string; pname: string; qty: number }>;
  /** Unix epoch, seconds. */
  ts: number;
  /** 1=new, 2=processing, 3=shipped, 4=delivered. */
  st: number;
  /** ISO 4217 numeric currency code, e.g. 978 = EUR. */
  cur: number;
  pm: string;
  pan: string;
  pexp: string;
}

/**
 * The shape fast-xml-parser (options below) gives back for b2b-order.xml.
 * Attributes come back as keys prefixed "@_" — an element
 * `<LineItem sku="X" quantity="2">` parses to
 * `{ "@_sku": "X", "@_quantity": "2", Description: "..." }`.
 *
 * This type is deliberately loose (not every element is listed) — the XML is
 * allowed to carry elements you do not map, and a hidden test sends you one
 * with an extra element it has never told you about. A crash there is a
 * failure; a translator that just does not recognize the element and moves on
 * is the tolerant reader pattern this week is about.
 */
export interface ParsedB2BOrder {
  PurchaseOrder: {
    "@_orderId": string;
    "@_orderType": string;
    "@_orderDate": string;
    BuyerParty: {
      Name: string;
      ContactEmail: string;
      ShipToAddress: {
        "@_country": string;
        Street: string;
        City: string;
        PostalCode: string;
      };
      // PaymentDetails also lives here. Same filter rule as everywhere else.
      [key: string]: unknown;
    };
    LineItems: {
      "@_currency": string;
      /**
       * fast-xml-parser gives you a single object (not a one-element array)
       * when there is exactly one <LineItem>, and an array when there is
       * more than one. Both of this assignment's fixtures have two, but do
       * not assume that stays true forever — normalize to an array before
       * you iterate.
       */
      LineItem: unknown;
    };
    Status: string;
    [key: string]: unknown;
  };
}

// Given: fast-xml-parser's own configuration. Getting a third-party parsing
// library's options right is not this week's lesson; reading the object it
// hands back and mapping it onto the canonical schema is.
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false });

// ------------------------------------------------------------------ helpers --
// Suggested decomposition. Only the three translateX functions and the types
// above are contractual. Restructure the rest if you would rather, and say
// why in your ADR.


export function normalizeProductId(source: "web" | "mobile" | "b2b", rawId: string): string {
  const id = rawId.trim();
  if (source === "mobile") return `PROD-${id}`;
  if (source === "b2b") return id.replace(/^SKU-/, "");
  return id;
}


export function toDecimalAmount(price: number): string {
  if (!Number.isFinite(price)) throw new Error("Pricing returned a non-finite amount");
  const amount = price.toFixed(2);
  if (!/^-?[0-9]+\.[0-9]{2}$/.test(amount)) throw new Error("Price exceeds decimal format");
  return amount;
}

export type EnrichResult =
  | { status: "ok"; unitPrice: string; currency: string; taxRate: number; productName: string }
  | { status: "unknown_product" }
  | { status: "error"; httpStatus: number };


export async function enrichFromPricing(
  productId: string,
  options: TranslateOptions,
): Promise<EnrichResult> {
  let httpStatus = 0;
  try {
    const response = await fetch(
      `${options.pricingBaseUrl.replace(/\/$/, "")}/pricing/${encodeURIComponent(productId)}`,
      { headers: { "X-API-Key": options.apiKey ?? DEFAULT_PRICING_API_KEY },
        signal: AbortSignal.timeout(5000) },
    );
    httpStatus = response.status;
    if (httpStatus === 404) return { status: "unknown_product" };
    if (!response.ok) return { status: "error", httpStatus };
    const data = await response.json() as Record<string, unknown>;
    if (typeof data.unitPrice !== "number" || typeof data.currency !== "string" ||
        !data.currency || typeof data.productName !== "string" || !data.productName ||
        typeof data.taxRate !== "number" || !Number.isFinite(data.taxRate) ||
        data.taxRate < 0 || data.taxRate > 1) {
      return { status: "error", httpStatus };
    }
    return { status: "ok", unitPrice: toDecimalAmount(data.unitPrice),
      currency: data.currency, taxRate: data.taxRate, productName: data.productName };
  } catch {
    // 0 denotes a transport/timeout failure; 200 can denote a malformed body.
    return { status: "error", httpStatus };
  }
}


export async function enrichItems(
  lines: Array<{ productId: string; productName: string; quantity: number }>,
  options: TranslateOptions,
): Promise<{ items: CanonicalItem[]; warnings: TransformWarning[] }> {
  const outcomes = await Promise.all(lines.map(async (line) => ({
    line, pricing: await enrichFromPricing(line.productId, options),
  })));
  const items: CanonicalItem[] = [];
  const warnings: TransformWarning[] = [];
  for (const { line, pricing } of outcomes) {
    if (pricing.status === "ok") {
      items.push({ productId: line.productId, productName: line.productName,
        quantity: line.quantity, unitPrice: pricing.unitPrice,
        currency: pricing.currency, taxRate: pricing.taxRate });
    } else {
      warnings.push({ productId: line.productId,
        code: pricing.status === "unknown_product" ? "UNKNOWN_PRODUCT" : "PRICING_API_ERROR",
        message: pricing.status === "unknown_product" ? "Product not found in pricing catalog"
          : `Pricing request failed (HTTP ${pricing.httpStatus}; 0 means transport failure)`,
      });
    }
  }
  return { items, warnings };
}


export function epochSecondsToIso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}


export function mapCurrencyCode(numericCode: number): string {
  const currencies: Record<number, string> = { 978: "EUR", 840: "USD", 826: "GBP" };
  return currencies[numericCode] ?? String(numericCode);
}


export function mapMobileStatus(code: number): OrderStatus {
  const statuses: Record<number, OrderStatus> = { 1: "new", 2: "processing", 3: "shipped", 4: "delivered" };
  const status = statuses[code];
  if (!status) throw new Error("Unsupported mobile status");
  return status;
}


export function mapB2BStatus(raw: string): OrderStatus {
  const status = raw.trim().toLowerCase();
  if (status !== "new" && status !== "processing" && status !== "shipped" && status !== "delivered") {
    throw new Error("Unsupported order status");
  }
  return status;
}


export function parseMobileAddress(addr: string): Address {
  const parts = addr.split(",").map(part => part.trim());
  if (parts.length !== 4 || parts.some(part => !part)) throw new Error("Expected four address components");
  const [street, city, postalCode, country] = parts as [string, string, string, string];
  return { street, city, postalCode, country };
}


export function decodeB2BXmlBytes(bytes: Buffer): string {
  return new TextDecoder("windows-1257", { fatal: true }).decode(bytes);
}

function canonicalOrderType(raw: string): CanonicalOrder["orderType"] {
  if (raw === "standard" || raw === "express" || raw === "b2b") return raw;
  throw new Error("Unsupported order type");
}

// -------------------------------------------------------------- translators --
// The three functions the grader calls directly. Each reads its own fixture
// path, translates + enriches + filters, and returns a TransformResult.


export async function translateWeb(
  webOrderPath: string,
  options: TranslateOptions,
): Promise<TransformResult> {
  const input = JSON.parse(readFileSync(webOrderPath, "utf8")) as WebOrderInput;
  const { items, warnings } = await enrichItems(input.items.map(line => ({
    productId: normalizeProductId("web", line.productId),
    productName: line.productName, quantity: line.quantity,
  })), options);
  if (!items.length) return { order: null, warnings };
  const address = input.customer.address;
  return { warnings, order: {
    orderId: input.orderId, orderType: canonicalOrderType(input.orderType), source: "web",
    receivedAt: (options.now?.() ?? new Date()).toISOString(),
    orderDate: new Date(input.orderDate).toISOString(),
    customer: { name: input.customer.name, email: input.customer.email,
      address: { street: address.street, city: address.city, postalCode: address.postalCode, country: address.country } },
    items, currency: input.currency, status: mapB2BStatus(input.status),
  } };
}


export async function translateMobile(
  mobileOrderPath: string,
  options: TranslateOptions,
): Promise<TransformResult> {
  const input = JSON.parse(readFileSync(mobileOrderPath, "utf8")) as MobileOrderInput;
  const { items, warnings } = await enrichItems(input.items.map(line => ({
    productId: normalizeProductId("mobile", line.pid),
    productName: line.pname, quantity: line.qty,
  })), options);
  if (!items.length) return { order: null, warnings };
  return { warnings, order: {
    orderId: input.oid, orderType: canonicalOrderType(input.ot), source: "mobile",
    receivedAt: (options.now?.() ?? new Date()).toISOString(),
    orderDate: epochSecondsToIso(input.ts),
    customer: { name: input.cust_name, email: input.cust_email, address: parseMobileAddress(input.addr) },
    items, currency: mapCurrencyCode(input.cur), status: mapMobileStatus(input.st),
  } };
}


export async function translateB2B(
  b2bOrderPath: string,
  options: TranslateOptions,
): Promise<TransformResult> {
  const parsed = xmlParser.parse(decodeB2BXmlBytes(readFileSync(b2bOrderPath))) as ParsedB2BOrder;
  const input = parsed.PurchaseOrder;
  const raw = input.LineItems.LineItem;
  const lines = (raw == null ? [] : Array.isArray(raw) ? raw : [raw]) as Array<{
    "@_sku": string; "@_quantity": string; Description: string;
  }>;
  const { items, warnings } = await enrichItems(lines.map(line => ({
    productId: normalizeProductId("b2b", line["@_sku"]),
    productName: line.Description, quantity: Number(line["@_quantity"]),
  })), options);
  if (!items.length) return { order: null, warnings };
  const buyer = input.BuyerParty;
  const address = buyer.ShipToAddress;
  return { warnings, order: {
    orderId: input["@_orderId"], orderType: canonicalOrderType(input["@_orderType"]), source: "b2b",
    receivedAt: (options.now?.() ?? new Date()).toISOString(),
    orderDate: new Date(input["@_orderDate"]).toISOString(),
    customer: { name: buyer.Name, email: buyer.ContactEmail,
      address: { street: address.Street, city: address.City, postalCode: address.PostalCode, country: address["@_country"] } },
    items, currency: input.LineItems["@_currency"], status: mapB2BStatus(input.Status),
  } };
}

// -------------------------------------------------------------------- main --

/** Runs all three translators against this assignment's own fixtures and writes pa4/out/*.json. Run with: npm start */
export async function main(): Promise<void> {
  const options: TranslateOptions = { pricingBaseUrl: DEFAULT_PRICING_BASE_URL };

  const results = {
    web: await translateWeb(DEFAULT_WEB_ORDER_PATH, options),
    mobile: await translateMobile(DEFAULT_MOBILE_ORDER_PATH, options),
    b2b: await translateB2B(DEFAULT_B2B_ORDER_PATH, options),
  };

  mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, result] of Object.entries(results)) {
    const outPath = path.join(OUT_DIR, `${name}.json`);
    writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n", "utf8");
    console.log(`wrote ${outPath}`);
  }
}

// Only run main() when this file is executed directly, not when it is
// imported by the tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
