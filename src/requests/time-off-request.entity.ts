import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';

export enum RequestStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

@Entity('time_off_request')
export class TimeOffRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'employee_id' })
  employeeId: string;

  @Column({ name: 'location_id' })
  locationId: string;

  @Column({ name: 'days_requested', type: 'real' })
  daysRequested: number;

  @Column({ name: 'status', default: RequestStatus.PENDING })
  status: RequestStatus;

  @Column({ name: 'hcm_reference_id', nullable: true })
  hcmReferenceId: string | null;

  @Column({ name: 'hcm_error', nullable: true, type: 'text' })
  hcmError: string | null;

  @Column({ name: 'balance_version_at_request' })
  balanceVersionAtRequest: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
