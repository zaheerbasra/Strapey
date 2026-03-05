import { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';

const inMemoryUsers = [
  { id: 'u-1', email: 'admin@strapey.local', passwordHash: bcrypt.hashSync('admin123', 10), role: 'admin' }
];

export async function registerAuth(app: FastifyInstance) {
  app.post('/auth/login', async (request, reply) => {
    const body = request.body as { email?: string; password?: string };
    const email = String(body?.email || '').toLowerCase();
    const password = String(body?.password || '');

    const user = inMemoryUsers.find((u) => u.email === email);
    if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    const token = app.jwt.sign({ sub: user.id, email: user.email, role: user.role });
    return { token, user: { id: user.id, email: user.email, role: user.role } };
  });
}

export async function authGuard(request: any, reply: any) {
  try {
    await request.jwtVerify();
  } catch {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
}
