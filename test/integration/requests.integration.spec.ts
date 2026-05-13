import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import request from 'supertest';
import * as http from 'http';
import { startServer } from '../../mock-hcm/server';
import { Balance } from '../../src/balance/balance.entity';
import { TimeOffRequest, RequestStatus } from '../../src/requests/time-off-request.entity';
import { SyncLog } from '../../src/sync/sync-log.entity';
import { BalanceModule } from '../../src/balance/balance.module';
import { RequestsModule } from '../../src/requests/requests.module';
import { SyncModule } from '../../src/sync/sync.module';
import axios from 'axios';

describe('Requests — Integration', () => {
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

  async function seedBalance(employeeId: string, locationId: string, balanceDays: number) {
    // Seed in HCM mock
    await axios.post(`http://localhost:${hcmPort}/hcm/balances/seed`, { employeeId, locationId, balanceDays });
    // Seed locally via sync realtime endpoint
    await request(app.getHttpServer())
      .post('/sync/realtime')
      .send({ employeeId, locationId, balanceDays, hcmTimestamp: new Date(Date.now() - 60000).toISOString() });
  }

  describe('Happy path', () => {
    it('approves a valid request and decrements local balance', async () => {
      await seedBalance('emp-001', 'loc-us-pto', 10);

      const res = await request(app.getHttpServer())
        .post('/requests')
        .send({ employeeId: 'emp-001', locationId: 'loc-us-pto', daysRequested: 3 });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe(RequestStatus.APPROVED);
      expect(res.body.hcmReferenceId).toMatch(/^hcm-ref-/);

      const balRes = await request(app.getHttpServer()).get('/balances/emp-001/loc-us-pto');
      expect(balRes.body.balanceDays).toBe(7);
    });

    it('allows multiple sequential requests until balance is exhausted', async () => {
      await seedBalance('emp-002', 'loc-us-pto', 4);

      const first = await request(app.getHttpServer())
        .post('/requests')
        .send({ employeeId: 'emp-002', locationId: 'loc-us-pto', daysRequested: 2 });
      expect(first.body.status).toBe(RequestStatus.APPROVED);

      const second = await request(app.getHttpServer())
        .post('/requests')
        .send({ employeeId: 'emp-002', locationId: 'loc-us-pto', daysRequested: 2 });
      expect(second.body.status).toBe(RequestStatus.APPROVED);

      const third = await request(app.getHttpServer())
        .post('/requests')
        .send({ employeeId: 'emp-002', locationId: 'loc-us-pto', daysRequested: 1 });
      expect(third.status).toBe(400);
    });
  });

  describe('Gate 1 — local rejection', () => {
    it('returns 400 when employee has no balance record', async () => {
      const res = await request(app.getHttpServer())
        .post('/requests')
        .send({ employeeId: 'emp-unknown', locationId: 'loc-us-pto', daysRequested: 1 });
      expect(res.status).toBe(400);
    });

    it('returns 400 when local balance is insufficient (no HCM call made)', async () => {
      await seedBalance('emp-003', 'loc-us-sick', 1);

      const res = await request(app.getHttpServer())
        .post('/requests')
        .send({ employeeId: 'emp-003', locationId: 'loc-us-sick', daysRequested: 5 });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Insufficient/);
    });
  });

  describe('Gate 2 — HCM rejection', () => {
    it('marks request REJECTED when HCM rejects (balance diverged externally)', async () => {
      // Seed local with 5 days, but HCM only has 1 day (simulating prior drift)
      await seedBalance('emp-001', 'loc-us-sick', 5);
      await axios.post(`http://localhost:${hcmPort}/hcm/balances/seed`, {
        employeeId: 'emp-001', locationId: 'loc-us-sick', balanceDays: 1,
      });

      const res = await request(app.getHttpServer())
        .post('/requests')
        .send({ employeeId: 'emp-001', locationId: 'loc-us-sick', daysRequested: 3 });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe(RequestStatus.REJECTED);
      expect(res.body.hcmError).toMatch(/Insufficient/);

      // Local balance should remain unchanged
      const balRes = await request(app.getHttpServer()).get('/balances/emp-001/loc-us-sick');
      expect(balRes.body.balanceDays).toBe(5);
    });
  });

  describe('Request retrieval', () => {
    it('returns request status by ID', async () => {
      await seedBalance('emp-001', 'loc-us-pto', 10);

      const createRes = await request(app.getHttpServer())
        .post('/requests')
        .send({ employeeId: 'emp-001', locationId: 'loc-us-pto', daysRequested: 1 });

      const id = createRes.body.id;
      const getRes = await request(app.getHttpServer()).get(`/requests/${id}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.id).toBe(id);
    });
  });
});
