import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

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

  /** MAX-PER-USER: số vé tối đa mỗi người dùng nhận được (default 4 khi
   *  không gửi — mirror content createTicketType). */
  @IsOptional()
  @IsInt()
  @Min(1)
  maxTicketsPerUser?: number;

  @IsOptional()
  @IsString()
  codePrefix?: string;

  /** VÉ-EMAIL: true = được phát vé qua email. Default false khi không gửi. */
  @IsOptional()
  @IsBoolean()
  emailDistribution?: boolean;

  /**
   * VÉ-MIỄN-PHÍ-MINH-CHỨNG: true = vé miễn phí yêu cầu người dùng gửi ảnh
   * minh chứng làm nhiệm vụ vào bình luận sự kiện trước khi được phát vé.
   * Default false khi không gửi.
   */
  @IsOptional()
  @IsBoolean()
  requireProof?: boolean;

  /** Mô tả nhiệm vụ cho AI kiểm tra ảnh (bắt buộc khi bật requireProof). */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  proofTaskDescription?: string;
}

/**
 * Edit screen admin (frontend /admin/ticket-types/:id/edit) — cho sửa
 * name + quantity + maxTicketsPerUser + requireProof/proofTaskDescription.
 * Ràng buộc quantity >= sold và requireProof cần mô tả được validate lại ở
 * content-service (service layer, không tin client) — đây chỉ là DTO shape.
 */
export class UpdateTicketTypeBasicDto {
  @IsString()
  name!: string;

  @IsInt()
  @Min(0)
  quantity!: number;

  /** MAX-PER-USER: số vé tối đa mỗi người dùng nhận được — không gửi thì
   *  content giữ nguyên giá trị hiện tại. */
  @IsOptional()
  @IsInt()
  @Min(1)
  maxTicketsPerUser?: number;

  /** VÉ-MIỄN-PHÍ-MINH-CHỨNG: bật/tắt yêu cầu ảnh minh chứng. */
  @IsOptional()
  @IsBoolean()
  requireProof?: boolean;

  /** Mô tả nhiệm vụ (bắt buộc khi bật requireProof). */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  proofTaskDescription?: string;
}
