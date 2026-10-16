import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';
import { activeStoreAddress } from '@/lib/stores/activeStoreToken';

const ORGANIZATION = `G${'A'.repeat(55)}`;
const STORE = `G${'B'.repeat(55)}`;
const mockQuery = vi.fn();

const { mockWithClient, mockWithMerchantClient, mockGetMerchantByAddress } = vi.hoisted(() => ({
  mockWithClient: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
  mockWithMerchantClient: vi.fn(
    async (_merchantId: number, fn: (client: unknown) => Promise<unknown>) =>
      fn({ query: mockQuery }),
  ),
  mockGetMerchantByAddress: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  withClient: mockWithClient,
  withMerchantClient: mockWithMerchantClient,
  ensureSchema: vi.fn(),
}));

vi.mock('@/lib/merchants', () => ({
  getMerchantByAddress: mockGetMerchantByAddress,
}));

const post = (body: unknown, raw = false) =>
  POST(
    new Request('http://localhost/api/merchant/stores/active', {
      method: 'POST',
      headers: { 'x-accensa-org-merchant': ORGANIZATION },
      body: raw ? (body as string) : JSON.stringify(body),
    }),
  );

describe('/api/merchant/stores/active POST', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://dummy';
    process.env.JWT_SECRET_KEY = 'store-token-test-secret';
    mockGetMerchantByAddress.mockResolvedValue({ id: 1, address: ORGANIZATION });
  });

  it('returns 503 when DATABASE_URL is not configured', async () => {
    delete process.env.DATABASE_URL;
    const res = await post({ storeId: 1 });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Database is unavailable' });
  });

  it('returns 400 for a non-JSON body', async () => {
    const res = await post('not json', true);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON body' });
  });

  it.each([
    ['an array body', [1]],
    ['a missing storeId', {}],
    ['a string storeId', { storeId: '1' }],
    ['a zero storeId', { storeId: 0 }],
    ['a fractional storeId', { storeId: 1.5 }],
  ])('returns 400 for %s', async (_name, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(mockWithMerchantClient).not.toHaveBeenCalled();
  });

  it('returns 400 with the selection message for an invalid storeId', async () => {
    const res = await post({ storeId: -3 });
    expect(await res.json()).toEqual({ error: 'storeId must be a positive integer or null' });
  });

  it('returns 404 Store not found when the store is not in the organisation', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const res = await post({ storeId: 99 });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Store not found' });
    expect(res.cookies.get('accensa_active_store')).toBeUndefined();
  });

  it('sets a signed cookie that verifies for this organisation and store', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 7, address: STORE }] });
    const res = await post({ storeId: 7 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ activeStoreId: 7 });

    const cookie = res.cookies.get('accensa_active_store');
    expect(cookie?.value).toBeTruthy();
    expect(await activeStoreAddress(cookie!.value, ORGANIZATION)).toBe(STORE);
    expect(await activeStoreAddress(cookie!.value, `G${'C'.repeat(55)}`)).toBeNull();
    expect(mockQuery.mock.calls[0][1]).toEqual([1, 7]);
  });

  it('sets the cookie as httpOnly, lax and path-scoped with a 24h lifetime', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 7, address: STORE }] });
    const cookie = (await post({ storeId: 7 })).cookies.get('accensa_active_store');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: 86400 });
  });

  it('clears the cookie with an empty value and zero maxAge on deselect', async () => {
    const res = await post({ storeId: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ activeStoreId: null });
    expect(res.cookies.get('accensa_active_store')).toMatchObject({
      value: '',
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
    expect(mockWithMerchantClient).not.toHaveBeenCalled();
  });
});
