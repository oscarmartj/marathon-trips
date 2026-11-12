import { Injectable } from '@nestjs/common';
import { AppError } from '../../platform/errors/safe-error';
import type { Tx } from './support';

export interface GatedPackage {
  id: string;
  editionId: string;
  currency: string;
}

/** A reason a package may not open yet; the message is fixed text. */
export type OpenGateResult = { code: string; message: string } | null;
export type OpenGate = (tx: Tx, pkg: GatedPackage) => Promise<OpenGateResult>;

/**
 * Extra conditions for moving a package to `open` (plan 6.1). Catalogue itself checks the deposit; pricing (2.1)
 * registers "a published, current and complete price version" here, so catalogue never imports pricing. The same
 * gates run again after any change to the options of a package on sale (plan 2.1, G1).
 */
@Injectable()
export class PackageOpenGates {
  private readonly gates = new Map<string, OpenGate>();

  register(name: string, gate: OpenGate): void {
    if (this.gates.has(name)) throw new AppError('open_gate_duplicate', `Open gate ${name} is already registered`);
    this.gates.set(name, gate);
  }

  names(): string[] {
    return [...this.gates.keys()];
  }

  async firstFailure(tx: Tx, pkg: GatedPackage): Promise<OpenGateResult> {
    for (const gate of this.gates.values()) {
      const r = await gate(tx, pkg);
      if (r) return r;
    }
    return null;
  }
}

/** Something about to be removed or changed in the catalogue; ids and flags only. */
export type ChangeTarget =
  | { kind: 'room'; roomOptionId: string; packageId: string }
  | { kind: 'entry_option'; packageId: string; raceDistanceId: string }
  | { kind: 'distance'; raceDistanceId: string }
  /** An extra whose price meaning changes: per person ↔ per booking, or who must or may take it. */
  | { kind: 'extra_terms'; extraId: string; packageId: string; pricingUnitChanged: boolean; termsChanged: boolean; onSale: boolean };
export type ChangeGuard = (tx: Tx, target: ChangeTarget) => Promise<OpenGateResult>;

/**
 * Checks other modules register before the catalogue removes a room, an entry option or a distance, or changes how an
 * extra is priced (plan 2.1, G1 and code review round 1): pricing refuses while rates depend on it, so the answer is a
 * clear 409, never a foreign-key error and never a price that changes without a new price version.
 */
@Injectable()
export class CatalogueChangeGuards {
  private readonly guards = new Map<string, ChangeGuard>();

  register(name: string, guard: ChangeGuard): void {
    if (this.guards.has(name)) throw new AppError('change_guard_duplicate', `Change guard ${name} is already registered`);
    this.guards.set(name, guard);
  }

  async firstFailure(tx: Tx, target: ChangeTarget): Promise<OpenGateResult> {
    for (const guard of this.guards.values()) {
      const r = await guard(tx, target);
      if (r) return r;
    }
    return null;
  }
}
