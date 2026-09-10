import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class DistributeRequestDto {
  @IsString()
  ticketTypeId!: string;

  /**
   * Tickets per recipient email. Mỗi vé = 1 PreTicket + 1 claim link riêng
   * → quantity vé thì gửi quantity email. DESIGN Δ4: cap 10 — chặn admin
   * token bị cước tạo hàng triệu PreTicket + email storm.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  quantity?: number;

  /**
   * DESIGN Δ4: cap 1000 recipients (khớp content mint DTO max). Chặn lệnh
   * POST khổng lồ tạo hàng triệu PreTicket (DoS + email storm).
   */
  @IsArray()
  @ArrayMaxSize(1000)
  @IsEmail({}, { each: true })
  recipients!: string[];

  @IsOptional()
  @IsString()
  idempotencyKey?: string;

  /** Link cập nhật của BTC (page/group/website của sự kiện) — hiển thị trong
   * email vé. Bỏ trống → email fallback env BTC_UPDATE_URL. */
  @IsOptional()
  @Matches(/^(https?:\/\/.{1,490})?$/i, { message: 'btcUrl must start with http:// or https://' })
  btcUrl?: string;
}
