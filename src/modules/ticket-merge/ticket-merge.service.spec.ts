import { HttpException, ServiceUnavailableException } from '@nestjs/common';

/**
 * Orchestration test cho TicketMergeService ("Gộp loại vé" phía admin mayo):
 * - Thứ tự apply: LOKAL repoint TRƯỚC → content merge SAU.
 * - content 4xx (chắc chắn chưa commit) → tự undo local + error enriched
 *   {localRepointRolledBack, repointAuditId}.
 * - content 5xx/timeout → PROBE merge-plan: loser mất = đã commit (giữ local,
 *   status merged-after-ambiguous-error); loser còn = chưa commit (undo local);
 *   mixed/probe-fail = KHÔNG rollback, 503 hướng dẫn thủ công.
 * - rollback: content TRƯỚC, local SAU; local fail → warning (không che
 *   kết quả rollback content).
 * Runner được jest.mock — logic repoint thật đã có spec/CLI riêng.
 */

jest.mock('../distribution/merge-repoint.runner', () => ({
  planRepoint: jest.fn(),
  applyRepoint: jest.fn(),
  rollbackRepoint: jest.fn(),
}));

import {
  applyRepoint,
  planRepoint,
  rollbackRepoint,
} from '../distribution/merge-repoint.runner';
import { TicketMergeService } from './ticket-merge.service';
import type { MergeTicketTypesDto } from './dtos/ticket-merge.dto';

const mockPlanRepoint = planRepoint as jest.MockedFunction<typeof planRepoint>;
const mockApplyRepoint = applyRepoint as jest.MockedFunction<typeof applyRepoint>;
const mockRollbackRepoint = rollbackRepoint as jest.MockedFunction<typeof rollbackRepoint>;

function makeContent() {
  return {
    getMergePlan: jest.fn(),
    mergeTicketTypes: jest.fn(),
    mergeRollback: jest.fn(),
  };
}

function makeDto(over: Partial<MergeTicketTypesDto> = {}): MergeTicketTypesDto {
  return {
    eventId: 'evt-1',
    survivorId: 'tt-a',
    loserIds: ['tt-b', 'tt-c'],
    confirm: 'MERGE',
    ...over,
  } as MergeTicketTypesDto;
}

const httpErr = (status: number, body: Record<string, unknown>) =>
  new HttpException(body, status);

describe('TicketMergeService.plan', () => {
  let content: ReturnType<typeof makeContent>;
  let svc: TicketMergeService;

  beforeEach(() => {
    jest.clearAllMocks();
    content = makeContent();
    svc = new TicketMergeService({} as any, content as any);
  });

  it('chưa chọn survivor → local=null, content plan không có loserIds', async () => {
    content.getMergePlan.mockResolvedValue({ mode: 'plan', types: [] });

    const out = await svc.plan('evt-1');

    expect(content.getMergePlan).toHaveBeenCalledWith({
      eventId: 'evt-1',
      survivorId: undefined,
      loserIds: undefined,
    });
    expect(out).toEqual({ content: { mode: 'plan', types: [] }, local: null });
    expect(mockPlanRepoint).not.toHaveBeenCalled();
  });

  it('loserIds nhận CSV string → parse + trim + dedupe, local plan dry-run', async () => {
    content.getMergePlan.mockResolvedValue({ mode: 'plan', types: [] });
    mockPlanRepoint.mockResolvedValue({ ok: true, counts: {} } as any);

    await svc.plan('evt-1', 'tt-a', 'tt-b, tt-c ,tt-b');

    expect(content.getMergePlan).toHaveBeenCalledWith({
      eventId: 'evt-1',
      survivorId: 'tt-a',
      loserIds: ['tt-b', 'tt-c'],
    });
    expect(mockPlanRepoint).toHaveBeenCalledWith(
      {},
      { survivorId: 'tt-a', loserIds: ['tt-b', 'tt-c'], includeTerminal: false, dryRun: true },
    );
  });

  it('local plan throw → fail-soft {error}, content plan vẫn trả về', async () => {
    content.getMergePlan.mockResolvedValue({ mode: 'plan', types: [] });
    mockPlanRepoint.mockRejectedValue(new Error('survivor không tồn tại ở DB lokal'));

    const out = await svc.plan('evt-1', 'tt-a', ['tt-b']);

    expect(out.local).toEqual({ error: 'survivor không tồn tại ở DB lokal' });
    expect(out.content).toEqual({ mode: 'plan', types: [] });
  });
});

