import 'reflect-metadata';
import * as net from 'net';
import * as http from 'http';
import request from 'supertest';
import axios from 'axios';
import { DataSource } from 'typeorm';
import { startServer } from '../../mock-hcm/server';
import { Balance } from '../../src/balance/balance.entity';
import { TimeOffRequest } from '../../src/requests/time-off-request.entity';
import { SyncLog, SyncStatus } from '../../src/sync/sync-log.entity';
import { INestApplication } from '@nestjs/common';
import { createTestApp } from '../helpers/create-test-app';

describe('Sync Engine — Integration', () => {
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

  describe('Realtime sync', () => {
    it('applies a work-anniversary bonus pushed by HCM', async () => {
      await request(app.getHttpServer())
        .post('/sync/realtime')
        .send({ employeeId: 'emp-001', locationId: 'loc-us-pto', balanceDays: 10, hcmTimestamp: new Date(Date.now() - 3600000).toISOString() });

      await axios.post(`http://localhost:${hcmPort}/hcm/balances/anniversary`, {
        employeeId: 'emp-001', locationId: 'loc-us-pto', bonusDays: 1,
      });

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
      const res = await request(app.getHttpServer()).post('/sync/batch');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(SyncStatus.COMPLETED);
      expect(res.body.recordsProcessed).toBeGreaterThan(0);
      expect(res.body.recordsUpdated).toBeGreaterThan(0);

      const balRes = await request(app.getHttpServer()).get('/balances/emp-001/loc-us-pto');
      expect(balRes.status).toBe(200);
      expect(balRes.body.balanceDays).toBe(10);
    });

    it('resolves anniversary drift: HCM-granted bonus overwrites local stale value', async () => {
      const oldTimestamp = new Date(Date.now() - 7200000).toISOString();
      await request(app.getHttpServer())
        .post('/sync/realtime')
        .send({ employeeId: 'emp-001', locationId: 'loc-us-pto', balanceDays: 10, hcmTimestamp: oldTimestamp });

      await axios.post(`http://localhost:${hcmPort}/hcm/balances/anniversary`, {
        employeeId: 'emp-001', locationId: 'loc-us-pto', bonusDays: 1,
      });

      await request(app.getHttpServer()).post('/sync/batch');

      const balRes = await request(app.getHttpServer()).get('/balances/emp-001/loc-us-pto');
      expect(balRes.body.balanceDays).toBe(11);
    });

    it('does not overwrite a fresh local user-write with stale batch data', async () => {
      await request(app.getHttpServer()).post('/sync/batch');

      await request(app.getHttpServer())
        .post('/requests')
        .send({ employeeId: 'emp-002', locationId: 'loc-us-pto', daysRequested: 2 });

      const balAfterRequest = await request(app.getHttpServer()).get('/balances/emp-002/loc-us-pto');
      const balanceAfterDeduction = balAfterRequest.body.balanceDays;

      await request(app.getHttpServer()).post('/sync/batch');

      const balFinal = await request(app.getHttpServer()).get('/balances/emp-002/loc-us-pto');
      expect(balFinal.body.balanceDays).toBe(balanceAfterDeduction);
    });

    it('reports status via GET /sync/status', async () => {
      await request(app.getHttpServer()).post('/sync/batch');
      const res = await request(app.getHttpServer()).get('/sync/status');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(SyncStatus.COMPLETED);
    });
  });
});
