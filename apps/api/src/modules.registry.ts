import type { Type } from '@nestjs/common';
import { AlertsModule } from './modules/alerts';
import { AutomationsModule } from './modules/automations';
import { BookingsModule } from './modules/bookings';
import { CrmModule } from './modules/crm';
import { CatalogueModule } from './modules/catalogue';
import { ComplaintsModule } from './modules/complaints';
import { ContentModule } from './modules/content';
import { KeyDatesModule } from './modules/keydates';
import { ReportsModule } from './modules/reports';
import { PaymentsModule } from './modules/payments';
import { PricingModule } from './modules/pricing';
import { SuppliersModule } from './modules/suppliers';
import { TemplatesModule } from './modules/templates';
import { WaitlistModule } from './modules/waitlist';

// The single list of business modules. Adding a module = a folder, its .prisma file and one line here.
export const MODULES: ReadonlyArray<Type<unknown>> = [CatalogueModule, PricingModule, AlertsModule, SuppliersModule, ContentModule, WaitlistModule, BookingsModule, CrmModule, PaymentsModule, TemplatesModule, ComplaintsModule, AutomationsModule, KeyDatesModule, ReportsModule];
