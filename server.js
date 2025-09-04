// server.js (BACKEND - DEBUG)
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';

const {
  PORT = 8080,
  NODE_ENV = 'production',
  FRONTEND_ORIGIN = 'https://mydotts.com',
  STRIPE_SECRET_KEY,
  STRIPE_PRICE_MONTHLY,
  STRIPE_PRICE_ANNUAL,
  STRIPE_WEBHOOK_SECRET,
} = process.env;

const app = express();

// ---- CORS (inclui localhost p/ teste) ----
const allowed = [
  FRONTEND_ORIGIN,
  'https://www.mydotts.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];
app.use(cors({ origin: allowed, credentials: true }));

// Health
app.get('/api/health', (_req, res) => res.json({ ok: true, env: NODE_ENV }));

// ---- DEBUG (temporário) ----
// NÃO expõe valores; só diz se existe e o formato está ok.
app.get('/api/debug-config', (_req, res) => {
  const mask = (v) => (typeof v === 'string' && v.length >= 7 ? `${v.slice(0, 7)}***` : null);
  res.json({
    FRONTEND_ORIGIN,
    STRIPE_SECRET_KEY_present: !!STRIPE_SECRET_KEY,
    STRIPE_SECRET_KEY_prefix: STRIPE_SECRET_KEY ? STRIPE_SECRET_KEY.slice(0, 7) : null, // deve ser 'sk_live'
    STRIPE_PRICE_MONTHLY_present: !!STRIPE_PRICE_MONTHLY,
    STRIPE_PRICE_ANNUAL_present: !!STRIPE_PRICE_ANNUAL,
    allowed_origins: allowed,
    tip: "STRIPE_SECRET_KEY deve iniciar com sk_live_ e preços são IDs price_... do modo LIVE.",
  });
});

// Webhook RAW (antes do JSON parser)
app.post('/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) {
      console.error('Webhook sem chave/segredo configurado.');
      return res.status(200).json({ received: true });
    }
    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
    try {
      const sig = req.headers['stripe-signature'];
      stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
      return res.json({ received: true });
    } catch (err) {
      console.error('Webhook verify failed:', err?.message);
      return res.status(400).send(`Webhook Error: ${err?.message}`);
    }
  }
);

// JSON parser para as demais rotas
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Checkout: cria sessão e devolve { url }
app.post('/api/stripe/checkout', async (req, res) => {
  try {
    if (!STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY ausente');
    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

    const plan = String(req.body?.plan || '').toLowerCase();
    const email = req.body?.email || undefined;

    const price = plan === 'annual' ? STRIPE_PRICE_ANNUAL : STRIPE_PRICE_MONTHLY;
    if (!price) {
      console.error('Preço não configurado. plan=', plan, 'monthly=', !!STRIPE_PRICE_MONTHLY, 'annual=', !!STRIPE_PRICE_ANNUAL);
      return res.status(400).json({ error: 'Preço não configurado' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      customer_email: email,            // ajuda o Stripe a associar customer
      allow_promotion_codes: true,
      automatic_tax: { enabled: true },
      billing_address_collection: 'auto',
      success_url: `${FRONTEND_ORIGIN}/plans?success=1`,
      cancel_url: `${FRONTEND_ORIGIN}/plans?cancelled=1`,
    });

    return res.json({ url: session.url });
  } catch (e) {
    // LOG detalhado no Render
    console.error('checkout error -> name:', e?.name);
    console.error('message:', e?.message);
    if (e?.type) console.error('type:', e?.type);
    if (e?.code) console.error('code:', e?.code);
    if (e?.raw) console.error('raw:', e?.raw);
    return res.status(500).json({ error: 'Checkout failed' });
  }
});

// Portal (opcional)
app.post('/api/stripe/portal', async (_req, res) => {
  try {
    if (!STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY ausente');
    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

    const session = await stripe.billingPortal.sessions.create({
      // Se você armazenar o customer_id do usuário, passe: customer: 'cus_...'
      return_url: `${FRONTEND_ORIGIN}/plans`,
    });
    return res.json({ url: session.url });
  } catch (e) {
    console.error('portal error:', e?.message);
    return res.status(500).json({ error: 'Portal failed' });
  }
});

app.listen(PORT, () => {
  console.log(`API on :${PORT} env=${NODE_ENV}`);
});
