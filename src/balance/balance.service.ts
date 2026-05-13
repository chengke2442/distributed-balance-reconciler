import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Balance } from './balance.entity';

export type ApplyResult = 'CREATED' | 'APPLIED' | 'SKIPPED';

@Injectable()
export class BalanceService {
  constructor(
    @InjectRepository(Balance)
    private readonly repo: Repository<Balance>,
  ) {}

  async getBalance(employeeId: string, locationId: string): Promise<Balance | null> {
    return this.repo.findOne({ where: { employeeId, locationId } });
  }

  async getBalanceOrFail(employeeId: string, locationId: string): Promise<Balance> {
    const balance = await this.getBalance(employeeId, locationId);
    if (!balance) {
      throw new NotFoundException(`No balance record for employee ${employeeId} at location ${locationId}`);
    }
    return balance;
  }

  /**
   * Atomically deducts days using optimistic concurrency.
   * Returns false if the expected version no longer matches (concurrent write detected).
   */
  async deductBalance(
    employeeId: string,
    locationId: string,
    days: number,
    expectedVersion: number,
  ): Promise<{ success: boolean; newBalance?: number }> {
    const result = await this.repo
      .createQueryBuilder()
      .update(Balance)
      .set({
        balanceDays: () => `balance_days - ${days}`,
        version: () => `version + 1`,
      })
      .where(
        'employee_id = :employeeId AND location_id = :locationId AND version = :version',
        { employeeId, locationId, version: expectedVersion },
      )
      .execute();

    if (result.affected === 0) {
      return { success: false };
    }

    const updated = await this.getBalance(employeeId, locationId);
    return { success: true, newBalance: updated.balanceDays };
  }

  /**
   * Applies an HCM-sourced update. Skips if local data is more recent (concurrency guard).
   */
  async applyHcmUpdate(
    employeeId: string,
    locationId: string,
    balanceDays: number,
    hcmTimestamp: Date,
  ): Promise<ApplyResult> {
    const existing = await this.getBalance(employeeId, locationId);

    if (!existing) {
      await this.repo.save({
        employeeId,
        locationId,
        balanceDays,
        version: 1,
        lastHcmSyncAt: hcmTimestamp,
      });
      return 'CREATED';
    }

    if (existing.lastHcmSyncAt && hcmTimestamp <= existing.lastHcmSyncAt) {
      return 'SKIPPED';
    }

    await this.repo
      .createQueryBuilder()
      .update(Balance)
      .set({
        balanceDays,
        version: () => `version + 1`,
        lastHcmSyncAt: hcmTimestamp,
      })
      .where('employee_id = :employeeId AND location_id = :locationId', { employeeId, locationId })
      .execute();

    return 'APPLIED';
  }

  async seed(employeeId: string, locationId: string, balanceDays: number, lastHcmSyncAt?: Date): Promise<Balance> {
    const existing = await this.getBalance(employeeId, locationId);
    if (existing) {
      await this.repo.update(existing.id, { balanceDays, lastHcmSyncAt: lastHcmSyncAt ?? null });
      return this.getBalance(employeeId, locationId);
    }
    return this.repo.save({ employeeId, locationId, balanceDays, version: 1, lastHcmSyncAt: lastHcmSyncAt ?? null });
  }
}
