import { CanActivate, ExecutionContext, Inject, Injectable, NotFoundException, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FeatureFlagService } from './flags.service';

const MODULE_KEY = 'requires-module';

/** Routes of a module answer 404 while its flag is off (plan 3.1). Register RequiresModuleGuard globally. */
export const RequiresModule = (module: string) => SetMetadata(MODULE_KEY, module);

@Injectable()
export class RequiresModuleGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(FeatureFlagService) private readonly flags: FeatureFlagService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const module = this.reflector.getAllAndOverride<string | undefined>(MODULE_KEY, [context.getHandler(), context.getClass()]);
    if (!module) return true;
    if (await this.flags.isModuleEnabled(module)) return true;
    throw new NotFoundException();
  }
}
