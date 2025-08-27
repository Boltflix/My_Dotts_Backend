import express from 'express';
import Stripe from 'stripe';

export const webhookRaw = express.raw({ type: 'application/json' });
const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Ex: usado pelo front se quiser exibir preços
router.get('/config', (req, res) => {
  res.json({
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    prices: {
      monthly: process.env.STRIPE_PRICE_MONTHLY,
      annual: process.env.STRIPE_PRICE_ANNUAL
    }
  });
});

// Checkout – o front manda form-urlencoded { plan: 'monthly' | 'annual' }
router.post('/checkout', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const { plan = 'monthly' } = req.body;
    const price = plan === 'annual' ? process.env.STRIPE_PRICE_ANNUAL : process.env.STRIPE_PRICE_MONTHLY;
    if (!price) return res.status(400).json({ error: 'missing_price_id' });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      success_url: `${process.env.FRONTEND_ORIGIN}/plan?success=true`,
      cancel_url: `${process.env.FRONTEND_ORIGIN}/plan?canceled=true`
    });

    return res.json({ url: session.url });
  } catch (e) {
    console.error('checkout_failed', e);
    return res.status(400).json({ error: 'checkout_failed' });
  }
});

// Webhook – valida a assinatura e (se quiser) atualiza status premium depois
router.post('/webhook', webhookRaw, async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed.', err.message);
    return res.sendStatus(400);
  }

  // Eventos comuns:
  switch (event.type) {
    case 'checkout.session.completed':
      // TODO: atualizar usuário como premium no Supabase (futuro)
      break;
    case 'customer.subscription.updated':
    case 'invoice.paid':
      // TODO: manter status/validade
      break;
  }

  res.json({ received: true });
});

export { router as stripeRouter };
