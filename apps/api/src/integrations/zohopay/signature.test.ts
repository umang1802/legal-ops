import { describe, expect, it } from 'vitest';
import { signZohoWebhook, verifyZohoWebhook } from './signature.js';

const KEY =
  '52402c8bd2edb946a072d13e0599ef992ad661a54e4a472385c394185cfb0d2597b88415891c11356c83a739be74b5797bf8dfbacc7a80c00bc6a2f5bb74e2d49a841b172fc78069237cbffe38ddc15b';
const body = Buffer.from('{"event_id":1,"event_type":"payment_link.paid"}');

describe('Zoho webhook signature', () => {
  it('accepts the header Zoho documents: t=<ms>,v=<hex HMAC-SHA256 of "<t>.<body>">', () => {
    expect(verifyZohoWebhook(body, signZohoWebhook(body, KEY, 1734340423138), KEY)).toBe(true);
  });

  it('rejects a changed body, a wrong key, a missing header and malformed headers', () => {
    const good = signZohoWebhook(body, KEY, 1734340423138);
    expect(verifyZohoWebhook(Buffer.from('{"event_id":2}'), good, KEY)).toBe(false);
    expect(verifyZohoWebhook(body, good, 'another-key-entirely')).toBe(false);
    expect(verifyZohoWebhook(body, undefined, KEY)).toBe(false);
    expect(verifyZohoWebhook(body, 'garbage', KEY)).toBe(false);
    expect(verifyZohoWebhook(body, 't=1734340423138', KEY)).toBe(false);
    expect(verifyZohoWebhook(body, 't=1734340423138,v=zz', KEY)).toBe(false);
  });

  it('a different timestamp invalidates the signature (the timestamp is part of what is signed)', () => {
    const [, v] = signZohoWebhook(body, KEY, 1000).split(',v=');
    expect(verifyZohoWebhook(body, `t=2000,v=${v}`, KEY)).toBe(false);
  });
});
