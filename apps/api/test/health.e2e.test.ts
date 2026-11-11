import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { healthResponseSchema } from '@mt/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';

describe('GET /health', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('reports ok with the database up, matching the shared schema', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    const body = healthResponseSchema.parse(res.body);
    expect(body).toEqual({ status: 'ok', appEnv: 'test', database: 'up' });
  });
});
