import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import type { ZodType } from 'zod';
import { ZodPipe } from '../../src/platform/http/zod.pipe';
import type { TestApp } from './auth';
import type { CustomerSession, OwnedRouteFixture } from './owned-route-fixtures';
import { allRoutes } from './routes';

/** Top-level keys a zod schema accepts (objects, unions of objects, pipes). */
export function schemaKeys(schema: ZodType): string[] {
  const def = (schema as unknown as { def?: Record<string, unknown>; _zod?: { def: Record<string, unknown> } })._zod?.def ?? {};
  if (def.shape) return Object.keys(def.shape as object);
  if (Array.isArray(def.options)) return (def.options as ZodType[]).flatMap(schemaKeys);
  if (def.in) return schemaKeys(def.in as ZodType);
  return [];
}

/** What a handler reads from the request: path params, query, and body keys (from its ZodPipe). */
export function handlerInputs(controller: new (...a: never[]) => object, handler: string): { params: boolean; query: boolean; bodyKeys: string[] } {
  const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, handler) ?? {}) as Record<string, { pipes?: unknown[] }>;
  const out = { params: false, query: false, bodyKeys: [] as string[] };
  for (const [key, arg] of Object.entries(args)) {
    const type = Number(key.split(':')[0]);
    if (type === RouteParamtypes.PARAM) out.params = true;
    if (type === RouteParamtypes.QUERY) out.query = true;
    if (type === RouteParamtypes.BODY) {
      for (const p of arg.pipes ?? []) if (p instanceof ZodPipe) out.bodyKeys.push(...schemaKeys(p.schema as ZodType));
    }
  }
  return out;
}

/**
 * Runs every @OwnedBy route of the app: `self` routes may take no resource id anywhere (path, query or body, M6);
 * customer-resource routes run their fixture and must answer 404 to the other customer and 2xx to the owner.
 */
export async function checkOwnedRoutes(t: TestApp, fixtures: Record<string, OwnedRouteFixture>, a: CustomerSession, b: CustomerSession) {
  const problems: string[] = [];
  let checked = 0;
  for (const r of allRoutes(t.app).filter((x) => x.marks[0]?.type === 'owned')) {
    const mark = r.marks[0]!;
    if (mark.type !== 'owned') continue;
    const name = `${r.method} ${r.path}`;
    if (!('owns' in mark.spec)) {
      const inputs = handlerInputs(r.controllerClass, r.handler);
      if (/:/.test(r.path) || inputs.params) problems.push(`${name}: self route with a path parameter`);
      if (inputs.query) problems.push(`${name}: self route reads the query`);
      const ids = inputs.bodyKeys.filter((k) => /id$|ids$/i.test(k));
      if (ids.length) problems.push(`${name}: self route takes ${ids.join(', ')} in the body`);
      checked++;
      continue;
    }
    const fixture = fixtures[mark.spec.fixture];
    if (!fixture) {
      problems.push(`${name}: no fixture "${mark.spec.fixture}"`);
      continue;
    }
    const req = await fixture.create(t, a, b);
    const mine = await req.asOwner();
    const theirs = await req.asOther();
    if (mine.status < 200 || mine.status >= 300) problems.push(`${name}: owner got ${mine.status}`);
    if (theirs.status !== 404) problems.push(`${name}: other customer got ${theirs.status}, expected 404`);
    checked++;
  }
  return { problems, checked };
}
