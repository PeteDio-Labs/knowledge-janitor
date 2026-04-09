import express from 'express';
import pino from 'pino';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const PORT = parseInt(process.env.PORT ?? '3007', 10);

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', agent: 'knowledge-janitor' });
});

app.listen(PORT, () => {
  log.info({ port: PORT }, 'knowledge-janitor listening (stub)');
});
