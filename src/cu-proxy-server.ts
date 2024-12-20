import cors from '@koa/cors';
import Router from '@koa/router';
import axios from 'axios';
import httpProxy from 'http-proxy';
import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import { LRUCache } from 'lru-cache';
import { pLimit } from 'plimit-lit';
import * as winston from 'winston';

import { cyrb53 } from './utils/hash.js';

// Configuration
const HOST_LIST = Array.from(
  new Set((process.env.HOST_LIST ?? 'https://cu123.ao-testnet.xyz').split(',')),
); // Deduplicate hosts
console.log(HOST_LIST);
const MAX_CACHE_SIZE_BYTES =
  Number(process.env.MAX_CACHE_SIZE_BYTES) || 10 * 1024 * 1024; // Default 10 MB
const FAILED_HOST_REFRESH_MS =
  Number(process.env.FAILED_HOST_REFRESH_MS) || 60000; // Default 1 minute
const CONCURRENCY_LIMIT = Number(process.env.CONCURRENCY_LIMIT) || 10; // Default concurrency limit
const PORT = Number(process.env.PORT) || 3000; // Default port
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) || 30000; // Default 30 seconds

export class CuProxyServer {
  private failedServicesCache: LRUCache<string, boolean>;
  private proxy: httpProxy;
  private hosts: string[];
  private processToHostMap: LRUCache<string, string>;
  private hashCache: LRUCache<string, number>;
  private recoveryInterval?: NodeJS.Timeout;
  private logger: winston.Logger;
  private app = new Koa();

