import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TimeOffRequest, RequestStatus } from './time-off-request.entity';
import { BalanceService } from '../balance/balance.service';
import { HcmService } from '../hcm/hcm.service';

@Injectable()
export class RequestsService {
  constructor(
    @InjectRepository(TimeOffRequest)
    private readonly repo: Repository<TimeOffRequest>,
    private readonly balanceService: BalanceService,
    private readonly hcmService: HcmService,
  ) {}

  async createRequest(
    employeeId: string,
    locationId: string,
    daysRequested: number,
  ): Promise<TimeOffRequest> {
    // Gate 1 — local eligibility check for instant feedback
    const balance = await this.balanceService.getBalance(employeeId, locationId);
    if (!balance || balance.balanceDays < daysRequested) {
      throw new BadRequestException(
        `Insufficient balance: ${balance?.balanceDays ?? 0} days available, ${daysRequested} requested`,
      );
    }

    const request = await this.repo.save({
      employeeId,
      locationId,
      daysRequested,
      status: RequestStatus.PENDING,
      balanceVersionAtRequest: balance.version,
    });

    // Gate 2 — HCM is the final authority
    const hcmResult = await this.hcmService.submitTimeOffRequest(employeeId, locationId, daysRequested);

    if (!hcmResult.success) {
      await this.repo.update(request.id, {
        status: RequestStatus.REJECTED,
        hcmError: hcmResult.error,
      });
      return this.repo.findOne({ where: { id: request.id } });
    }

    // Deduct locally with optimistic lock
    const deductResult = await this.balanceService.deductBalance(
      employeeId,
      locationId,
      daysRequested,
      balance.version,
    );

    if (!deductResult.success) {
      // Version conflict: a concurrent write happened. Re-read and retry once.
      const fresh = await this.balanceService.getBalance(employeeId, locationId);
      if (fresh) {
        await this.balanceService.deductBalance(employeeId, locationId, daysRequested, fresh.version);
      }
      // Either way, HCM approved — mark approved and let batch sync reconcile local state.
    }

    await this.repo.update(request.id, {
      status: RequestStatus.APPROVED,
      hcmReferenceId: hcmResult.referenceId,
    });

    return this.repo.findOne({ where: { id: request.id } });
  }

  async getRequest(id: string): Promise<TimeOffRequest> {
    const request = await this.repo.findOne({ where: { id } });
    if (!request) throw new NotFoundException(`Request ${id} not found`);
    return request;
  }

  async getRequestsByEmployee(employeeId: string): Promise<TimeOffRequest[]> {
    return this.repo.find({ where: { employeeId }, order: { createdAt: 'DESC' } });
  }
}
