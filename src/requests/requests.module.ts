import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TimeOffRequest } from './time-off-request.entity';
import { RequestsService } from './requests.service';
import { RequestsController } from './requests.controller';
import { BalanceModule } from '../balance/balance.module';
import { HcmModule } from '../hcm/hcm.module';

@Module({
  imports: [TypeOrmModule.forFeature([TimeOffRequest]), BalanceModule, HcmModule],
  controllers: [RequestsController],
  providers: [RequestsService],
  exports: [RequestsService],
})
export class RequestsModule {}