  constructor() {
    this.hosts = HOST_LIST; // Keep hosts sorted for balancing
    this.hosts.sort();
    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json(),
      ),
      transports: [new winston.transports.Console()],
    });
    this.logger.info('Starting with hosts: ' + JSON.stringify(this.hosts));
    this.failedServicesCache = new LRUCache({
      max: this.hosts?.length ?? 1,
    });

    this.proxy = httpProxy.createProxyServer();

    this.processToHostMap = new LRUCache({
      max: MAX_CACHE_SIZE_BYTES ?? 1,
      dispose: (processId) => {
        this.hashCache.delete(processId);
      },
    });
    this.hashCache = new LRUCache({
      maxSize: MAX_CACHE_SIZE_BYTES ?? 1,
      sizeCalculation: () => 8, // Approximate size of a number in bytes
    });
  }

  private getTargetHost(processId: string): string | undefined {
    const availableHosts = this.getAvailableHosts();

    if (availableHosts.length === 0) {
      return undefined; // No available hosts
    }

    if (this.processToHostMap.has(processId)) {
      const recordedHost = this.processToHostMap.get(processId)!;

      if (!this.failedServicesCache.has(recordedHost)) {
        return recordedHost; // Use cached host if it's still available
      }
    }

    // Assign a new host deterministically based on the hash
    const hash = this.computeHashSumFromProcessId(
      processId,
      availableHosts.length,
    );
    const newHost = availableHosts[hash % availableHosts.length];
    this.processToHostMap.set(processId, newHost);
    return newHost;
  }

  private getAvailableHosts(): string[] {
    return this.hosts.filter((host) => !this.failedServicesCache.has(host));
  }

  private computeHashSumFromProcessId(
    processId: string,
    length: number,
  ): number {
    if (this.hashCache.has(processId)) {
      return this.hashCache.get(processId)!;
    }

    const hash = Number(BigInt(cyrb53(processId)) % BigInt(length));
    this.hashCache.set(processId, hash);
    return hash;
  }

  private updateProcessToHostMap(oldHost: string, newHost: string): void {
    for (const [processId, host] of this.processToHostMap.entries()) {
      if (host === oldHost) {
        this.processToHostMap.set(processId, newHost);
      }
    }
  }

  private updateProcessToHostMapForRecoveredHost(host: string): void {
    for (const [processId, hash] of this.hashCache.entries()) {
      const computedHost = this.hosts[hash % this.hosts.length];
      if (computedHost === host) {
        this.processToHostMap.set(processId, host);
      }
    }
  }

  private async checkFailedHosts(): Promise<void> {
    const limit = pLimit(CONCURRENCY_LIMIT);
    const checks = Array.from(this.failedServicesCache.keys()).map((host) =>
      limit(async () => {
        try {
          await axios.head(host, { timeout: 5000 });
          this.failedServicesCache.delete(host);
          this.updateProcessToHostMapForRecoveredHost(host);
          this.logger.info(`Host recovered: ${host}`);
        } catch {
          this.logger.info(`Host still failing: ${host}`);
        }
      }),
    );

    await Promise.all(checks);
  }

  private startFailedHostsRecovery(): void {
    this.logger.info('Starting failed hosts monitoring');
    this.recoveryInterval = setInterval(() => {
      this.checkFailedHosts().catch((err) =>
        this.logger.error('Failed hosts recovery error:', err),
      );
    }, FAILED_HOST_REFRESH_MS);
  }

  private stopFailedHostsRecovery(): void {
    if (this.recoveryInterval) {
      clearInterval(this.recoveryInterval);
      this.logger.info('Failed hosts recovery stopped.');
    }
  }

  public async start(): Promise<void> {
    this.logger.info('Booting up CU Router');
    this.app.use(bodyParser());
    this.app.use(
      cors({
        origin: '*',
      }),
    );

    this.startFailedHostsRecovery();

    const router = new Router();

    router.get(
      '/',
      this.proxyMiddleware(() => 'process'),
    );
    router.get(
      '/result/:messageTxId',
      this.proxyMiddleware((ctx) => ctx.query['process-id'] as string),
    );
    router.get(
      '/results/:processId',
      this.proxyMiddleware((ctx) => ctx.params.processId),
    );
    router.get(
      '/state/:processId',
      this.proxyMiddleware((ctx) => ctx.params.processId),
    );
    router.get(
      '/cron/:processId',
      this.proxyMiddleware((ctx) => ctx.params.processId),
    );
    router.post(
      '/dry-run',
      this.proxyMiddleware((ctx) => ctx.query['process-id'] as string),
    );

    this.app.use(router.routes()).use(router.allowedMethods());

    this.app.listen(PORT, () => {
      this.logger.info(`Proxy server running on port ${PORT}`);
    });
  }

  public async stop(): Promise<void> {
    this.stopFailedHostsRecovery();
    this.logger.info('Proxy server stopped.');
  }

  public proxyMiddleware(
    processIdFromRequest: (ctx: Koa.Context) => string | undefined,
  ) {
    return async (ctx: Koa.Context) => {
      const processId = processIdFromRequest(ctx);

      if (!processId) {
        ctx.status = 400;
        ctx.body = { error: 'Missing process ID' };
        return;
      }

      let target: string | undefined = undefined;
      while ((target = this.getTargetHost(processId))) {
        try {
          await Promise.race([
            new Promise<void>((resolve, reject) => {
              this.proxy.web(ctx.req, ctx.res, { target }, (err: any) => {
                if (target === undefined) {
                  throw new Error('Target host is undefined');
                }
                if (err) {
                  this.logger.error(`Error proxying to ${target}:`, err);
                  this.failedServicesCache.set(target, true);
                  this.updateProcessToHostMap(
                    target,
                    this.getAvailableHosts()[0] || '',
                  );
                  reject(err);
                } else {
                  resolve();
                }
              });
            }),
            new Promise((_, reject) => {
              setTimeout(() => {
                reject(
                  new Error(`Request timeout after ${REQUEST_TIMEOUT_MS}ms`),
                );
              }, REQUEST_TIMEOUT_MS);
            }),
          ]);
          return; // Successfully proxied, exit loop
        } catch (err: any) {
          this.logger.error(`Proxy failed for host ${target}:`, err);
          if (err.message.includes('Request timeout')) {
            ctx.status = 504; // Gateway Timeout
            ctx.body = { error: 'Request timed out' };
            return;
          }
          // Continue to next failover
        }
      }

      // If no target succeeded
      ctx.status = 502;
      ctx.body = { error: 'No available hosts' };
    };
  }
}
