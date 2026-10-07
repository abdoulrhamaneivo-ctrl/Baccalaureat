'use strict';

const Redis = require('ioredis');
const { createAdapter } = require('@socket.io/redis-adapter');
const { createGameServer } = require('../server');

if (!process.env.KV_URL) throw new Error('La variable KV_URL manque. Reliez la base Redis Upstash au projet Vercel.');

const redisPublisher = new Redis(process.env.KV_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});
const redisSubscriber = redisPublisher.duplicate({
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});
const gameServer = createGameServer({
  redis: redisPublisher,
  serveStatic: false,
  socketPath: '/api/socket-io',
  addTrailingSlash: false,
});

gameServer.io.adapter(createAdapter(redisPublisher, redisSubscriber));

module.exports = gameServer.server;
