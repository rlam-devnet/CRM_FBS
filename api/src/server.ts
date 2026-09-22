import Fastify from 'fastify';
import cors from '@fastify/cors';
import dotenv from 'dotenv';
import { leadsRoutes } from './routes/leads.js';
import { qualificationRoutes } from './routes/qualification.js';
import { consultationsRoutes } from './routes/consultations.js';
import { configRoutes } from './routes/config.js';
import { query } from './db.js';

dotenv.config();

async function bootstrap() {
  const server = Fastify({
    logger: process.env.NODE_ENV !== 'production' ? { level: 'info' } : false,
  });

  await server.register(cors, { origin: true });

  // Health check endpoint
  server.get('/health', async (_request, reply) => {
    try {
      const res = await query('SELECT 1 as healthy');
      return reply.send({
        status: 'ok',
        service: 'fbs-crm-api',
        db: res[0]?.healthy === 1 ? 'connected' : 'error',
        timestamp: new Date().toISOString(),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ status: 'error', db: msg });
    }
  });

  // Register routes
  await server.register(leadsRoutes);
  await server.register(qualificationRoutes);
  await server.register(consultationsRoutes);
  await server.register(configRoutes);

  const PORT = parseInt(process.env.PORT || '3000', 10);
  const HOST = process.env.HOST || '0.0.0.0';

  try {
    await server.listen({ port: PORT, host: HOST });
    console.log(`FBS CRM API running on http://${HOST}:${PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

bootstrap();