describe('TicketMergeService.apply', () => {
  let content: ReturnType<typeof makeContent>;
  let svc: TicketMergeService;

  beforeEach(() => {
    jest.clearAllMocks();
    content = makeContent();
    svc = new TicketMergeService({} as any, content as any);
    mockApplyRepoint.mockResolvedValue({
      auditId: 'rp-1',
      movedPreTickets: 4,
      movedJobs: 1,
    });
  });

  it('happy: local repoint TRƯỚC (survivorName từ overrides), content SAU, trả auditId 2 bên', async () => {
    content.mergeTicketTypes.mockResolvedValue({ auditId: 'ca-1', survivor: { id: 'tt-a' } });

    const out = await svc.apply(
      makeDto({ overrides: { name: 'Vé Hợp Nhất' } as any }),
      'admin-9',
    );

    expect(mockApplyRepoint).toHaveBeenCalledWith(
      {},
      {
        survivorId: 'tt-a',
        loserIds: ['tt-b', 'tt-c'],
        survivorName: 'Vé Hợp Nhất',
        includeTerminal: false,
        dryRun: false,
      },
      expect.any(Function),
    );
    // Thứ tự: local xong mới gọi content
    expect(mockApplyRepoint.mock.invocationCallOrder[0]).toBeLessThan(
      content.mergeTicketTypes.mock.invocationCallOrder[0],
    );
    expect(content.mergeTicketTypes).toHaveBeenCalledWith({
      eventId: 'evt-1',
      survivorId: 'tt-a',
      loserIds: ['tt-b', 'tt-c'],
      overrides: { name: 'Vé Hợp Nhất' },
      actorId: 'admin-9',
    });
    expect(out).toEqual({
      status: 'merged',
      content: { auditId: 'ca-1', survivor: { id: 'tt-a' } },
      local: { repointAuditId: 'rp-1', movedPreTickets: 4, movedJobs: 1 },
    });
    expect(mockRollbackRepoint).not.toHaveBeenCalled();
  });

  it('content 409 BLOCKED → tự undo local + error giữ nguyên body + localRepointRolledBack=true', async () => {
    content.mergeTicketTypes.mockRejectedValue(
      httpErr(409, {
        message: 'chặn',
        code: 'TICKET_TYPE_MERGE_BLOCKED',
        blockers: ['tt-b: 2 PENDING'],
      }),
    );
    mockRollbackRepoint.mockResolvedValue({ movedPreTickets: 4, movedJobs: 1 });

    const err = (await svc.apply(makeDto()).catch((e) => e)) as HttpException;

    expect(err.getStatus()).toBe(409);
    const body = err.getResponse() as Record<string, unknown>;
    expect(body.code).toBe('TICKET_TYPE_MERGE_BLOCKED');
    expect(body.blockers).toEqual(['tt-b: 2 PENDING']);
    expect(body.localRepointRolledBack).toBe(true);
    expect(body.repointAuditId).toBe('rp-1');
    expect(mockRollbackRepoint).toHaveBeenCalledWith({}, 'rp-1');
  });

  it('content 4xx + undo local THẤT BẠI → localRepointRolledBack=false (admin thấy audit để manual)', async () => {
    content.mergeTicketTypes.mockRejectedValue(
      httpErr(400, { message: 'shape lỗi', code: 'TICKET_TYPE_MERGE_INVALID_INPUT' }),
    );
    mockRollbackRepoint.mockRejectedValue(new Error('db lỗi'));

    const err = (await svc.apply(makeDto()).catch((e) => e)) as HttpException;

    expect(err.getStatus()).toBe(400);
    const body = err.getResponse() as Record<string, unknown>;
    expect(body.localRepointRolledBack).toBe(false);
    expect(body.repointAuditId).toBe('rp-1');
  });

  it('content 5xx + probe: loser BIẾN MẤT → merged-after-ambiguous-error, GIỮ local', async () => {
    content.mergeTicketTypes.mockRejectedValue(httpErr(502, { message: 'timeout' }));
    content.getMergePlan.mockResolvedValue({
      types: [{ id: 'tt-a' }], // chỉ survivor còn — cả 2 loser đã mất
    });

    const out = await svc.apply(makeDto());

    expect(out.status).toBe('merged-after-ambiguous-error');
    expect(out.content).toBeNull();
    expect(out.local.repointAuditId).toBe('rp-1');
    expect(mockRollbackRepoint).not.toHaveBeenCalled();
  });

  it('content 5xx + probe: loser CÒN NGUYÊN → chưa commit → undo local + re-throw enriched', async () => {
    content.mergeTicketTypes.mockRejectedValue(httpErr(502, { message: 'down' }));
    content.getMergePlan.mockResolvedValue({
      types: [{ id: 'tt-a' }, { id: 'tt-b' }, { id: 'tt-c' }],
    });
    mockRollbackRepoint.mockResolvedValue({ movedPreTickets: 4, movedJobs: 1 });

    const err = (await svc.apply(makeDto()).catch((e) => e)) as HttpException;

    expect(err.getStatus()).toBe(502);
    expect((err.getResponse() as any).localRepointRolledBack).toBe(true);
    expect(mockRollbackRepoint).toHaveBeenCalledWith({}, 'rp-1');
  });

  it('content 5xx + probe MIXED (1 mất 1 còn) → KHÔNG rollback, 503 hướng dẫn thủ công', async () => {
    content.mergeTicketTypes.mockRejectedValue(httpErr(504, { message: 'gateway timeout' }));
    content.getMergePlan.mockResolvedValue({ types: [{ id: 'tt-a' }, { id: 'tt-b' }] });

    const err = (await svc.apply(makeDto()).catch((e) => e)) as ServiceUnavailableException;

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify(err.getResponse())).toContain('rp-1');
    expect(mockRollbackRepoint).not.toHaveBeenCalled();
  });

  it('content 5xx + probe cũng LỖI → 503, không rollback mù', async () => {
    content.mergeTicketTypes.mockRejectedValue(httpErr(500, { message: 'boom' }));
    content.getMergePlan.mockRejectedValue(new Error('content down hẳn'));

    const err = (await svc.apply(makeDto()).catch((e) => e)) as ServiceUnavailableException;

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(mockRollbackRepoint).not.toHaveBeenCalled();
  });
});

