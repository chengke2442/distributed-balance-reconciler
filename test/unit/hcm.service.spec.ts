import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HcmService } from '../../src/hcm/hcm.service';

function makeConfigService(retryCount = 2) {
  return {
    get: (key: string, def: any) => {
      if (key === 'HCM_BASE_URL') return 'http://mock-hcm';
      if (key === 'HCM_TIMEOUT_MS') return 5000;
      if (key === 'HCM_RETRY_COUNT') return retryCount;
      return def;
    },
  };
}

describe('HcmService', () => {
  let service: HcmService;
  let mockClient: { post: jest.Mock; get: jest.Mock };

  beforeEach(async () => {
    mockClient = { post: jest.fn(), get: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HcmService,
        { provide: ConfigService, useValue: makeConfigService(2) },
      ],
    }).compile();

    service = module.get<HcmService>(HcmService);
    (service as any).client = mockClient;
  });

  afterEach(() => jest.useRealTimers());

  describe('submitTimeOffRequest', () => {
    it('returns referenceId on HCM approval', async () => {
      mockClient.post.mockResolvedValue({ data: { referenceId: 'hcm-ref-123' } });

      const result = await service.submitTimeOffRequest('emp-001', 'loc-us-pto', 3);

      expect(result.success).toBe(true);
      expect(result.referenceId).toBe('hcm-ref-123');
    });

    it('returns success=false when HCM returns 200 with no referenceId (silent failure)', async () => {
      mockClient.post.mockResolvedValue({ data: {} });

      const result = await service.submitTimeOffRequest('emp-001', 'loc-us-pto', 3);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/silent failure/);
    });

    it('returns success=false immediately on non-retryable 4xx (no retry)', async () => {
      const err = Object.assign(new Error('Bad Request'), {
        response: { status: 400, data: { error: 'Bad employee ID' } },
      });
      mockClient.post.mockRejectedValue(err);

      const result = await service.submitTimeOffRequest('emp-001', 'loc-us-pto', 3);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Bad employee ID');
      expect(mockClient.post).toHaveBeenCalledTimes(1);
    });

    it('returns success=false after exhausting retries on repeated 5xx', async () => {
      jest.useFakeTimers();
      const err5xx = Object.assign(new Error('Gateway Timeout'), { response: { status: 504 } });
      mockClient.post.mockRejectedValue(err5xx);

      const resultPromise = service.submitTimeOffRequest('emp-001', 'loc-us-pto', 3);
      const assertion = expect(resultPromise).resolves.toMatchObject({ success: false });
      await jest.runAllTimersAsync();
      await assertion;

      expect(mockClient.post).toHaveBeenCalledTimes(2);
    });

    it('retries on 5xx and returns success when second attempt succeeds', async () => {
      jest.useFakeTimers();
      const err5xx = Object.assign(new Error('Gateway Timeout'), { response: { status: 504 } });
      mockClient.post
        .mockRejectedValueOnce(err5xx)
        .mockResolvedValueOnce({ data: { referenceId: 'hcm-ref-retry' } });

      const resultPromise = service.submitTimeOffRequest('emp-001', 'loc-us-pto', 3);
      await jest.runAllTimersAsync();
      const result = await resultPromise;

      expect(mockClient.post).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
      expect(result.referenceId).toBe('hcm-ref-retry');
    });
  });

  describe('getBatchCorpus', () => {
    it('returns balance records from HCM', async () => {
      const records = [
        { employeeId: 'emp-001', locationId: 'loc-us-pto', balanceDays: 10, timestamp: new Date().toISOString() },
      ];
      mockClient.get.mockResolvedValue({ data: records });

      const result = await service.getBatchCorpus();

      expect(result).toEqual(records);
    });

    it('throws after exhausting all retries on repeated 5xx (withRetryOrThrow)', async () => {
      jest.useFakeTimers();
      const err = Object.assign(new Error('Service Unavailable'), { response: { status: 503 } });
      mockClient.get.mockRejectedValue(err);

      const resultPromise = service.getBatchCorpus();
      // Attach the rejection handler BEFORE advancing timers to avoid unhandled-rejection detection.
      const assertion = expect(resultPromise).rejects.toThrow('Service Unavailable');
      await jest.runAllTimersAsync();
      await assertion;

      expect(mockClient.get).toHaveBeenCalledTimes(2);
    });
  });
});
