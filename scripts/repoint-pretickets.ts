/**
 * MERGE-REPOINT — CLI entry (thin wrapper; convention scripts/backfill-mint.ts:
 * logic importable ở src/modules/distribution/merge-repoint.runner.ts,
 * STDOUT JSON, STDERR log, xác nhận gõ tay khi --apply).
 *
 * Chạy TRƯỚC khi merge phía content-service:
 *   # 1) DRY-RUN:
 *   DATABASE_URL=... npx ts-node scripts/repoint-pretickets.ts \
 *     --survivor <ticketTypeIdGiữLại> --merge <loserId1,loserId2> \
 *     [--survivor-name "Vé chung"] [--include-terminal]
 *
 *   # 2) APPLY (gõ REPOINT để xác nhận; --yes cho CI):
 *   ... --apply
 *
 *   # 3) ROLLBACK:
 *   ... --rollback <auditId> --apply
 */
import { PrismaService } from '../src/prisma/prisma.service';
import {
  applyRepoint,
  parseRepointArgs,
  planRepoint,
  rollbackRepoint,
} from '../src/modules/distribution/merge-repoint.runner';

const logErr = (...a: unknown[]) => process.stderr.write(a.join(' ') + '\n');

async function confirm(): Promise<boolean> {
  const answer = await new Promise<string>((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('end', () => resolve(''));
    process.stdin.once('close', () => resolve(''));
    process.stdin.once('data', (d) => resolve(String(d).trim()));
  });
  return answer === 'REPOINT';
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseRepointArgs(process.argv.slice(2));
  } catch (e) {
    logErr(`[ARG ERROR] ${(e as Error).message}`);
    return 2;
  }
  const prisma = new PrismaService();
  await prisma.onModuleInit();
  try {
    if (parsed.rollback) {
      if (!process.argv.includes('--apply')) {
        logErr('Rollback cần --apply.');
        return 2;
      }
      if (!process.argv.includes('--yes') && !(await confirm())) {
        logErr('Hủy.');
        return 0;
      }
      const r = await rollbackRepoint(prisma, parsed.rollback);
      process.stdout.write(JSON.stringify({ mode: 'rollback', ...r }, null, 2) + '\n');
      return 0;
    }
    const { input } = parsed;
    const plan = await planRepoint(prisma, input);
    for (const b of plan.blockers) logErr(`[BLOCKER] ${b}`);
    for (const w of plan.warnings) logErr(`[WARN] ${w}`);
    if (input.dryRun) {
      process.stdout.write(JSON.stringify({ mode: 'dry-run', plan }, null, 2) + '\n');
      logErr(plan.ok ? 'DRY-RUN OK — chạy --apply để thực thi.' : 'DRY-RUN: còn blocker.');
      return plan.ok ? 0 : 3;
    }
    if (!plan.ok) return 3;
    if (!process.argv.includes('--yes') && !(await confirm())) {
      logErr('Hủy. Không đụng gì.');
      return 0;
    }
    const r = await applyRepoint(prisma, input, logErr);
    process.stdout.write(JSON.stringify({ mode: 'apply', ...r, plan }, null, 2) + '\n');
    logErr(`APPLY OK. Rollback: npx ts-node scripts/repoint-pretickets.ts --rollback ${r.auditId} --apply`);
    return 0;
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
