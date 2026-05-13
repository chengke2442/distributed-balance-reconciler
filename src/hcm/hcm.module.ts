import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HcmService } from './hcm.service';

@Module({
  imports: [ConfigModule],
  providers: [HcmService],
  exports: [HcmService],
})
export class HcmModule {}
