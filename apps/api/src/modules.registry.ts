import type { Type } from '@nestjs/common';
import { CatalogueModule } from './modules/catalogue';
import { PricingModule } from './modules/pricing';

// The single list of business modules. Adding a module = a folder, its .prisma file and one line here.
export const MODULES: ReadonlyArray<Type<unknown>> = [CatalogueModule, PricingModule];
