// server.js — Stripe (assinatura) com trial de 30 dias e sem Stripe Tax
// SUBSTITUA seu server.js inteiro por ESTE arquivo.

import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';

const {
  PORT = 8080,
  NODE_ENV = 'production',
  FRONTEND_ORIGIN = 'https://mydotts.com',

  STRIPE_SECRET_KEY,        // sk_live_...
  STRIPE_PRICE_MONTHLY,     // price_... (LIVE)
  STRIPE_PRICE_ANNUAL,      // price_... (LIVE)
  STRIPE_WEBHOOK_SECRET,    // whsec_... (opcional)

  // Se quiser mudar o trial sem mexer no código:
  TRIAL_DAYS = '30',        // por padrão 30 dias
} = process.env;

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
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
}));

/* ---------- Health & Debug ---------- */
app.get('/api/health', (_req, res) => res.json({ ok: true, env: NODE_ENV }));

app.get('/api/debug-config', (_req, res) => {
  res.json({
    FRONTEND_ORIGIN,
    STRIPE_SECRET_KEY_present: !!STRIPE_SECRET_KEY,
    STRIPE_SECRET_KEY_prefix: STRIPE_SECRET_KEY ? STRIPE_SECRET_KEY.slice(0, 7) : null,
    STRIPE_PRICE_MONTHLY_present: !!STRIPE_PRICE_MONTHLY,
    STRIPE_PRICE_ANNUAL_present: !!STRIPE_PRICE_ANNUAL,
    TRIAL_DAYS,
    allowed_origins: allowedOrigins,
    tip: 'Use chave LIVE (sk_live_) e preços LIVE (price_...).',
  });
});

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

/* ---------- Webhook (RAW) ---------- */
app.post('/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) {
      console.warn('Webhook sem chave/segredo — pulando verificação.');
      return res.status(200).json({ received: true });
    }
    try {
      const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
      const sig = req.headers['stripe-signature'];
      const event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
      // TODO: tratar eventos (checkout.session.completed, customer.subscription.updated, etc.)
      return res.json({ received: true, type: event?.type });
    } catch (err) {
      console.error('Webhook verify failed:', err?.message);
      return res.status(400).send(`Webhook Error: ${err?.message}`);
    }
  }
);

/* ---------- Parsers para demais rotas ---------- */
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

function getStripe() {
  if (!STRIPE_SECRET_KEY) {
    const e = new Error('STRIPE_SECRET_KEY ausente');
    e.code = 'NO_SK';
    throw e;
  }
  return new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
}

function pickPriceId(plan) {
  return String(plan).toLowerCase() === 'annual' ? STRIPE_PRICE_ANNUAL : STRIPE_PRICE_MONTHLY;
}

/* ---------- Core: criar sessão com TRIAL ---------- */
async function createCheckoutSession({ plan, email, promoCode }) {
  const stripe = getStripe();
  const price = pickPriceId(plan);
  if (!price) {
    const e = new Error('Preço não configurado');
    e.code = 'NO_PRICE';
    throw e;
  }

  // (opcional) procurar promotion code para pré-aplicar
  let discounts;
  if (promoCode) {
    try {
      const found = await stripe.promotionCodes.list({ code: promoCode, active: true, limit: 1 });
      if (found?.data?.length) discounts = [{ promotion_code: found.data[0].id }];
    } catch (e) {
      console.warn('promotion code lookup failed:', e?.message);
    }
  }

  const trialDays = Number.parseInt(TRIAL_DAYS, 10) || 30;

  // IMPORTANTE:
  // - payment_method_collection: 'always' → coleta cartão mesmo com trial
  // - subscription_data.trial_period_days: trial de 30 dias
  // - REMOVIDO automatic_tax (Stripe Tax não suportado na sua conta/país)
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    customer_email: email || undefined,
    payment_method_collection: 'always',
    allow_promotion_codes: true,
    ...(discounts ? { discounts } : {}),
    subscription_data: {
      trial_period_days: trialDays,
      // Opcional: se quiser cancelar se cliente não tiver PM no fim do trial
      // trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
    },
    billing_address_collection: 'auto',
    success_url: `${FRONTEND_ORIGIN}/plans?success=1`,
    cancel_url: `${FRONTEND_ORIGIN}/plans?cancelled=1`,
  });

  return session;
}

/* ---------- Rotas ---------- */
app.post('/api/stripe/checkout', async (req, res) => {
  try {
    const { plan = 'monthly', email, promo } = req.body || {};
    const session = await createCheckoutSession({ plan, email, promoCode: promo });
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

// Alias de compatibilidade
app.post('/api/stripe/create-checkout-session', async (req, res) => {
  try {
    const { plan = 'monthly', email, promo } = req.body || {};
    const session = await createCheckoutSession({ plan, email, promoCode: promo });
    return res.json({ url: session.url });
  } catch (e) {
    console.error('checkout (alias) error:', e?.message);
    return res.status(500).json({ error: 'Checkout failed' });
  }
});

app.post('/api/stripe/portal', async (req, res) => {
  try {
    const stripe = getStripe();
    const email = req.body?.email;
    if (!email) return res.status(400).json({ error: 'Email necessário' });

    const customers = await stripe.customers.search({ query: `email:"${email}"` });
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

// Alias do portal
app.post('/api/stripe/create-portal-session', async (req, res) => {
  req.url = '/api/stripe/portal';
  app._router.handle(req, res, () => {});
});

/* ---------- Start ---------- */
app.listen(PORT, () => {
  console.log(`API on :${PORT} env=${NODE_ENV}`);
});
