import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ContentClientService } from '../content-client/content-client.service';
import {
  applySplitRepoint,
  planSplitRepoint,
  rollbackSplitRepoint,
  SplitRepointPlan,
} from './split-repoint.helper';
import {
  assertConfirm,
  SplitRollbackDto,
  SplitTicketTypesDto,
} from './dtos/ticket-split.dto';

/**
 * ĐIỀU PHỐI TICKET-TYPE-SPLIT phía admin ticket-mayo.
 *
 * content-service là nguồn sự thật (Ticket/Seat + counter + Redis) →
 * split/rollback CHỈ qua internal API của content (x-service-token).
 *
 * PreTicket repoint SUBSET: split KHÔNG xóa source (khác merge) nên claim/
 * mint theo ticketTypeId không gãy — chỉ cần PreTicket có contentTicketId ∈
 * movedIds đổi snapshot hiển thị. movedIds lấy từ split-plan movePreview
 * (apply response KHÔNG trả) — nên thứ tự apply:
 *
 *   1. Lấy split-plan từ content (đồng thời là nguồn movedIds).
 *   2. moveCount > cap 500 (MOVE_PREVIEW_CAP content) → apply TỰ CHIA ĐỢT
 *      (D16): mỗi đợt bốc tối đa 500 vé mới nhất còn lại, plan lại từng đợt
 *      (preview ≤500 = đủ movedIds), local repoint + content split riêng —
 *      mỗi đợt 1 auditId, rollback được từng đợt theo thứ tự ngược. Đợt
 *      giữa giữ "dịch chỗ theo vé": srcQty = SL ban đầu − lũy kế đã chuyển,
 *      tgtQty = SL ban đầu + lũy kế; đợt CUỐI dùng quantity override của
 *      DTO (vAbsolute) để về đúng số cuối user chốt.
 *   3. Local subset repoint (audit riêng/đợt) — trước content như merge: lỗi
 *      4xx ở bước 4 chắc chắn chưa commit → undo local sạch.
 *   4. content POST split (≤500 vé/transaction).
 *      4xx → undo local + re-throw enriched (kèm các đợt đã commit trước đó).
 *      5xx/timeout → probe: split-plan lại, source.sold === keepCount dự
 *      kiến (projection.sourceAfter.sold) = ĐÃ commit (dừng loop, giữ local,
 *      trả split-after-ambiguous-error + danh sách audit các đợt); không
 *      khớp = chưa commit (undo local); probe fail → để nguyên + 503.
 *
 * Rollback: content rollback TRƯỚC (vé về source) → undo local repoint
 * theo repointAuditId.
 */
@Injectable()
export class TicketSplitService {
  private readonly logger = new Logger(TicketSplitService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly content: ContentClientService,
  ) {}

  // ─── PLAN (dry-run: content split-plan + lokal PreTicket subset report) ───
  async plan(
    eventId: string,
    sourceId: string,
    targetId: string,
    keepCount: number,
    sourceQuantity?: number,
    targetQuantity?: number,
  ) {
    const contentPlan = await this.content.getSplitPlan({
      eventId,
      sourceId,
      targetId,
      keepCount,
      sourceQuantity,
      targetQuantity,
    });

    let local: (SplitRepointPlan & { note?: string }) | { error: string } | null = null;
    if (Array.isArray(contentPlan?.movePreview) && contentPlan.movePreview.length > 0) {
      const movedIds = (contentPlan.movePreview as { ticketId: string }[]).map(
        (t) => t.ticketId,
      );
      try {
        const p = await planSplitRepoint(this.prisma, movedIds);
        local =
          p.affectedPreTickets === 0
            ? { ...p, note: 'Không có PreTicket nào trong tập chuyển — bước local no-op.' }
            : p;
      } catch (err) {
        local = { error: (err as Error).message };
      }
    }
    return { content: contentPlan, local };
  }

  // ─── APPLY (tự chia đợt ≤ SPLIT_ROUND_CAP vé — D16) ───
  /** Bằng MOVE_PREVIEW_CAP của content-service: plan đợt ≤500 → preview đủ movedIds. */
  private static readonly SPLIT_ROUND_CAP = 500;

