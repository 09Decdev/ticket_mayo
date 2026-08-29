import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, DistributionStatus, type DistributionJob } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MailDispatcherService } from '../mail-dispatcher/mail-dispatcher.service';
import { AuditService } from '../audit/audit.service';
import { EventService } from '../event/event.service';
import { generateClaimToken, generateJobId } from '../../common/utils/claim-token.util';
import { generateEmailHash, normalizeEmailForLookup } from '../../common/utils/email-hash.util';
import { ClaimMailPayload } from '../mail-dispatcher/mail.adapter';
import { UserCommunityClientService } from '../user-community-client/user-community-client.service';
import {
  ContentClientService,
  type MintRecipientResult,
} from '../content-client/content-client.service';
import { DistributeRequestDto } from './dtos/distribute-request.dto';

@Injectable()
export class DistributionService {
  private readonly logger = new Logger(DistributionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailDispatcher: MailDispatcherService,
    private readonly audit: AuditService,
    private readonly eventService: EventService,
    private readonly userCommunity: UserCommunityClientService,
    private readonly content: ContentClientService,
  ) {}

  async distribute(dto: DistributeRequestDto, adminId: string) {
    const distributeStartTs = Date.now();
    // 1. Idempotency — same key returns the existing job.
    if (dto.idempotencyKey) {
      const existing = await this.prisma.distributionJob.findUnique({
        where: { idempotencyKey: dto.idempotencyKey },
      });
      if (existing) {
        this.logger.log(`idempotency hit — returning existing job ${existing.id}`);
        return { job: existing };
      }
    }

    // 2. Resolve TicketType + Event từ content-service (nguồn sự thật).
    const tt = await this.eventService.getTicketTypeWithEvent(dto.ticketTypeId);
    if (!tt) {
      throw new NotFoundException(`Ticket type ${dto.ticketTypeId} not found.`);
    }

    // 3. Normalize + dedupe recipients by emailHash.
    const recipients = this.normalizeAndDedupe(dto.recipients);
    if (recipients.length === 0) {
      throw new ConflictException('No valid unique recipient emails.');
    }

    // 3b. Validate quota NGAY từ server (KHÔNG chờ mint fail): tổng vé yêu cầu
    //     (số email unique × vé mỗi email) phải ≤ số vé còn lại. Lỗi đi ra như
    //     409 TICKET_QUOTA_EXCEEDED kèm remaining/requested — giống body content
    //     fail tại mint, frontend format sẵn. Mint vẫn là lớp chống race cuối
    //     cùng (Redis stock) — validation này chỉ chặn lỗi sớm trước khi tạo
    //     job/PreTicket.
    const requestedTotal = recipients.length * Math.max(1, dto.quantity ?? 1);
    if (Number.isFinite(tt.remaining) && requestedTotal > tt.remaining) {
      this.logger.warn(
        `[DISTRIBUTE] QUOTA pre-check FAIL ticketType=${tt.id} requested=${requestedTotal} remaining=${tt.remaining}`,
      );
      throw new ConflictException({
        code: 'TICKET_QUOTA_EXCEEDED',
        message: `Số vé yêu cầu (${requestedTotal}) vượt quá số vé còn lại (${tt.remaining}/${tt.quantity}).`,
        remaining: tt.remaining,
        requested: requestedTotal,
      });
    }

    // 4. Build PreTicket seeds — quantity PreTickets per recipient, each with
    //    its OWN claim token/link, so "2 vé → 2 email, 3 vé → 3 email".
    const quantity = Math.max(1, dto.quantity ?? 1);
    const jobId = generateJobId();
    const seeds = recipients.flatMap((email) =>
      Array.from({ length: quantity }, () => ({
        email,
        recipientEmailHash: generateEmailHash(email),
        claimToken: generateClaimToken(),
      })),
    );
    this.logger.log(
      `[DISTRIBUTE] start mode=EAGER ticketType=${tt.id} (${tt.name}) event=${tt.eventName} recipients=${recipients.length} qty=${quantity} → ${seeds.length} PreTicket`,
    );

    // Resolve PortalUser.id per email (CÙNG DB, không HTTP) — mint luôn kèm
    //     userId nếu email đã có tài khoản. Map<emailHash, userId> — email
    //     chưa có tài khoản → không có trong map.
    const userIdByHash = new Map<string, string>();
    const users = await this.prisma.portalUser.findMany({
      where: { emailHash: { in: seeds.map((s) => s.recipientEmailHash) } },
      select: { id: true, emailHash: true },
    });
    for (const u of users) userIdByHash.set(u.emailHash, u.id);

    // 5. Persist job + PreTickets atomically (kèm recipientUserId đã resolve — E1.4/E1.5).
    let job: DistributionJob | null = null;
    try {
      job = await this.prisma.$transaction(async (tx) => {
        const created = await tx.distributionJob.create({
          data: {
            id: jobId,
            ticketTypeId: tt.id,
            ticketTypeName: tt.name,
            eventName: tt.eventName,
            eventId: tt.eventId,
            total: seeds.length,
            status: 'RUNNING',
            mintMode: 'EAGER', // luôn mint trước khi email (UI-P1)
            idempotencyKey: dto.idempotencyKey ?? null,
            createdBy: adminId,
          },
        });
        await tx.preTicket.createMany({
          data: seeds.map((s) => ({
            jobId: created.id,
            recipientEmailHash: s.recipientEmailHash,
            claimToken: s.claimToken,
            ticketTypeId: tt.id,
            eventId: tt.eventId,
            ticketTypeName: tt.name,
            eventName: tt.eventName,
            status: 'PENDING',
            // gắn userId đã resolve (email-only → NULL).
            ...(userIdByHash.has(s.recipientEmailHash)
              ? { recipientUserId: userIdByHash.get(s.recipientEmailHash) }
              : {}),
          })),
        });
        return created;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Race on idempotencyKey unique constraint — re-read existing.
        const existing = dto.idempotencyKey
          ? await this.prisma.distributionJob.findUnique({
              where: { idempotencyKey: dto.idempotencyKey },
            })
          : null;
        if (existing) return { job: existing };
      }
      throw err;
    }

    if (!job) {
      throw new Error('Failed to create distribution job');
    }

    this.logger.log(
      `[DISTRIBUTE] job=${job.id} đã tạo (status=RUNNING, ${job.total} PreTicket, mode=${job.mintMode})`,
    );

    await this.audit.record({
      jobId: job.id,
      action: 'DISTRIBUTION_START',
      detail: { ticketTypeId: tt.id, eventId: tt.eventId, recipients: recipients.length },
    });

    // 6. Mint TOÀN BỘ vé thật ở content-service TRƯỚC khi gửi email — email
    //    chỉ gửi sau khi vé đã trừ ở content. Mint fail cả batch → KHÔNG gửi
    //    email nào (xử lý trong mintEager).
    await this.mintEager(job, tt);

    // 7. Enqueue ticket emails, then finalize job counts.
    //    Lookup displayName qua user-community (chỉ user đã có tài khoản PortalUser);
    //    chưa có → fallback tên "Người dùng MAYogu", SĐT rỗng.
    //    Chỉ gửi email cho PreTicket MINTED/LINKED (vé đã tồn tại thật);
    //    mint-fail PreTicket KHÔNG nhận email (không hứa vé không tồn tại).
    const preTicketsForEmail = await this.prisma.preTicket.findMany({
      where: { jobId: job.id, status: { in: ['MINTED', 'LINKED'] } },
    });

    const nameMap = await this.userCommunity.lookupDisplayNames(recipients);
    // ticketCode/ticketId trong email/PDF = MÃ VÉ + TICKET ID THẬT từ bảng
    // Ticket (content-service, PreTicket đã mint MINTED/LINKED); fallback slice
    // claimToken chỉ khi vé chưa có code thật (retry job fail).
    const ticketByToken = new Map(
      preTicketsForEmail.map((pt) => [
        pt.claimToken,
        { code: pt.contentTicketCode, id: pt.contentTicketId },
      ]),
    );
    const basePayloads: ClaimMailPayload[] = seeds.map((s) => {
      const src = ticketByToken.get(s.claimToken);
      return {
        jobId: job.id,
        email: s.email,
        claimToken: s.claimToken,
        claimUrl: this.mailDispatcher.buildClaimUrl(s.claimToken),
        ticketTypeName: tt.name,
        eventName: tt.eventName,
        eventDate: this.formatEventDate(tt.eventStartAt, tt.eventEndAt),
        venue: tt.venue ?? null,
        eventImage: tt.eventImageUrl ?? null,
        customerName: nameMap.get(s.email) ?? 'Người dùng MAYogu',
        customerPhone: '',
        bookedAt: this.formatDateTime(job.createdAt),
        ticketCode: src?.code ?? s.claimToken.slice(-8).toUpperCase(),
        ticketId: src?.id ?? undefined,
      };
    });

    // Chỉ giữ payload của PreTicket đã mint (match qua claimToken duy nhất).
    const mintedTokens = new Set(preTicketsForEmail.map((pt) => pt.claimToken));
    const payloads = basePayloads.filter((p) => mintedTokens.has(p.claimToken));

    const result = await this.mailDispatcher.dispatchBatch(payloads);

    // emailSentAt per-email-ack (F-05 — chống gửi đôi khi resend;
    // email fail giữ NULL để /resend-emails gửi lại).
    const okTokens = new Set(
      result.results.filter((r) => r.ok).map((r) => r.claimToken),
    );
    if (okTokens.size > 0) {
      await this.prisma.preTicket.updateMany({
        where: { jobId: job.id, claimToken: { in: [...okTokens] } },
        data: { emailSentAt: new Date() },
      });
    }

    await this.prisma.distributionJob.update({
      where: { id: job.id },
      data: {
        sent: result.dispatched,
        failed: result.failed,
        status: await this.finalizeJobStatus(job.id),
      },
    });

    const finalJob = await this.prisma.distributionJob.findUnique({ where: { id: job.id } });
    this.logger.log(
      `[DISTRIBUTE] job=${job.id} DONE status=${finalJob?.status ?? ''} email: dispatched=${result.dispatched} failed=${result.failed}/${job.total} (${Date.now() - distributeStartTs}ms)`,
    );
    return { job: finalJob ?? job };
  }

  /**
   * T5 EAGER mint flow — gọi SAU khi job + PreTickets đã persist.
   *
   * Trình tự (DESIGN §4.1-§4.5):
   *  1. Lock batch PENDING → MINTING (updateMany atomic; bản đồ idempotent).
   *  2. Gọi content mintForDistribution (HMAC ký sẵn ở client).
   *  3. Reconciliation Δ9a trong RAM: mỗi preTicketId gửi phải có ticketId trong
   *     response — thiếu → lastMintError + CRITICAL log.
   *  4. Quota (409 TICKET_SOLD_OUT/TICKET_QUOTA_EXCEEDED) → PreTickets EXPIRED
   *     (terminal — KHÔNG mồ côi PENDING, không mint lại → không doubling khi
   *     admin phát lại job mới), job FAILED, throw ConflictException 409 với
   *     remaining/requested.
   *  5. Lỗi khác (5xx/transport/timeout) → PreTickets GIỮ MINTING + lastMintError
   *     (idempotent retry; content dedupe theo preTicketId), job FAILED, re-throw.
   *  6. Thành công → per-recipient update MINTED {contentTicketId, contentTicketCode,
   *     mintedAt} guard status='MINTING' (stale-safe).
   */
  private async mintEager(
    job: DistributionJob,
    tt: { id: string; eventId: string },
  ): Promise<void> {
    // 1. Lock batch PENDING → MINTING (atomic, chịu được chạy đua distribute
    //    trùng lặp — updateMany chỉ thắng với row còn PENDING).
    const locked = await this.prisma.preTicket.updateMany({
      where: { jobId: job.id, status: 'PENDING' },
      data: { status: 'MINTING' },
    });
    if (locked.count === 0) {
      // Không row nào lock được → job đã bị xử lý (retry/đổi trạng thái tay).
      this.logger.warn(`mintEager job=${job.id}: 0 PreTicket PENDING — bỏ qua mint.`);
      return;
    }

    const minting = await this.prisma.preTicket.findMany({
      where: { jobId: job.id, status: 'MINTING' },
      select: { id: true, recipientEmailHash: true, recipientUserId: true },
    });
    if (minting.length === 0) {
      this.logger.warn(`mintEager job=${job.id}: không tìm thấy PreTicket MINTING sau lock.`);
      return;
    }
    this.logger.log(
      `[MINT-EAGER] job=${job.id} lock Ok — ${locked.count} PreTicket PENDING→MINTING, gọi content mint (${minting.length} recipient, chunk ≤500)`,
    );

    const recipients = minting.map((pt) => ({
      preTicketId: pt.id,
      emailHash: pt.recipientEmailHash,
      userId: pt.recipientUserId,
    }));

    // 2. Gọi content mint API (client đã ký HMAC + chunk 500).
    try {
      const res = await this.content.mintForDistribution({
        eventId: tt.eventId,
        ticketTypeId: tt.id,
        recipients,
        idempotencyKey: job.id,
      });

      // 3. Reconciliation Δ9a — đối chiếu preTicketId gửi vs ticketId response.
      const resultByPreTicket = new Map(res.results.map((r) => [r.preTicketId, r]));
      const missing: string[] = [];
      const mintedIds: string[] = [];
      for (const pt of minting) {
        const r = resultByPreTicket.get(pt.id);
        if (r?.ticketId) {
          mintedIds.push(pt.id);
        } else {
          missing.push(pt.id);
        }
      }

      // Δ9a extras (M3): response chứa preTicketId KHÔNG nằm trong set gửi đi
      // → lệch dữ liệu nghiêm trọng (minta nhầm batch / race) — log CRITICAL
      // cùng kiểu lệch để cảnh báo đối chiếu tay.
      const sentIds = new Set(minting.map((pt) => pt.id));
      const extras = res.results
        .map((r) => r.preTicketId)
        .filter((id) => !sentIds.has(id) && !!id);
      if (extras.length > 0) {
        this.logger.error(
          `[CRITICAL] Δ9a reconciliation lệch (extras) job=${job.id}: response chứa ${extras.length} preTicketId KHÔNG nằm trong batch gửi đi: ${extras.join(', ')}`,
        );
      }

      // Per-recipient fail → lastMintError (giữ MINTING để retry từng cái).
      if (missing.length > 0) {
        this.logger.error(
          `[CRITICAL] Δ9a reconciliation lệch job=${job.id}: ${missing.length}/${minting.length} preTicket KHÔNG có ticketId trong response — có thể đã mint ở content nhưng mất kết quả. Cần đối chiếu tay preTicketIds: ${missing.join(', ')}`,
        );
        await this.prisma.preTicket.updateMany({
          where: { id: { in: missing }, status: 'MINTING' },
          data: { lastMintError: 'Mint result missing from content response (Δ9a)' },
        });
      }

      // 4. Update MINTED — guard status='MINTING' (idempotent: retry gặp
      //    MINTED/LINKED sẽ bỏ qua).
      if (mintedIds.length > 0) {
        const mintedAt = new Date();
        for (const ptId of mintedIds) {
          const r = resultByPreTicket.get(ptId)!;
          await this.prisma.preTicket.updateMany({
            where: { id: ptId, status: 'MINTING' },
            data: {
              status: 'MINTED',
              contentTicketId: r.ticketId,
              contentTicketCode: r.ticketCode,
              mintedAt,
            },
          });
        }
      }

      await this.audit.record({
        jobId: job.id,
        action: 'MINT_EAGER_DONE',
        detail: { minted: mintedIds.length, missing: missing.length },
      });
      this.logger.log(
        `[MINT-EAGER] job=${job.id} content OK — minted=${mintedIds.length} missing=${missing.length} (${minting.length} recipient)`,
      );
    } catch (err) {
      // MAJOR-1: TRƯỚC KHI đánh trạng thái fail, áp dụng kết quả mint THẬT của
      // các chunk THÀNH CÔNG (content-client gắn partialMintResults vào error).
      // PreTicket có trong kết quả → update MINTED như path bình thường (guard
      // status='MINTING' idempotent). Không có → mới là ứng viên EXPIRED/MINTING.
      // Tránh bug cũ: chunk 1 mint thật 500 vé, chunk 2 vướng 409 → cả 800 vé
      // bị EXPIRED terminal → admin re-issue phát vé THỨ HAI cho 500 người.
      const partialResults = (
        err as HttpException & { partialMintResults?: MintRecipientResult[] }
      ).partialMintResults;
      if (Array.isArray(partialResults) && partialResults.length > 0) {
        const partialByPreTicket = new Map(partialResults.map((r) => [r.preTicketId, r]));
        const partialMintedIds: string[] = [];
        for (const pt of minting) {
          const r = partialByPreTicket.get(pt.id);
          if (r?.ticketId) {
            partialMintedIds.push(pt.id);
          }
        }
        if (partialMintedIds.length > 0) {
          const mintedAt = new Date();
          for (const ptId of partialMintedIds) {
            const r = partialByPreTicket.get(ptId)!;
            await this.prisma.preTicket.updateMany({
              where: { id: ptId, status: 'MINTING' },
              data: {
                status: 'MINTED',
                contentTicketId: r.ticketId,
                contentTicketCode: r.ticketCode,
                mintedAt,
              },
            });
          }
          this.logger.log(
            `mintEager job=${job.id}: áp dụng ${partialMintedIds.length} vé mint thật từ các chunk thành công trước khi xử lý lỗi.`,
          );
          await this.audit.record({
            jobId: job.id,
            action: 'MINT_EAGER_PARTIAL_APPLIED',
            detail: { mintedBeforeError: partialMintedIds.length },
          });
        }
      }

      // 4b. Quota → ConflictException 409 + PreTickets EXPIRED (terminal).
      //     Chỉ PreTicket KHÔNG có trong partial results mới EXPIRED (MAJOR-1).
      const bizCode = (err as HttpException)?.getResponse
        ? ((err as HttpException).getResponse() as { code?: string })?.code
        : undefined;
      if (
        err instanceof HttpException &&
        err.getStatus() === 409 &&
        (bizCode === 'TICKET_SOLD_OUT' || bizCode === 'TICKET_QUOTA_EXCEEDED')
      ) {
        const body = err.getResponse() as { message?: string; remaining?: number; requested?: number };
        this.logger.warn(
          `[MINT-EAGER] job=${job.id} QUOTA_FAIL code=${bizCode} remaining=${body.remaining} requested=${body.requested} → PreTicket EXPIRED (terminal), job FAILED`,
        );
        await this.prisma.preTicket.updateMany({
          where: { jobId: job.id, status: 'MINTING' },
          data: { status: 'EXPIRED', lastMintError: body.message ?? 'Quota exceeded' },
        });
        await this.prisma.distributionJob.update({
          where: { id: job.id },
          data: { status: 'FAILED' },
        });
        await this.audit.record({
          jobId: job.id,
          action: 'MINT_EAGER_QUOTA_FAIL',
          detail: { code: bizCode, remaining: body.remaining, requested: body.requested },
        });
        throw new ConflictException({
          code: bizCode,
          message: body.message,
          remaining: body.remaining,
          requested: body.requested,
        });
      }

      // 5. Lỗi khác (5xx/transport/timeout) → giữ MINTING (idempotent retry),
      //    job FAILED, KHÔNG gửi email, KHÔNG rollback về PENDING.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `mintEager job=${job.id} FAILED — PreTickets giữ MINTING để retry idempotent: ${message}`,
      );
      await this.prisma.preTicket.updateMany({
        where: { jobId: job.id, status: 'MINTING' },
        data: { lastMintError: message },
      });
      await this.prisma.distributionJob.update({
        where: { id: job.id },
        data: { status: 'FAILED' },
      });
      throw err;
    }
  }

