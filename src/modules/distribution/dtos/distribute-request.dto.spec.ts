import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { DistributeRequestDto } from './distribute-request.dto';

/**
 * MAJOR-3 (SecArch MEDIUM-1 / TM-4): DTO cap validation —
 * quantity @Max(10) + recipients @ArrayMaxSize(1000) (DESIGN Δ4).
 * Chặn admin-token bị cước tạo hàng triệu PreTicket + email storm.
 */

describe('DistributeRequestDto — validation caps (MAJOR-3, DESIGN Δ4)', () => {
  const VALID_EMAIL = 'user@example.com';

  function make(over: Partial<Record<string, unknown>>): DistributeRequestDto {
    return plainToInstance(DistributeRequestDto, {
      ticketTypeId: 'tt-1',
      recipients: [VALID_EMAIL],
      quantity: 1,
      ...over,
    });
  }

  it('baseline hợp lệ — 0 lỗi', async () => {
    const errors = await validate(make({}));
    expect(errors).toHaveLength(0);
  });

  it('recipients 1001 email → REJECT (ArrayMaxSize 1000)', async () => {
    const emails = Array.from({ length: 1001 }, (_, i) => `user${i}@example.com`);
    const errors = await validate(make({ recipients: emails }));
    expect(errors.length).toBeGreaterThan(0);
    const recipientsErr = errors.find((e) => e.property === 'recipients');
    expect(recipientsErr).toBeDefined();
    expect(Object.keys(recipientsErr?.constraints ?? {})).toContain('arrayMaxSize');
  });

  it('recipients 1000 email (đúng cap) → PASS', async () => {
    const emails = Array.from({ length: 1000 }, (_, i) => `user${i}@example.com`);
    const errors = await validate(make({ recipients: emails }));
    expect(errors).toHaveLength(0);
  });

  it('quantity 11 → REJECT (Max 10)', async () => {
    const errors = await validate(make({ quantity: 11 }));
    expect(errors.length).toBeGreaterThan(0);
    const quantityErr = errors.find((e) => e.property === 'quantity');
    expect(quantityErr).toBeDefined();
    expect(Object.keys(quantityErr?.constraints ?? {})).toContain('max');
  });

  it('quantity 10 (đúng cap) → PASS', async () => {
    const errors = await validate(make({ quantity: 10 }));
    expect(errors).toHaveLength(0);
  });

  it('quantity 0 → REJECT (Min 1 — giữ nguyên rule cũ)', async () => {
    const errors = await validate(make({ quantity: 0 }));
    expect(errors.length).toBeGreaterThan(0);
    const quantityErr = errors.find((e) => e.property === 'quantity');
    expect(Object.keys(quantityErr?.constraints ?? {})).toContain('min');
  });
});
