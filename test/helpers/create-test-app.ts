import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { Balance } from '../../src/balance/balance.entity';
import { TimeOffRequest } from '../../src/requests/time-off-request.entity';
import { SyncLog } from '../../src/sync/sync-log.entity';
import { BalanceModule } from '../../src/balance/balance.module';
import { RequestsModule } from '../../src/requests/requests.module';
import { SyncModule } from '../../src/sync/sync.module';

export async function createTestApp(): Promise<INestApplication> {
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

  const app = module.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  await app.init();
  return app;
}
