import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SyncService } from '../../src/sync/sync.service';
import { SyncLog, SyncStatus, SyncType } from '../../src/sync/sync-log.entity';
import { BalanceService } from '../../src/balance/balance.service';
import { HcmService } from '../../src/hcm/hcm.service';

describe('SyncService', () => {
  let service: SyncService;
  let balanceService: jest.Mocked<BalanceService>;
  let hcmService: jest.Mocked<HcmService>;
  let mockSyncLogRepo: any;

  const batchRecord = (overrides = {}) => ({
    employeeId: 'emp-001',
    locationId: 'loc-us-pto',
    balanceDays: 12,
    timestamp: new Date().toISOString(),
    ...overrides,
  });

  beforeEach(async () => {
    mockSyncLogRepo = {
      save: jest.fn().mockImplementation((data) => Promise.resolve({ id: 1, ...data })),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      findOne: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncService,
        { provide: getRepositoryToken(SyncLog), useValue: mockSyncLogRepo },
        {
          provide: BalanceService,
          useValue: {
            applyHcmUpdate: jest.fn(),
          },
        },
        {
          provide: HcmService,
          useValue: {
            getBatchCorpus: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<SyncService>(SyncService);
    balanceService = module.get(BalanceService);
    hcmService = module.get(HcmService);
  });

  describe('handleRealtimeUpdate', () => {
    it('applies an incoming HCM push and logs it', async () => {
      balanceService.applyHcmUpdate.mockResolvedValue('APPLIED');
      mockSyncLogRepo.save.mockResolvedValue({ id: 1, syncType: SyncType.REALTIME, status: SyncStatus.COMPLETED });

      const result = await service.handleRealtimeUpdate('emp-001', 'loc-us-pto', 12, new Date());
      expect(result.result).toBe('APPLIED');
      expect(mockSyncLogRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ syncType: SyncType.REALTIME, status: SyncStatus.COMPLETED }),
      );
    });

    it('returns SKIPPED when local data is more recent', async () => {
      balanceService.applyHcmUpdate.mockResolvedValue('SKIPPED');
      mockSyncLogRepo.save.mockResolvedValue({ id: 2 });

      const result = await service.handleRealtimeUpdate('emp-001', 'loc-us-pto', 8, new Date('2020-01-01'));
      expect(result.result).toBe('SKIPPED');
    });
  });

  describe('runBatchSync', () => {
    it('marks sync FAILED when HCM corpus fetch throws', async () => {
      hcmService.getBatchCorpus.mockRejectedValue(new Error('HCM unreachable'));
      mockSyncLogRepo.findOne.mockResolvedValue({ id: 1, status: SyncStatus.FAILED });

      const result = await service.runBatchSync();
      expect(mockSyncLogRepo.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: SyncStatus.FAILED }),
      );
      expect(result.status).toBe(SyncStatus.FAILED);
    });

    it('applies new records and skips stale ones in a batch', async () => {
      hcmService.getBatchCorpus.mockResolvedValue([
        batchRecord({ employeeId: 'emp-001', balanceDays: 12 }),
        batchRecord({ employeeId: 'emp-002', balanceDays: 15 }),
        batchRecord({ employeeId: 'emp-003', balanceDays: 3 }),
      ]);

      balanceService.applyHcmUpdate
        .mockResolvedValueOnce('APPLIED')
        .mockResolvedValueOnce('SKIPPED')
        .mockResolvedValueOnce('CREATED');

      mockSyncLogRepo.findOne.mockResolvedValue({
        id: 1,
        status: SyncStatus.COMPLETED,
        recordsProcessed: 3,
        recordsUpdated: 2,
        recordsSkipped: 1,
      });

      const result = await service.runBatchSync();
      expect(mockSyncLogRepo.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          status: SyncStatus.COMPLETED,
          recordsProcessed: 3,
          recordsUpdated: 2,
          recordsSkipped: 1,
        }),
      );
      expect(result.status).toBe(SyncStatus.COMPLETED);
    });

    it('continues processing remaining records when one record fails', async () => {
      hcmService.getBatchCorpus.mockResolvedValue([
        batchRecord({ employeeId: 'emp-001' }),
        batchRecord({ employeeId: 'emp-002' }),
      ]);

      balanceService.applyHcmUpdate
        .mockRejectedValueOnce(new Error('DB write failed'))
        .mockResolvedValueOnce('APPLIED');

      mockSyncLogRepo.findOne.mockResolvedValue({ id: 1, status: SyncStatus.COMPLETED });
      await service.runBatchSync();

      expect(mockSyncLogRepo.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ recordsUpdated: 1, recordsSkipped: 1 }),
      );
    });

    it('counts CREATED records as updated', async () => {
      hcmService.getBatchCorpus.mockResolvedValue([batchRecord()]);
      balanceService.applyHcmUpdate.mockResolvedValue('CREATED');
      mockSyncLogRepo.findOne.mockResolvedValue({ id: 1, status: SyncStatus.COMPLETED });

      await service.runBatchSync();
      expect(mockSyncLogRepo.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ recordsUpdated: 1, recordsSkipped: 0 }),
      );
    });
  });
});
