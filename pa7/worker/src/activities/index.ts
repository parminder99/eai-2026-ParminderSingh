import { ApplicationFailure, Context } from "@temporalio/activity";
import type { CanonicalItem } from "../types";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
const PAYMENT_URL = requiredEnv("PAYMENT_URL");
const INVENTORY_URL = requiredEnv("INVENTORY_URL");
const SHIPPING_URL = requiredEnv("SHIPPING_URL");
const NOTIFICATION_URL = requiredEnv("NOTIFICATION_URL");

async function post(base: string, route: string, body: object): Promise<void> {
  const response = await fetch(`${base.replace(/\/$/, "")}${route}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: Context.current().cancellationSignal,
  });
  if (response.ok) { await response.arrayBuffer(); return; }
  const data = await response.json().catch(() => ({})) as { code?: string; message?: string };
  const code = typeof data.code === "string" ? data.code : `http_${response.status}`;
  const message = typeof data.message === "string" ? data.message : `Downstream HTTP ${response.status}`;
  if (response.status >= 400 && response.status < 500) {
    throw ApplicationFailure.nonRetryable(message, code);
  }
  throw ApplicationFailure.retryable(message, code);
}
export async function authorizePayment(orderId: string, amount: string): Promise<void> {
  await post(PAYMENT_URL, "/payment/authorize", { orderId, amount });
}
export async function reserveInventory(orderId: string, items: CanonicalItem[]): Promise<void> {
  await post(INVENTORY_URL, "/inventory/reserve", { orderId, items });
}
export async function createShipment(orderId: string): Promise<void> {
  await post(SHIPPING_URL, "/shipping/create", { orderId });
}
export async function sendNotification(orderId: string, recipient: string): Promise<void> {
  await post(NOTIFICATION_URL, "/notification/send", { orderId, recipient });
}
export async function refundPayment(orderId: string): Promise<void> {
  await post(PAYMENT_URL, "/payment/refund", { orderId });
}
export async function releaseInventory(orderId: string): Promise<void> {
  await post(INVENTORY_URL, "/inventory/release", { orderId });
}
