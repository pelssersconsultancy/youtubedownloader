import { NestFactory } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import { AppModule } from './app.module.ts';

function loadLocalEnv() {
  try {
    const contents = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
    }
  } catch { /* Local environment files are optional. */ }
}

async function bootstrap() {
  loadLocalEnv();
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: 'http://localhost:4200' });
  await app.listen(3000);
  console.log('API draait op http://localhost:3000/api');
}
bootstrap();
