import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { apiRouter } from './routes/api.routes.js';

export const app = express();

const createHttpLogger = pinoHttp as unknown as (
  options: { logger: typeof logger }
) => express.RequestHandler;

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet());
app.use(createHttpLogger({ logger }));
app.use(cors({
  credentials: true,
  origin(origin, callback) {
    if (!origin || env.corsOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('Origin not allowed by CORS policy'));
  },
}));
app.use(express.json({ limit: '1mb' }));

app.use('/api', apiRouter);

app.use(notFoundHandler);
app.use(errorHandler);