describe('TicketMergeService.rollback', () => {
  let content: ReturnType<typeof makeContent>;
  let svc: TicketMergeService;

  beforeEach(() => {
    jest.clearAllMocks();
    content = makeContent();
    svc = new TicketMergeService({} as any, content as any);
  });

  it('happy: content rollback TRƯỚC, local SAU, trả cả 2 kết quả', async () => {
    content.mergeRollback.mockResolvedValue({ rolledBack: true, auditId: 'ca-1' });
    mockRollbackRepoint.mockResolvedValue({ movedPreTickets: 4, movedJobs: 1 });

    const out = await svc.rollback(
      { contentAuditId: 'ca-1', repointAuditId: 'rp-1', confirm: 'ROLLBACK' } as any,
      'admin-9',
    );

    expect(content.mergeRollback).toHaveBeenCalledWith({ auditId: 'ca-1', actorId: 'admin-9' });
    expect(content.mergeRollback.mock.invocationCallOrder[0]).toBeLessThan(
      mockRollbackRepoint.mock.invocationCallOrder[0],
    );
    expect(out).toEqual({
      status: 'rolled_back',
      content: { rolledBack: true, auditId: 'ca-1' },
      local: { movedPreTickets: 4, movedJobs: 1 },
    });
    expect(out.warning).toBeUndefined();
  });

  it('không có repointAuditId → chỉ rollback content, local=null', async () => {
    content.mergeRollback.mockResolvedValue({ rolledBack: true });

    const out = await svc.rollback({ contentAuditId: 'ca-1', confirm: 'ROLLBACK' } as any);

    expect(mockRollbackRepoint).not.toHaveBeenCalled();
    expect(out.local).toBeNull();
  });

  it('local rollback fail → content rollback VẪN thành công + warning kèm lệnh CLI', async () => {
    content.mergeRollback.mockResolvedValue({ rolledBack: true });
    mockRollbackRepoint.mockRejectedValue(new Error('manifest mất'));

    const out = await svc.rollback(
      { contentAuditId: 'ca-1', repointAuditId: 'rp-1', confirm: 'ROLLBACK' } as any,
    );

    expect(out.status).toBe('rolled_back');
    expect(out.local).toBeNull();
    expect(out.warning).toContain('rp-1');
    expect(out.warning).toContain('npx ts-node scripts/repoint-pretickets.ts --rollback rp-1');
  });

  it('content rollback 409 (đã rollback trước đó) → pass-through, KHÔNG đụng local', async () => {
    content.mergeRollback.mockRejectedValue(
      httpErr(409, { message: 'đã rollback', code: 'TICKET_TYPE_MERGE_ROLLBACK_CONFLICT' }),
    );

    const err = (await svc
      .rollback({ contentAuditId: 'ca-1', repointAuditId: 'rp-1', confirm: 'ROLLBACK' } as any)
      .catch((e) => e)) as HttpException;

    expect(err.getStatus()).toBe(409);
    expect(mockRollbackRepoint).not.toHaveBeenCalled();
  });
});
