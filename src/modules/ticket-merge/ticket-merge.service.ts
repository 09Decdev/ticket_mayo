import {
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ContentClientService } from '../content-client/content-client.service';
import {
  applyRepoint,
  planRepoint,
  rollbackRepoint,
} from '../distribution/merge-repoint.runner';
import { MergeRollbackDto, MergeTicketTypesDto } from './dtos/ticket-merge.dto';

/**
 * ĐIỀU PHỐI TICKET-TYPE-MERGE phía admin ticket-mayo.
 *
 * content-service là nguồn sự thật (Ticket/Reservation/Seat/GiftCampaign +
 * Redis stock) → merge/rollback CHỈ qua internal API của content
 * (x-service-token). DB lokal mayo (PreTicket/DistributionJob) giữ tham
 * chiếu ticketTypeId → bước "repoint" chạy thẳng bằng runner có sẵn.
 *
 * Thứ tự apply (cố ý):
 *   1. applyRepoint LOKAL TRƯỚC — khi loser còn tồn tại ở content, lỗi bước
 *      2 (4xx nghiệp vụ, merge CHẮC CHẮN chưa commit) → rollbackRepoint sạch,
 *      hiện trạng nguyên vẹn.
 *   2. content POST merge.
 * Timeout/5xx (nghi vấn commit thật) → KHÔNG đoán mò: probe content
 * merge-plan — loser biến mất = đã commit (giữ local, báo rõ); loser còn =
 * chưa commit (undo local, re-throw); probe fail → để nguyên + bắt admin
 * kiểm tra thủ công (an toàn hơn rollback nhầm khi content đã xóa loser).
 *
 * Rollback đối xứng: content rollback TRƯỚC (loser được tạo lại y nguyên id),
 * sau đó mới undo local repoint theo repointAuditId.
 */
@Injectable()
export class TicketMergeService {
  private readonly logger = new Logger(TicketMergeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly content: ContentClientService,
  ) {}

  // ─── PLAN (dry-run: content report + lokal repoint report) ───
  async plan(eventId: string, survivorId?: string, loserIdsCsv?: string | string[]) {
    const loserIds = this.parseCsv(loserIdsCsv);
    const contentPlan = await this.content.getMergePlan({
      eventId,
      survivorId: survivorId || undefined,
      loserIds: loserIds.length ? loserIds : undefined,
    });

    let local: unknown = null;
    if (survivorId && loserIds.length > 0) {
      try {
        local = await planRepoint(this.prisma, {
          survivorId,
          loserIds,
          includeTerminal: false,
          dryRun: true,
        });
      } catch (err) {
        // Báo cáo lokal không được chặn content plan — fail-soft kèm message.
        local = { error: (err as Error).message };
      }
    }
    return { content: contentPlan, local };
  }

