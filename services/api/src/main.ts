import './core/tracing/instrumentation';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { loadEnv } from './core/config/env';

async function main() {
  const env = loadEnv();
  const app = configureApp(await NestFactory.create(AppModule.forRoot(env)));
  await app.listen(env.API_PORT);
  Logger.log(`API listening on http://localhost:${env.API_PORT}/api/v1`, 'Bootstrap');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
