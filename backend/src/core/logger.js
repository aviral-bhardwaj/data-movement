const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = levels[process.env.LOG_LEVEL || 'info'] || 20;

function fmt(level, msg, meta) {
  const base = { ts: new Date().toISOString(), level, msg };
  return JSON.stringify(meta ? { ...base, ...meta } : base);
}

const logger = {
  debug(msg, meta) { if (minLevel <= 10) console.log(fmt('debug', msg, meta)); },
  info(msg, meta) { if (minLevel <= 20) console.log(fmt('info', msg, meta)); },
  warn(msg, meta) { if (minLevel <= 30) console.warn(fmt('warn', msg, meta)); },
  error(msg, meta) { if (minLevel <= 40) console.error(fmt('error', msg, meta)); },
  child(defaults) {
    return {
      debug: (m, meta) => logger.debug(m, { ...defaults, ...meta }),
      info: (m, meta) => logger.info(m, { ...defaults, ...meta }),
      warn: (m, meta) => logger.warn(m, { ...defaults, ...meta }),
      error: (m, meta) => logger.error(m, { ...defaults, ...meta }),
    };
  },
};

module.exports = logger;