  // ─── APPLY ───
  async apply(dto: MergeTicketTypesDto, actorId?: string) {
    this.logger.log(
      `[MERGE-APPLY] actor=${actorId ?? '?'} event=${dto.eventId} survivor=${dto.survivorId} ` +
        `losers=[${dto.loserIds.join(',')}] includeTerminal=${!!dto.includeTerminal} overrides=${JSON.stringify(dto.overrides ?? {})}`,
    );

    // Bước 1: lokal repoint (PreTicket sống + job đang chạy; terminal tùy chọn).
    const local = await applyRepoint(
      this.prisma,
      {
        survivorId: dto.survivorId,
        loserIds: dto.loserIds,
        survivorName: dto.overrides?.name,
        includeTerminal: dto.includeTerminal ?? false,
        dryRun: false,
      },
      (m) => this.logger.log(`[MERGE-APPLY][LOCAL] ${m}`),
    );

    // Bước 2: content merge — transaction thật + AuditLog manifest.
    try {
      const contentRes = await this.content.mergeTicketTypes({
        eventId: dto.eventId,
        survivorId: dto.survivorId,
        loserIds: dto.loserIds,
        overrides: dto.overrides as Record<string, unknown> | undefined,
        actorId,
      });
      this.logger.log(
        `[MERGE-APPLY] DONE audit=${contentRes?.auditId} localRepointAudit=${local.auditId} movedPre=${local.movedPreTickets} movedJobs=${local.movedJobs}`,
      );
      return {
        status: 'merged',
        content: contentRes,
        local: {
          repointAuditId: local.auditId,
          movedPreTickets: local.movedPreTickets,
          movedJobs: local.movedJobs,
        },
      };
    } catch (err) {
      const status = err instanceof HttpException ? err.getStatus() : 0;
      if (status >= 400 && status < 500) {
        // 4xx chắc chắn merge KHÔNG commit (validate trước tx / blocker) → undo local.
        const undone = await this.safeRollbackLocal(local.auditId);
        this.logger.warn(
          `[MERGE-APPLY] content từ chối ${status} — local repoint ${undone ? 'đã undo' : 'UNDO THẤT BẠI (manual)'}`,
        );
        throw this.enrichError(err, {
          localRepointRolledBack: undone,
          repointAuditId: local.auditId,
        });
      }
      // 5xx/timeout/nghi vấn → probe content: loser còn tồn tại không?
      const committed = await this.probeMergeCommitted(dto.eventId, dto.loserIds);
      if (committed === true) {
        this.logger.error(
          `[MERGE-APPLY] content báo lỗi ${status} NHƯNG loser đã biến mất → merge ĐÃ COMMIT. Giữ local repoint audit=${local.auditId}.`,
        );
        return {
          status: 'merged-after-ambiguous-error',
          content: null,
          local: {
            repointAuditId: local.auditId,
            movedPreTickets: local.movedPreTickets,
            movedJobs: local.movedJobs,
          },
          note:
            'HTTP call merge trả lỗi nhưng content-service đã commit (loser không còn trong plan). ' +
            'Lấy auditId rollback: tìm AuditLog TICKET_TYPE_MERGE mới nhất của event ở content ' +
            '(hoặc rollback lại content rồi merge lại sạch sẽ).',
        };
      }
      if (committed === false) {
        const undone = await this.safeRollbackLocal(local.auditId);
        this.logger.warn(
          `[MERGE-APPLY] content lỗi ${status}, probe xác nhận CHƯA commit — local ${undone ? 'đã undo' : 'UNDO THẤT BẠI'}`,
        );
        throw this.enrichError(err, {
          localRepointRolledBack: undone,
          repointAuditId: local.auditId,
        });
      }
      // Probe cũng fail → KHÔNG rollback (tránh bất đồng bộ ngược).
      throw new ServiceUnavailableException(
        `Không xác định được merge đã commit chưa (content lỗi ${status} + probe thất bại). ` +
          `Không tự rollback để tránh mất đồng bộ. Kiểm tra thủ công: loserIds [${dto.loserIds.join(', ')}] còn ở content không; ` +
          `local repoint audit=${local.auditId} (rollback bằng POST rollback kèm repointAuditId nếu content CHƯA merge).`,
      );
    }
  }

  // ─── ROLLBACK ───
  async rollback(dto: MergeRollbackDto, actorId?: string) {
    this.logger.log(
      `[MERGE-ROLLBACK] actor=${actorId ?? '?'} contentAudit=${dto.contentAuditId} repointAudit=${dto.repointAuditId ?? '-'}`,
    );
    // content rollback TRƯỚC — loser được tạo lại đúng id gốc, local repoint
    // (PreTicket đang trỏ survivor) mới có đích để quay về.
    const contentRes = await this.content.mergeRollback({
      auditId: dto.contentAuditId,
      actorId,
    });
    let local: unknown = null;
    let localWarning: string | undefined;
    if (dto.repointAuditId) {
      try {
        local = await rollbackRepoint(this.prisma, dto.repointAuditId);
      } catch (err) {
        // content đã rollback — local thất bại là lỗi cần thao tác thủ công,
        // không được che bằng exception (admin phải thấy rolledBack=true).
        localWarning = `Lokal repoint rollback THẤT BẠI (${(err as Error).message}) — audit=${dto.repointAuditId}, cần chạy: npx ts-node scripts/repoint-pretickets.ts --rollback ${dto.repointAuditId}`;
        this.logger.error(`[MERGE-ROLLBACK] ${localWarning}`);
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
  private parseCsv(raw: string | string[] | undefined): string[] {
    const list = Array.isArray(raw) ? raw : (raw ?? '').split(',');
    return [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
  }

  private async safeRollbackLocal(repointAuditId: string): Promise<boolean> {
    try {
      await rollbackRepoint(this.prisma, repointAuditId);
      return true;
    } catch (err) {
      this.logger.error(
        `[MERGE-APPLY] rollbackRepoint(${repointAuditId}) thất bại: ${(err as Error).message} — PreTicket lokal vẫn trỏ survivor trong khi content chưa/đã rollback. Cần thao tác thủ công.`,
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

  /** true = mọi loser biến mất (đã commit); false = còn nguyên; null = không rõ. */
  private async probeMergeCommitted(eventId: string, loserIds: string[]): Promise<boolean | null> {
    try {
      const report = await this.content.getMergePlan({ eventId });
      const ids = new Set((report?.types ?? []).map((t: any) => t.id));
      const stillPresent = loserIds.filter((id) => ids.has(id));
      if (stillPresent.length === 0) return true;
      if (stillPresent.length === loserIds.length) return false;
      return null;
    } catch {
      return null;
    }
  }
}
