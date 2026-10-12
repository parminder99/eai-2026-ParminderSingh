import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_WEB_ORDER_PATH, DEFAULT_MOBILE_ORDER_PATH, DEFAULT_B2B_ORDER_PATH,
  DEFAULT_PRICING_BASE_URL, DEFAULT_PRICING_API_KEY,
  enrichFromPricing, translateWeb, translateMobile, translateB2B,
} from '../../starter/src/transform';
import { forceStatus, resetPricingCatalog } from '../public/_pricing-admin';

const options = { pricingBaseUrl: DEFAULT_PRICING_BASE_URL,
  now: () => new Date('2026-10-12T08:00:00Z') };
const scratch = mkdtempSync(path.join(tmpdir(), 'pa4-verification-'));
afterEach(resetPricingCatalog);

describe('pricing failures preserve usable lines without inventing prices', () => {
  it('returns a warning for an unknown product in each source', async () => {
    const web = JSON.parse(readFileSync(DEFAULT_WEB_ORDER_PATH, 'utf8'));
    web.items[0].productId = 'PROD-999999';
    const webPath = path.join(scratch, 'web.json');
    writeFileSync(webPath, JSON.stringify(web));
    const mobile = JSON.parse(readFileSync(DEFAULT_MOBILE_ORDER_PATH, 'utf8'));
    mobile.items[0].pid = '999999';
    const mobilePath = path.join(scratch, 'mobile.json');
    writeFileSync(mobilePath, JSON.stringify(mobile));
    const xmlPath = path.join(scratch, 'unknown.xml');
    // Latin-1 round-trip changes ASCII bytes only and preserves the CP1257 bytes.
    writeFileSync(xmlPath, Buffer.from(readFileSync(DEFAULT_B2B_ORDER_PATH).toString('latin1')
      .replace('SKU-PROD-001', 'SKU-PROD-999999'), 'latin1'));
    for (const result of [await translateWeb(webPath, options),
      await translateMobile(mobilePath, options), await translateB2B(xmlPath, options)]) {
      expect(result.order?.items).toHaveLength(1);
      expect(result.warnings).toEqual([{code: 'UNKNOWN_PRODUCT', productId: 'PROD-999999',
        message: 'Product not found in pricing catalog'}]);
      expect(result.order?.receivedAt).toBe('2026-10-12T08:00:00.000Z');
    }
  });

  it('reports HTTP 500 for every source, dropping only the failed line', async () => {
    await forceStatus('PROD-001', 500);
    for (const result of [await translateWeb(DEFAULT_WEB_ORDER_PATH, options),
      await translateMobile(DEFAULT_MOBILE_ORDER_PATH, options),
      await translateB2B(DEFAULT_B2B_ORDER_PATH, options)]) {
      expect(result.order?.items.map(item => item.productId)).toEqual(['PROD-002']);
      expect(result.warnings[0]?.code).toBe('PRICING_API_ERROR');
      expect(result.warnings[0]?.message).toContain('500');
    }
  });

  it('returns null with a warning for each line when authentication fails', async () => {
    const result = await translateWeb(DEFAULT_WEB_ORDER_PATH, {...options, apiKey: 'incorrect'});
    expect(result.order).toBeNull();
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.every(w => w.message.includes('401'))).toBe(true);
  });

  it('handles connection failure without throwing or pricing at zero', async () => {
    expect(await enrichFromPricing('PROD-001', {pricingBaseUrl: 'http://127.0.0.1:1'}))
      .toEqual({status: 'error', httpStatus: 0});
  });

  it('rejects malformed successful pricing responses', async () => {
    await fetch(`${DEFAULT_PRICING_BASE_URL}/admin/pricing/PROD-001`, {
      method: 'PUT', headers: {'X-API-Key': DEFAULT_PRICING_API_KEY, 'Content-Type': 'application/json'},
      body: JSON.stringify({taxRate: 2}),
    });
    expect(await enrichFromPricing('PROD-001', options)).toEqual({status: 'error', httpStatus: 200});
  });
});

it('handles singleton XML, preserves numeric postal text, and filters unknown elements', async () => {
  let xml = readFileSync(DEFAULT_B2B_ORDER_PATH).toString('latin1');
  let count = 0;
  xml = xml.replace(/<LineItem\b[\s\S]*?<\/LineItem>/g, line => ++count === 1 ? line : '');
  xml = xml.replace(/<PostalCode>[^<]*<\/PostalCode>/, '<PostalCode>00123</PostalCode>');
  xml = xml.replace('</PurchaseOrder>', '<Extra><PaymentDetails>PRIVATE-MARKER</PaymentDetails></Extra></PurchaseOrder>');
  const file = path.join(scratch, 'singleton.xml');
  writeFileSync(file, Buffer.from(xml, 'latin1'));
  const result = await translateB2B(file, options);
  expect(result.order?.items).toHaveLength(1);
  expect(result.order?.customer.address.postalCode).toBe('00123');
  expect(result.order?.customer.name).toBe('Anna Bērziņa');
  expect(JSON.stringify(result)).not.toContain('PRIVATE-MARKER');
  expect(result.warnings).toEqual([]);
});
