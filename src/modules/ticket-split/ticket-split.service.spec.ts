import { HttpException, ServiceUnavailableException } from '@nestjs/common';

/**
 * Orchestration test cho TicketSplitService ("Điều chuyển vé" phía admin mayo):
 * - Thứ tự apply: split-plan (lấy movedIds từ movePreview) → LOKAL subset
 *   repoint TRƯỚC → content split SAU.
 * - Truncated preview (moveCount > cap 500) → REFUSE 409 riêng (movedIds thiếu).
 * - content 4xx (chưa commit) → tự undo local + error enriched
 *   {localRepointRolledBack, repointAuditId}.
 * - content 5xx/timeout → PROBE split-plan lại: source.sold === projection
 *   .sourceAfter.sold của plan TRƯỚC apply = đã commit (giữ local, status
 *   split-after-ambiguous-error); khác = chưa commit (undo local); probe
 *   fail = KHÔNG rollback, 503 hướng dẫn thủ công.
 * - rollback: content TRƯỚC, local SAU; local fail → warning (không che
 *   kết quả rollback content).
 * Helper repoint được jest.mock — logic repoint thật nằm ở spec riêng/CLI.
 */

jest.mock('./split-repoint.helper', () => ({
  planSplitRepoint: jest.fn(),
  applySplitRepoint: jest.fn(),
  rollbackSplitRepoint: jest.fn(),
}));

import {
  applySplitRepoint,
  planSplitRepoint,
  rollbackSplitRepoint,
} from './split-repoint.helper';
import { TicketSplitService } from './ticket-split.service';
import type { SplitTicketTypesDto } from './dtos/ticket-split.dto';

const mockPlanSplitRepoint = planSplitRepoint as jest.MockedFunction<
  typeof planSplitRepoint
>;
const mockApplySplitRepoint = applySplitRepoint as jest.MockedFunction<
  typeof applySplitRepoint
>;
const mockRollbackSplitRepoint = rollbackSplitRepoint as jest.MockedFunction<
  typeof rollbackSplitRepoint
>;

function makeContent() {
  return {
    getSplitPlan: jest.fn(),
    splitTicketTypes: jest.fn(),
    splitRollback: jest.fn(),
  };
}

function makeDto(over: Partial<SplitTicketTypesDto> = {}): SplitTicketTypesDto {
  return {
    eventId: 'evt-1',
    sourceId: 'tt-src',
    targetId: 'tt-tgt',
    keepCount: 100,
    confirm: 'SPLIT',
    ...over,
  } as SplitTicketTypesDto;
}

/** Shape split-plan tối giản đủ cho apply: movePreview 2 vé + projection
 * (moveCount LUÔN = movePreview.length khi chưa truncated — invariant của
 * content-service: preview cap 500, truncated flag bật khi cắt). */
function makePlan(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    shapeErrors: [],
    blockers: [],
    warnings: [],
    eligibleCount: 102,
    moveCount: 2,
    movePreview: [
      { ticketId: 'ct-189', ticketCode: 'FREE-0189', userId: 'u-189', createdAt: '2026-09-18T01:00:00Z', status: 'VALID' },
      { ticketId: 'ct-188', ticketCode: 'FREE-0188', userId: 'u-188', createdAt: '2026-09-17T23:00:00Z', status: 'VALID' },
    ],
    movePreviewTruncated: false,
    projection: {
      sourceAfter: { quantity: 100, sold: 100, remaining: 0 },
      targetAfter: { quantity: 500, sold: 189, remaining: 311 },
      maxParticipantsAfter: 600,
    },
    source: { id: 'tt-src', name: 'Vé Miễn Phí', price: '0', quantity: 500, sold: 289, remaining: 211 },
    target: { id: 'tt-tgt', name: 'Vé Chuyển', price: '0', quantity: 500, sold: 0, remaining: 500 },
    event: { maxParticipantsBefore: 600 },
    generatedAt: '2026-09-18T02:00:00Z',
    ...over,
  };
}

