import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsDateString, IsNumber, IsPositive, IsString } from 'class-validator';
import { SyncService } from './sync.service';
import { SyncLog } from './sync-log.entity';

class RealtimeUpdateDto {
  @IsString()
  employeeId: string;

  @IsString()
  locationId: string;

  @IsNumber()
  @IsPositive()
  balanceDays: number;

  @IsDateString()
  hcmTimestamp: string;
}

@Controller('sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post('realtime')
  async realtimeUpdate(@Body() dto: RealtimeUpdateDto): Promise<{ result: string }> {
    return this.syncService.handleRealtimeUpdate(
      dto.employeeId,
      dto.locationId,
      dto.balanceDays,
      new Date(dto.hcmTimestamp),
    );
  }

  @Post('batch')
  async triggerBatch(): Promise<SyncLog> {
    return this.syncService.runBatchSync();
  }

  @Get('status')
  async getStatus(): Promise<SyncLog | null> {
    return this.syncService.getLatestSyncLog();
  }
}
