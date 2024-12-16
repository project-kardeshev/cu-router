import { CuProxyServer } from './cu-proxy-server.js';

let app: CuProxyServer;

(async () => {
  app = new CuProxyServer();
  await app.start();

  process.on('SIGINT', app.stop);
  process.on('SIGTERM', app.stop);
})();
