const Redis = require('ioredis');
const logger = require('../utils/logger');

const tlsEnabled = process.env.REDIS_TLS === 'true';

const client = new Redis({
  host: process.env.REDIS_URL || '127.0.0.1',
  port: 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  ...(tlsEnabled ? { tls: {} } : {}),
  retryStrategy: (times) => Math.min(times * 200, 5000),
});

client.on('connect', () => logger.info('Redis connected'));
client.on('error', (err) => logger.error('Redis error', { err: err.message }));

async function setJSON(key, value, ttlSeconds) {
  const str = JSON.stringify(value);
  if (ttlSeconds) {
    await client.set(key, str, 'EX', ttlSeconds);
  } else {
    await client.set(key, str);
  }
}

async function getJSON(key) {
  const str = await client.get(key);
  return str ? JSON.parse(str) : null;
}

async function del(...keys) {
  if (keys.length) await client.del(...keys);
}

module.exports = { client, setJSON, getJSON, del };
