// Copy fonts Roboto (src/assets/fonts) vào dist/assets/fonts sau build —
// TicketPdfService.getFontBuffer resolve cả 2 nơi, dist-side copy đảm bảo
// `node dist/main` tìm thấy font bất kể cwd chạy ở đâu (PM2/systemd).
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const src = join(process.cwd(), 'src', 'assets', 'fonts');
const dest = join(process.cwd(), 'dist', 'assets', 'fonts');

if (existsSync(src)) {
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log(`[copy-pdf-assets] copied fonts → ${dest}`);
} else {
  console.warn(`[copy-pdf-assets] ${src} không tồn tại — bỏ qua (font sẽ fallback Helvetica).`);
}

const srcImg = join(process.cwd(), 'src', 'assets', 'images');
const destImg = join(process.cwd(), 'dist', 'assets', 'images');
if (existsSync(srcImg)) {
  mkdirSync(destImg, { recursive: true });
  cpSync(srcImg, destImg, { recursive: true });
  console.log(`[copy-pdf-assets] copied images → ${destImg}`);
}

