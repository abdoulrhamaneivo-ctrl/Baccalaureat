'use strict';

const Redis = require('ioredis');
const { createGameServer } = require('../server');

const redisUrl = process.env.KV_URL || process.env.REDIS_URL;
if (!redisUrl) throw new Error('Définissez KV_URL ou REDIS_URL avec l’URL Redis Upstash du projet.');

const statsRedis = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});
const gameServer = createGameServer({
  statsRedis,
  checkpointRedis: statsRedis,
  serveStatic: false,
  socketPath: '/socket.io',
  addTrailingSlash: false,
});

async function start() {
  const restoredRooms = await gameServer.restoreRooms();
  const { port } = await gameServer.listen();
  console.log(`Petit Bac temps réel prêt sur le port ${port} · ${restoredRooms} salle(s) reprise(s)`);
}

start().catch((error) => {
  console.error('Impossible de démarrer le serveur temps réel :', error);
  process.exitCode = 1;
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await gameServer.close(); }
  finally {
    if (statsRedis.status !== 'end') await statsRedis.quit().catch(() => statsRedis.disconnect());
  }
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
