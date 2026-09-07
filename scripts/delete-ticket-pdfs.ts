/**
 * XÓA TOÀN BỘ PDF trong bucket SeaweedFS S3 (ticket-email-pdfs) — CLI
 * idempotent, DRY-RUN mặc định, --apply phải gõ "DELETE" (--yes cho CI).
 * STDOUT JSON, STDERR log — convention scripts/repoint-pretickets.ts.
 *
 * Chỉ đụng S3 — KHÔNG đụng DB/content-service. Sau khi xóa, zip download
 * sẽ liệt kê thiếu PDF (_THIEU_PDF.txt); muốn in lại thì tạo job PRINT mới.
 *
 * Chạy: npx ts-node --transpile-only scripts/delete-ticket-pdfs.ts            (dry-run)
 *       npx ts-node --transpile-only scripts/delete-ticket-pdfs.ts --apply    (gõ DELETE)
 *       npx ts-node --transpile-only scripts/delete-ticket-pdfs.ts --apply --yes
 * Tuỳ chọn: --prefix print/  (mặc định: xóa mọi object trong bucket)
 */
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { env } from '../src/config/env';

interface Args {
  prefix?: string;
  apply: boolean;
  yes: boolean;
}

function parseArgs(argv: string[]): Args {
  const prefixIdx = argv.indexOf('--prefix');
  return {
    prefix: prefixIdx >= 0 ? argv[prefixIdx + 1] : undefined,
    apply: argv.includes('--apply'),
    yes: argv.includes('--yes'),
  };
}

async function confirm(): Promise<boolean> {
  const answer = await new Promise<string>((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('end', () => resolve(''));
    process.stdin.once('close', () => resolve(''));
    process.stdin.once('data', (d) => resolve(String(d).trim()));
  });
  return answer === 'DELETE';
}

async function listAllKeys(client: S3Client, bucket: string, prefix?: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = res.NextContinuationToken;
  } while (token);
  return keys;
}

async function main(): Promise<number> {
  if (!env.S3_ENDPOINT || !env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) {
    process.stderr.write('Thiếu S3_ENDPOINT / S3_ACCESS_KEY / S3_SECRET_KEY trong .env.\n');
    return 1;
  }
  const { prefix, apply, yes } = parseArgs(process.argv.slice(2));
  // SeaweedFS chỉ listen IPv4 → rewrite localhost → 127.0.0.1 như getClient.
  const endpoint = (env.S3_ENDPOINT as string).replace(/^http:\/\/localhost/, 'http://127.0.0.1');
  const bucket = env.S3_TICKET_PDF_BUCKET ?? 'ticket-email-pdfs';
  const client = new S3Client({
    region: 'us-east-1',
    endpoint,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY as string,
      secretAccessKey: env.S3_SECRET_KEY as string,
    },
    forcePathStyle: true,
  });

  const keys = await listAllKeys(client, bucket, prefix);
  const log = (m: string) => process.stderr.write(m + '\n');
  log(`Bucket ${bucket} | prefix=${prefix ?? '(toàn bucket)'} | tìm thấy ${keys.length} object.`);

  if (keys.length === 0) {
    process.stdout.write(JSON.stringify({ bucket, prefix: prefix ?? null, deleted: 0, remaining: 0 }, null, 2) + '\n');
    return 0;
  }
  for (const k of keys.slice(0, 5)) log(`  VD: ${k}`);
  if (keys.length > 5) log(`  ... và ${keys.length - 5} object khác.`);

  if (!apply) {
    process.stdout.write(
      JSON.stringify(
        {
          bucket,
          prefix: prefix ?? null,
          mode: 'dry-run',
          wouldDelete: keys.length,
          sample: keys.slice(0, 10),
        },
        null,
        2,
      ) + '\n',
    );
    log('DRY-RUN — chạy lại với --apply (gõ DELETE) để xóa thật.');
    return 0;
  }

  if (!yes && !(await confirm())) {
    log('Hủy. Không xóa gì.');
    return 0;
  }

  // DeleteObjectsCommand tối đa 1000 key/lần → chia batch.
  let deleted = 0;
  const errors: unknown[] = [];
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    const res = await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }),
    );
    deleted += batch.length - (res.Errors?.length ?? 0);
    for (const e of res.Errors ?? []) errors.push(e);
  }
  const remainingKeys = await listAllKeys(client, bucket, prefix);
  process.stdout.write(
    JSON.stringify(
      {
        bucket,
        prefix: prefix ?? null,
        mode: 'apply',
        requested: keys.length,
        deleted,
        errors,
        remaining: remainingKeys.length,
      },
      null,
      2,
    ) + '\n',
  );
  log(`Đã xóa ${deleted}/${keys.length}; còn lại ${remainingKeys.length} object.`);
  return errors.length > 0 || remainingKeys.length > 0 ? 4 : 0;
}

main().then((code) => process.exit(code));
