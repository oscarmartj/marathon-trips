import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings';
import { PaymentsModule } from '../payments';
import { TemplatesModule } from '../templates';
import { CustomerAccountService } from './account.service';
import { CustomerAccountController } from './controller';
import { DocumentRateLimitGuard } from './rate-limit.guard';

/** The customer area (task 5.1): no tables, no permissions, no flag; it reads through other modules' public services. */
@Module({
  imports: [BookingsModule, PaymentsModule, TemplatesModule],
  controllers: [CustomerAccountController],
  providers: [CustomerAccountService, DocumentRateLimitGuard],
})
export class CustomerPortalModule {}