  async apply(dto: SplitTicketTypesDto, actorId?: string) {
    this.logger.log(
      `[SPLIT-APPLY] actor=${actorId ?? '?'} event=${dto.eventId} source=${dto.sourceId} ` +
        `target=${dto.targetId} keep=${dto.keepCount} ` +
        `srcQty=${dto.sourceQuantity ?? '-'} tgtQty=${dto.targetQuantity ?? '-'}`,
    );
    assertConfirm(dto.confirm, 'SPLIT');

    const planParams = {
      eventId: dto.eventId,
      sourceId: dto.sourceId,
      targetId: dto.targetId,
      keepCount: dto.keepCount,
      sourceQuantity: dto.sourceQuantity,
      targetQuantity: dto.targetQuantity,
    };
    type RoundSummary = {
      round: number;
      keepCount: number;
      movedTickets: number | null;
      contentAuditId: string | null;
      repointAuditId: string;
    };
    const rounds: RoundSummary[] = [];
    // Đối chiếu sau chuyển (DB "Ticket"): toàn bộ vé đã bốc về đích — gom từ
    // movePreview của MỌI đợt (mỗi đợt ≤500 → không bao giờ bị cắt).
    const movedTickets: {
      ticketId: string;
      ticketCode: string;
      userId: string | null;
      status: string;
      createdAt: string;
    }[] = [];
    const collectPreview = (plan: Record<string, unknown> | null) => {
      const arr = Array.isArray(plan?.movePreview) ? (plan!.movePreview as unknown[]) : [];
      for (const t of arr as Record<string, unknown>[]) {
        movedTickets.push({
          ticketId: String(t?.ticketId ?? ''),
          ticketCode: String(t?.ticketCode ?? ''),
          userId: typeof t?.userId === 'string' ? t.userId : null,
          status: String(t?.status ?? ''),
          createdAt: String(t?.createdAt ?? ''),
        });
      }
    };

    const measure = async () => {
      const p = await this.content.getSplitPlan(planParams);
      if (p?.ok === false) throw this.planRejected(p, dto, rounds);
      return p as Record<string, unknown> | null;
    };

    // ── Đo lần đầu: vừa validate toàn bộ (blockers/shape với số CUỐI) vừa đủ
    // movedIds nếu moveCount ≤ cap → chạy thẳng 1 đợt như thiết kế cũ. ──
    const p0 = await measure();
    const m0 = Number(p0?.moveCount ?? 0);
    if (m0 <= TicketSplitService.SPLIT_ROUND_CAP) {
      const movedIds = this.extractMovedIds(p0, dto);
      collectPreview(p0);
      const r = await this.applyRound(dto, p0, movedIds, actorId, rounds);
      if (r.ambiguous === 'committed') {
        this.logger.error(
          `[SPLIT-APPLY] content báo lỗi ${r.httpStatus} NHƯNG source.sold đã về mức split → ĐÃ COMMIT. Giữ local repoint audit=${r.repointAuditId}.`,
        );
        return {
          status: 'split-after-ambiguous-error',
          content: null,
          local: {
            repointAuditId: r.repointAuditId,
            movedPreTickets: r.movedPreTickets,
            movedIdsCount: movedIds.length,
          },
          moved: movedTickets,
          note: r.note,
        };
      }
      if (r.ambiguous === 'unknown') {
        throw new ServiceUnavailableException(
          `Không xác định được split đã commit chưa (content lỗi ${r.httpStatus} + probe thất bại). ` +
            `Không tự rollback để tránh mất đồng bộ. Kiểm tra thủ công: split-plan event=${dto.eventId} ` +
            `source=${dto.sourceId} keep=${dto.keepCount} — source.sold đã giảm chưa; ` +
            `local repoint audit=${r.repointAuditId} (rollback bằng POST rollback kèm repointAuditId nếu content CHƯA split).`,
        );
      }
      this.logger.log(
        `[SPLIT-APPLY] DONE audit=${r.contentAuditId} localRepointAudit=${r.repointAuditId} ` +
          `movedPreTickets=${r.movedPreTickets}`,
      );
      return {
        status: 'split',
        content: r.content,
        local: {
          repointAuditId: r.repointAuditId,
          movedPreTickets: r.movedPreTickets,
          movedIdsCount: movedIds.length,
        },
        moved: movedTickets,
      };
    }

    // ── BATCH: mỗi đợt bốc ≤500 vé MỚI NHẤT còn lại (keep đợt = keep cuối +
    // việc còn lại − đợt này). Kết quả cuối == 1 lệnh split lớn. ──
    let meas: Record<string, unknown> | null = p0;
    let guard = 0;
    for (;;) {
      if (++guard > 100) {
        throw new ServiceUnavailableException(
          `Chia đợt bị kẹt sau ${rounds.length} đợt (eligible không giảm như dự kiến) — ` +
            `dừng để tránh lặp vô hạn. Chạy split-plan kiểm tra rồi mới retry. ` +
            `Audit đã commit: ${rounds.map((x) => x.contentAuditId).join(', ')}`,
        );
      }
      if (rounds.length > 0) meas = await measure(); // đo lại eligible hiện tại
      const mCur = Number(meas?.moveCount ?? 0);
      if (!(mCur > 0)) break; // drift may mắn: đã về đúng keep cuối
      const mv = Math.min(TicketSplitService.SPLIT_ROUND_CAP, mCur);
      const keepNow = dto.keepCount + mCur - mv;
      const isLast = mCur <= TicketSplitService.SPLIT_ROUND_CAP;
      // Quantity đợt này (tuyệt đối SAU đợt). Đợt giữa: "dịch chỗ theo vé" từ
      // snapshot HIỆN TẠI của plan. Đợt CUỐI: dùng override tuyệt đối của DTO
      // (undefined = mặc định backend như lệnh đơn — tương thích CLI cũ).
      const srcSnap = (meas?.source as { quantity?: number | null } | null)?.quantity;
      const tgtSnap = (meas?.target as { quantity?: number | null } | null)?.quantity;
      const srcQ = isLast
        ? dto.sourceQuantity
        : srcSnap != null
          ? Math.max(srcSnap - mv, 0)
          : undefined;
      const tgtQ = isLast
        ? dto.targetQuantity
        : tgtSnap != null
          ? tgtSnap + mv
          : undefined;

      let rp: Record<string, unknown> | null = meas;
      if (!isLast) {
        // Plan riêng cho đợt: preview ≤500 = đủ movedIds + validate giữa đợt.
        rp = await this.content.getSplitPlan({
          eventId: dto.eventId,
          sourceId: dto.sourceId,
          targetId: dto.targetId,
          keepCount: keepNow,
          sourceQuantity: srcQ,
          targetQuantity: tgtQ,
        });
        if (rp?.ok === false) throw this.planRejected(rp, dto, rounds);
      }
      const movedIds = this.extractMovedIds(rp, dto);
      collectPreview(rp);
      const eff: SplitTicketTypesDto = {
        ...dto,
        keepCount: keepNow,
        sourceQuantity: srcQ,
        targetQuantity: tgtQ,
      };
      const r = await this.applyRound(eff, rp, movedIds, actorId, rounds);

      if (r.ambiguous === 'committed') {
        rounds.push({
          round: rounds.length + 1,
          keepCount: keepNow,
          movedTickets: null,
          contentAuditId: null,
          repointAuditId: r.repointAuditId,
        });
        this.logger.error(
          `[SPLIT-APPLY] DỪNG: ${rounds.length - 1} đợt đã commit chắc chắn, ` +
            `đợt cuối lỗi ${r.httpStatus} nhưng probe báo ĐÃ commit — auditId đợt này chưa rõ. ` +
            `Xác minh AuditLog content trước khi rollback/retry.`,
        );
        return {
          status: 'split-batched',
          partial: true,
          note: r.note,
          moved: movedTickets,
          totalMoved: rounds.reduce((s, x) => s + (x.movedTickets ?? 0), 0),
          contentAuditIds: rounds.map((x) => x.contentAuditId).filter(Boolean),
          repointAuditIds: rounds.map((x) => x.repointAuditId),
          rounds,
        };
      }
      if (r.ambiguous === 'unknown') {
        throw new ServiceUnavailableException(
          `Không xác định được đợt ${rounds.length + 1}/${Math.ceil(m0 / TicketSplitService.SPLIT_ROUND_CAP)} ` +
            `đã commit chưa (content lỗi ${r.httpStatus} + probe thất bại). KHÔNG tự rollback. ` +
            `${rounds.length} đợt trước đã commit (audit: ${rounds.map((x) => x.contentAuditId).join(', ') || '-'}); ` +
            `local repoint đợt kẹt=${r.repointAuditId}. Kiểm tra split-plan + AuditLog content rồi retry.`,
        );
      }
      rounds.push({
        round: rounds.length + 1,
        keepCount: keepNow,
        movedTickets: r.movedTickets ?? null,
        contentAuditId: r.contentAuditId ?? null,
        repointAuditId: r.repointAuditId,
      });
      this.logger.log(
        `[SPLIT-APPLY] ROUND ${rounds.length} DONE keep=${keepNow} moved=${r.movedTickets} ` +
          `audit=${r.contentAuditId} localRepoint=${r.repointAuditId}`,
      );
      if (isLast) break; // không đo lại sau đợt cuối (plan sẽ trả moveCount=0 = shape-error)
    }

    const totalMoved = rounds.reduce((s, x) => s + (x.movedTickets ?? 0), 0);
    this.logger.log(`[SPLIT-APPLY] BATCH DONE rounds=${rounds.length} totalMoved=${totalMoved}`);
    return {
      status: 'split-batched',
      totalMoved,
      moved: movedTickets,
      contentAuditIds: rounds.map((x) => x.contentAuditId).filter(Boolean),
      repointAuditIds: rounds.map((x) => x.repointAuditId),
      rounds,
    };
  }

