import { IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateTicketTypeDto {
  @IsString()
  eventId!: string;

  @IsString()
  name!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @IsInt()
  @Min(0)
  quota!: number;

  @IsOptional()
  @IsString()
  codePrefix?: string;
}
