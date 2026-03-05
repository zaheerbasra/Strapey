"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAuth = registerAuth;
exports.authGuard = authGuard;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const inMemoryUsers = [
    { id: 'u-1', email: 'admin@strapey.local', passwordHash: bcryptjs_1.default.hashSync('admin123', 10), role: 'admin' }
];
async function registerAuth(app) {
    app.post('/auth/login', async (request, reply) => {
        const body = request.body;
        const email = String(body?.email || '').toLowerCase();
        const password = String(body?.password || '');
        const user = inMemoryUsers.find((u) => u.email === email);
        if (!user || !bcryptjs_1.default.compareSync(password, user.passwordHash)) {
            return reply.code(401).send({ error: 'Invalid credentials' });
        }
        const token = app.jwt.sign({ sub: user.id, email: user.email, role: user.role });
        return { token, user: { id: user.id, email: user.email, role: user.role } };
    });
}
async function authGuard(request, reply) {
    try {
        await request.jwtVerify();
    }
    catch {
        return reply.code(401).send({ error: 'Unauthorized' });
    }
}
