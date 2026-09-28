require('dotenv').config();
const fs           = require('fs');
const http         = require('http');
const https        = require('https');
const os           = require('os');
const express      = require('express');
const path         = require('path');
const compression  = require('compression');
const helmet       = require('helmet');
const rateLimit     = require('express-rate-limit');
const config                     = require('./config/app');
const apiRoutes                  = require('./routes/api');
const pageRoutes                 = require('./routes/pages');
const requestLogger              = require('./middleware/requestLogger');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const { issueCsrfToken, verifyCsrfToken } = require('./middleware/csrf');
const { refreshData }            = require('./services/dataService');
const { startScheduler }         = require('./services/schedulerService');
const logger                     = require('./helpers/logger');
const isProduction               = process.env.NODE_ENV === 'production';
const isHttps                     = /^(1|true|yes)$/i.test(process.env.HTTPS || '');

// Refuse to boot with a guessable session-signing secret in production —
// a default secret means anyone can forge an admin session cookie.
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  logger.error('SESSION_SECRET is not set. Refusing to start in production with a default secret.');
  process.exit(1);
}

// Safety net: without these, ANY unhandled error anywhere in the app
// (including inside third-party libraries, or a background task like the
// scheduled AMFI refresh) crashes the entire Node process — taking the
// whole site down for every visitor until someone notices and restarts it
// manually. Log it and keep the server alive instead.
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — server continuing', { error: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  logger.error('Unhandled promise rejection — server continuing', { error: msg, stack });
});

const app = express();
app.locals.assetVersion = Date.now();

// Security headers (X-Frame-Options, X-Content-Type-Options, HSTS, etc.)
// Note: HSTS and upgradeInsecureRequests are ONLY active when running over HTTPS.
// Running over plain HTTP with upgradeInsecureRequests breaks LAN/IP access.
app.use(helmet({
  hsts: isProduction && isHttps,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"],
      upgradeInsecureRequests: isHttps ? [] : null,
    },
  },
}));

// Gzip all responses — cuts 943KB payload to ~120KB
app.use(compression());

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Cache static assets for 1 day
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.get('/.well-known/appspecific/com.chrome.devtools.json', (req, res) => res.status(204).end());
app.use(requestLogger);

// CSRF protection (double-submit cookie) — issue a token cookie on every
// request, then reject any POST/PUT/DELETE/PATCH whose token doesn't match.
app.use(issueCsrfToken);
app.use(verifyCsrfToken);

// Brute-force protection on login: 10 attempts per 15 minutes per IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts. Please try again in a few minutes.' },
});
app.use('/login', loginLimiter);

app.use('/api', apiRoutes);
app.use('/', pageRoutes);
app.use(notFound);
app.use(errorHandler);

function getLanIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

function startServer(port, retries = 5) {
  return new Promise((resolve, reject) => {
    const host = process.env.HOST || '0.0.0.0';
    const server = isHttps
      ? https.createServer({
          pfx: fs.readFileSync(process.env.TLS_PFX_PATH || path.join(__dirname, 'certs', 'lan.pfx')),
          passphrase: process.env.TLS_PFX_PASSPHRASE,
        }, app)
      : http.createServer(app);
    server.listen(port, host, () => resolve(server));
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && retries > 0) {
        const nextPort = port + 1;
        logger.warn(`Port ${port} is busy, trying ${nextPort}`);
        server.close(() => resolve(startServer(nextPort, retries - 1)));
      } else {
        reject(err);
      }
    });
  });
}

async function boot() {
  const port = Number(process.env.PORT || (isHttps ? 7443 : config.port || 8080));
  const server = await startServer(port);
  const actualPort = server.address().port;
  const protocol = isHttps ? 'https' : 'http';
  logger.info(`Server running on ${protocol}://localhost:${actualPort}`);
  const lanIps = getLanIpAddresses();
  if (lanIps.length) {
    lanIps.forEach(ip => logger.info(`Server available on LAN: ${protocol}://${ip}:${actualPort}`));
  } else {
    logger.info(`Server listening on ${protocol}://${server.address().address}:${actualPort}`);
  }

  const cacheService = require('./services/cacheService');
  const commissionOverrideService = require('./services/commissionOverrideService');
  commissionOverrideService.loadFromDisk();
  const diskLoaded = await cacheService.loadFromDisk();

  if (diskLoaded) {
    logger.info('Disk cache loaded — background refresh starting in 3s...');
    setTimeout(() => refreshData(), 3000);
  } else {
    logger.info('No usable disk cache found — starting a live refresh to build the matrix.');
    await refreshData();
  }

  startScheduler();
}

boot().catch(err => {
  logger.error('Fatal boot error', { error: err.message });
  process.exit(1);
});

module.exports = app;