import { Injectable } from '@nestjs/common';
import { AppError } from '../errors/safe-error';
import { moduleFlagKey } from './flags.service';

export interface FlagDef {
  key: string;
  description: string;
  /** Value the demo seed sets in development, test and ci. Elsewhere a missing flag is off (plan 4.8). */
  seedEnabled: boolean;
}

export const FLAGS = {
  customerSignIn: 'auth.customer_sign_in',
} as const;

/** The platform's own flags. Business modules add `module.<key>` through the module registry. */
export const PLATFORM_FLAGS: readonly FlagDef[] = [
  { key: FLAGS.customerSignIn, description: 'Customers can ask for a sign-in link and sign in', seedEnabled: true },
];

/** Flags declared in code; only these can be changed through the admin API (M12). */
@Injectable()
export class FlagRegistry {
  private readonly defs = new Map<string, FlagDef>();

  constructor() {
    for (const d of PLATFORM_FLAGS) this.declare(d);
  }

  declare(def: FlagDef): void {
    if (this.defs.has(def.key)) throw new AppError('flag_duplicate', `Flag ${def.key} is declared twice`);
    this.defs.set(def.key, def);
  }

  declareModule(module: string, description: string): void {
    this.declare({ key: moduleFlagKey(module), description, seedEnabled: true });
  }

  get(key: string): FlagDef | undefined {
    return this.defs.get(key);
  }

  all(): FlagDef[] {
    return [...this.defs.values()].sort((a, b) => a.key.localeCompare(b.key));
  }
}
