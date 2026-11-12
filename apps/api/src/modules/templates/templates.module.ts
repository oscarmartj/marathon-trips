import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { PermissionRegistry } from '../../platform/access/permissions';
import { templatesManifest } from './manifest';
import { TemplatesAdminController } from './templates.controller';
import { TemplatesService } from './templates.service';

@Module({
  controllers: [TemplatesAdminController],
  providers: [TemplatesService],
  exports: [TemplatesService],
})
export class TemplatesModule implements OnModuleInit {
  constructor(@Inject(PermissionRegistry) private readonly permissions: PermissionRegistry) {}

  /** Runs before AccessService syncs the permission table (onApplicationBootstrap). */
  onModuleInit(): void {
    this.permissions.register(templatesManifest.permissions);
  }
}
