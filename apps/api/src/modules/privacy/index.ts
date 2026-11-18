// The public API of the privacy module (plan 3.1). Other modules import from here and nowhere else in this folder.
export { PrivacyModule } from './privacy.module';
export { privacyManifest, PRIVACY_PERMISSIONS, PRIVACY_EVENTS } from './manifest';
export { ConsentService } from './consent.service';
export { ErasureService } from './erasure.service';
