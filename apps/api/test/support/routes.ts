import type { INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer, Reflector } from '@nestjs/core';
import type { AccessMark } from '../../src/platform/access/access.decorators';
import { marksOf } from '../../src/platform/access/access.guard';

export interface RouteInfo {
  controller: string;
  controllerClass: new (...a: never[]) => object;
  handler: string;
  method: string;
  path: string;
  marks: AccessMark[];
}

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];
const join = (...parts: string[]) => `/${parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;

/** Every route of every controller registered in the application, with its access marks. */
export function allRoutes(app: INestApplication): RouteInfo[] {
  const reflector = new Reflector();
  const routes: RouteInfo[] = [];
  for (const mod of app.get(ModulesContainer).values()) {
    for (const wrapper of mod.controllers.values()) {
      const ctrl = wrapper.metatype as (new (...a: never[]) => object) | null;
      if (!ctrl) continue;
      const base = String(Reflect.getMetadata(PATH_METADATA, ctrl) ?? '');
      for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
        if (name === 'constructor') continue;
        const fn = Object.getOwnPropertyDescriptor(ctrl.prototype, name)?.value as unknown; // skips getters
        if (typeof fn !== 'function') continue;
        const path = Reflect.getMetadata(PATH_METADATA, fn);
        if (path === undefined) continue;
        const method = METHODS[Number(Reflect.getMetadata(METHOD_METADATA, fn))] ?? 'GET';
        routes.push({ controller: ctrl.name, controllerClass: ctrl, handler: name, method, path: join(base, String(path)), marks: marksOf(reflector, fn, ctrl) });
      }
    }
  }
  return routes;
}
