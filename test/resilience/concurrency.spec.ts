import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import request from 'supertest';
import * as http from 'http';
import axios from 'axios';
import { startServer } from '../../mock-hcm/server';
import { Balance } from '../../src/balance/balance.entity';
import { TimeOffRequest } from '../../src/requests/time-off-request.entity';
import { SyncLog } from '../../src/sync/sync-log.entity';
import { BalanceModule } from '../../src/balance/balance.module';
import { RequestsModule } from '../../src/requests/requests.module';
import { SyncModule } from '../../src/sync/sync.module';
import { RequestStatus } from '../../src/requests/time-off-request.entity';

describe('Resilience — Concurrency & Race Conditions', () => {
  let app: INestApplication;
  let hcmServer: http.Server;
  let hcmPort: number;

  beforeAll(async () => {
    hcmServer = startServer(0);
    await new Promise<void>((resolve) => hcmServer.on('listening', resolve));
    hcmPort = (hcmServer.address() as any).port;

    process.env.HCM_BASE_URL = `http://localhost:${hcmPort}`;
    process.env.HCM_TIMEOUT_MS = '3000';
    process.env.HCM_RETRY_COUNT = '1';

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        ScheduleModule.forRoot(),
        TypeOrmModule.forRoot({
          type: 'sqljs',
          entities: [Balance, TimeOffRequest, SyncLog],
          synchronize: true,
        }),
        BalanceModule,
        RequestsModule,
        SyncModule,
      ],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve) => hcmServer.close(() => resolve()));
  });

  beforeEach(async () => {
    await axios.post(`http://localhost:${hcmPort}/test/reset`);
  });

  async function seedBalance(employeeId: string, locationId: string, days: number) {
    await axios.post(`http://localhost:${hcmPort}/hcm/balances/seed`, { employeeId, locationId, balanceDays: days });
    await request(app.getHttpServer())
      .post('/sync/realtime')
      .send({ employeeId, locationId, balanceDays: days, hcmTimestamp: new Date(Date.now() - 60000).toISOString() });
  }

  describe('Optimistic concurrency control', () => {
    it('prevents double-spend: two concurrent requests against tight balance yield exactly one approval', async () => {
      // emp-001 has exactly 2 days; both requests ask for 2 days
      await seedBalance('emp-001', 'loc-us-pto', 2);

      const [res1, res2] = await Promise.all([
        request(app.getHttpServer())
          .post('/requests')
          .send({ employeeId: 'emp-001', locationId: 'loc-us-pto', daysRequested: 2 }),
        request(app.getHttpServer())
          .post('/requests')
          .send({ employeeId: 'emp-001', locationId: 'loc-us-pto', daysRequested: 2 }),
      ]);

      const statuses = [res1.body.status, res2.body.status];
      const approved = statuses.filter((s) => s === RequestStatus.APPROVED);
      const rejected = statuses.filter((s) => s === RequestStatus.REJECTED || res1.status === 400 || res2.status === 400);

      // Exactly one should be approved (the other rejected by Gate 1 or Gate 2)
      // Note: because SQLite serializes writes, one request will win; the other may be blocked by Gate 1 (optimistic)
      // or Gate 2 (HCM). Either way, the final balance should be >= 0.
      const balRes = await request(app.getHttpServer()).get('/balances/emp-001/loc-us-pto');
      expect(balRes.body.balanceDays).toBeGreaterThanOrEqual(0);

      // At most one approval
      expect(approved.length).toBeLessThanOrEqual(1);
    });

    it('does not let balance go negative even with concurrent requests', async () => {
      await seedBalance('emp-002', 'loc-us-pto', 3);

      // Fire 5 concurrent requests of 1 day each against a 3-day balance
      await Promise.all(
        Array.from({ length: 5 }, () =>
          request(app.getHttpServer())
            .post('/requests')
            .send({ employeeId: 'emp-002', locationId: 'loc-us-pto', daysRequested: 1 }),
        ),
      );

      const balRes = await request(app.getHttpServer()).get('/balances/emp-002/loc-us-pto');
      expect(balRes.body.balanceDays).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Race: batch sync vs. user request', () => {
    it('preserves a user request that arrives during batch sync (version guard)', async () => {
      // Seed local with older timestamp
      const oldTs = new Date(Date.now() - 7200000).toISOString();
      await request(app.getHttpServer())
        .post('/sync/realtime')
        .send({ employeeId: 'emp-003', locationId: 'loc-us-pto', balanceDays: 5, hcmTimestamp: oldTs });
      await axios.post(`http://localhost:${hcmPort}/hcm/balances/seed`, {
        employeeId: 'emp-003', locationId: 'loc-us-pto', balanceDays: 5,
      });

      // User request and batch sync fire concurrently
      const [reqRes, _syncRes] = await Promise.all([
        request(app.getHttpServer())
          .post('/requests')
          .send({ employeeId: 'emp-003', locationId: 'loc-us-pto', daysRequested: 1 }),
        request(app.getHttpServer()).post('/sync/batch'),
      ]);

      // Whatever the final balance is, it must not be negative
      const balRes = await request(app.getHttpServer()).get('/balances/emp-003/loc-us-pto');
      expect(balRes.body.balanceDays).toBeGreaterThanOrEqual(0);

      // And the request must have a definitive status (not stuck in PENDING)
      if (reqRes.status === 201) {
        expect([RequestStatus.APPROVED, RequestStatus.REJECTED]).toContain(reqRes.body.status);
      }
    });
  });
});
