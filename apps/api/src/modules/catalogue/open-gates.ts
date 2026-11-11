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
 * registers "at least one published, current price version" here when it exists, so catalogue never imports pricing.
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