  /**
   * Một đợt: local subset repoint TRƯỚC → content split SAU.
   * 4xx → undo local + throw enriched (kèm rounds đã commit).
   * 5xx/timeout → probe sold source: committed/unknown → trả về để apply()
   * dừng batch; chưa commit → undo local + throw enriched.
   */
  private async applyRound(
    eff: SplitTicketTypesDto,
    plan: Record<string, unknown> | null,
    movedIds: string[],
    actorId: string | undefined,
    completedRounds: {
      round: number;
      keepCount: number;
      movedTickets: number | null;
      contentAuditId: string | null;
      repointAuditId: string;
    }[],
  ): Promise<
    | {
        ambiguous?: undefined;
        content: unknown;
        contentAuditId: string | null;
        movedTickets: number | null;
        movedPreTickets: number;
        repointAuditId: string;
        httpStatus: number;
        note: string;
      }
    | {
        ambiguous: 'committed' | 'unknown';
        content?: undefined;
        contentAuditId?: undefined;
        movedTickets?: undefined;
        movedPreTickets: number;
        repointAuditId: string;
        httpStatus: number;
        note: string;
      }
  > {
    const targetName: string | null =
      ((plan?.target as { name?: string } | null) ?? null)?.name ?? null;
    const local = await applySplitRepoint(
      this.prisma,
      {
        sourceId: eff.sourceId,
        targetId: eff.targetId,
        targetName,
        movedIds,
      },
      (m) => this.logger.log(`[SPLIT-APPLY][LOCAL] ${m}`),
    );

    try {
      const contentRes = await this.content.splitTicketTypes({
        eventId: eff.eventId,
        sourceId: eff.sourceId,
        targetId: eff.targetId,
        keepCount: eff.keepCount,
        sourceQuantity: eff.sourceQuantity,
        targetQuantity: eff.targetQuantity,
        actorId,
      });
      return {
        content: contentRes,
        contentAuditId:
          typeof contentRes?.auditId === 'string' ? contentRes.auditId : null,
        movedTickets: Number(
          (contentRes?.moved as { tickets?: number } | undefined)?.tickets ?? movedIds.length,
        ),
        movedPreTickets: local.movedPreTickets,
        repointAuditId: local.auditId,
        httpStatus: 200,
        note: '',
      };
    } catch (err) {
      const status = err instanceof HttpException ? err.getStatus() : 0;
      if (status >= 400 && status < 500) {
        // 4xx chắc chắn split KHÔNG commit (validate trước tx / blocker) → undo local.
        const undone = await this.safeRollbackLocal(local.auditId);
        this.logger.warn(
          `[SPLIT-APPLY] content từ chối ${status} — local repoint ${undone ? 'đã undo' : 'UNDO THẤT BẠI (manual)'}`,
        );
        throw this.enrichError(err, {
          localRepointRolledBack: undone,
          repointAuditId: local.auditId,
          completedRounds,
        });
      }
      // 5xx/timeout/nghi vấn → probe: sold source đã giảm đúng keepCount đợt này chưa?
      const committed = await this.probeSplitCommitted(
        eff,
        (plan?.projection as { sourceAfter?: { sold?: number } } | null)?.sourceAfter?.sold,
      );
      if (committed === false) {
        const undone = await this.safeRollbackLocal(local.auditId);
        this.logger.warn(
          `[SPLIT-APPLY] content lỗi ${status}, probe xác nhận CHƯA commit — local ${undone ? 'đã undo' : 'UNDO THẤT BẠI'}`,
        );
        throw this.enrichError(err, {
          localRepointRolledBack: undone,
          repointAuditId: local.auditId,
          completedRounds,
        });
      }
      return {
        ambiguous: committed === true ? 'committed' : 'unknown',
        movedPreTickets: local.movedPreTickets,
        repointAuditId: local.auditId,
        httpStatus: status,
        note:
          'HTTP call split trả lỗi nhưng content-service đã commit (sold source đã giảm đúng). ' +
          'Lấy auditId rollback: tìm AuditLog TICKET_TYPE_SPLIT mới nhất của event ở content ' +
          '(hoặc rollback rồi split lại sạch sẽ).',
      };
    }
  }

