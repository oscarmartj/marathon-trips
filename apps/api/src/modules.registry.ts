import type { Type } from '@nestjs/common';
import { AlertsModule } from './modules/alerts';
import { BookingsModule } from './modules/bookings';
import { CatalogueModule } from './modules/catalogue';
import { ContentModule } from './modules/content';
import { PricingModule } from './modules/pricing';
import { SuppliersModule } from './modules/suppliers';
import { WaitlistModule } from './modules/waitlist';

// The single list of business modules. Adding a module = a folder, its .prisma file and one line here.
export const MODULES: ReadonlyArray<Type<unknown>> = [CatalogueModule, PricingModule, AlertsModule, SuppliersModule, ContentModule, WaitlistModule, BookingsModule];
