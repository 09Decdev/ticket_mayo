import { BadRequestException } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Min,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';

/**
 * DTO admin API TICKET-TYPE-MERGE (ticket-mayo → content internal + local repoint).
 * Strict validation: survivor KHÔNG nằm trong losers, loser không trùng,
 * confirm phải gõ đúng chuỗi 'MERGE'/'ROLLBACK' (case-sensitive) — chống
 * double-click/API script vô ý gộp vé đang có người mua.
 */

@ValidatorConstraint({ name: 'survivorNotInLosers', async: false })
class SurvivorNotInLosersConstraint implements ValidatorConstraintInterface {
  validate(survivorId: string, args: ValidationArguments): boolean {
    const dto = args.object as { survivorId?: string; loserIds?: string[] };
    if (!Array.isArray(dto.loserIds)) return true; // loserIds lỗi — báo ở rule khác
    return !dto.loserIds.some((l) => typeof l === 'string' && l.trim() === String(survivorId).trim());
  }
  defaultMessage(): string {
    return 'survivorId không được nằm trong loserIds (loại vé đích không thể bị gộp).';
  }
}

@ValidatorConstraint({ name: 'noDuplicateLosers', async: false })
class NoDuplicateLosersConstraint implements ValidatorConstraintInterface {
  validate(loserIds: string[]): boolean {
    if (!Array.isArray(loserIds)) return true;
    const norm = loserIds.map((l) => String(l).trim());
    return new Set(norm).size === norm.length;
  }
  defaultMessage(): string {
    return 'loserIds không được chứa id trùng nhau.';
  }
}

export class MergeTicketTypeOverridesDto {
  @ApiProperty({ required: false, description: 'Tên mới cho survivor sau merge', example: 'VVIP Pass' })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @ApiProperty({ required: false, description: 'Giá mới (chỉ áp dụng vé phát sau merge)', example: 150000 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @ApiProperty({
    required: false,
    description: 'Tổng số lượng survivor (mặc định = survivor + Σ losers; phải >= sold cộng dồn)',
    example: 500,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  quantity?: number;

  @ApiProperty({ required: false, description: 'Hạn mức vé mỗi user trên survivor', example: 2 })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxTicketsPerUser?: number;

  @ApiProperty({ required: false, description: 'Bật/tắt phát vé qua email trên survivor', example: true })
  @IsOptional()
  @IsBoolean()
  emailDistribution?: boolean;
}

export class MergeTicketTypesDto {
  @ApiProperty({ description: 'Event chứa các loại vé cần gộp', example: 'evt-uuid' })
  @IsString()
  @Length(1, 64)
  eventId!: string;

  @ApiProperty({ description: 'Loại vé ĐÍCH (giữ lại, nhận cộng dồn)', example: 'tt-survivor' })
  @IsString()
  @Length(1, 64)
  @Validate(SurvivorNotInLosersConstraint)
  survivorId!: string;

  @ApiProperty({ description: 'Các loại vé bị gộp (sẽ xóa sau re-point)', type: [String], example: ['tt-a', 'tt-b'] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Validate(NoDuplicateLosersConstraint)
  loserIds!: string[];

  @ApiProperty({ required: false, type: MergeTicketTypeOverridesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => MergeTicketTypeOverridesDto)
  overrides?: MergeTicketTypeOverridesDto;

  @ApiProperty({
    required: false,
    default: false,
    description:
      'Re-point CẢ PreTicket lịch sử (MINTED/LINKED/CLAIMED/EXPIRED) + job COMPLETED/FAILED ở DB mayo — mặc định chỉ row sống.',
  })
  @IsOptional()
  @IsBoolean()
  includeTerminal?: boolean;

  @ApiProperty({ description: "Chuỗi xác nhận — phải gõ đúng 'MERGE'", example: 'MERGE' })
  @IsString()
  @IsIn(['MERGE'])
  confirm!: 'MERGE';
}

export class MergeRollbackDto {
  @ApiProperty({
    description: 'auditId nội dung (AuditLog TICKET_TYPE_MERGE của content-service)',
    example: 'audit-uuid',
  })
  @IsString()
  @Length(1, 64)
  contentAuditId!: string;

  @ApiProperty({
    required: false,
    description:
      'auditId repoint lokal mayo (DistributionAudit MERGE_REPOINT trả về lúc apply) — có thì rollback luôn PreTicket/job local',
    example: 'repoint-audit-uuid',
  })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  repointAuditId?: string;

  @ApiProperty({ description: "Chuỗi xác nhận — phải gõ đúng 'ROLLBACK'", example: 'ROLLBACK' })
  @IsString()
  @IsIn(['ROLLBACK'])
  confirm!: 'ROLLBACK';
}

/** Guard thừa: nếu ValidationPipe bị tắt ở đâu đó, service vẫn chặn confirm sai. */
export function assertConfirm(value: string | undefined, expected: 'MERGE' | 'ROLLBACK'): void {
  if (value !== expected) {
    throw new BadRequestException(`Thiếu xác nhận: phải gửi confirm="${expected}".`);
  }
}
