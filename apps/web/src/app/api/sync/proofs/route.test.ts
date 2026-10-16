import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

const COMMITMENT = 'a'.repeat(64);
const SCHEME = 'sha256-commitment-opening';
const PROOF = { scheme: SCHEME, payload: { amount: 5 }, blinding: 'b' };

const { mockWithClient, mockGetMerchantFromRequest, mockRecord, mockVerify } = vi.hoisted(() => ({
  mockWithClient: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
  mockGetMerchantFromRequest: vi.fn(),
  mockRecord: vi.fn(),
  mockVerify: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ withClient: mockWithClient, ensureSchema: vi.fn() }));
vi.mock('@/lib/merchants', () => ({ getMerchantFromRequest: mockGetMerchantFromRequest }));
vi.mock('@/lib/zk-ledger', () => ({
  ensureZkCommitmentsSchema: vi.fn(),
  recordVerifiedCommitment: mockRecord,
}));
vi.mock('@accensa/sdk/zk-proof', () => ({
  ZK_PROOF_SCHEME: 'sha256-commitment-opening',
  canonicalJson: (v: unknown) => JSON.stringify(v),
  sha256Hex: vi.fn(async () => 'f'.repeat(64)),
  verifyOpeningProof: mockVerify,
}));

const post = (body: unknown, raw = false) =>
  POST(
    new Request('http://localhost/api/sync/proofs', {
      method: 'POST',
      body: raw ? (body as string) : JSON.stringify(body),
    }),
  );

describe('/api/sync/proofs POST', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://dummy';
    mockVerify.mockResolvedValue(true);
    mockGetMerchantFromRequest.mockResolvedValue({ id: 1, address: 'GABC' });
    mockRecord.mockResolvedValue({ recorded: true });
  });

  it('returns 500 when DATABASE_URL is missing', async () => {
    delete process.env.DATABASE_URL;
    const res = await post({ commitment: COMMITMENT, proof: PROOF });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'DATABASE_URL is not configured' });
  });

  it('returns 400 for a non-JSON body', async () => {
    const res = await post('nope', true);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON body' });
  });

  it('returns 400 when the commitment is not a 64-char hex digest', async () => {
    const res = await post({ commitment: 'xyz', proof: PROOF });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'commitment must be a 64-character hex SHA-256 digest',
    });
  });

  it('returns 400 when the proof is missing', async () => {
    const res = await post({ commitment: COMMITMENT });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'proof is required' });
  });

  it('returns 400 for an unsupported proof scheme', async () => {
    const res = await post({ commitment: COMMITMENT, proof: { ...PROOF, scheme: 'snark-v9' } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unsupported proof scheme: snark-v9' });
  });

  it('returns 422 and writes nothing when the proof does not open the commitment', async () => {
    mockVerify.mockResolvedValue(false);
    const res = await post({ commitment: COMMITMENT, proof: PROOF });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'proof does not open the commitment' });
    expect(mockWithClient).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('returns 401 for an unresolvable merchant, after proof verification', async () => {
    mockGetMerchantFromRequest.mockResolvedValue(null);
    const res = await post({ commitment: COMMITMENT, proof: PROOF });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(mockVerify).toHaveBeenCalledWith(COMMITMENT, PROOF);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('returns 201 when the commitment is newly recorded', async () => {
    const res = await post({ commitment: COMMITMENT, proof: PROOF });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      success: true,
      merchant: 'GABC',
      commitment: COMMITMENT,
      recorded: true,
    });
    expect(mockRecord).toHaveBeenCalledWith(expect.anything(), 1, {
      commitment: COMMITMENT,
      payloadHash: 'f'.repeat(64),
      scheme: SCHEME,
    });
  });

  it('returns 200 when the same commitment is replayed', async () => {
    mockRecord.mockResolvedValueOnce({ recorded: true }).mockResolvedValueOnce({ recorded: false });
    const first = await post({ commitment: COMMITMENT, proof: PROOF });
    const replay = await post({ commitment: COMMITMENT, proof: PROOF });
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect((await replay.json()).recorded).toBe(false);
  });

  it('returns 500 when persistence throws', async () => {
    mockRecord.mockRejectedValue(new Error('db down'));
    const res = await post({ commitment: COMMITMENT, proof: PROOF });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: 'Internal Server Error' });
  });
});
