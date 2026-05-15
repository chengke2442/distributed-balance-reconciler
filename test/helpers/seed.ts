import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import axios from 'axios';

export async function seedBalance(
  app: INestApplication,
  hcmPort: number,
  employeeId: string,
  locationId: string,
  days: number,
): Promise<void> {
  await axios.post(`http://localhost:${hcmPort}/hcm/balances/seed`, { employeeId, locationId, balanceDays: days });
  await request(app.getHttpServer())
    .post('/sync/realtime')
    .send({ employeeId, locationId, balanceDays: days, hcmTimestamp: new Date(Date.now() - 60000).toISOString() });
}

export async function seedLocalBalance(
  app: INestApplication,
  employeeId: string,
  locationId: string,
  days: number,
): Promise<void> {
  await request(app.getHttpServer())
    .post('/sync/realtime')
    .send({ employeeId, locationId, balanceDays: days, hcmTimestamp: new Date(Date.now() - 3600000).toISOString() });
}
