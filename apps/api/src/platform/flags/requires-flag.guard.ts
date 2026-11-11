import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { notFound } from '../http/api-error';
import { FeatureFlagService } from './flags.service';

const FLAG_KEY = 'requires-flag';

/** The route answers 404 while the flag is off (or missing). */
export const RequiresFlag = (key: string) => SetMetadata(FLAG_KEY, key);

@Injectable()
export class RequiresFlagGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(FeatureFlagService) private readonly flags: FeatureFlagService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const key = this.reflector.getAllAndOverride<string | undefined>(FLAG_KEY, [context.getHandler(), context.getClass()]);
    if (!key || (await this.flags.isEnabled(key))) return true;
    throw notFound();
  }
}