  // ─── ROLLBACK ───
  async rollback(dto: SplitRollbackDto, actorId?: string) {
    this.logger.log(
      `[SPLIT-ROLLBACK] actor=${actorId ?? '?'} contentAudit=${dto.contentAuditId} repointAudit=${dto.repointAuditId ?? '-'}`,
    );
    assertConfirm(dto.confirm, 'ROLLBACK');
    // content rollback TRƯỚC — vé về lại source, snapshot PreTicket mới
    // khớp lại đích undo local repoint.
    const contentRes = await this.content.splitRollback({
      auditId: dto.contentAuditId,
      actorId,
    });
    let local: unknown = null;
    let localWarning: string | undefined;
    if (dto.repointAuditId) {
      try {
        local = await rollbackSplitRepoint(this.prisma, dto.repointAuditId);
      } catch (err) {
        // content đã rollback — local thất bại là lỗi cần thao tác thủ công,
        // không được che bằng exception (admin phải thấy rolledBack=true).
        localWarning = `Lokal repoint rollback THẤT BẠI (${(err as Error).message}) — audit=${dto.repointAuditId}, cần xử lý thủ công: DistributionAudit action SPLIT_REPOINT detail.pretickets[].`;
        this.logger.error(`[SPLIT-ROLLBACK] ${localWarning}`);
      }
    }
    return {
      status: 'rolled_back',
      content: contentRes,
      local,
      ...(localWarning ? { warning: localWarning } : {}),
    };
  }

