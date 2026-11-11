import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './platform/config/config';

async function bootstrap(): Promise<void> {
  const config = loadConfig(); // throws before anything starts if APP_ENV or DATABASE_URL is missing
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(config.API_PORT, '0.0.0.0');
}

bootstrap().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'API failed to start');
  process.exit(1);
});
