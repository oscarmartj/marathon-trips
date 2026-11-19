// The public API of the templates module. Other modules import from here and nowhere else in this folder.
export { TemplatesModule } from './templates.module';
export { templatesManifest, TEMPLATES_PERMISSIONS } from './manifest';
export { TemplatesService } from './templates.service';
// Task 4.6: receipts are printed with the same plain PDF writer, with a fixed layout (not a template).
export { buildPdf } from './pdf';
