import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { stripeRouter, webhookRaw } from './routes/stripe.js';

const app = express();

// CORS: libera seu domínio e localhost (dev)
const allowed = [
  process.env.FRONTEND_ORIGIN,           // ex: https://www.mydotts.com
  'http://localhost:5173',
  'http://127.0.0.1:5173'
].filter(Boolean);

app.use(cors({ origin: allowed, credentials: true }));
app.use(cookieParser());

// Webhook Stripe PRECISA vir ANTES do express.json() e com RAW
app.post('/api/stripe/webhook', webhookRaw);

// Depois, parsers normais
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Healthcheck
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'dotts-api', time: new Date().toISOString() });
});

// Rotas Stripe
app.use('/api/stripe', stripeRouter);

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`[dotts-api] up on :${port}`);
  console.log(`[dotts-api] CORS allowed:`, allowed);
});