  /**
   * Finalize job status (DESIGN §4.5):
   *  - 0 MINTED → FAILED; một phần mint fail → PARTIALLY_MINTED;
   *    100% mint + email fail từng cái KHÔNG làm job fail → COMPLETED.
   */
  private async finalizeJobStatus(jobId: string): Promise<DistributionStatus> {
    const [minted, total] = await Promise.all([
      this.prisma.preTicket.count({ where: { jobId, status: { in: ['MINTED', 'LINKED', 'CLAIMED'] } } }),
      this.prisma.preTicket.count({ where: { jobId } }),
    ]);
    if (minted === 0) return DistributionStatus.FAILED;
    if (minted < total) return DistributionStatus.PARTIALLY_MINTED;
    return DistributionStatus.COMPLETED;
  }

  async list(page = 1, limit = 20) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));
    const [total, data] = await Promise.all([
      this.prisma.distributionJob.count(),
      this.prisma.distributionJob.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
    ]);
    return {
      data,
      meta: {
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.max(1, Math.ceil(total / safeLimit)),
      },
    };
  }

  async getStatus(jobId: string, includeFailed?: boolean) {
    const job = await this.prisma.distributionJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException(`Distribution job ${jobId} not found.`);
    // T5: mint counts cho MỌI call (spec mục 3 — UI cần 4 field ở mọi view),
    // không chỉ khi includeFailed=true.
    const mint = await this.getMintCounts(job.id);
    if (includeFailed) {
      const preTickets = await this.prisma.preTicket.findMany({ where: { jobId: job.id } });
      return { job, mint, preTickets };
    }
    return { job, mint };
  }

  /** T5: đếm PreTicket theo kết quả mint (chỉ job EAGER có dữ liệu). */
  private async getMintCounts(jobId: string) {
    const [minted, mintedWithUser, mintedEmailOnly, mintFailed] = await Promise.all([
      this.prisma.preTicket.count({
        where: { jobId, status: { in: ['MINTED', 'LINKED', 'CLAIMED'] } },
      }),
      this.prisma.preTicket.count({
        where: { jobId, status: { in: ['MINTED', 'LINKED', 'CLAIMED'] }, recipientUserId: { not: null } },
      }),
      this.prisma.preTicket.count({
        where: { jobId, status: { in: ['MINTED', 'LINKED', 'CLAIMED'] }, recipientUserId: null },
      }),
      this.prisma.preTicket.count({
        where: { jobId, status: { in: ['MINTING', 'EXPIRED'] }, lastMintError: { not: null } },
      }),
    ]);
    return { minted, mintedWithUser, mintedEmailOnly, mintFailed };
  }

  /**
   * T5 admin retry — mint lại PreTicket MINTING-fail của job
   * PARTIALLY_MINTED/FAILED (Δ5: retry = chỉ mint, KHÔNG email).
   * Idempotent: content dedupe theo preTicketId → vé đã mint trả về
   * alreadyMinted=true, sold không tăng → KHÔNG doubling.
   */
  async retryMint(jobId: string, adminId: string) {
    const job = await this.prisma.distributionJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException(`Distribution job ${jobId} not found.`);
    if (job.status !== 'PARTIALLY_MINTED' && job.status !== 'FAILED') {
      throw new ConflictException(
        `Job ${jobId} status ${job.status} — retry chỉ áp dụng cho PARTIALLY_MINTED/FAILED.`,
      );
    }

    // Chỉ retry PreTicket còn MINTING (fail transport/5xx); EXPIRED (quota) là
    // terminal — admin phát lại bằng job MỚI.
    const retryables = await this.prisma.preTicket.findMany({
      where: { jobId: job.id, status: 'MINTING' },
      select: { id: true, recipientEmailHash: true, recipientUserId: true },
    });
    if (retryables.length === 0) {
      throw new ConflictException(
        `Job ${jobId}: không có PreTicket MINTING để retry (EXPIRED là terminal — tạo distribution mới).`,
      );
    }
    this.logger.log(`[MINT-RETRY] job=${jobId} retry ${retryables.length} PreTicket MINTING → content mint`);

    const recipients = retryables.map((pt) => ({
      preTicketId: pt.id,
      emailHash: pt.recipientEmailHash,
      userId: pt.recipientUserId,
    }));

    let mintedCount = 0;
    let alreadyMintedCount = 0;
    try {
      const res = await this.content.mintForDistribution({
        eventId: job.eventId,
        ticketTypeId: job.ticketTypeId,
        recipients,
        idempotencyKey: job.id,
      });
      const resultByPreTicket = new Map(res.results.map((r) => [r.preTicketId, r]));
      const missing: string[] = [];
      const mintedAt = new Date();
      for (const pt of retryables) {
        const r = resultByPreTicket.get(pt.id);
        if (r?.ticketId) {
          // Guard MINTING: row đã MINTED (race với procs khác) → bỏ qua.
          const upd = await this.prisma.preTicket.updateMany({
            where: { id: pt.id, status: 'MINTING' },
            data: {
              status: 'MINTED',
              contentTicketId: r.ticketId,
              contentTicketCode: r.ticketCode,
              mintedAt,
              lastMintError: null,
            },
          });
          if (upd.count > 0) mintedCount++;
          if (r.alreadyMinted) alreadyMintedCount++;
        } else {
          missing.push(pt.id);
        }
      }
      if (missing.length > 0) {
        this.logger.error(
          `[CRITICAL] retryMint job=${jobId}: ${missing.length} preTicket thiếu ticketId trong response: ${missing.join(', ')}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.preTicket.updateMany({
        where: { jobId: job.id, status: 'MINTING' },
        data: { lastMintError: message },
      });
      await this.audit.record({
        jobId: job.id,
        action: 'MINT_RETRY_FAIL',
        detail: { adminId, message },
      });
      throw err;
    }

    // Finalize lại theo §4.5.
    const [minted, total] = await Promise.all([
      this.prisma.preTicket.count({
        where: { jobId: job.id, status: { in: ['MINTED', 'LINKED', 'CLAIMED'] } },
      }),
      this.prisma.preTicket.count({ where: { jobId: job.id } }),
    ]);
    const newStatus = minted === 0 ? 'FAILED' : minted < total ? 'PARTIALLY_MINTED' : 'COMPLETED';
    await this.prisma.distributionJob.update({
      where: { id: job.id },
      data: { status: newStatus },
    });
    await this.audit.record({
      jobId: job.id,
      action: 'MINT_RETRY_DONE',
      detail: { adminId, minted: mintedCount, alreadyMinted: alreadyMintedCount, total },
    });
    this.logger.log(
      `[MINT-RETRY] job=${job.id} DONE status=${newStatus} minted=${mintedCount} alreadyMinted=${alreadyMintedCount}`,
    );
    return {
      jobId: job.id,
      status: newStatus,
      retried: retryables.length,
      minted: mintedCount,
      alreadyMinted: alreadyMintedCount,
    };
  }

  /**
   * T5 admin resend-emails — gửi lại email cho PreTicket MINTED có
   * emailSentAt IS NULL (chỉ vé đã mint; Δ5 tách bạch khỏi retry mint).
   * Idempotent: sau lần 1 emailSentAt đã set → lần 2 trả về sent=0.
   */
  async resendEmails(jobId: string, adminId: string) {
    const job = await this.prisma.distributionJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException(`Distribution job ${jobId} not found.`);

    // Chỉ MINTED/LINKED + emailSentAt IS NULL (chưa từng gửi thành công).
    const pending = await this.prisma.preTicket.findMany({
      where: {
        jobId: job.id,
        status: { in: ['MINTED', 'LINKED'] },
        emailSentAt: null,
      },
      select: { claimToken: true },
    });
    if (pending.length === 0) {
      return { jobId: job.id, sent: 0, skipped: 0 };
    }

    // Email đích: resolve qua PortalUser theo emailHash (D3 — không lưu plaintext).
    const hashByToken = new Map<string, string>();
    const tokens = new Set(pending.map((pt) => pt.claimToken));
    const preTicketsAll = await this.prisma.preTicket.findMany({
      where: { jobId: job.id },
      select: {
        claimToken: true,
        recipientEmailHash: true,
        contentTicketCode: true,
        contentTicketId: true,
      },
    });
    const tktByToken = new Map(
      preTicketsAll.map((pt) => [pt.claimToken, pt]),
    );
    for (const pt of preTicketsAll) {
      if (tokens.has(pt.claimToken)) hashByToken.set(pt.claimToken, pt.recipientEmailHash);
    }
    const users = await this.prisma.portalUser.findMany({
      where: { emailHash: { in: [...hashByToken.values()] } },
      select: { emailHash: true, email: true, displayName: true },
    });
    const userByHash = new Map(users.map((u) => [u.emailHash, u]));

    const tt = await this.eventService.getTicketTypeWithEvent(job.ticketTypeId);
    const payloads: ClaimMailPayload[] = [];
    const tokenToHash = new Map<string, string>();
    for (const [token, hash] of hashByToken) {
      const user = userByHash.get(hash);
      if (!user) continue; // Không resolve được email (không PortalUser) — skip.
      tokenToHash.set(token, hash);
      payloads.push({
        jobId: job.id,
        email: user.email,
        claimToken: token,
        claimUrl: this.mailDispatcher.buildClaimUrl(token),
        ticketTypeName: job.ticketTypeName,
        eventName: job.eventName,
        eventDate: tt ? this.formatEventDate(tt.eventStartAt, tt.eventEndAt) : '',
        venue: tt?.venue ?? null,
        eventImage: tt?.eventImageUrl ?? null,
        customerName: user.displayName ?? 'Người dùng MAYogu',
        customerPhone: '',
        bookedAt: this.formatDateTime(job.createdAt),
        ticketCode: tktByToken.get(token)?.contentTicketCode ?? token.slice(-8).toUpperCase(),
        ticketId: tktByToken.get(token)?.contentTicketId ?? undefined,
      });
    }

    const result = await this.mailDispatcher.dispatchBatch(payloads);
    const okTokens = new Set(result.results.filter((r) => r.ok).map((r) => r.claimToken));
    if (okTokens.size > 0) {
      await this.prisma.preTicket.updateMany({
        where: { jobId: job.id, claimToken: { in: [...okTokens] } },
        data: { emailSentAt: new Date() },
      });
    }
    const skipped = pending.length - payloads.length;
    await this.audit.record({
      jobId: job.id,
      action: 'RESEND_EMAILS',
      detail: { adminId, sent: result.dispatched, failed: result.failed, skipped },
    });
    return { jobId: job.id, sent: result.dispatched, failed: result.failed, skipped };
  }

  private normalizeAndDedupe(emails: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of emails) {
      const email = normalizeEmailForLookup(raw);
      if (!email) continue;
      const hash = generateEmailHash(email);
      if (seen.has(hash)) continue;
      seen.add(hash);
      out.push(email);
    }
    return out;
  }

  private formatDateTime(iso?: string | Date | null): string {
    if (!iso) return '';
    const d = iso instanceof Date ? iso : new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /** "dd/MM/yyyy | HH:mm" hoặc "dd/MM/yyyy | HH:mm – HH:mm" khi có endTime. */
  private formatEventDate(start?: string | Date | null, end?: string | Date | null): string {
    if (!start) return '';
    const dStart = start instanceof Date ? start : new Date(start);
    if (Number.isNaN(dStart.getTime())) return '';
    const date = dStart.toLocaleDateString('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
    const time = dStart.toLocaleTimeString('vi-VN', {
      hour: '2-digit',
      minute: '2-digit',
    });
    if (!end) return `${date} | ${time}`;
    const dEnd = end instanceof Date ? end : new Date(end);
    if (Number.isNaN(dEnd.getTime())) return `${date} | ${time}`;
    const endtime = dEnd.toLocaleTimeString('vi-VN', {
      hour: '2-digit',
      minute: '2-digit',
    });
    return `${date} | ${time} – ${endtime}`;
  }
}
