# Stripe Setup Instructions

## 1. API Keys
Go to **Stripe Dashboard → Developers → API Keys**
- Copy the **Secret Key** (`sk_live_...`)
- Copy the **Publishable Key** (`pk_live_...`)

## 2. Create Webhook
Go to **Stripe Dashboard → Developers → Webhooks → Add Endpoint**
- Endpoint URL: `https://arcwright-site-production.up.railway.app/api/webhook/stripe`
- Events to subscribe: `checkout.session.completed`
- Copy the **Signing Secret** (`whsec_...`)

## 3. Set Railway Env Vars
```
railway variables set \
  STRIPE_SECRET_KEY=sk_live_... \
  STRIPE_PUBLISHABLE_KEY=pk_live_... \
  STRIPE_WEBHOOK_SECRET=whsec_...
```

Or set them in the Railway dashboard for the Arcwright service.

## 4. Test
- Use Stripe test keys first (`sk_test_...`, `pk_test_...`) to verify the flow
- Test card: `4242 4242 4242 4242`, any future expiry, any CVC
- Once confirmed working, swap to live keys
