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

// 1) Webhook precisa de RAW antes do json()
app.post('/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('Webhook signature verify failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    // TODO: tratar eventos relevantes (checkout.session.completed, customer.subscription.updated, etc.)
    res.json({ received: true });
  }
);

// 2) Demais rotas usam JSON normal
const allowed = [FRONTEND_ORIGIN, 'https://www.mydotts.com'];
app.use(cors({ origin: allowed, credentials: true }));
app.use(express.json());

// Health
app.get('/api/health', (_req, res) => res.json({ ok: true, env: NODE_ENV }));

// Checkout (form-urlencoded ou JSON — aqui aceitamos ambos)
app.post('/api/stripe/checkout',
  express.urlencoded({ extended: false }),
  async (req, res) => {
    try {
      const plan = (req.body.plan || req.query.plan || '').toString();
      const price = plan === 'annual' ? STRIPE_PRICE_ANNUAL : STRIPE_PRICE_MONTHLY;
      if (!price) return res.status(400).json({ error: 'Preço não configurado' });

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: [{ price, quantity: 1 }],
        automatic_tax: { enabled: true },
        allow_promotion_codes: true,
        success_url: `${FRONTEND_ORIGIN}/plans?success=1`,
        cancel_url: `${FRONTEND_ORIGIN}/plans?cancelled=1`,
      });
      return res.json({ url: session.url });
    } catch (e) {
      console.error('checkout error', e);
      return res.status(500).json({ error: 'Checkout failed' });
    }
  }
);

// Portal do cliente (precisa de customer; ajuste se você já resgata pelo user)
app.post('/api/stripe/portal', async (_req, res) => {
  try {
    // 🔧 Se você já guarda o customer_id por usuário, busque aqui.
    // Para simplificar, criamos uma sessão genérica que pedirá login do e-mail do comprador anterior.
    const session = await stripe.billingPortal.sessions.create({
      // Se você tiver customer_id => passe { customer: 'cus_...' }
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
