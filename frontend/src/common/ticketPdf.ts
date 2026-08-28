import { PDFDocument } from 'pdf-lib';
import type { TicketView } from '../api/types';

/**
 * Tạo file PDF của toàn bộ "template vé" (banner + thông tin vé + mã QR)
 * bằng cách vẽ lên canvas A4 @300dpi rồi nhúng 1 ảnh JPEG vào PDF qua pdf-lib
 * — không cần html2canvas, ảnh banner qua proxy backend nên không vướng CORS.
 */

// A4 @ 300 DPI
const CANVAS_W = 2480;
const CANVAS_H = 3508;

const STATUS_LABEL: Record<string, string> = {
  VALID: 'Còn hiệu lực',
  USED: 'Đã check-in',
  CANCELLED: 'Đã hủy',
};

const STATUS_COLOR: Record<string, string> = {
  VALID: '#16a34a',
  USED: '#d97706',
  CANCELLED: '#dc2626',
};

const TEXT_DARK = '#0f172a';
const TEXT_MUTED = '#64748b';
const ACCENT = '#4f46e5';
const LINE = '#e2e8f0';

export interface TicketPdfSource {
  ticket: TicketView;
  /** Canvas QR từ qrcode.react trên trang — vẽ trực tiếp (giữ nét, không tainted). */
  qrCanvas: HTMLCanvasElement | null;
  /** Bytes banner ảnh — lấy qua GET /tickets/:id/image (same-origin). null → gradient. */
  bannerBlob: Blob | null;
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width > maxWidth && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    } else {
      cur = next;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  const out = lines.map((l) => (ctx.measureText(l).width > maxWidth ? truncate(ctx, l, maxWidth) : l));
  return out;
}

function truncate(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
  return t + '…';
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const BANNER_H = 1100;

function drawBanner(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, eventName: string, banner: HTMLImageElement | null) {
  if (banner) {
    // cover-crop: giữ tỷ lệ ảnh, cắt thừa theo chiều ngang
    const sy = 0;
    const sx = (banner.width - (BANNER_H * banner.width) / canvas.width) / 2;
    const sWidth = (BANNER_H * banner.width) / canvas.width;
    ctx.drawImage(banner, Math.max(sx, 0), sy, sWidth, banner.height, 0, 0, canvas.width, BANNER_H);
  } else {
    const g = ctx.createLinearGradient(0, 0, canvas.width, BANNER_H);
    g.addColorStop(0, '#4f46e5');
    g.addColorStop(1, '#7c3aed');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, BANNER_H);
  }

  // overlay tối ở đáy banner để chữ đọc được
  const ov = ctx.createLinearGradient(0, BANNER_H - 320, 0, BANNER_H);
  ov.addColorStop(0, 'rgba(15,23,42,0)');
  ov.addColorStop(1, 'rgba(15,23,42,0.62)');
  ctx.fillStyle = ov;
  ctx.fillRect(0, BANNER_H - 320, canvas.width, 320);

  ctx.fillStyle = '#ffffff';
  ctx.font = '700 84px system-ui, -apple-system, "Segoe UI", sans-serif';
  const lines = wrapLines(ctx, eventName, canvas.width - 240, 2);
  let y = BANNER_H - 110;
  for (const line of lines) {
    ctx.fillText(line, 120, y);
    y += 100;
  }
}

function drawStatusPill(ctx: CanvasRenderingContext2D, status: string, x: number, y: number) {
  const label = STATUS_LABEL[status] ?? status;
  const color = STATUS_COLOR[status] ?? TEXT_MUTED;
  ctx.font = '600 44px system-ui, sans-serif';
  const w = ctx.measureText(label).width + 88;
  ctx.fillStyle = color;
  roundRect(ctx, x, y - 62, w, 88, 44);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, x + 44, y + 8);
}

