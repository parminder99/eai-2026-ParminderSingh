import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../tests/package.json', import.meta.url));
const amqp = require('amqplib');
const root = fileURLToPath(new URL('../', import.meta.url));
const logPath = new URL('../notification-service/data/notification.log', import.meta.url);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const order = {
  orderId: 'RESTART-CHECK', orderType: 'standard', source: 'web',
  receivedAt: new Date().toISOString(), orderDate: new Date().toISOString(),
  customer: { name: 'Verification Customer', email: 'test@example.com',
    address: { street: 'Test Street', city: 'Riga', postalCode: 'LV-1001', country: 'LV' } },
  items: [{ productId: 'PROD-001', productName: 'Test item', quantity: 1,
    unitPrice: '22.50', currency: 'EUR', taxRate: 0.21 }], currency: 'EUR', status: 'new',
};
const response = await fetch('http://localhost:3002/orders', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(order),
});
if (response.status !== 201) throw new Error('Order was not accepted');
const {correlationId} = await response.json();
const fetched = await (await fetch(`http://localhost:3002/orders/${correlationId}`)).json();
if (JSON.stringify(fetched.order) !== JSON.stringify(order)) throw new Error('Canonical body changed');
function matchingLines() {
  return readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line)).filter(entry => entry.correlationId === correlationId);
}
await pause(2000);
if (matchingLines().length !== 1) throw new Error('Expected first notification');
execFileSync('docker', ['compose', 'restart', 'notification-service'], {cwd: root, stdio: 'pipe'});
await pause(3000);
const connection = await amqp.connect('amqp://eai:eai-pa5@localhost:5674');
try {
  const channel = await connection.createConfirmChannel();
  channel.sendToQueue('notifications.queue', Buffer.from(JSON.stringify(order)), {
    headers: {correlationId}, contentType: 'application/json', persistent: true,
  });
  await channel.waitForConfirms();
  await channel.close();
} finally { await connection.close(); }
await pause(2000);
if (matchingLines().length !== 1) throw new Error('Restart lost deduplication state');
console.log('PASS: unchanged canonical body and duplicate skipped after notification restart');

const invalid = await fetch('http://localhost:3002/orders', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({...order, correlationId: 'not-allowed-in-body'}),
});
if (invalid.status !== 400) throw new Error('Extra canonical field accepted');
const missing = await fetch('http://localhost:3002/orders/not-an-order');
if (missing.status !== 404) throw new Error('Unknown order did not return 404');
console.log('PASS: unknown lookup and invalid canonical body rejected');
