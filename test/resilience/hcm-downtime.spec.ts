import 'reflect-metadata';
import * as net from 'net';
import * as http from 'http';
import request from 'supertest';
import axios from 'axios';
import { DataSource } from 'typeorm';
import { startServer } from '../../mock-hcm/server';
import { Balance } from '../../src/balance/balance.entity';
import { TimeOffRequest, RequestStatus } from '../../src/requests/time-off-request.entity';
import { SyncLog, SyncStatus } from '../../src/sync/sync-log.entity';
import { INestApplication } from '@nestjs/common';
import { createTestApp } from '../helpers/create-test-app';
import { seedLocalBalance } from '../helpers/seed';

describe('Resilience — HCM Downtime & Error Handling', () => {
  let app: INestApplication;
  let hcmServer: http.Server;
  let hcmPort: number;

  beforeAll(async () => {
    hcmServer = startServer(0);
    await new Promise<void>((resolve) => hcmServer.on('listening', resolve));
    hcmPort = (hcmServer.address() as net.AddressInfo).port;

    process.env.HCM_BASE_URL = `http://localhost:${hcmPort}`;
    process.env.HCM_TIMEOUT_MS = '500';
    process.env.HCM_RETRY_COUNT = '1';

    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve) => hcmServer.close(() => resolve()));
  });

  beforeEach(async () => {
    await axios.post(`http://localhost:${hcmPort}/test/reset`);
    const ds = app.get(DataSource);
    await ds.getRepository(Balance).clear();
    await ds.getRepository(TimeOffRequest).clear();
    await ds.getRepository(SyncLog).clear();
  });

  describe('HCM timeout', () => {
    it('rejects the request cleanly and leaves balance unchanged when HCM never responds', async () => {
      await seedLocalBalance(app, 'emp-001', 'loc-us-pto', 10);

      await axios.post(`http://localhost:${hcmPort}/test/simulate-timeout`);

      const res = await request(app.getHttpServer())
        .post('/requests')
        .send({ employeeId: 'emp-001', locationId: 'loc-us-pto', daysRequested: 2 })
        .timeout(5000);

      expect(res.status).toBe(201);
      expect(res.body.status).toBe(RequestStatus.REJECTED);
      expect(res.body.hcmError).toBeDefined();

      const balRes = await request(app.getHttpServer()).get('/balances/emp-001/loc-us-pto');
      expect(balRes.body.balanceDays).toBe(10);
    });
  });

  describe('HCM 5xx errors with retry', () => {
    it('succeeds on the third attempt after two 500 errors', async () => {
      process.env.HCM_RETRY_COUNT = '3';
      process.env.HCM_TIMEOUT_MS = '2000';

      const app2 = await createTestApp();

      await axios.post(`http://localhost:${hcmPort}/test/reset`);
      await request(app2.getHttpServer())
        .post('/sync/realtime')
        .send({ employeeId: 'emp-001', locationId: 'loc-us-pto', balanceDays: 10, hcmTimestamp: new Date(Date.now() - 3600000).toISOString() });

      await axios.post(`http://localhost:${hcmPort}/test/fail-next`, { count: 2 });

      const res = await request(app2.getHttpServer())
        .post('/requests')
        .send({ employeeId: 'emp-001', locationId: 'loc-us-pto', daysRequested: 2 });

      expect(res.body.status).toBe(RequestStatus.APPROVED);

      await app2.close();
      process.env.HCM_RETRY_COUNT = '1';
      process.env.HCM_TIMEOUT_MS = '500';
    }, 30000);
  });

  describe('HCM silent failure', () => {
    it('rejects request when HCM returns 200 with no referenceId', async () => {
      await seedLocalBalance(app, 'emp-001', 'loc-us-pto', 10);

      await axios.post(`http://localhost:${hcmPort}/test/fail-next`, { count: 1 });

      const res = await request(app.getHttpServer())
        .post('/requests')
        .send({ employeeId: 'emp-001', locationId: 'loc-us-pto', daysRequested: 2 });

      expect(res.body.status).toBe(RequestStatus.REJECTED);

      const balRes = await request(app.getHttpServer()).get('/balances/emp-001/loc-us-pto');
      expect(balRes.body.balanceDays).toBe(10);
    });
  });

  describe('Batch sync resilience', () => {
    it('marks batch sync FAILED when HCM is completely unreachable', async () => {
      process.env.HCM_BASE_URL = 'http://localhost:19999';

      const app4 = await createTestApp();

      const res = await request(app4.getHttpServer()).post('/sync/batch');
      expect(res.body.status).toBe(SyncStatus.FAILED);
      expect(res.body.errorDetail).toMatch(/HCM fetch failed/);

      await app4.close();
      process.env.HCM_BASE_URL = `http://localhost:${hcmPort}`;
    });
  });
});
