import { buildPlatformApp } from './app';
import { env } from './config/env';

async function main() {
  const app = await buildPlatformApp();
  try {
    await app.listen({ port: env.port, host: '0.0.0.0' });
    app.log.info(`Platform API running at http://localhost:${env.port}`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

main();
