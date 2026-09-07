const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const ev = await prisma.event.findUnique({ where: { id: '1acae842-08d4-4a10-a04c-097b9aeed234' }, select: { name: true, serialPrefix: true } });
  console.log('EVENT:', JSON.stringify(ev));
  const tt = await prisma.ticketType.findUnique({ where: { id: '9f8cd810-7dcf-4f3d-b808-f6fd34952976' }, select: { name: true, typeCode: true, quantity: true, sold: true } });
  console.log('TICKET TYPE:', JSON.stringify(tt));
  const seq = await prisma.$queryRaw`SELECT last_value, is_called FROM ticket_global_seq`;
  console.log('SEQ:', JSON.stringify(seq));
}
main().catch((e) => { console.error(e.message); process.exit(1); }).finally(() => prisma.$disconnect());
