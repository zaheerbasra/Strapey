"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = require("./app");
const env_1 = require("./config/env");
async function main() {
    const app = await (0, app_1.buildPlatformApp)();
    try {
        await app.listen({ port: env_1.env.port, host: '0.0.0.0' });
        app.log.info(`Platform API running at http://localhost:${env_1.env.port}`);
    }
    catch (error) {
        app.log.error(error);
        process.exit(1);
    }
}
main();
