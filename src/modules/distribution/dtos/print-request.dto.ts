import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * VÉ CỨNG (physical tickets để in): admin chọn loại vé + số lượng → mint N vé
 * không người nhận → render PDF mỗi vé (PII trống) → lưu bucket → zip tải
 * gửi đối tác in. KHÔNG có recipients/email — không gửi email gì cả.
 */
export class PrintRequestDto {
  @IsString()
  ticketTypeId!: string;

  /**
   * Cap 5000 — yêu cầu briefing cho phép "vài nghìn"; lớn hơn admin nên tách
   * nhiều job (mỗi job mint đồng bộ trong 1 request HTTP, vài nghìn là đủ ranh
   * an toàn về thời gian + bộ nhớ PDF trước khi zip).
   */
  @IsInt()
  @Min(1)
  @Max(5000)
  quantity!: number;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}
