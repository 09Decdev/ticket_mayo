import { IsOptional, IsString } from 'class-validator';

export class CheckInDto {
  @IsString()
  ticketCode!: string;

  @IsOptional()
  @IsString()
  gateId?: string;
}
