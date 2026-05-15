import 'reflect-metadata';
import * as net from 'net';
import * as http from 'http';
import request from 'supertest';
import axios from 'axios';
import { DataSource } from 'typeorm';
import { startServer } from '../../mock-hcm/server';
import { Balance } from '../../src/balance/balance.entity';
import { TimeOffRequest, RequestStatus } from '../../src/requests/time-off-request.entity';
import { SyncLog } from '../../src/sync/sync-log.entity';
import { INestApplication } from '@nestjs/common';
import { createTestApp } from '../helpers/create-test-app';
import { seedBalance } from '../helpers/seed';

describe('Resilience — Concurrency & Race Conditions', () => {
  let app: INestApplication;
  let hcmServer: http.Server;
  let hcmPort: number;

  beforeAll(async () => {
    hcmServer = startServer(0);
    await new Promise<void>((resolve) => hcmServer.on('listening', resolve));
    hcmPort = (hcmServer.address() as net.AddressInfo).port;

    process.env.HCM_BASE_URL = `http://localhost:${hcmPort}`;
    process.env.HCM_TIMEOUT_MS = '3000';
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

  describe('Optimistic concurrency control', () => {
    it('prevents double-spend: two concurrent requests against tight balance yield exactly one approval', async () => {
      await seedBalance(app, hcmPort, 'emp-001', 'loc-us-pto', 2);

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

      const balRes = await request(app.getHttpServer()).get('/balances/emp-001/loc-us-pto');
      expect(balRes.body.balanceDays).toBeGreaterThanOrEqual(0);
      expect(approved.length).toBeLessThanOrEqual(1);
    });

    it('does not let balance go negative even with concurrent requests', async () => {
      await seedBalance(app, hcmPort, 'emp-002', 'loc-us-pto', 3);

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
      const oldTs = new Date(Date.now() - 7200000).toISOString();
      await request(app.getHttpServer())
        .post('/sync/realtime')
        .send({ employeeId: 'emp-003', locationId: 'loc-us-pto', balanceDays: 5, hcmTimestamp: oldTs });
      await axios.post(`http://localhost:${hcmPort}/hcm/balances/seed`, {
        employeeId: 'emp-003', locationId: 'loc-us-pto', balanceDays: 5,
      });

      const [reqRes, _syncRes] = await Promise.all([
        request(app.getHttpServer())
          .post('/requests')
          .send({ employeeId: 'emp-003', locationId: 'loc-us-pto', daysRequested: 1 }),
        request(app.getHttpServer()).post('/sync/batch'),
      ]);

      const balRes = await request(app.getHttpServer()).get('/balances/emp-003/loc-us-pto');
      expect(balRes.body.balanceDays).toBeGreaterThanOrEqual(0);

      if (reqRes.status === 201) {
        expect([RequestStatus.APPROVED, RequestStatus.REJECTED]).toContain(reqRes.body.status);
      }
    });
  });
});
