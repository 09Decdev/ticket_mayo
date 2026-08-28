import { IsEnum, IsInt, IsOptional, IsString, Min, Max } from 'class-validator';
import { Transform } from 'class-transformer';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export enum MailTransport {
  Console = 'console',
  Kafka = 'kafka',
  Smtp = 'smtp',
}

class EnvConfig {
  @IsString()
  DATABASE_URL!: string;

  @IsString()
  JWT_SECRET!: string;

  @IsString()
  FIELD_ENCRYPTION_PEPPER!: string;

  @IsString()
  ADMIN_EMAIL!: string;

  @IsString()
  ADMIN_PASSWORD!: string;

  @IsEnum(MailTransport)
  MAIL_TRANSPORT!: MailTransport;

  @IsOptional()
  @IsString()
  KAFKA_BROKERS?: string;

  /** SMTP transport (MAIL_TRANSPORT=smtp). */
  @IsOptional()
  @IsString()
  MAIL_HOST?: string;

  @Transform(({ value }: { value?: string }) => (value == null ? undefined : Number(value)))
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  MAIL_PORT?: number;

  @IsOptional()
  @IsString()
  MAIL_USER?: string;

  @IsOptional()
  @IsString()
  MAIL_PASS?: string;

  @IsOptional()
  @IsString()
  MAIL_FROM?: string;

  /** Base URL của content-service (nguồn sự thật event/ticket). Global prefix `content-service`. */
  @IsOptional()
  @IsString()
  CONTENT_SERVICE_BASE_URL?: string;

  /** Token nội bộ để gọi content-service internal APIs (x-service-token). */
  @IsOptional()
  @IsString()
  INTERNAL_SERVICE_TOKEN?: string;

  /**
   * Khóa ký HMAC-SHA256 recipient cho mint API (Δ11 VB3-2) — BẮT BUỘC:
   * mọi đợt phát vé đều mint ngay trong distribute() trước khi gửi email.
   * ≥32 chars, PHẢI khớp MINT_SIGNING_KEY của content-service, RIÊNG —
   * KHÔNG được reuse INTERNAL_SERVICE_TOKEN.
   */
  @IsString()
  MINT_SIGNING_KEY!: string;

  /** Base URL của user-community-service (lookup displayName người nhận). */
  @IsOptional()
  @IsString()
  USER_COMMUNITY_BASE_URL?: string;

  /** Thông tin thương hiệu in trong email vé (fallback nếu env thiếu). */
  @IsOptional()
  @IsString()
  SUPPORT_EMAIL?: string;

  @IsOptional()
  @IsString()
  SUPPORT_PHONE?: string;

  @IsOptional()
  @IsString()
  BRAND_LOGO_URL?: string;

  @IsOptional()
  @IsString()
  NOTICE_ICON_URL?: string;

  @IsOptional()
  @IsString()
  DEFAULT_BANNER_URL?: string;

  @IsOptional()
  @IsString()
  APP_STORE_URL?: string;

  @IsOptional()
  @IsString()
  GOOGLE_PLAY_URL?: string;

  @IsString()
  PUBLIC_BASE_URL!: string;

  /** Base URL cho universal link nhận vé (mở app nếu đã cài, chưa cài về trang tải app). */
  @IsOptional()
  @IsString()
  APP_UNIVERSAL_LINK_BASE?: string;

  /** Public base URL của backend API (cho nút "Tải vé PDF"). Dev fallback localhost:PORT. */
  @IsOptional()
  @IsString()
  TICKET_MAYO_BASE_URL?: string;

