import { Entity, Column, PrimaryGeneratedColumn, Index, UpdateDateColumn } from 'typeorm';

@Entity('balance')
@Index(['employeeId', 'locationId'], { unique: true })
export class Balance {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'employee_id' })
  employeeId: string;

  @Column({ name: 'location_id' })
  locationId: string;

  @Column({ name: 'balance_days', type: 'real', default: 0 })
  balanceDays: number;

  @Column({ name: 'version', default: 1 })
  version: number;

  @Column({ name: 'last_hcm_sync_at', nullable: true, type: 'datetime' })
  lastHcmSyncAt: Date | null;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
