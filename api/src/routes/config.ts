import { FastifyPluginAsync } from 'fastify';
import { query } from '../db.js';

export const configRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { key: string } }>('/config/:key', async (request, reply) => {
    const { key } = request.params;
    const rows = await query('SELECT * FROM config_variables WHERE key = $1', [key]);

    if (rows.length === 0) {
      return reply.status(404).send({ error: `Clave de configuración '${key}' no encontrada` });
    }

    const item = rows[0] as Record<string, unknown>;
    const status = item.status as string;

    if (status === 'blocking') {
      return reply.status(423).send({
        error: 'CONFIG_BLOCKING',
        key,
        status,
        message: `La variable '${key}' está bloqueada y requiere activación por el administrador antes de operar`
      });
    }

    return reply.send({
      key: item.key,
      value: item.value,
      status: item.status,
      description: item.description,
    });
  });
};
