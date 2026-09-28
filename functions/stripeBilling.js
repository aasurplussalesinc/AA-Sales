/**
 * SkidSling - SkidSling's OWN subscription billing (the platform Stripe account).
 *
 * This is the event handling that used to sit inline in exports.stripeWebhook
 * in index.js, moved here unchanged so it can be pinned by a regression test
 * (tests/unit/billingWebhook.test.mjs). stripeWebhook still verifies the
 * signature with STRIPE_WEBHOOK_SECRET and then calls handleBillingEvent().
 *
 * One addition: an event that carries `event.account` happened on a CONNECTED
 * account (a tenant's own Stripe account used for invoicing, see invoicing.js).
 * Those belong to stripeConnectWebhook and must never touch a tenant's plan or
 * subscription state here - a tenant's customer paying an invoice also emits
 * `invoice.*`-looking and `checkout.session.completed` events. They are
 * acknowledged and ignored.
 */

module.exports = function createBillingEventHandler(deps) {
  var db = deps.db;
  var admin = deps.admin;
  var PRICE_TO_PLAN = deps.PRICE_TO_PLAN;

  async function handleBillingEvent(event) {
    if (event && event.account) {
      console.log('stripeWebhook: ignoring connected-account event ' + event.type + ' (' + event.id + ')');
      return { ignored: 'connected-account event' };
    }

    switch (event.type) {

      // ── Payment succeeded — activate subscription ──
      case 'checkout.session.completed': {
        const session = event.data.object;
        const orgId = session.metadata?.orgId;
        const plan = session.metadata?.plan;
        const billingCycle = session.metadata?.billingCycle || 'monthly';

        if (orgId && plan) {
          await db.collection('organizations').doc(orgId).update({
            plan: plan,
            billingCycle: billingCycle,
            status: 'active',
            stripeSubscriptionId: session.subscription,
            stripeCustomerId: session.customer,
            subscriptionStartedAt: admin.firestore.FieldValue.serverTimestamp(),
            trialEndsAt: null,
          });
          console.log(`Activated ${plan} (${billingCycle}) for org ${orgId}`);
        }
        break;
      }

      // ── Subscription updated (upgrade/downgrade) ──
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const orgSnap = await db.collection('organizations')
          .where('stripeCustomerId', '==', sub.customer)
          .limit(1).get();

        if (!orgSnap.empty) {
          const orgRef = orgSnap.docs[0].ref;
          // Map Stripe price ID back to our { plan, billingCycle }
          const priceId = sub.items.data[0]?.price?.id;
          const mapped = priceId ? PRICE_TO_PLAN[priceId] : null;

          const updateData = {
            stripeSubscriptionId: sub.id,
            status: sub.status === 'active' ? 'active' : sub.status,
          };
          if (mapped) {
            updateData.plan = mapped.plan;
            updateData.billingCycle = mapped.billingCycle;
          }

          await orgRef.update(updateData);
          console.log(`Updated subscription for customer ${sub.customer}`);
        }
        break;
      }

      // ── Subscription cancelled or payment failed ──
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const orgSnap = await db.collection('organizations')
          .where('stripeCustomerId', '==', sub.customer)
          .limit(1).get();

        if (!orgSnap.empty) {
          await orgSnap.docs[0].ref.update({
            plan: 'expired',
            status: 'cancelled',
            stripeSubscriptionId: null,
          });
          console.log(`Cancelled subscription for customer ${sub.customer}`);
        }
        break;
      }

      // ── Payment failed ──
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const orgSnap = await db.collection('organizations')
          .where('stripeCustomerId', '==', invoice.customer)
          .limit(1).get();

        if (!orgSnap.empty) {
          await orgSnap.docs[0].ref.update({
            status: 'past_due',
          });
          console.log(`Payment failed for customer ${invoice.customer}`);
        }
        break;
      }

      // ── Payment recovered ──
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        if (invoice.billing_reason === 'subscription_cycle') {
          const orgSnap = await db.collection('organizations')
            .where('stripeCustomerId', '==', invoice.customer)
            .limit(1).get();

          if (!orgSnap.empty) {
            await orgSnap.docs[0].ref.update({
              status: 'active',
            });
          }
        }
        break;
      }

      default:
        console.log(`Unhandled event: ${event.type}`);
    }
    return { handled: event.type };
  }

  return { handleBillingEvent: handleBillingEvent };
};
