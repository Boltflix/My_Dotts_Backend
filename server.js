// server.js
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import bodyParser from 'body-parser';
import { createClient } from '@supabase/supabase-js';

const {
  PORT = 8080,
  FRONTEND_ORIGIN = 'https://www.mydotts.com',
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  STRIPE_SECRET_KEY,
  STRIPE_PRICE_MONTHLY,
  STRIPE_PRICE_ANNUAL,
  STRIPE_WEBHOOK_SECRET,
  OPENAI_API_KEY
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE envs'); process.exit(1);
}
if (!STRIPE_SECRET_KEY) { console.error('Missing STRIPE_SECRET_KEY'); process.exit(1); }

const app = express();

// Webhook precisa do raw body (não usar express.json para /stripe/webhook)
app.use((req, res, next) => {
  if (req.originalUrl === '/stripe/webhook') {
    next();
  } else {
    express.json()(req, res, next);
  }
});

app.use(cors({
  origin: [FRONTEND_ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:5173'],
  credentials: true
}));

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

// Helpers
async function getOrCreateStripeCustomer(userId) {
  // tenta achar na profiles
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, email, stripe_customer_id')
    .eq('id', userId)
    .single();

  if (profile?.stripe_customer_id) return profile.stripe_customer_id;

  // cria no Stripe
  const customer = await stripe.customers.create({
    email: profile?.email ?? undefined,
    metadata: { supabase_user_id: userId }
  });

  // salva
  await supabase.from('profiles')
    .update({ stripe_customer_id: customer.id })
    .eq('id', userId);

  return customer.id;
}

// Routes
app.get('/health', (_, res) => res.json({ ok: true }));

app.post('/stripe/create-checkout-session', async (req, res) => {
  try {
    const { userId, priceId } = req.body;
    if (!userId || !priceId) return res.status(400).json({ error: 'userId and priceId are required' });

    const customerId = await getOrCreateStripeCustomer(userId);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${FRONTEND_ORIGIN}/plan?success=1`,
      cancel_url: `${FRONTEND_ORIGIN}/plan?canceled=1`,
      metadata: { userId }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('create-checkout-session error', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.post('/stripe/create-portal-session', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const customerId = await getOrCreateStripeCustomer(userId);
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${FRONTEND_ORIGIN}/plan`
    });
    res.json({ url: portalSession.url });
  } catch (err) {
    console.error('create-portal-session error', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Webhook
app.post('/stripe/webhook',
  bodyParser.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('Webhook signature verification failed.', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          const userId = session.metadata?.userId;
          const subscriptionId = session.subscription;
          const customerId = session.customer;

          if (userId) {
            // upsert subscriptions
            await supabase.from('subscriptions').upsert({
              user_id: userId,
              stripe_customer_id: String(customerId),
              stripe_subscription_id: String(subscriptionId),
              status: 'active'
            }, { onConflict: 'user_id' });

            // set profile plan
            await supabase.from('profiles')
              .update({ plan: 'premium' })
              .eq('id', userId);
          }
          break;
        }

        case 'customer.subscription.updated':
        case 'customer.subscription.created': {
          const sub = event.data.object;
          const customerId = sub.customer;
          const status = sub.status;
          const priceId = sub.items?.data?.[0]?.price?.id || null;
          const currentPeriodEnd = sub.current_period_end
            ? new Date(sub.current_period_end * 1000).toISOString()
            : null;

          // find user by customerId
          const { data: prof } = await supabase
            .from('profiles')
            .select('id')
            .eq('stripe_customer_id', customerId)
            .single();

          if (prof?.id) {
            await supabase.from('subscriptions').upsert({
              user_id: prof.id,
              stripe_customer_id: customerId,
              stripe_subscription_id: sub.id,
              price_id: priceId,
              status,
              current_period_end: currentPeriodEnd
            }, { onConflict: 'user_id' });

            await supabase.from('profiles')
              .update({ plan: status === 'active' ? 'premium' : 'free' })
              .eq('id', prof.id);
          }
          break;
        }

        case 'customer.subscription.deleted': {
          const sub = event.data.object;
          const customerId = sub.customer;

          const { data: prof } = await supabase
            .from('profiles')
            .select('id')
            .eq('stripe_customer_id', customerId)
            .single();

          if (prof?.id) {
            await supabase.from('subscriptions')
              .update({ status: 'canceled' })
              .eq('user_id', prof.id);

            await supabase.from('profiles')
              .update({ plan: 'free' })
              .eq('id', prof.id);
          }
          break;
        }
        default:
          // ignore others
          break;
      }
      res.json({ received: true });
    } catch (err) {
      console.error('Webhook handler error', err);
      res.status(500).send('Server error');
    }
  }
);

// Diário com IA (resumo)
app.post('/diary/summarize', async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(400).json({ error: 'OPENAI_API_KEY not configured' });
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });

    // Modelo enxuto (troque pelo de sua preferência)
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Resuma o texto em 2-3 frases, tom positivo e claro.' },
          { role: 'user', content: text }
        ],
        temperature: 0.3
      })
    });

    const data = await resp.json();
    const summary = data?.choices?.[0]?.message?.content ?? '';
    res.json({ summary });
  } catch (err) {
    console.error('summarize error', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.listen(PORT, () => console.log(`API listening on :${PORT}`));
