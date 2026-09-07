/**
 * Tạo bucket PDF vé trên SeaweedFS S3 — CLI idempotent (chạy được nhiều lần).
 *
 * Dùng khi cần chuẩn bị bucket TRƯỚC khi chạy ticket-mayo (service cũng tự
 * ensureBucket lúc boot nếu S3_* được cấu hình). Đọc env qua src/config/env
 * (dotenv tự load .env ở repo root).
 *
 * Chạy: npm run s3:ensure-bucket
 *   hoặc: npx ts-node --transpile-only scripts/ensure-ticket-bucket.ts
 */
import {
  BucketAlreadyExists,
  BucketAlreadyOwnedByYou,
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { env } from '../src/config/env';

async function main(): Promise<number> {
  if (!env.S3_ENDPOINT || !env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) {
    process.stderr.write(
      'Thiếu S3_ENDPOINT / S3_ACCESS_KEY / S3_SECRET_KEY trong .env — không tạo bucket.\n',
    );
    return 1;
  }
  const endpoint = (env.S3_ENDPOINT as string).replace(
    /^http:\/\/localhost/,
    'http://127.0.0.1',
  );
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

  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    process.stdout.write(`Bucket đã tồn tại: ${bucket}\n`);
    return 0;
  } catch {
    // chưa có → create
  }
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    process.stdout.write(`Đã tạo bucket ${bucket} (private — PDF chứa PII).\n`);
    return 0;
  } catch (err) {
    if (err instanceof BucketAlreadyExists || err instanceof BucketAlreadyOwnedByYou) {
      process.stdout.write(`Bucket đã tồn tại (race): ${bucket}\n`);
      return 0;
    }
    process.stderr.write(`Tạo bucket thất bại: ${(err as Error).message}\n`);
    return 1;
  }
}

main().then((code) => process.exit(code));
