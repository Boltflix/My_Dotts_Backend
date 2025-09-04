// server.js (BACKEND)
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

if (!STRIPE_SECRET_KEY) {
  console.error('STRIPE_SECRET_KEY ausente'); process.exit(1);
}
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

const app = express();

// 1) Webhook RAW antes do json/cors
app.post('/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const sig = req.headers['stripe-signature'];
    try {
      stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
      // TODO: tratar eventos checkout.session.completed / subscription.updated
      return res.json({ received: true });
    } catch (err) {
      console.error('Webhook verify failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }
);

// 2) Demais rotas
const allowed = [
  FRONTEND_ORIGIN,
  'https://www.mydotts.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];
app.use(cors({ origin: allowed, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Health
app.get('/api/health', (_req, res) => res.json({ ok: true, env: NODE_ENV }));

// Checkout – retorna { url }
app.post('/api/stripe/checkout', async (req, res) => {
  try {
    const plan = String(req.body?.plan || '');
    const email = req.body?.email || undefined;

    const price = plan === 'annual' ? STRIPE_PRICE_ANNUAL : STRIPE_PRICE_MONTHLY;
    if (!price) return res.status(400).json({ error: 'Preço não configurado no servidor.' });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      customer_email: email,
      allow_promotion_codes: true,
      automatic_tax: { enabled: true },
      billing_address_collection: 'auto',
      success_url: `${FRONTEND_ORIGIN}/plans?success=1`,
      cancel_url: `${FRONTEND_ORIGIN}/plans?cancelled=1`,
    });

    return res.json({ url: session.url });
  } catch (e) {
    console.error('checkout error', e);
    return res.status(500).json({ error: 'Checkout failed' });
  }
});

// Portal – retorna { url }
app.post('/api/stripe/portal', async (_req, res) => {
  try {
    const session = await stripe.billingPortal.sessions.create({
      // Se você salvar customer_id por usuário, passe aqui: customer: 'cus_...'
      return_url: `${FRONTEND_ORIGIN}/plans`,
    });
    return res.json({ url: session.url });
  } catch (e) {
    console.error('portal error', e);
    return res.status(500).json({ error: 'Portal failed' });
  }
});

app.listen(PORT, () => {
  console.log(`API on :${PORT} env=${NODE_ENV}`);
});

