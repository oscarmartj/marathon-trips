import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { PermissionRegistry } from '../../platform/access/permissions';
import { ContentAdminController } from './admin.controller';
import { ContentService } from './content.service';
import { contentManifest } from './manifest';
import { ContentPublicController } from './public.controller';
import { PublicContentService } from './public.service';
import { RedirectService } from './redirect.service';

@Module({
  controllers: [ContentAdminController, ContentPublicController],
  providers: [ContentService, RedirectService, PublicContentService],
  exports: [PublicContentService],
})
export class ContentModule implements OnModuleInit {
  constructor(@Inject(PermissionRegistry) private readonly permissions: PermissionRegistry) {}

  /** Runs before AccessService syncs the permission table (onApplicationBootstrap). */
  onModuleInit(): void {
    this.permissions.register(contentManifest.permissions);
  }
}
