'use strict';

const Redis = require('ioredis');
const { Pool } = require('pg');
const { createGameServer } = require('../server');
const { createStatsStore } = require('./stats-store.js');

const redisUrl = process.env.KV_URL || process.env.REDIS_URL;
if (!redisUrl) throw new Error('Définissez KV_URL ou REDIS_URL avec l’URL Redis Upstash du projet.');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Définissez DATABASE_URL avec l’URL de connexion Neon.');
const databaseConnection = new URL(databaseUrl);
if (databaseConnection.searchParams.get('sslmode') === 'require') databaseConnection.searchParams.set('sslmode', 'verify-full');

const statsRedis = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});
const databasePool = new Pool({
  connectionString: databaseConnection.toString(),
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
});
const statsStore = createStatsStore(null, { pool: databasePool });
let gameServer = null;

async function start() {
  await statsStore.initialize();
  const migrated = await statsStore.migrateLegacyRedis(statsRedis);
  gameServer = createGameServer({
    statsRedis: null,
    statsStore,
    checkpointRedis: statsRedis,
    serveStatic: false,
    socketPath: '/socket.io',
    addTrailingSlash: false,
  });
  const restoredRooms = await gameServer.restoreRooms();
  const { port } = await gameServer.listen();
  console.log(`Petit Bac temps réel prêt sur le port ${port} · ${restoredRooms} salle(s) reprise(s) · Neon prêt${migrated ? ' · données existantes importées' : ''}`);
}

start().catch((error) => {
  console.error('Impossible de démarrer le serveur temps réel :', error);
  process.exitCode = 1;
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { if (gameServer) await gameServer.close(); }
  finally {
    await databasePool.end().catch(() => {});
    if (statsRedis.status !== 'end') await statsRedis.quit().catch(() => statsRedis.disconnect());
  }
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
