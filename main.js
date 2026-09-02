require('dotenv').config();

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const pinoHttp = require('pino-http');
const path = require('path');
const fs = require('fs');
const { corsOptions } = require('./lib/cors');

const Product = require('./models/Product');
const PendingBill = require('./models/PendingBill');

const logger = require('./lib/logger');
const authRoutes = require('./routes/auth');
const { errorHandler } = require('./middleware/errorHandler');
const exportRoutes = require('./routes/export');
const syncRoutes = require('./routes/sync');
const productsRoutes = require('./routes/products');
const customersRoutes = require('./routes/customers');
const billingRoutes = require('./routes/billing');
const suppliersRoutes = require('./routes/suppliers');
const ordersRoutes = require('./routes/orders');
const auditRoutes = require('./routes/audit');
const usersRoutes = require('./routes/users');

const app = express();

const port = Number(process.env.PORT) || 3000;

const isProduction = process.env.NODE_ENV === 'production';

const MONGO_URI =
  process.env.MONGO_URI 
  ||
  (isProduction
    ? null
    : 'mongodb://localhost:27017/billing_system');

const DRAFT_IDLE_TIMEOUT_MS =
  parseInt(process.env.DRAFT_IDLE_TIMEOUT_MS, 10) ||
  15 * 60 * 1000;

const DRAFT_SWEEP_INTERVAL_MS =
  parseInt(process.env.DRAFT_SWEEP_INTERVAL_MS, 10) ||
  60 * 1000;

if (isProduction && !MONGO_URI) {
  logger.error(
    'MONGO_URI is required when NODE_ENV=production'
  );
  process.exit(1);
}

if (isProduction && !process.env.JWT_SECRET) {
  logger.error(
    'JWT_SECRET is required when NODE_ENV=production'
  );
  process.exit(1);
}

app.use(cors(corsOptions));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => req.url === '/dashboard/load',
    },
  })
);

app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    status: 'ok',
    service: 'bpiols-backend',
    environment: process.env.NODE_ENV || 'development',
  });
});

app.use('/auth', authRoutes);

if (process.env.ENABLE_EXPORTS !== 'false') {
  app.use('/api/export', exportRoutes);
} else {
  logger.info(
    'Export module disabled (ENABLE_EXPORTS=false)'
  );
}

if (process.env.ENABLE_OFFLINE_SYNC === 'true') {
  app.use('/api/sync', syncRoutes);
} else {
  logger.info(
    'Offline sync module disabled (set ENABLE_OFFLINE_SYNC=true to enable)'
  );
}

app.use('/', productsRoutes);
app.use('/', customersRoutes);
app.use('/', billingRoutes);
app.use('/', suppliersRoutes);
app.use('/', ordersRoutes);
app.use('/', auditRoutes);
app.use('/', usersRoutes);

app.use(['/api', '/auth'], (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Not found.',
  });
});

const frontendDist = path.join(
  __dirname,
  'frontend',
  'dist'
);

if (fs.existsSync(path.join(frontendDist, 'index.html'))) {
  app.use(express.static(frontendDist));

  app.get(/.*/, (req, res) => {
    res.sendFile(
      path.join(frontendDist, 'index.html')
    );
  });
} else {
  logger.warn(
    'frontend/dist not found — run `npm run build` inside /frontend to serve the React app from this server. ' +
      'API routes still work; only the UI is unavailable until it is built.'
  );
}

app.use(errorHandler);

async function sweepAbandonedDrafts() {
  if (mongoose.connection.readyState !== 1) {
    return;
  }

  const cutoff = new Date(
    Date.now() - DRAFT_IDLE_TIMEOUT_MS
  );

  const stale = await PendingBill.find({
    status: 'active',
    updatedAt: { $lt: cutoff },
    'items.0': { $exists: true },
  });

  for (const draft of stale) {
    try {
      await Promise.all(
        draft.items.map((it) =>
          Product.findOneAndUpdate(
            {
              productID: it.productID,
              reserved: { $gte: it.quantity },
            },
            {
              $inc: {
                reserved: -it.quantity,
              },
            }
          )
        )
      );

      draft.status = 'abandoned';
      draft.items = [];
      draft.updatedAt = new Date();

      await draft.save();

      logger.info(
        {
          cashier: draft.cashier,
          billID: draft.billID,
        },
        'Released stock for an abandoned draft bill'
      );
    } catch (err) {
      logger.error(
        {
          err: err.message,
          cashier: draft.cashier,
        },
        'Failed to sweep an abandoned draft'
      );
    }
  }
}

setInterval(() => {
  sweepAbandonedDrafts().catch((err) =>
    logger.error(
      {
        err: err.message,
      },
      'Draft sweep tick failed'
    )
  );
}, DRAFT_SWEEP_INTERVAL_MS);

async function startServer() {
  try {
    await mongoose.connect(MONGO_URI);

    logger.info('MongoDB connected');

    try {
      await mongoose.connection.db.admin().command({
        replSetGetStatus: 1,
      });
    } catch (err) {
      logger.warn(
        {
          err: err.message,
        },
        'MongoDB does not appear to be running as a replica set — order checkout (transactions) will fail. ' +
          'For local dev: run mongod with --replSet rs0, then run rs.initiate() once in mongosh.'
      );
    }

    app.listen(port, '0.0.0.0', () => {
      logger.info(
        {
          port,
          environment:
            process.env.NODE_ENV || 'development',
        },
        'Server started'
      );
    });
  } catch (err) {
    logger.error(
      {
        err,
      },
      'MongoDB connection failed'
    );

    process.exit(1);
  }
}

async function shutdown(signal) {
  logger.info(
    { signal },
    'Shutdown signal received'
  );

  try {
    await mongoose.connection.close();

    logger.info('MongoDB connection closed');

    process.exit(0);
  } catch (err) {
    logger.error(
      {
        err,
      },
      'Error while closing MongoDB connection'
    );

    process.exit(1);
  }
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  shutdown('SIGINT');
});

startServer();