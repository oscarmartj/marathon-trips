import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyFields, renderFieldClasses } from './field-classes';

const root = join(__dirname, '..');
writeFileSync(join(root, 'src/platform/audit/field-classes.generated.ts'), renderFieldClasses(classifyFields(join(root, 'prisma/schema'))));
console.log('field-classes.generated.ts written');
