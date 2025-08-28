// server.js
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import bodyParser from 'body-parser';
import { createClient } from '@supabase/supabase-js';

const {
  PORT = 8080,
  // coloque SEMPRE seu domínio principal aqui; vou incluir ambos no CORS logo abaixo
  FRONTEND_ORIGIN = 'https://www.mydotts.com',
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  STRIPE_SECRET_KEY,
  STRIPE_PRICE_MONTHLY,   // opcional se for usar pelo front
  STRIPE_PRICE_ANNUAL,    // opcional se for usar pelo front
  STRIPE_WEBHOOK_SECRET,
  OPENAI_API_KEY
} = process.env;

// --- sanity checks ---
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[BOOT] Missing SUPABASE envs');
  process.exit(1);
}
if (!STRIPE_SECRET_KEY) {
  console.error('[BOOT] Missing STRIPE_SECRET_KEY');
  process.exit(1);
}
if (!STRIPE_WEBHOOK_SECRET) {
  console.warn('[BOOT] STRIPE_WEBHOOK_SECRET is not set (webhook will fail).');
}

const app = express();

// Usaremos bodyParser.raw SOMENTE no webhook:
app.use((req, res, next) => {
  if (req.originalUrl === '/api/stripe/webhook') {
    next();
  } else {
    express.json()(req, res, next);
  }
});

// CORS — libere produção e dev
app.use(
  cors({
    origin: [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'https://mydotts.com',
      'https://www.mydotts.com',
      FRONTEND_ORIGIN, // por garantia
    ],
    credentials: true,
  })
);

// opcional: responder preflight rapidamente
app.options('*', cors());

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// --------------------- HELPERS ---------------------
async function getOrCreateStripeCustomer(userId) {
  const { data: profile, error: profErr } = await supabase
    .from('profiles')
    .select('id, email, stripe_customer_id')
    .eq('id', userId)
    .single();

  if (profErr) {
    console.warn('[getOrCreateStripeCustomer] profiles select error:', profErr);
  }

  if (profile?.stripe_customer_id) return profile.stripe_customer_id;

  const customer = await stripe.customers.create({
    email: profile?.email ?? undefined,
    metadata: { supabase_user_id: userId },
  });

  const { error: upErr } = await supabase
    .from('profiles')
    .update({ stripe_customer_id: customer.id })
    .eq('id', userId);

  if (upErr) console.warn('[getOrCreateStripeCustomer] profiles update error:', upErr);

  return customer.id;
}

// --------------------- ROUTES ---------------------
// Healthcheck (agora com prefixo /api)
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Cria sessão do Checkout (assinatura)
app.post('/api/stripe/create-checkout-session', async (req, res) => {
  try {
    const { userId, priceId } = req.body;
    if (!userId || !priceId) {
      return res.status(400).json({ error: 'userId and priceId are required' });
    }

    const customerId = await getOrCreateStripeCustomer(userId);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      // seu front usa /plans (e não /plan)
      success_url: `https://www.mydotts.com/plans?success=1`,
      cancel_url: `https://www.mydotts.com/plans?canceled=1`,
      metadata: { userId },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[create-checkout-session] error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Portal do cliente
app.post('/api/stripe/create-portal-session', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const customerId = await getOrCreateStripeCustomer(userId);
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `https://www.mydotts.com/plans`,
    });

    res.json({ url: portalSession.url });
  } catch (err) {
    console.error('[create-portal-session] error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Webhook do Stripe (AGORA em /api/stripe/webhook)
app.post(
  '/api/stripe/webhook',
  bodyParser.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('[webhook] signature verification failed:', err.message);
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
            await supabase.from('subscriptions').upsert(
              {
                user_id: userId,
                stripe_customer_id: String(customerId),
                stripe_subscription_id: String(subscriptionId),
                status: 'active',
              },
              { onConflict: 'user_id' }
            );

            await supabase
              .from('profiles')
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

          const { data: prof } = await supabase
            .from('profiles')
            .select('id')
            .eq('stripe_customer_id', customerId)
            .single();

          if (prof?.id) {
            await supabase.from('subscriptions').upsert(
              {
                user_id: prof.id,
                stripe_customer_id: customerId,
                stripe_subscription_id: sub.id,
                price_id: priceId,
                status,
                current_period_end: currentPeriodEnd,
              },
              { onConflict: 'user_id' }
            );

            await supabase
              .from('profiles')
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
            await supabase
              .from('subscriptions')
              .update({ status: 'canceled' })
              .eq('user_id', prof.id);

            await supabase
              .from('profiles')
              .update({ plan: 'free' })
              .eq('id', prof.id);
          }
          break;
        }
        default:
          // ignore outros eventos
          break;
      }

      res.json({ received: true });
    } catch (err) {
      console.error('[webhook handler] error:', err);
      res.status(500).send('Server error');
    }
  }
);

// Diário com IA (resumo) sob /api
app.post('/api/diary/summarize', async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(400).json({ error: 'OPENAI_API_KEY not configured' });
    }
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'Resuma o texto em 2-3 frases, tom positivo e claro.',
          },
          { role: 'user', content: text },
        ],
        temperature: 0.3,
      }),
    });

    const data = await resp.json();
    const summary = data?.choices?.[0]?.message?.content ?? '';
    res.json({ summary });
  } catch (err) {
    console.error('[diary/summarize] error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.listen(PORT, () => {
  console.log(`[BOOT] Server running on port ${PORT}`);
  console.log(`[BOOT] Health: GET /api/health`);
});