  @Transform(({ value }: { value?: string }) => (value == null ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT!: number;

  @IsEnum(NodeEnv)
  NODE_ENV!: NodeEnv;
}

type RawEnv = Record<keyof EnvConfig, string | undefined>;

function loadRaw(): RawEnv {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dotenv = require('dotenv');
  dotenv.config();

  return {
    DATABASE_URL: process.env.DATABASE_URL,
    JWT_SECRET: process.env.JWT_SECRET,
    FIELD_ENCRYPTION_PEPPER: process.env.FIELD_ENCRYPTION_PEPPER,
    ADMIN_EMAIL: process.env.ADMIN_EMAIL,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    MAIL_TRANSPORT: process.env.MAIL_TRANSPORT ?? MailTransport.Console,
    KAFKA_BROKERS: process.env.KAFKA_BROKERS,
    MAIL_HOST: process.env.MAIL_HOST,
    MAIL_PORT: process.env.MAIL_PORT,
    MAIL_USER: process.env.MAIL_USER,
    MAIL_PASS: process.env.MAIL_PASS,
    MAIL_FROM: process.env.MAIL_FROM,
    CONTENT_SERVICE_BASE_URL:
      process.env.CONTENT_SERVICE_BASE_URL ?? 'http://localhost:30041',
    INTERNAL_SERVICE_TOKEN: process.env.INTERNAL_SERVICE_TOKEN ?? '',
    MINT_SIGNING_KEY: process.env.MINT_SIGNING_KEY ?? '',
    USER_COMMUNITY_BASE_URL:
      process.env.USER_COMMUNITY_BASE_URL ?? 'http://localhost:3001',
    SUPPORT_EMAIL: process.env.SUPPORT_EMAIL ?? 'support@mayogu.com',
    SUPPORT_PHONE: process.env.SUPPORT_PHONE ?? '0966 855 560',
    BRAND_LOGO_URL: process.env.BRAND_LOGO_URL ?? '',
    NOTICE_ICON_URL:
      process.env.NOTICE_ICON_URL ??
      'https://placehold.co/19x18/1f2937/ffffff.png?text=%E2%9C%8E',
    DEFAULT_BANNER_URL:
      process.env.DEFAULT_BANNER_URL ??
      'https://placehold.co/600x313/1e1b2e/8b5cf6.png?text=MAYogu+Event',
    APP_STORE_URL: process.env.APP_STORE_URL ?? 'https://apps.apple.com/vn/app/mayogu/id6755509373',
    GOOGLE_PLAY_URL: process.env.GOOGLE_PLAY_URL ?? 'https://play.google.com/store/apps/details?id=com.mayogu.app&pcampaignid=web_share',
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL ?? 'http://localhost:5174',
    APP_UNIVERSAL_LINK_BASE:
      process.env.APP_UNIVERSAL_LINK_BASE ?? process.env.PUBLIC_BASE_URL ?? 'http://localhost:5174',
    TICKET_MAYO_BASE_URL: process.env.TICKET_MAYO_BASE_URL ?? '',
    PORT: process.env.PORT ?? '3005',
    NODE_ENV: process.env.NODE_ENV ?? NodeEnv.Development,
  };
}

function buildEnv(): EnvConfig {
  const raw = loadRaw();
  const required: (keyof RawEnv)[] = [
    'DATABASE_URL',
    'JWT_SECRET',
    'FIELD_ENCRYPTION_PEPPER',
    'ADMIN_EMAIL',
    'ADMIN_PASSWORD',
  ];
  const missing = required.filter((k) => raw[k] == null);
  if (missing.length > 0) {
    throw new Error(
      `[env] missing required variables: ${missing.join(', ')}. Check .env / .env.example.`,
    );
  }
  if (raw.MAIL_TRANSPORT === MailTransport.Kafka && !raw.KAFKA_BROKERS) {
    throw new Error(
      '[env] MAIL_TRANSPORT=kafka requires KAFKA_BROKERS to be set, or switch MAIL_TRANSPORT=console.',
    );
  }
  if (raw.MAIL_TRANSPORT === MailTransport.Smtp && !raw.MAIL_HOST) {
    throw new Error(
      '[env] MAIL_TRANSPORT=smtp requires MAIL_HOST/MAIL_PORT/MAIL_USER/MAIL_PASS to be set.',
    );
  }
  // Mint là bắt buộc ở mọi đợt phát vé (email chỉ gửi sau khi vé đã trừ ở
  // content) → MINT_SIGNING_KEY luôn phải có, ≥32 chars, fail-loud lúc boot
  // tránh sản xuất chạy nửa chừng mới fail từng mint call.
  const mintKey = raw.MINT_SIGNING_KEY ?? '';
  if (mintKey.length < 32) {
    throw new Error(
      '[env] MINT_SIGNING_KEY (bắt buộc, ≥32 chars) phải được cấu hình và khớp ' +
        'với content-service MINT_SIGNING_KEY. Generate: openssl rand -hex 32.',
    );
  }
  const result = new EnvConfig();
  (Object.keys(raw) as (keyof RawEnv)[]).forEach((k) => {
    (result as unknown as Record<string, unknown>)[k] = raw[k];
  });
  return result;
}

export const env: EnvConfig = buildEnv();
