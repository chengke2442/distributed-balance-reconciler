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
import { SyncStatus } from '../../src/sync/sync-log.entity';

describe('Sync Engine — Integration', () => {
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

  describe('Realtime sync', () => {
    it('applies a work-anniversary bonus pushed by HCM', async () => {
      // Seed local balance at 10 days
      await request(app.getHttpServer())
        .post('/sync/realtime')
        .send({ employeeId: 'emp-001', locationId: 'loc-us-pto', balanceDays: 10, hcmTimestamp: new Date(Date.now() - 3600000).toISOString() });

      // HCM grants anniversary bonus (now has 11 days)
      await axios.post(`http://localhost:${hcmPort}/hcm/balances/anniversary`, {
        employeeId: 'emp-001', locationId: 'loc-us-pto', bonusDays: 1,
      });

      // HCM pushes realtime update to our service
      const syncRes = await request(app.getHttpServer())
        .post('/sync/realtime')
        .send({ employeeId: 'emp-001', locationId: 'loc-us-pto', balanceDays: 11, hcmTimestamp: new Date().toISOString() });

      expect(syncRes.body.result).toBe('APPLIED');

      const balRes = await request(app.getHttpServer()).get('/balances/emp-001/loc-us-pto');
      expect(balRes.body.balanceDays).toBe(11);
    });

    it('ignores a realtime push with an older timestamp (local data is fresher)', async () => {
      const recent = new Date().toISOString();
      await request(app.getHttpServer())
        .post('/sync/realtime')
        .send({ employeeId: 'emp-002', locationId: 'loc-us-pto', balanceDays: 15, hcmTimestamp: recent });

      const stale = new Date(Date.now() - 7200000).toISOString();
      const res = await request(app.getHttpServer())
        .post('/sync/realtime')
        .send({ employeeId: 'emp-002', locationId: 'loc-us-pto', balanceDays: 5, hcmTimestamp: stale });

      expect(res.body.result).toBe('SKIPPED');

      const balRes = await request(app.getHttpServer()).get('/balances/emp-002/loc-us-pto');
      expect(balRes.body.balanceDays).toBe(15);
    });

    it('creates a new local record for employees not yet in local cache', async () => {
      const res = await request(app.getHttpServer())
        .post('/sync/realtime')
        .send({ employeeId: 'emp-new-99', locationId: 'loc-us-pto', balanceDays: 7, hcmTimestamp: new Date().toISOString() });

      expect(res.body.result).toBe('CREATED');

      const balRes = await request(app.getHttpServer()).get('/balances/emp-new-99/loc-us-pto');
      expect(balRes.body.balanceDays).toBe(7);
    });
  });

  describe('Batch sync', () => {
    it('reconciles all HCM balances and creates missing local records', async () => {
      // HCM mock has emp-001, emp-002, emp-003 pre-seeded
      const res = await request(app.getHttpServer()).post('/sync/batch');

      expect(res.status).toBe(201);
      expect(res.body.status).toBe(SyncStatus.COMPLETED);
      expect(res.body.recordsProcessed).toBeGreaterThan(0);
      expect(res.body.recordsUpdated).toBeGreaterThan(0);

      // Local records should now exist
      const balRes = await request(app.getHttpServer()).get('/balances/emp-001/loc-us-pto');
      expect(balRes.status).toBe(200);
      expect(balRes.body.balanceDays).toBe(10);
    });

    it('resolves anniversary drift: HCM-granted bonus overwrites local stale value', async () => {
      // Seed local with old timestamp and 10 days
      const oldTimestamp = new Date(Date.now() - 7200000).toISOString();
      await request(app.getHttpServer())
        .post('/sync/realtime')
        .send({ employeeId: 'emp-001', locationId: 'loc-us-pto', balanceDays: 10, hcmTimestamp: oldTimestamp });

      // HCM grants anniversary bonus — now has 11 days with newer timestamp
      await axios.post(`http://localhost:${hcmPort}/hcm/balances/anniversary`, {
        employeeId: 'emp-001', locationId: 'loc-us-pto', bonusDays: 1,
      });

      // Batch sync should pick up the newer HCM value
      await request(app.getHttpServer()).post('/sync/batch');

      const balRes = await request(app.getHttpServer()).get('/balances/emp-001/loc-us-pto');
      expect(balRes.body.balanceDays).toBe(11);
    });

    it('does not overwrite a fresh local user-write with stale batch data', async () => {
      // First sync to seed local data with a timestamp
      await request(app.getHttpServer()).post('/sync/batch');

      // User submits a request, updating local balance
      await request(app.getHttpServer())
        .post('/requests')
        .send({ employeeId: 'emp-002', locationId: 'loc-us-pto', daysRequested: 2 });

      const balAfterRequest = await request(app.getHttpServer()).get('/balances/emp-002/loc-us-pto');
      const balancAfterDeduction = balAfterRequest.body.balanceDays;

      // Batch sync runs again with the same HCM data (which still shows 15 - 2 = 13 because HCM was debited too)
      await request(app.getHttpServer()).post('/sync/batch');

      // Local balance should reflect the deduction, not be reset
      const balFinal = await request(app.getHttpServer()).get('/balances/emp-002/loc-us-pto');
      // The batch timestamp equals the previous batch — should be SKIPPED or correct
      expect(balFinal.body.balanceDays).toBe(balancAfterDeduction);
    });

    it('reports status via GET /sync/status', async () => {
      await request(app.getHttpServer()).post('/sync/batch');
      const res = await request(app.getHttpServer()).get('/sync/status');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(SyncStatus.COMPLETED);
    });
  });
});
