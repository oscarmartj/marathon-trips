import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { loadConfig } from '../src/platform/config/config';
import { mintPaymentLinkToken } from '../src/modules/payments/core/payment-links.service';

/**
 * Mints the token of a booking's active payment link and prints { token } as JSON, so an end-to-end test can open the
 * link without reading a mailbox (task 5.1, review m6). It calls the same function as the email's send step, so the
 * same checks apply (link active and in date, booking able to pay its item, account open) and only the hash is
 * stored. Not an HTTP route; refuses to run outside test and ci. Usage: tsx scripts/e2e-payment-link.ts MT-XXXXXX
 */
async function main(): Promise<void> {
  const config = loadConfig();
  if (config.APP_ENV !== 'test' && config.APP_ENV !== 'ci') throw new Error('e2e-payment-link runs only with APP_ENV=test or ci');
  const reference = process.argv[2] ?? '';
  if (!/^MT-[0-9A-HJKMNP-TV-Z]{6}$/.test(reference)) throw new Error('give a booking reference');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: config.DATABASE_URL }) });
  try {
    const link = await prisma.paymentLink.findFirst({ where: { booking: { reference }, status: 'active' }, select: { id: true } });
    if (!link) throw new Error('no active payment link for this booking');
    const { token } = await prisma.$transaction((tx) => mintPaymentLinkToken(tx, link.id, 'test'));
    process.stdout.write(JSON.stringify({ token }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : 'e2e-payment-link failed');
  process.exit(1);
});
