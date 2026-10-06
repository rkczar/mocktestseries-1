import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// pg pool per process (each PM2 worker, each cron script). Before Live CBT
// this used pg defaults: max 10 and NO connection timeout, so under a
// submission spike requests queued silently until nginx's 60 s timeout.
// Now: up to 20 per worker (2 workers + crons stay far below PostgreSQL's
// max_connections = 100) and a 30 s acquire timeout, so an overloaded
// request fails fast enough for the player's save/submit retry instead of
// hanging. Overridable per environment (PG_POOL_MAX, PG_POOL_ACQUIRE_TIMEOUT_MS).
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX) || 20,
  connectionTimeoutMillis: Number(process.env.PG_POOL_ACQUIRE_TIMEOUT_MS) || 30_000,
  idleTimeoutMillis: 30_000,
});

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    // How long a transaction may wait for a pooled connection (Prisma's
    // default is 2 s). At a Live CBT deadline the whole cohort submits at
    // once; with 2 s, queued submits failed with P2028 (load test, 200
    // candidates). 25 s queues them instead — under the pool's 30 s acquire
    // timeout and nginx's 60 s proxy timeout.
    transactionOptions: { maxWait: 25_000 },
  });

// One client (one pool) per PROCESS, in production too. Next.js loads this
// module in more than one server bundle per worker; without the global, each
// bundle built its own client + pool (measured: ~25 connections per worker
// against a nominal max of 20 — up to N×max under load), which could exhaust
// PostgreSQL's max_connections during a Live CBT submission spike.
globalForPrisma.prisma = prisma;
