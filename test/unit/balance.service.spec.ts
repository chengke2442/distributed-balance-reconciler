import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BalanceService } from '../../src/balance/balance.service';
import { Balance } from '../../src/balance/balance.entity';
import { makeBalance } from '../helpers/factories';

describe('BalanceService', () => {
  let service: BalanceService;
  let mockRepo: any;

  beforeEach(async () => {
    mockRepo = {
      findOne: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BalanceService,
        { provide: getRepositoryToken(Balance), useValue: mockRepo },
      ],
    }).compile();

    service = module.get<BalanceService>(BalanceService);
  });

  describe('getBalance', () => {
    it('returns null when no record exists', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      const result = await service.getBalance('emp-unknown', 'loc-x');
      expect(result).toBeNull();
    });

    it('returns the balance record when found', async () => {
      const balance = makeBalance();
      mockRepo.findOne.mockResolvedValue(balance);
      const result = await service.getBalance('emp-001', 'loc-us-pto');
      expect(result.balanceDays).toBe(10);
      expect(result.version).toBe(1);
    });
  });

  describe('getBalanceOrFail', () => {
    it('throws NotFoundException when balance does not exist', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      await expect(service.getBalanceOrFail('emp-missing', 'loc-x')).rejects.toThrow('No balance record');
    });
  });

  describe('deductBalance', () => {
    const buildQb = (affected: number) => ({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected }),
    });

    it('returns success=false when version does not match (concurrent write)', async () => {
      mockRepo.createQueryBuilder.mockReturnValue(buildQb(0));
      const result = await service.deductBalance('emp-001', 'loc-us-pto', 2, 1);
      expect(result.success).toBe(false);
    });

    it('returns success=true and new balance when version matches', async () => {
      const updatedBalance = makeBalance({ balanceDays: 8, version: 2 });
      mockRepo.createQueryBuilder.mockReturnValue(buildQb(1));
      mockRepo.findOne.mockResolvedValue(updatedBalance);

      const result = await service.deductBalance('emp-001', 'loc-us-pto', 2, 1);
      expect(result.success).toBe(true);
      expect(result.newBalance).toBe(8);
    });
  });

  describe('applyHcmUpdate', () => {
    it('creates a new record when no local record exists', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      mockRepo.save.mockResolvedValue(makeBalance());

      const result = await service.applyHcmUpdate('emp-new', 'loc-us-pto', 15, new Date());
      expect(result).toBe('CREATED');
      expect(mockRepo.save).toHaveBeenCalledWith(expect.objectContaining({ balanceDays: 15 }));
    });

    it('skips update when local lastHcmSyncAt is newer than incoming timestamp', async () => {
      const newerDate = new Date('2026-05-13T12:00:00Z');
      const olderHcmTimestamp = new Date('2026-05-13T10:00:00Z');
      mockRepo.findOne.mockResolvedValue(makeBalance({ lastHcmSyncAt: newerDate }));

      const result = await service.applyHcmUpdate('emp-001', 'loc-us-pto', 12, olderHcmTimestamp);
      expect(result).toBe('SKIPPED');
    });

    it('applies update when HCM timestamp is newer than local lastHcmSyncAt', async () => {
      const olderDate = new Date('2026-05-10T00:00:00Z');
      const newerHcmTimestamp = new Date('2026-05-13T00:00:00Z');
      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      mockRepo.findOne.mockResolvedValue(makeBalance({ lastHcmSyncAt: olderDate }));
      mockRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.applyHcmUpdate('emp-001', 'loc-us-pto', 12, newerHcmTimestamp);
      expect(result).toBe('APPLIED');
      expect(qb.set).toHaveBeenCalledWith(expect.objectContaining({ balanceDays: 12 }));
    });

    it('applies update when no lastHcmSyncAt exists locally (first sync)', async () => {
      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      mockRepo.findOne.mockResolvedValue(makeBalance({ lastHcmSyncAt: null }));
      mockRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.applyHcmUpdate('emp-001', 'loc-us-pto', 12, new Date());
      expect(result).toBe('APPLIED');
    });
  });
});
