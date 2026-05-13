import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { Balance } from './balance/balance.entity';
import { TimeOffRequest } from './requests/time-off-request.entity';
import { SyncLog } from './sync/sync-log.entity';
import { BalanceModule } from './balance/balance.module';
import { RequestsModule } from './requests/requests.module';
import { SyncModule } from './sync/sync.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'sqljs',
        location: config.get<string>('DATABASE_PATH', 'timeoff.db'),
        autoSave: true,
        entities: [Balance, TimeOffRequest, SyncLog],
        synchronize: true,
      }),
    }),
    BalanceModule,
    RequestsModule,
    SyncModule,
  ],
})
export class AppModule {}
