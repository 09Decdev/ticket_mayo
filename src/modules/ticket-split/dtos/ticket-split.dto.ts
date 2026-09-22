import { ApiProperty } from '@nestjs/swagger';
import { BadRequestException } from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

/**
 * DTO admin API TICKET-TYPE-SPLIT (ticket-mayo → content internal + local
 * subset repoint). Strict validation: keepCount >= 0, confirm phải gõ đúng
 * chuỗi 'SPLIT'/'ROLLBACK' (case-sensitive) — chống double-click/API script
 * vô ý điều chuyển vé đang có người mua. source != target validate ở
 * content-service (shape error 400).
 */

export class SplitTicketTypesDto {
  @ApiProperty({ description: 'Event chứa 2 loại vé', example: 'evt-uuid' })
  @IsString()
  @Length(1, 64)
  eventId!: string;

  @ApiProperty({ description: 'Loại vé NGUỒN (giữ lại keepCount vé cũ nhất)', example: 'tt-source' })
  @IsString()
  @Length(1, 64)
  sourceId!: string;

  @ApiProperty({ description: 'Loại vé ĐÍCH nhận moveCount vé mới nhất', example: 'tt-target' })
  @IsString()
  @Length(1, 64)
  targetId!: string;

  @ApiProperty({ description: 'Số vé CŨ NHẤT giữ lại ở source', example: 100 })
  @IsInt()
  @Min(0)
  keepCount!: number;

  @ApiProperty({
    required: false,
    description: 'Đặt lại quantity source (mặc định = keepCount; phải >= sold sau chuyển)',
    example: 100,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  sourceQuantity?: number;

  @ApiProperty({
    required: false,
    description: 'Đặt lại quantity target (mặc định giữ nguyên; phải chứa sold sau chuyển)',
    example: 500,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  targetQuantity?: number;

  @ApiProperty({ description: "Chuỗi xác nhận — phải gõ đúng 'SPLIT'", example: 'SPLIT' })
  @IsString()
  @IsIn(['SPLIT'])
  confirm!: 'SPLIT';
}

export class SplitRollbackDto {
  @ApiProperty({
    description: 'auditId nội dung (AuditLog TICKET_TYPE_SPLIT của content-service)',
    example: 'audit-uuid',
  })
  @IsString()
  @Length(1, 64)
  contentAuditId!: string;

  @ApiProperty({
    required: false,
    description:
      'auditId repoint lokal mayo (DistributionAudit SPLIT_REPOINT trả về lúc apply) — có thì rollback luôn PreTicket local',
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
export function assertConfirm(value: string | undefined, expected: 'SPLIT' | 'ROLLBACK'): void {
  if (value !== expected) {
    throw new BadRequestException(`Thiếu xác nhận: phải gửi confirm="${expected}".`);
  }
}
