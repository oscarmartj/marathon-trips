// The public API of the complaints module (plan 3.1). Other modules import from here and nowhere else in this folder.
export { ComplaintsModule } from './complaints.module';
export { complaintsManifest, COMPLAINTS_PERMISSIONS } from './manifest';
export { ComplaintService } from './complaint.service';
export { defaultDueDates, deadlinesOf } from './deadlines';