const httpErr = (status: number, body: Record<string, unknown>) =>
  new HttpException(body, status);

describe('TicketSplitService.plan', () => {
  let content: ReturnType<typeof makeContent>;
  let svc: TicketSplitService;

  beforeEach(() => {
    jest.clearAllMocks();
    content = makeContent();
    svc = new TicketSplitService({} as any, content as any);
  });

  it('movePreview có vé → local dry-run với đúng movedIds (mới nhất trước)', async () => {
    content.getSplitPlan.mockResolvedValue(makePlan());
    mockPlanSplitRepoint.mockResolvedValue({ affectedPreTickets: 3, byStatus: { MINTED: 2, LINKED: 1 } });

    const out = await svc.plan('evt-1', 'tt-src', 'tt-tgt', 100);

    expect(content.getSplitPlan).toHaveBeenCalledWith({
      eventId: 'evt-1',
      sourceId: 'tt-src',
      targetId: 'tt-tgt',
      keepCount: 100,
    });
    expect(mockPlanSplitRepoint).toHaveBeenCalledWith({}, ['ct-189', 'ct-188']);
    expect(out.local).toEqual({ affectedPreTickets: 3, byStatus: { MINTED: 2, LINKED: 1 } });
    expect(out.content.moveCount).toBe(2);
  });

  it('0 PreTicket trong tập chuyển → local kèm note no-op', async () => {
    content.getSplitPlan.mockResolvedValue(makePlan());
    mockPlanSplitRepoint.mockResolvedValue({ affectedPreTickets: 0, byStatus: {} });

    const out = await svc.plan('evt-1', 'tt-src', 'tt-tgt', 100);

    expect(out.local).toEqual({
      affectedPreTickets: 0,
      byStatus: {},
      note: 'Không có PreTicket nào trong tập chuyển — bước local no-op.',
    });
  });

  it('movePreview rỗng → local=null, không gọi planSplitRepoint', async () => {
    content.getSplitPlan.mockResolvedValue(makePlan({ moveCount: 0, movePreview: [], eligibleCount: 0 }));

    const out = await svc.plan('evt-1', 'tt-src', 'tt-tgt', 500);

    expect(out.local).toBeNull();
    expect(mockPlanSplitRepoint).not.toHaveBeenCalled();
  });

  it('local plan throw → fail-soft {error}, content plan vẫn trả về', async () => {
    content.getSplitPlan.mockResolvedValue(makePlan());
    mockPlanSplitRepoint.mockRejectedValue(new Error('DB lokal lỗi'));

    const out = await svc.plan('evt-1', 'tt-src', 'tt-tgt', 100);

    expect(out.local).toEqual({ error: 'DB lokal lỗi' });
    expect(out.content.ok).toBe(true);
  });
});

