import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { IsNumber, IsPositive, IsString, Min } from 'class-validator';
import { RequestsService } from './requests.service';
import { TimeOffRequest } from './time-off-request.entity';

class CreateRequestDto {
  @IsString()
  employeeId: string;

  @IsString()
  locationId: string;

  @IsNumber()
  @IsPositive()
  @Min(0.5)
  daysRequested: number;
}

@Controller('requests')
export class RequestsController {
  constructor(private readonly requestsService: RequestsService) {}

  @Post()
  async createRequest(@Body() dto: CreateRequestDto): Promise<TimeOffRequest> {
    return this.requestsService.createRequest(dto.employeeId, dto.locationId, dto.daysRequested);
  }

  @Get(':id')
  async getRequest(@Param('id') id: string): Promise<TimeOffRequest> {
    return this.requestsService.getRequest(id);
  }

  @Get('employee/:employeeId')
  async getByEmployee(@Param('employeeId') employeeId: string): Promise<TimeOffRequest[]> {
    return this.requestsService.getRequestsByEmployee(employeeId);
  }
}
