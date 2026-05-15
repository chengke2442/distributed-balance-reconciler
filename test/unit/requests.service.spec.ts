import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { RequestsService } from '../../src/requests/requests.service';
import { TimeOffRequest, RequestStatus } from '../../src/requests/time-off-request.entity';
import { BalanceService } from '../../src/balance/balance.service';
import { HcmService } from '../../src/hcm/hcm.service';
import { makeBalance, makeRequest } from '../helpers/factories';

describe('RequestsService', () => {
  let service: RequestsService;
  let balanceService: jest.Mocked<BalanceService>;
  let hcmService: jest.Mocked<HcmService>;
  let mockRepo: any;

  beforeEach(async () => {
    mockRepo = {
      save: jest.fn(),
      update: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RequestsService,
        { provide: getRepositoryToken(TimeOffRequest), useValue: mockRepo },
        {
          provide: BalanceService,
          useValue: {
            getBalance: jest.fn(),
            deductBalance: jest.fn(),
          },
        },
        {
          provide: HcmService,
          useValue: {
            submitTimeOffRequest: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<RequestsService>(RequestsService);
    balanceService = module.get(BalanceService);
    hcmService = module.get(HcmService);
  });

  describe('getRequest', () => {
    it('throws NotFoundException when request ID does not exist', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      await expect(service.getRequest('non-existent-id')).rejects.toThrow(
        'Request non-existent-id not found',
      );
    });
  });

  describe('Gate 1 — local eligibility', () => {
    it('rejects immediately when no balance record exists', async () => {
      balanceService.getBalance.mockResolvedValue(null);
      await expect(service.createRequest('emp-001', 'loc-us-pto', 2)).rejects.toThrow(BadRequestException);
      expect(hcmService.submitTimeOffRequest).not.toHaveBeenCalled();
    });

    it('rejects immediately when local balance is insufficient', async () => {
      balanceService.getBalance.mockResolvedValue(makeBalance({ balanceDays: 1 }));
      await expect(service.createRequest('emp-001', 'loc-us-pto', 2)).rejects.toThrow(
        'Insufficient balance: 1 days available, 2 requested',
      );
      expect(hcmService.submitTimeOffRequest).not.toHaveBeenCalled();
    });
  });

  describe('Gate 2 — HCM authority', () => {
    beforeEach(() => {
      balanceService.getBalance.mockResolvedValue(makeBalance({ balanceDays: 10, version: 3 }));
      mockRepo.save.mockResolvedValue(makeRequest({ balanceVersionAtRequest: 3 }));
      mockRepo.update.mockResolvedValue({ affected: 1 });
    });

    it('rejects the request when HCM rejects', async () => {
      hcmService.submitTimeOffRequest.mockResolvedValue({ success: false, error: 'Insufficient balance in HCM' });
      mockRepo.findOne.mockResolvedValue(makeRequest({ status: RequestStatus.REJECTED, hcmError: 'Insufficient balance in HCM' }));

      const result = await service.createRequest('emp-001', 'loc-us-pto', 2);
      expect(result.status).toBe(RequestStatus.REJECTED);
      expect(balanceService.deductBalance).not.toHaveBeenCalled();
    });

    it('rejects when HCM returns 200 with no referenceId (silent failure)', async () => {
      hcmService.submitTimeOffRequest.mockResolvedValue({
        success: false,
        error: 'HCM returned no confirmation (silent failure)',
      });
      mockRepo.findOne.mockResolvedValue(makeRequest({ status: RequestStatus.REJECTED }));

      const result = await service.createRequest('emp-001', 'loc-us-pto', 2);
      expect(result.status).toBe(RequestStatus.REJECTED);
      expect(balanceService.deductBalance).not.toHaveBeenCalled();
    });

    it('approves and deducts when both gates pass', async () => {
      hcmService.submitTimeOffRequest.mockResolvedValue({ success: true, referenceId: 'hcm-ref-1' });
      balanceService.deductBalance.mockResolvedValue({ success: true, newBalance: 8 });
      mockRepo.findOne.mockResolvedValue(makeRequest({ status: RequestStatus.APPROVED, hcmReferenceId: 'hcm-ref-1' }));

      const result = await service.createRequest('emp-001', 'loc-us-pto', 2);
      expect(result.status).toBe(RequestStatus.APPROVED);
      expect(result.hcmReferenceId).toBe('hcm-ref-1');
      expect(balanceService.deductBalance).toHaveBeenCalledWith('emp-001', 'loc-us-pto', 2, 3);
    });

    it('retries deduction on version conflict and still marks APPROVED (HCM is authoritative)', async () => {
      hcmService.submitTimeOffRequest.mockResolvedValue({ success: true, referenceId: 'hcm-ref-2' });
      // First deduct fails (version conflict), retry reads fresh balance and also conflicts
      balanceService.deductBalance
        .mockResolvedValueOnce({ success: false })
        .mockResolvedValueOnce({ success: false });
      balanceService.getBalance.mockResolvedValue(makeBalance({ version: 99 }));
      mockRepo.findOne.mockResolvedValue(makeRequest({ status: RequestStatus.APPROVED, hcmReferenceId: 'hcm-ref-2' }));

      const result = await service.createRequest('emp-001', 'loc-us-pto', 2);
      // HCM approved it, so we must mark APPROVED and let batch sync fix local state
      expect(result.status).toBe(RequestStatus.APPROVED);
    });
  });
});