describe('TicketSplitService.apply', () => {
  let content: ReturnType<typeof makeContent>;
  let svc: TicketSplitService;

  beforeEach(() => {
    jest.clearAllMocks();
    content = makeContent();
    svc = new TicketSplitService({} as any, content as any);
    content.getSplitPlan.mockResolvedValue(makePlan());
    mockApplySplitRepoint.mockResolvedValue({ auditId: 'rp-1', movedPreTickets: 2 });
  });

  it('happy: plan → local subset repoint TRƯỚC (targetName từ plan.target), content SAU', async () => {
    content.splitTicketTypes.mockResolvedValue({ auditId: 'ca-1', moved: { tickets: 189, seats: 0 } });

    const out = await svc.apply(makeDto(), 'admin-9');

    expect(mockApplySplitRepoint).toHaveBeenCalledWith(
      {},
      {
        sourceId: 'tt-src',
        targetId: 'tt-tgt',
        targetName: 'Vé Chuyển',
        movedIds: ['ct-189', 'ct-188'],
      },
      expect.any(Function),
    );
    // Thứ tự: local xong mới gọi content
    expect(mockApplySplitRepoint.mock.invocationCallOrder[0]).toBeLessThan(
      content.splitTicketTypes.mock.invocationCallOrder[0],
    );
    expect(content.splitTicketTypes).toHaveBeenCalledWith({
      eventId: 'evt-1',
      sourceId: 'tt-src',
      targetId: 'tt-tgt',
      keepCount: 100,
      sourceQuantity: undefined,
      targetQuantity: undefined,
      actorId: 'admin-9',
    });
    expect(out).toEqual({
      status: 'split',
      content: { auditId: 'ca-1', moved: { tickets: 189, seats: 0 } },
      local: { repointAuditId: 'rp-1', movedPreTickets: 2, movedIdsCount: 2 },
      // Đối chiếu sau chuyển: full vé đã bốc (từ movePreview của plan)
      moved: [
        { ticketId: 'ct-189', ticketCode: 'FREE-0189', userId: 'u-189', status: 'VALID', createdAt: '2026-09-18T01:00:00Z' },
        { ticketId: 'ct-188', ticketCode: 'FREE-0188', userId: 'u-188', status: 'VALID', createdAt: '2026-09-17T23:00:00Z' },
      ],
    });
    expect(mockRollbackSplitRepoint).not.toHaveBeenCalled();
  });

  it('confirm sai → 400 trước khi gọi content', async () => {
    const err = (await svc.apply(makeDto({ confirm: 'MERGE' as any })).catch((e) => e)) as HttpException;
    expect(err.getStatus()).toBe(400);
    expect(content.splitTicketTypes).not.toHaveBeenCalled();
    expect(mockApplySplitRepoint).not.toHaveBeenCalled();
  });

  it('plan có blockers → 409 TICKET_TYPE_SPLIT_BLOCKED, KHÔNG repoint, KHÔNG split', async () => {
    content.getSplitPlan.mockResolvedValue(
      makePlan({ ok: false, blockers: ['tt-tgt: 2 PENDING reservation'] }),
    );

    const err = (await svc.apply(makeDto()).catch((e) => e)) as HttpException;

    expect(err.getStatus()).toBe(409);
    const body = err.getResponse() as Record<string, unknown>;
    expect(body.code).toBe('TICKET_TYPE_SPLIT_BLOCKED');
    expect(body.blockers).toEqual(['tt-tgt: 2 PENDING reservation']);
    expect(mockApplySplitRepoint).not.toHaveBeenCalled();
    expect(content.splitTicketTypes).not.toHaveBeenCalled();
  });

  it('movePreview truncated → 409 riêng, KHÔNG repoint (movedIds thiếu)', async () => {
    // An toàn còn lại: apply đã tự chia đợt ≤500 — chỉ trigger được khi
    // MỌI plan (kể cả plan từng đợt) vẫn truncated (eligible drift bất thường).
    content.getSplitPlan.mockResolvedValue(makePlan({ moveCount: 700, movePreviewTruncated: true }));

    const err = (await svc.apply(makeDto()).catch((e) => e)) as HttpException;

    expect(err.getStatus()).toBe(409);
    const body = err.getResponse() as Record<string, unknown>;
    expect(body.code).toBe('TICKET_TYPE_SPLIT_PREVIEW_TRUNCATED');
    expect(mockApplySplitRepoint).not.toHaveBeenCalled();
    expect(content.splitTicketTypes).not.toHaveBeenCalled();
  });

  // ─── D16: batch ≤500/đợt ───
  const ids = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ ticketId: `ct-${i}`, ticketCode: `C${i}` }));
  const snap = (over: Record<string, unknown>) => ({
    id: 'tt',
    name: 'T',
    price: '0',
    quantity: 100,
    sold: 100,
    remaining: 0,
    ...over,
  });

  it('batch: moveCount 702 → 2 đợt (500 + 202), mỗi đợt plan+split riêng, đủ audit', async () => {
    let keep100Calls = 0;
    content.getSplitPlan.mockImplementation(async ({ keepCount, sourceQuantity }: any) => {
      if (keepCount === 100 && sourceQuantity === undefined) {
        keep100Calls++;
        return keep100Calls === 1
          ? makePlan({
              eligibleCount: 802,
              moveCount: 702,
              movePreview: ids(500),
              movePreviewTruncated: true,
              source: snap({ id: 'tt-src', quantity: 902, sold: 802 }),
              target: snap({ id: 'tt-tgt', quantity: 700, sold: 0 }),
            })
          : makePlan({
              eligibleCount: 302,
              moveCount: 202,
              movePreview: ids(202),
              source: snap({ id: 'tt-src', quantity: 402, sold: 302 }),
              target: snap({ id: 'tt-tgt', quantity: 1200, sold: 500 }),
            });
      }
      if (keepCount === 302) {
        return makePlan({
          eligibleCount: 802,
          moveCount: 500,
          movePreview: ids(500),
          source: snap({ id: 'tt-src', quantity: 902, sold: 802 }),
          target: snap({ id: 'tt-tgt', quantity: 700, sold: 0 }),
        });
      }
      throw new Error(`unexpected plan keep=${keepCount} srcQ=${sourceQuantity}`);
    });
    content.splitTicketTypes
      .mockResolvedValueOnce({ auditId: 'ca-1', moved: { tickets: 500, seats: 0 } })
      .mockResolvedValueOnce({ auditId: 'ca-2', moved: { tickets: 202, seats: 0 } });

    const out: any = await svc.apply(makeDto(), 'admin-9');

    // Đợt giữa: "dịch chỗ theo vé" (902−500=402 / 700+500=1200). Đợt cuối:
    // keep = dto 100, không override → quantity undefined (mặc định backend như CLI cũ).
    expect(content.splitTicketTypes).toHaveBeenNthCalledWith(1, {
      eventId: 'evt-1',
      sourceId: 'tt-src',
      targetId: 'tt-tgt',
      keepCount: 302,
      sourceQuantity: 402,
      targetQuantity: 1200,
      actorId: 'admin-9',
    });
    expect(content.splitTicketTypes).toHaveBeenNthCalledWith(2, {
      eventId: 'evt-1',
      sourceId: 'tt-src',
      targetId: 'tt-tgt',
      keepCount: 100,
      sourceQuantity: undefined,
      targetQuantity: undefined,
      actorId: 'admin-9',
    });
    expect(out.status).toBe('split-batched');
    expect(out.totalMoved).toBe(702);
    expect(out.moved).toHaveLength(702); // 500 (đợt 1) + 202 (đợt cuối) — không bị cắt 500
    expect(out.moved[0].ticketId).toBe('ct-0');
    expect(out.contentAuditIds).toEqual(['ca-1', 'ca-2']);
    expect(out.rounds).toHaveLength(2);
    expect(out.rounds[1].keepCount).toBe(100);
    expect(mockApplySplitRepoint).toHaveBeenCalledTimes(2);
  });

  it('batch + quantity override: đợt giữa shift, ĐỢT CUỐI dùng số tuyệt đối DTO', async () => {
    let keepFinal = 0;
    content.getSplitPlan.mockImplementation(async ({ keepCount }: any) => {
      if (keepCount === 100) {
        keepFinal++;
        return keepFinal === 1
          ? makePlan({
              eligibleCount: 600,
              moveCount: 550,
              movePreview: ids(500),
              movePreviewTruncated: true,
              source: snap({ id: 'tt-src', quantity: 700, sold: 600 }),
              target: snap({ id: 'tt-tgt', quantity: 650, sold: 100 }),
            })
          : makePlan({
              eligibleCount: 100,
              moveCount: 50,
              movePreview: ids(50),
              source: snap({ id: 'tt-src', quantity: 200, sold: 100 }),
              target: snap({ id: 'tt-tgt', quantity: 1150, sold: 600 }),
            });
      }
      return makePlan({
        eligibleCount: 600,
        moveCount: 500,
        movePreview: ids(500),
        source: snap({ id: 'tt-src', quantity: 700, sold: 600 }),
        target: snap({ id: 'tt-tgt', quantity: 650, sold: 100 }),
      });
    });
    content.splitTicketTypes
      .mockResolvedValueOnce({ auditId: 'ca-1', moved: { tickets: 500, seats: 0 } })
      .mockResolvedValueOnce({ auditId: 'ca-2', moved: { tickets: 50, seats: 0 } });

    await svc.apply(makeDto({ sourceQuantity: 200, targetQuantity: 1200 }));

    expect(content.splitTicketTypes).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ keepCount: 150, sourceQuantity: 200, targetQuantity: 1150 }),
    ); // giữa đợt: keepNow=100+550−500=150; qty shift 700−500=200 / 650+500=1150
    expect(content.splitTicketTypes).toHaveBeenNthCalledWith(2, {
      eventId: 'evt-1',
      sourceId: 'tt-src',
      targetId: 'tt-tgt',
      keepCount: 100,
      sourceQuantity: 200,
      targetQuantity: 1200,
      actorId: undefined,
    });
  });

  it('batch: đợt 2 lỗi 4xx → undo local đợt 2 + error kèm completedRounds (đợt 1 đã commit)', async () => {
    // dto.keepCount=500, eligible 1200 → moveCount 700 → 2 đợt (500 + 200).
    let measure500 = 0;
    content.getSplitPlan.mockImplementation(async ({ keepCount }: any) => {
      if (keepCount === 700) {
        // preview riêng cho đợt 1 (keepNow = 500 + 700 − 500)
        return makePlan({
          eligibleCount: 1200,
          moveCount: 500,
          movePreview: ids(500),
          source: snap({ id: 'tt-src', quantity: 1200, sold: 1200 }),
          target: snap({ id: 'tt-tgt', quantity: 600, sold: 0 }),
        });
      }
      // measure() luôn gọi với keepCount = dto 500
      measure500++;
      return measure500 === 1
        ? makePlan({
            eligibleCount: 1200,
            moveCount: 700,
            movePreview: ids(500),
            movePreviewTruncated: true,
            source: snap({ id: 'tt-src', quantity: 1200, sold: 1200 }),
            target: snap({ id: 'tt-tgt', quantity: 600, sold: 0 }),
          })
        : makePlan({
            eligibleCount: 700,
            moveCount: 200,
            movePreview: ids(200),
            source: snap({ id: 'tt-src', quantity: 700, sold: 700 }),
            target: snap({ id: 'tt-tgt', quantity: 1100, sold: 500 }),
          });
    });
    content.splitTicketTypes
      .mockResolvedValueOnce({ auditId: 'ca-ok', moved: { tickets: 500, seats: 0 } })
      .mockRejectedValueOnce(httpErr(400, { message: 'blocker giữa đợt', code: 'X' }));
    mockRollbackSplitRepoint.mockResolvedValue({ movedPreTickets: 200 });

    const err = (await svc.apply(makeDto({ keepCount: 500 })).catch((e) => e)) as HttpException;

    expect(err.getStatus()).toBe(400);
    const body = err.getResponse() as any;
    // Đợt 1 commit xong (audit ca-ok); đợt 2 fail → local đợt 2 undone.
    expect(body.completedRounds).toEqual([
      {
        round: 1,
        keepCount: 700,
        movedTickets: 500,
        contentAuditId: 'ca-ok',
        repointAuditId: 'rp-1',
      },
    ]);
    expect(body.localRepointRolledBack).toBe(true);
    expect(mockApplySplitRepoint).toHaveBeenCalledTimes(2); // mỗi đợt repoint 1 lần
    expect(mockRollbackSplitRepoint).toHaveBeenCalledTimes(1); // chỉ undo local đợt kẹt
  });

  it('content 409 → tự undo local + error giữ nguyên body + localRepointRolledBack=true', async () => {
    content.splitTicketTypes.mockRejectedValue(
      httpErr(409, { message: 'chặn', code: 'TICKET_TYPE_SPLIT_BLOCKED', blockers: ['x'] }),
    );
    mockRollbackSplitRepoint.mockResolvedValue({ movedPreTickets: 2 });

    const err = (await svc.apply(makeDto()).catch((e) => e)) as HttpException;

    expect(err.getStatus()).toBe(409);
    const body = err.getResponse() as Record<string, unknown>;
    expect(body.code).toBe('TICKET_TYPE_SPLIT_BLOCKED');
    expect(body.localRepointRolledBack).toBe(true);
    expect(body.repointAuditId).toBe('rp-1');
    expect(mockRollbackSplitRepoint).toHaveBeenCalledWith({}, 'rp-1');
  });

  it('content 4xx + undo local THẤT BẠI → localRepointRolledBack=false (admin thấy audit để manual)', async () => {
    content.splitTicketTypes.mockRejectedValue(
      httpErr(400, { message: 'shape lỗi', code: 'TICKET_TYPE_SPLIT_INVALID_INPUT' }),
    );
    mockRollbackSplitRepoint.mockRejectedValue(new Error('db lỗi'));

    const err = (await svc.apply(makeDto()).catch((e) => e)) as HttpException;

    expect(err.getStatus()).toBe(400);
    const body = err.getResponse() as Record<string, unknown>;
    expect(body.localRepointRolledBack).toBe(false);
    expect(body.repointAuditId).toBe('rp-1');
  });

  it('content 5xx + probe: source.sold === projection.sourceAfter.sold → ĐÃ COMMIT, GIỮ local', async () => {
    content.splitTicketTypes.mockRejectedValue(httpErr(502, { message: 'timeout' }));
    // Plan sau apply: source.sold đã về 100 (đúng projection trước apply).
    content.getSplitPlan
      .mockResolvedValueOnce(makePlan())
      .mockResolvedValueOnce(makePlan({ source: { id: 'tt-src', name: 'Vé Miễn Phí', price: '0', quantity: 100, sold: 100, remaining: 0 } }));

    const out = await svc.apply(makeDto());

    expect(out.status).toBe('split-after-ambiguous-error');
    expect(out.content).toBeNull();
    expect((out as any).local.repointAuditId).toBe('rp-1');
    expect(mockRollbackSplitRepoint).not.toHaveBeenCalled();
  });

  it('content 5xx + probe: source.sold KHÔNG khớp → chưa commit → undo local + re-throw enriched', async () => {
    content.splitTicketTypes.mockRejectedValue(httpErr(502, { message: 'down' }));
    // Plan sau lỗi: source.sold vẫn 289 (khác projection.sourceAfter.sold=100) → chưa commit.
    content.getSplitPlan
      .mockResolvedValueOnce(makePlan())
      .mockResolvedValueOnce(
        makePlan({
          source: { id: 'tt-src', name: 'Vé Miễn Phí', price: '0', quantity: 500, sold: 289, remaining: 211 },
        }),
      );
    mockRollbackSplitRepoint.mockResolvedValue({ movedPreTickets: 2 });

    const err = (await svc.apply(makeDto()).catch((e) => e)) as HttpException;

    expect(err.getStatus()).toBe(502);
    expect((err.getResponse() as any).localRepointRolledBack).toBe(true);
    expect(mockRollbackSplitRepoint).toHaveBeenCalledWith({}, 'rp-1');
  });

  it('content 5xx + probe cũng LỖI → 503, KHÔNG rollback mù', async () => {
    // Lần 1 (apply) trả plan OK; lần 2 (probe) throw.
    content.getSplitPlan
      .mockResolvedValueOnce(makePlan())
      .mockRejectedValueOnce(new Error('content down hẳn'));
    content.splitTicketTypes.mockRejectedValue(httpErr(500, { message: 'boom' }));

    const err = (await svc.apply(makeDto()).catch((e) => e)) as ServiceUnavailableException;

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify(err.getResponse())).toContain('rp-1');
    expect(mockRollbackSplitRepoint).not.toHaveBeenCalled();
  });

  it('plan thiếu projection.sourceAfter.sold → probe không chạy được → 503 (không rollback mù)', async () => {
    content.getSplitPlan.mockResolvedValue(
      makePlan({ projection: null, source: { id: 'tt-src', name: 'Vé Miễn Phí', price: '0', quantity: 500, sold: 289, remaining: 211 } }),
    );
    content.splitTicketTypes.mockRejectedValue(httpErr(503, { message: 'unavailable' }));

    const err = (await svc.apply(makeDto()).catch((e) => e)) as ServiceUnavailableException;

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(mockRollbackSplitRepoint).not.toHaveBeenCalled();
  });
});

