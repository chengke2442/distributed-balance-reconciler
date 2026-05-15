import { Balance } from '../../src/balance/balance.entity';
import { TimeOffRequest, RequestStatus } from '../../src/requests/time-off-request.entity';

export const makeBalance = (overrides: Partial<Balance> = {}): Balance =>
  Object.assign(new Balance(), {
    id: 1,
    employeeId: 'emp-001',
    locationId: 'loc-us-pto',
    balanceDays: 10,
    version: 1,
    lastHcmSyncAt: null,
    updatedAt: new Date(),
    ...overrides,
  });

export const makeRequest = (overrides: Partial<TimeOffRequest> = {}): TimeOffRequest =>
  Object.assign(new TimeOffRequest(), {
    id: 'req-uuid-1',
    employeeId: 'emp-001',
    locationId: 'loc-us-pto',
    daysRequested: 2,
    status: RequestStatus.PENDING,
    hcmReferenceId: null,
    hcmError: null,
    balanceVersionAtRequest: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
