import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface Order {
  orderId: string;
  customerId: string;
  customerName: string;
  orderDate: string;
  amount: string;
  currency: string;
}

export interface RejectedRecord {
  line: number;
  raw: string;
  reason: string;
}

export interface Report {
  orders: Order[];
  rejected: RejectedRecord[];
  unmatchedCustomers: string[];
}

export interface IngestOptions {
  ordersPath: string;
  customersPath: string;
}

export const ORDER_LAYOUT = {
  orderId: [0, 10],
  customerId: [10, 20],
  customerName: [20, 52],
  orderDate: [52, 62],
  amount: [62, 74],
  currency: [74, 77],
} as const;

export const ORDER_LINE_LENGTH = 77;

const PA1_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const DEFAULT_ORDERS_PATH = path.join(
  PA1_ROOT,
  "data",
  "orders-20260901.txt",
);

export const DEFAULT_CUSTOMERS_PATH = path.join(
  PA1_ROOT,
  "data",
  "customers.csv",
);

export const OUTPUT_PATH = path.join(PA1_ROOT, "out", "report.json");

export function decodeOrderFile(bytes: Buffer): string {
  const decoder = new TextDecoder("windows-1257");
  return decoder.decode(bytes);
}

export function toIsoDate(ddmmyyyy: string): string {
  const [day, month, year] = ddmmyyyy.split(".");
  return `${year}-${month}-${day}`;
}

export function toDecimalString(amount: string): string {
  return amount.replace(",", ".");
}

export function parseCustomers(csv: string): Map<string, string> {
  const customers = new Map<string, string>();

  const lines = csv.split(/\r?\n/);

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    if (line === undefined || line === "") {
      continue;
    }

    const parts = line.split(";");
    const customerId = parts[0];
    const fullName = parts[1];

    if (customerId === undefined || fullName === undefined) {
      continue;
    }

    customers.set(customerId, fullName);
  }

  return customers;
}

export function ingest(options: IngestOptions): Report {
  const customersText = readFileSync(options.customersPath, "utf8");
  const customers = parseCustomers(customersText);

  const orderBytes = readFileSync(options.ordersPath);
  const orderText = decodeOrderFile(orderBytes);

  const lines = orderText.split(/\r?\n/);

  const orders: Order[] = [];
  const rejected: RejectedRecord[] = [];
  const acceptedCustomerIds = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line === undefined) {
      continue;
    }

    const lineNumber = i + 1;

    if (line === "" && i === lines.length - 1) {
      continue;
    }

    if (line.length !== ORDER_LINE_LENGTH) {
      rejected.push({
        line: lineNumber,
        raw: line,
        reason: `expected 77 characters, got ${line.length}`,
      });

      continue;
    }

    const orderId = line.slice(0, 10).trim();
    const customerId = line.slice(10, 20).trim();
    const customerName = line.slice(20, 52).trim();
    const orderDate = line.slice(52, 62).trim();
    const amount = line.slice(62, 74).trim();
    const currency = line.slice(74, 77).trim();

    orders.push({
      orderId,
      customerId,
      customerName,
      orderDate: toIsoDate(orderDate),
      amount: toDecimalString(amount),
      currency,
    });

    acceptedCustomerIds.add(customerId);
  }

  const unmatchedCustomers = [...customers.keys()].filter(
    (customerId) => !acceptedCustomerIds.has(customerId),
  );

  return {
    orders,
    rejected,
    unmatchedCustomers,
  };
}

export function main(): void {
  const report = ingest({
    ordersPath: DEFAULT_ORDERS_PATH,
    customersPath: DEFAULT_CUSTOMERS_PATH,
  });

  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log(
    `wrote ${OUTPUT_PATH}\n` +
      `  ${report.orders.length} orders\n` +
      `  ${report.rejected.length} rejected\n` +
      `  ${report.unmatchedCustomers.length} customers with no order`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}