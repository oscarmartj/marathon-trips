'use client';

import { CsvTools } from '../table/csv-tools';
import { emptyQuery, type Meta } from '../table/shared';

const RACE_COLUMNS = ['slug', 'name', 'countryCode', 'city', 'timeZone', 'raceType', 'typicalMonth', 'summary', 'websiteUrl'];
const PACKAGE_COLUMNS = ['slug', 'name', 'checkInDate', 'checkOutDate', 'balanceDueDate', 'minTravellers', 'maxTravellers', 'maxExtraNightsBefore', 'maxExtraNightsAfter', 'instantBooking', 'autoConfirmOnDeposit'];

const meta = (entityType: string, importColumns: string[]): Meta => ({
  entityType, columns: [], softDelete: false, taggable: false, notes: false, bulkActions: [], importColumns,
  can: { write: true, delete: false, export: true, import: true, annotate: false },
});

/** CSV for races (export, check, import as drafts). The API refuses whatever the person may not do. */
export function RaceCsv({ onImported }: { onImported: () => void }) {
  return (
    <CsvTools
      meta={meta('race', RACE_COLUMNS)}
      query={emptyQuery}
      onImported={onImported}
      endpoints={{ exportUrl: '/admin/catalogue/races/export', importUrl: '/admin/catalogue/races/import', exportBody: {}, stem: 'catalogue-races' }}
    />
  );
}

/** CSV for the packages of one edition. */
export function PackageCsv({ editionId, onImported }: { editionId: string; onImported: () => void }) {
  return (
    <CsvTools
      meta={meta('package', PACKAGE_COLUMNS)}
      query={emptyQuery}
      onImported={onImported}
      endpoints={{ exportUrl: `/admin/catalogue/editions/${editionId}/packages/export`, importUrl: `/admin/catalogue/editions/${editionId}/packages/import`, exportBody: {}, stem: 'catalogue-packages' }}
    />
  );
}
