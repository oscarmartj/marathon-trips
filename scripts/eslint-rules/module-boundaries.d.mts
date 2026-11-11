export function locate(file: string): { area: 'module'; name: string } | { area: 'platform' } | null;
export function violation(file: string, spec: string): string | null;
declare const plugin: { rules: Record<string, unknown> };
export default plugin;
