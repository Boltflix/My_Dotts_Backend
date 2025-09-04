// server.js — backend Stripe com debug de prices
// (cole este arquivo inteiro no lugar do seu)

import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';

// ---------- ENV ----------
const {
  PORT = 8080,
  NODE_ENV = 'production',

  // defina no Render para o domínio que você usa
  FRONTEND_ORIGIN = 'https://mydotts.com',

  STRIPE_SECRET_KEY,        // sk_live_...
  STRIPE_PRICE_MONTHLY,     // price_... (LIVE)
  STRIPE_PRICE_ANNUAL,      // price_... (LIVE)

  // opcional (apenas se usar webhook)
  STRIPE_WEBHOOK_SECRET     // whsec_...
} = process.env;

// ---------- APP / CORS ----------
const app = express();

const allowedOrigins = Array.from(new Set([
  FRONTEND_ORIGIN,
  'https://mydotts.com',
  'https://www.mydotts.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]));

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);               // permite curl/Invoke
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
}));

// ---------- HEALTH & DEBUG BÁSICO ----------
app.get('/api/health', (_req, res) => res.json({ ok: true, env: NODE_ENV }));

app.get('/api/debug-config', (_req, res) => {
  res.json({
    FRONTEND_ORIGIN,
    STRIPE_SECRET_KEY_present: !!STRIPE_SECRET_KEY,
    STRIPE_SECRET_KEY_prefix: STRIPE_SECRET_KEY ? STRIPE_SECRET_KEY.slice(0, 7) : null, // "sk_live"
    STRIPE_PRICE_MONTHLY_present: !!STRIPE_PRICE_MONTHLY,
    STRIPE_PRICE_ANNUAL_present: !!STRIPE_PRICE_ANNUAL,
    allowed_origins: allowedOrigins,
    tip: 'Use chave LIVE (sk_live_) e preços LIVE (price_...).',
  });
});

// ---------- DEBUG DE PRICES (NOVA ROTA) ----------
// Checa se os price IDs existem e estão em modo live.
app.get('/api/debug-prices', async (_req, res) => {
  try {
    if (!STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY ausente');
    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

    const out = {};
    const inspect = async (label, id) => {
      if (!id) { out[label] = { present: false }; return; }
      try {
        const p = await stripe.prices.retrieve(id);
        out[label] = {
          present: true,
          id: p.id,
          active: p.active,
          currency: p.currency,
          unit_amount: p.unit_amount,
          type: p.type,
          recurring: p.recurring || null,
          product: p.product || null,
          livemode: !!p.livemode,
        };
      } catch (e) {
        out[label] = { present: true, error: e?.message || String(e) };
      }
    };

    await inspect('monthly', STRIPE_PRICE_MONTHLY);
    await inspect('annual', STRIPE_PRICE_ANNUAL);

    return res.json(out);
  } catch (e) {
    console.error('debug-prices error:', e?.message);
    return res.status(500).json({ error: 'debug-prices failed' });
  }
});

// ---------- WEBHOOK (RAW) ----------
app.post('/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) {
      console.error('Webhook sem chave/segredo — ignorando verificação.');
      return res.status(200).json({ received: true });
    }
    try {
      const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
      const sig = req.headers['stripe-signature'];
      const event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
      // TODO: tratar eventos conforme necessário
      return res.json({ received: true, type: event?.type });
    } catch (err) {
      console.error('Webhook verify failed:', err?.message);
      return res.status(400).send(`Webhook Error: ${err?.message}`);
    }
  }
);

// ---------- PARSERS PARA AS DEMAIS ROTAS ----------
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Helpers
function getStripe() {
  if (!STRIPE_SECRET_KEY) {
    const e = new Error('STRIPE_SECRET_KEY ausente');
    e.code = 'NO_SK';
    throw e;
  }
  return new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
}

async function createCheckoutSession(plan, email) {
  const stripe = getStripe();
  const price = String(plan).toLowerCase() === 'annual'
    ? STRIPE_PRICE_ANNUAL
    : STRIPE_PRICE_MONTHLY;

  if (!price) {
    const e = new Error('Preço não configurado');
    e.code = 'NO_PRICE';
    throw e;
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    customer_email: email || undefined,
    allow_promotion_codes: true,
    automatic_tax: { enabled: true },
    billing_address_collection: 'auto',
    success_url: `${FRONTEND_ORIGIN}/plans?success=1`,
    cancel_url: `${FRONTEND_ORIGIN}/plans?cancelled=1`,
  });

  return session;
}

// ---------- CHECKOUT ----------
app.post('/api/stripe/checkout', async (req, res) => {
  try {
    const plan = req.body?.plan || 'monthly';
    const email = req.body?.email || undefined;
    const session = await createCheckoutSession(plan, email);
    return res.json({ url: session.url });
  } catch (e) {
    console.error('checkout error -> name:', e?.name);
    console.error('message:', e?.message);
    if (e?.type) console.error('type:', e?.type);
    if (e?.code) console.error('code:', e?.code);
    if (e?.raw?.message) console.error('raw.message:', e.raw.message);
    if (e?.raw?.param) console.error('raw.param:', e.raw.param);
    return res.status(500).json({ error: 'Checkout failed' });
  }
});

// Alias compat
app.post('/api/stripe/create-checkout-session', async (req, res) => {
  try {
    const plan = req.body?.plan || 'monthly';
    const email = req.body?.email || undefined;
    const session = await createCheckoutSession(plan, email);
    return res.json({ url: session.url });
  } catch (e) {
    console.error('checkout (alias) error:', e?.message);
    return res.status(500).json({ error: 'Checkout failed' });
  }
});

// ---------- PORTAL ----------
app.post('/api/stripe/portal', async (req, res) => {
  try {
    const stripe = getStripe();
    const email = req.body?.email;
    if (!email) return res.status(400).json({ error: 'Email necessário' });

    const customers = await stripe.customers.search({
      query: `email:"${email}"`,
    });

    if (!customers?.data?.length) {
      return res.status(404).json({ error: 'Customer não encontrado para este e-mail' });
    }

    const customerId = customers.data[0].id;
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${FRONTEND_ORIGIN}/plans`,
    });

    return res.json({ url: session.url });
  } catch (e) {
    console.error('portal error ->', e?.message);
    if (e?.raw?.message) console.error('raw.message:', e.raw.message);
    return res.status(500).json({ error: 'Portal failed' });
  }
});

// Alias compat
app.post('/api/stripe/create-portal-session', async (req, res) => {
  req.url = '/api/stripe/portal';
  app._router.handle(req, res, () => {});
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`API on :${PORT} env=${NODE_ENV}`);
});