export async function downloadTicketPdf(src: TicketPdfSource): Promise<void> {
  const { ticket } = src;
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Trình duyệt không hỗ trợ canvas.');

  let banner: HTMLImageElement | null = null;
  if (src.bannerBlob) {
    try {
      const url = URL.createObjectURL(src.bannerBlob);
      try {
        banner = await new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('banner load fail'));
          img.src = url;
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch {
      banner = null; // fallback gradient — không làm hỏng PDF
    }
  }

  // nền trắng
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  drawBanner(ctx, canvas, ticket.event.name, banner);

  // header dưới banner
  ctx.font = '600 40px system-ui, sans-serif';
  ctx.fillStyle = ACCENT;
  ctx.fillText('VÉ ĐIỆN TỬ', 120, BANNER_H + 150);
  ctx.font = '500 40px system-ui, sans-serif';
  ctx.fillStyle = TEXT_MUTED;
  ctx.textAlign = 'right';
  ctx.fillText(`ticket-mayo · ${ticket.ticketCode}`, CANVAS_W - 120, BANNER_H + 150);
  ctx.textAlign = 'left';

  // title
  ctx.font = '700 68px system-ui, sans-serif';
  ctx.fillStyle = TEXT_DARK;
  const titleLines = wrapLines(ctx, `${ticket.event.name} — ${ticket.ticketType.name}`, 1480, 2);
  let ty = BANNER_H + 250;
  for (const line of titleLines) {
    ctx.fillText(line, 120, ty);
    ty += 84;
  }

  // divider
  const dividerY = ty + 40;
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(120, dividerY);
  ctx.lineTo(CANVAS_W - 120, dividerY);
  ctx.stroke();

  // info rows (trái) + QR (phải)
  const rows: Array<[string, string | null]> = [
    ['Mã vé', ticket.ticketCode],
    ['Loại vé', ticket.ticketType.name],
    ['Sự kiện', ticket.event.name],
    ['Trạng thái', null],
    ['Check-in lúc', ticket.checkedInAt ? new Date(ticket.checkedInAt).toLocaleString('vi-VN') : 'Chưa check-in'],
  ];
  let rowY = dividerY + 120;
  ctx.font = '500 40px system-ui, sans-serif';
  for (const [label, value] of rows) {
    ctx.fillStyle = TEXT_MUTED;
    ctx.fillText(label, 120, rowY);
    ctx.font = '600 52px system-ui, sans-serif';
    ctx.fillStyle = TEXT_DARK;
    if (label === 'Trạng thái') {
      drawStatusPill(ctx, ticket.status, 120, rowY + 30);
    } else {
      ctx.fillText(value ?? '—', 120, rowY);
    }
    ctx.font = '500 40px system-ui, sans-serif';
    rowY += 128;
  }

  // QR card
  const qrX = 1500;
  const qrY = dividerY + 90;
  const cardW = CANVAS_W - qrX - 120;
  const cardH = 880;
  ctx.fillStyle = '#f8fafc';
  roundRect(ctx, qrX, qrY, cardW, cardH, 40);
  ctx.fill();
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 3;
  roundRect(ctx, qrX, qrY, cardW, cardH, 40);
  ctx.stroke();

  const qrSize = 620;
  const qrCenterX = qrX + cardW / 2 - qrSize / 2;
  const qrCenterY = qrY + (cardH - qrSize) / 2 - 60;
  if (src.qrCanvas) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src.qrCanvas, qrCenterX, qrCenterY, qrSize, qrSize);
    ctx.imageSmoothingEnabled = true;
  } else {
    ctx.fillStyle = LINE;
    ctx.fillRect(qrCenterX, qrCenterY, qrSize, qrSize);
  }
  ctx.font = '500 36px system-ui, sans-serif';
  ctx.fillStyle = TEXT_MUTED;
  ctx.textAlign = 'center';
  ctx.fillText('Đưa mã QR cho nhân viên check-in', qrX + cardW / 2, qrCenterY + qrSize + 90);
  ctx.textAlign = 'left';

  // footer
  ctx.font = '400 36px system-ui, sans-serif';
  ctx.fillStyle = TEXT_MUTED;
  ctx.textAlign = 'center';
  ctx.fillText(`Vé điện tử do ticket-mayo phát hành · Giữ mã QR để check-in tại sự kiện`, CANVAS_W / 2, CANVAS_H - 100);
  ctx.textAlign = 'left';

  const jpeg = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Không tạo được ảnh PDF.'))), 'image/jpeg', 0.88);
  });

  const pdf = await PDFDocument.create();
  const img = await pdf.embedJpg(new Uint8Array(await jpeg.arrayBuffer()));
  const page = pdf.addPage([595.28, 841.89]); // A4 pt
  const scale = Math.min(595.28 / img.width, 841.89 / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  page.drawImage(img, { x: (595.28 - w) / 2, y: (841.89 - h) / 2, width: w, height: h });
  const bytes = await pdf.save();

  const safeCode = ticket.ticketCode.replace(/[^A-Za-z0-9_-]/g, '-') || 've';
  const blobPdf = new Blob([bytes as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blobPdf);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ve-${safeCode}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}