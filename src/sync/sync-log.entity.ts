import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';

export enum SyncType {
  BATCH = 'BATCH',
  REALTIME = 'REALTIME',
}

export enum SyncStatus {
  STARTED = 'STARTED',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

@Entity('sync_log')
export class SyncLog {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'sync_type' })
  syncType: SyncType;

  @Column({ name: 'status' })
  status: SyncStatus;

  @Column({ name: 'records_processed', default: 0 })
  recordsProcessed: number;

  @Column({ name: 'records_updated', default: 0 })
  recordsUpdated: number;

  @Column({ name: 'records_skipped', default: 0 })
  recordsSkipped: number;

  @Column({ name: 'error_detail', nullable: true, type: 'text' })
  errorDetail: string | null;

  @CreateDateColumn({ name: 'started_at' })
  startedAt: Date;

  @Column({ name: 'completed_at', nullable: true, type: 'datetime' })
  completedAt: Date | null;
}