describe('TicketSplitService.rollback', () => {
  let content: ReturnType<typeof makeContent>;
  let svc: TicketSplitService;

  beforeEach(() => {
    jest.clearAllMocks();
    content = makeContent();
    svc = new TicketSplitService({} as any, content as any);
  });

  it('happy: content rollback TRƯỚC, local SAU, trả cả 2 kết quả', async () => {
    content.splitRollback.mockResolvedValue({ rolledBack: true, auditId: 'ca-1', restored: { tickets: 189, seats: 0 } });
    mockRollbackSplitRepoint.mockResolvedValue({ movedPreTickets: 2 });

    const out = await svc.rollback(
      { contentAuditId: 'ca-1', repointAuditId: 'rp-1', confirm: 'ROLLBACK' } as any,
      'admin-9',
    );

    expect(content.splitRollback).toHaveBeenCalledWith({ auditId: 'ca-1', actorId: 'admin-9' });
    expect(content.splitRollback.mock.invocationCallOrder[0]).toBeLessThan(
      mockRollbackSplitRepoint.mock.invocationCallOrder[0],
    );
    expect(out).toEqual({
      status: 'rolled_back',
      content: { rolledBack: true, auditId: 'ca-1', restored: { tickets: 189, seats: 0 } },
      local: { movedPreTickets: 2 },
    });
    expect(out.warning).toBeUndefined();
  });

  it('không có repointAuditId → chỉ rollback content, local=null', async () => {
    content.splitRollback.mockResolvedValue({ rolledBack: true });

    const out = await svc.rollback({ contentAuditId: 'ca-1', confirm: 'ROLLBACK' } as any);

    expect(mockRollbackSplitRepoint).not.toHaveBeenCalled();
    expect(out.local).toBeNull();
  });

  it('local rollback fail → content rollback VẪN thành công + warning kèm audit cần xử lý', async () => {
    content.splitRollback.mockResolvedValue({ rolledBack: true });
    mockRollbackSplitRepoint.mockRejectedValue(new Error('manifest mất'));

    const out = await svc.rollback(
      { contentAuditId: 'ca-1', repointAuditId: 'rp-1', confirm: 'ROLLBACK' } as any,
    );

    expect(out.status).toBe('rolled_back');
    expect(out.local).toBeNull();
    expect(out.warning).toContain('rp-1');
    expect(out.warning).toContain('SPLIT_REPOINT');
  });

  it('content rollback lỗi → pass-through, KHÔNG đụng local', async () => {
    content.splitRollback.mockRejectedValue(
      httpErr(409, { message: 'đã rollback', code: 'TICKET_TYPE_SPLIT_ROLLBACK_CONFLICT' }),
    );

    const err = (await svc
      .rollback({ contentAuditId: 'ca-1', repointAuditId: 'rp-1', confirm: 'ROLLBACK' } as any)
      .catch((e) => e)) as HttpException;

    expect(err.getStatus()).toBe(409);
    expect(mockRollbackSplitRepoint).not.toHaveBeenCalled();
  });
});
