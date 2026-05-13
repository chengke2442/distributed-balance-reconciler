import { Controller, Get, Param } from '@nestjs/common';
import { BalanceService } from './balance.service';
import { Balance } from './balance.entity';

@Controller('balances')
export class BalanceController {
  constructor(private readonly balanceService: BalanceService) {}

  @Get(':employeeId/:locationId')
  async getBalance(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
  ): Promise<Balance> {
    return this.balanceService.getBalanceOrFail(employeeId, locationId);
  }
}
