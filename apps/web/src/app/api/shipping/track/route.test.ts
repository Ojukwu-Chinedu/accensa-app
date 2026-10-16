import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

const { mockFetchTracking, mockBuildEvidence } = vi.hoisted(() => ({
  mockFetchTracking: vi.fn(),
  mockBuildEvidence: vi.fn(),
}));

vi.mock('../../../../../lib/shipping/trackingAdapter', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../../lib/shipping/trackingAdapter')>();
  return {
    ...actual,
    fetchTracking: mockFetchTracking,
    buildTrackingEvidenceDocument: mockBuildEvidence,
  };
});

import { ShippingTrackingError } from '../../../../../lib/shipping/trackingAdapter';

const get = (query: string) => GET(new Request(`http://localhost/api/shipping/track${query}`));

describe('/api/shipping/track GET', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a missing carrier with 400 and the supported-carrier message', async () => {
    const res = await get('?trackingNumber=1Z999');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'carrier must be one of USPS, FedEx, DHL, or UPS' });
    expect(mockFetchTracking).not.toHaveBeenCalled();
  });

  it('rejects a missing trackingNumber with 400 and its own message', async () => {
    const res = await get('?carrier=UPS');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'trackingNumber is required' });
    expect(mockFetchTracking).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only trackingNumber', async () => {
    const res = await get('?carrier=UPS&trackingNumber=%20%20');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'trackingNumber is required' });
  });

  it('rejects an unknown carrier with 400 naming every supported carrier', async () => {
    const res = await get('?carrier=PigeonPost&trackingNumber=123');
    expect(res.status).toBe(400);
    const { error } = await res.json();
    for (const carrier of ['USPS', 'FedEx', 'DHL', 'UPS']) expect(error).toContain(carrier);
    expect(mockFetchTracking).not.toHaveBeenCalled();
  });

  it('returns 200 with Cache-Control: no-store on success', async () => {
    const tracking = { carrier: 'UPS', trackingNumber: '1Z999', events: [] };
    mockFetchTracking.mockResolvedValue(tracking);
    mockBuildEvidence.mockReturnValue({ kind: 'evidence' });

    const res = await get('?carrier=ups&trackingNumber=%201Z999%20');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ tracking, evidence: { kind: 'evidence' } });
    expect(mockFetchTracking).toHaveBeenCalledWith({ carrier: 'UPS', trackingNumber: '1Z999' });
  });

  it('maps an upstream carrier error carrying a status to 502', async () => {
    mockFetchTracking.mockRejectedValue(new ShippingTrackingError('carrier down', 'UPS', 503));
    const res = await get('?carrier=UPS&trackingNumber=1Z999');
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'carrier down' });
  });

  it('maps an unexpected adapter throw to 500 instead of an unhandled rejection', async () => {
    mockFetchTracking.mockRejectedValue(new Error('boom'));
    const res = await get('?carrier=UPS&trackingNumber=1Z999');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'boom' });
  });
});
