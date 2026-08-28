/**
 * T7 — Backfill PreTicket PENDING → EAGER mint — CLI entry (thin wrapper).
 *
 * Toàn bộ logic nằm ở src/modules/distribution/backfill.runner.ts (importable
 * — jest rootDir=src không scan scripts/). File này chỉ: parse args, new các
 * service thật (manual instantiation — không Nest runtime, đủ vì cả 3 service
 * constructor no-arg hoặc chỉ nhận PrismaService), in JSON ra STDOUT (Δ5 — UI
 * import được), log người đọc ra STDERR, exit code.
 *
 * lazy-mint runtime kept until GA (PRD Story G).
 */
import { Logger } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { ContentClientService } from '../src/modules/content-client/content-client.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { parseArgs, parseDbHost, runBackfill } from '../src/modules/distribution/backfill.runner';

const logErr = (...a: unknown[]) => process.stderr.write(a.join(' ') + '\n');

async function main(): Promise<number> {
  // Δ5: STDOUT chỉ chứa JSON cuối — Nest Logger mặc định ghi console.log ra
  // stdout (dòng "Prisma connected"...) sẽ làm bẩn document. Tắt toàn bộ Nest
  // logger; mọi log người đọc đã đi qua logErr → STDERR.
  Logger.overrideLogger(false);

  const opts = parseArgs(process.argv.slice(2));
  const dbHost = parseDbHost(process.env.DATABASE_URL ?? '');

  const prisma = new PrismaService();
  const content = new ContentClientService();
  const audit = new AuditService(prisma);
  await prisma.onModuleInit();

  try {
    const res = await runBackfill(
      { prisma, content, audit },
      {
        dryRun: opts.dryRun,
        jobIdFilter: opts.jobId,
        verifyRedis: opts.verifyRedis,
        dbHost,
        log: logErr,
        // Real-run guard: --yes bỏ prompt (CI); ngược lại phải gõ đúng BACKFILL.
        confirm: opts.yes
          ? async () => {
              logErr('--yes — bỏ qua prompt (CI mode).');
              return true;
            }
          : async () => {
              const answer = await new Promise<string>((resolve) => {
                process.stdin.setEncoding('utf8');
                // MINOR-1: stdin đóng (</dev/null, CI) không --yes → 'end'/
                // 'close' phải resolve '' (không đợi 'data' vĩnh viễn — treo).
                process.stdin.once('end', () => resolve(''));
                process.stdin.once('close', () => resolve(''));
                process.stdin.once('data', (d) => resolve(String(d).trim()));
              });
              return answer === 'BACKFILL';
            },
      },
    );
    if (res.report) {
      process.stdout.write(JSON.stringify(res.report, null, 2) + '\n');
    }
    if (res.aborted) {
      logErr('Nhận được đáp án ≠ "BACKFILL" — hủy. Không đụng gì (exit 0).');
    }
    return res.exitCode;
  } finally {
    await prisma.onModuleDestroy().catch(() => undefined);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    logErr(`[FATAL] ${(err as Error).stack ?? err}`);
    process.exit(1);
  });
