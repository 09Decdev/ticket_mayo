import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';

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

  /** VÉ-EMAIL: true = được phát vé qua email. Default false khi không gửi. */
  @IsOptional()
  @IsBoolean()
  emailDistribution?: boolean;
}

/**
 * Edit screen admin (frontend /admin/ticket-types/:id/edit) — CHỈ cho sửa
 * name + quantity. Ràng buộc quantity >= sold được validate lại ở
 * content-service (service layer, không tin client) — đây chỉ là DTO shape.
 */
export class UpdateTicketTypeBasicDto {
  @IsString()
  name!: string;

  @IsInt()
  @Min(0)
  quantity!: number;
}
