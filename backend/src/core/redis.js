const Redis = require('ioredis');
const config = require('./config');

// Shared Redis connection (used for webhook buffers, CDC bookmarks, caches).
const redis = new Redis({ ...config.redis, maxRetriesPerRequest: null });

redis.on('error', (e) => console.error('[redis]', e.message));

module.exports = redis;