  // ─── helpers ───
  private extractMovedIds(
    plan:
      | {
          movePreview?: unknown;
          movePreviewTruncated?: boolean;
          moveCount?: number;
        }
      | null,
    dto: SplitTicketTypesDto,
  ): string[] {
    if (!plan) {
      throw new NotFoundException('Split-plan không trả về dữ liệu — thử lại.');
    }
    if (plan.movePreviewTruncated === true) {
      // Lẽ ra không xảy ra: apply đã chia đợt ≤500 trước khi tới đây.
      throw new HttpException(
        {
          message:
            `movePreview đợt vẫn bị cắt (moveCount > cap 500) — eligible source tăng bất thường ` +
            `giữa hai đợt. Dừng an toàn; chạy lại split-plan rồi apply tiếp.`,
          code: 'TICKET_TYPE_SPLIT_PREVIEW_TRUNCATED',
        },
        HttpStatus.CONFLICT,
      );
    }
    const preview = Array.isArray(plan.movePreview)
      ? (plan.movePreview as { ticketId?: unknown }[])
      : [];
    if (preview.length === 0) {
      throw new HttpException(
        {
          message:
            `Split-plan không trả movePreview (moveCount có thể = 0 hoặc shape lỗi) — chạy plan lại trước khi apply.`,
          code: 'TICKET_TYPE_SPLIT_INVALID_INPUT',
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    const movedIds = preview
      .map((t) => (typeof t?.ticketId === 'string' ? t.ticketId : ''))
      .filter(Boolean);
    const expected = Number(plan?.moveCount ?? -1);
    if (movedIds.length !== preview.length || (expected >= 0 && movedIds.length !== expected)) {
      void dto;
      throw new HttpException(
        {
          message: `movePreview thiếu ticketId (${movedIds.length}/${preview.length}) — hủy apply, chạy plan lại.`,
          code: 'TICKET_TYPE_SPLIT_INVALID_INPUT',
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    return movedIds;
  }

  private planRejected(
    plan: { blockers?: unknown[]; warnings?: unknown[]; shapeErrors?: unknown[] },
    dto: SplitTicketTypesDto,
    completedRounds: unknown[] = [],
  ): never {
    void dto;
    throw new HttpException(
      {
        message:
          completedRounds.length > 0
            ? `Split-plan blockers/shape errors ở đợt sau — ${completedRounds.length} đợt đầu đã commit, ROLLBACK theo thứ tự ngược rồi xử lý.`
            : 'Split-plan báo blockers/shape errors — không apply.',
        code: 'TICKET_TYPE_SPLIT_BLOCKED',
        blockers: Array.isArray(plan?.blockers) ? plan.blockers : [],
        shapeErrors: Array.isArray(plan?.shapeErrors) ? plan.shapeErrors : [],
        warnings: Array.isArray(plan?.warnings) ? plan.warnings : [],
        completedRounds,
      },
      HttpStatus.CONFLICT,
    );
  }

  private async safeRollbackLocal(repointAuditId: string): Promise<boolean> {
    try {
      await rollbackSplitRepoint(this.prisma, repointAuditId);
      return true;
    } catch (err) {
      this.logger.error(
        `[SPLIT-APPLY] rollbackSplitRepoint(${repointAuditId}) thất bại: ${(err as Error).message} — PreTicket lokal vẫn trỏ target trong khi content chưa/đã rollback. Cần thao tác thủ công.`,
      );
      return false;
    }
  }

  /** Giữ nguyên status/code/message pass-through, gắn thêm field trạng thái local. */
  private enrichError(err: unknown, extra: Record<string, unknown>): never {
    if (err instanceof HttpException) {
      const res = err.getResponse();
      const body = typeof res === 'string' ? { message: res } : { ...(res as object) };
      throw new HttpException({ ...body, ...extra }, err.getStatus());
    }
    throw err;
  }

  /**
   * true = source.sold đã về mức split (đã commit); false = chưa; null = không rõ.
   * expectedSold = projection.sourceAfter.sold từ plan TRƯỚC apply — plan sau
   * apply sẽ trả sourceBefore.sold == expectedSold nếu đã commit.
   */
  private async probeSplitCommitted(
    dto: SplitTicketTypesDto,
    expectedSold: number | undefined,
  ): Promise<boolean | null> {
    if (expectedSold === undefined) return null;
    try {
      const report = await this.content.getSplitPlan({
        eventId: dto.eventId,
        sourceId: dto.sourceId,
        targetId: dto.targetId,
        keepCount: dto.keepCount,
      });
      const soldNow = (report?.source as { sold?: number } | null)?.sold;
      if (typeof soldNow !== 'number') return null;
      return soldNow === expectedSold ? true : false;
    } catch {
      return null;
    }
  }
}
