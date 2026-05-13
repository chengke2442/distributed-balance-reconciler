import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { SyncLog, SyncStatus, SyncType } from './sync-log.entity';
import { BalanceService } from '../balance/balance.service';
import { HcmService, HcmBalanceRecord } from '../hcm/hcm.service';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @InjectRepository(SyncLog)
    private readonly syncLogRepo: Repository<SyncLog>,
    private readonly balanceService: BalanceService,
    private readonly hcmService: HcmService,
  ) {}

  /**
   * Handles a real-time push from the HCM (e.g., work anniversary bonus).
   */
  async handleRealtimeUpdate(
    employeeId: string,
    locationId: string,
    balanceDays: number,
    hcmTimestamp: Date,
  ): Promise<{ result: string }> {
    const result = await this.balanceService.applyHcmUpdate(
      employeeId,
      locationId,
      balanceDays,
      hcmTimestamp,
    );

    await this.syncLogRepo.save({
      syncType: SyncType.REALTIME,
      status: SyncStatus.COMPLETED,
      recordsProcessed: 1,
      recordsUpdated: result !== 'SKIPPED' ? 1 : 0,
      recordsSkipped: result === 'SKIPPED' ? 1 : 0,
      completedAt: new Date(),
    });

    return { result };
  }

  /**
   * Full batch reconciliation — scheduled hourly and triggerable on demand.
   */
  @Cron(process.env.BATCH_SYNC_CRON || '0 * * * *')
  async runBatchSync(): Promise<SyncLog> {
    this.logger.log('Starting batch sync');
    const log = await this.syncLogRepo.save({
      syncType: SyncType.BATCH,
      status: SyncStatus.STARTED,
    });

    let batchData: HcmBalanceRecord[];
    try {
      batchData = await this.hcmService.getBatchCorpus();
    } catch (err) {
      this.logger.error(`Batch sync failed: could not fetch HCM corpus — ${err.message}`);
      await this.syncLogRepo.update(log.id, {
        status: SyncStatus.FAILED,
        errorDetail: `HCM fetch failed: ${err.message}`,
        completedAt: new Date(),
      });
      return this.syncLogRepo.findOne({ where: { id: log.id } });
    }

    let updated = 0;
    let skipped = 0;

    for (const record of batchData) {
      try {
        const result = await this.balanceService.applyHcmUpdate(
          record.employeeId,
          record.locationId,
          record.balanceDays,
          new Date(record.timestamp),
        );
        if (result === 'SKIPPED') skipped++;
        else updated++;
      } catch (err) {
        this.logger.warn(
          `Batch sync skipped record ${record.employeeId}/${record.locationId}: ${err.message}`,
        );
        skipped++;
      }
    }

    await this.syncLogRepo.update(log.id, {
      status: SyncStatus.COMPLETED,
      recordsProcessed: batchData.length,
      recordsUpdated: updated,
      recordsSkipped: skipped,
      completedAt: new Date(),
    });

    this.logger.log(`Batch sync done: ${updated} updated, ${skipped} skipped`);
    return this.syncLogRepo.findOne({ where: { id: log.id } });
  }

  async getLatestSyncLog(): Promise<SyncLog | null> {
    return this.syncLogRepo.findOne({ where: {}, order: { id: 'DESC' } });
  }
}
