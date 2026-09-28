/**
 * Default, conservative payment-related legal copy for an Indian online
 * mock-test service. Seeded ONCE into the admin-managed Contact / About /
 * Legal content (scripts/apply-payment-legal-content.ts) — after that the
 * text is owned and edited in Admin → Website → Homepage, never in code.
 *
 * Deliberately factual: it describes what the platform actually does
 * (Razorpay checkout, digital access to an account, invoices, automatic
 * re-checks of unconfirmed payments, refunds to the original method via
 * Razorpay) and makes no promise that needs an owner decision — no refund
 * windows, no guaranteed refunds, no "no refunds" rule, no legal entity,
 * no GST claims. Admin → Payments → Live Launch Readiness keeps every
 * document at "Owner review required" until a Master Admin reviews it.
 */

/** Payment paragraphs of the original (pre-payments) Terms / Privacy text, replaced only on an exact match. */
export const LEGACY_TERMS_PAYMENT_BLOCK =
  "## No Payment Obligation Today\nThe Platform does not currently charge for access. If paid plans are introduced, separate terms covering payment, refunds, and cancellation will be published before checkout is enabled. [Requires owner/legal review before payments launch.]";

export const LEGACY_PRIVACY_PAYMENT_BLOCK =
  "## Payments\nMockTestSeries.in does not currently process payments. All content on the Platform is available without a paid checkout flow. If paid plans are introduced in the future, this policy will be updated before any payment information is collected. [Requires owner/legal review before payments launch.]";

export const TERMS_PAYMENT_SECTION = `## Paid Plans and Payments
Some content on the Platform is free. Other content requires a paid plan. The price, what the plan includes and how long access lasts are shown on the plan and checkout pages before you pay, and the amount shown at checkout is the amount charged. Prices are in Indian Rupees (INR).

Payments are processed by Razorpay, our payment processor, using the payment methods it offers at checkout (for example UPI, cards or net banking). MockTestSeries.in does not receive or store your full card number, CVV, UPI PIN or OTP.

## Digital Access
A paid plan is a digital access right for your own student account. Access is activated once the payment is confirmed and lasts for the period shown on the plan. It is personal to your account and may not be shared, resold or transferred. An invoice for each successful payment is available in your account under Payments & Invoices.

If you choose to extend a plan that is still active, the extension is added to your current access end date, as shown on the checkout page before you pay.

## Refunds and Cancellation
Cancellations and refunds are governed by our Refund & Cancellation Policy, available at /refund-policy.`;

export const PRIVACY_PAYMENT_SECTION = `## Payments
When you buy a plan, your payment is processed by Razorpay, our payment processor. The card, UPI or bank details you enter at checkout are collected and processed by Razorpay under its own terms and privacy policy. MockTestSeries.in does not receive or store your full card number, CVV, UPI PIN or OTP.

To prefill the checkout form, your name, email address and mobile number (where available) are shared with Razorpay.

We keep a record of each order and payment — the plan, amount, date and time, order and payment reference numbers, payment status, the type of payment method used (for example "card" or "UPI") and the invoice issued — so that we can activate your access, show your payment history and invoices, respond to support, refund or dispute requests, and keep accounting records.`;

export const REFUND_POLICY_DEFAULT = `## About This Policy
This policy explains how cancellations and refunds work for paid plans bought on MockTestSeries.in. Please read it together with our Terms & Conditions.

## Nature of the Service
Paid plans give your student account digital access to online content — such as mock tests, previous year papers, solutions and performance analysis — for the period shown on the plan. Access is activated in your account once the payment is confirmed. Nothing is delivered physically.

## Cancellation
You can abandon a payment at any time before it is completed, and nothing is charged. Once a payment is completed, access is activated straight away. If you want to cancel a plan after buying it, contact us using the details below and your request will be handled as described under Refund Eligibility.

## Duplicate Payments
If you are charged more than once for the same purchase, contact us with the order number or payment reference. We will check it against our payment records and the payment processor's records and resolve any confirmed duplicate charge.

## Payment Failed but Amount Debited
If money was debited but your purchase was not confirmed, please do not pay again straight away. Our system automatically re-checks such payments with the payment processor and activates your access if the payment was successfully completed. Amounts that were debited but not successfully completed are normally reversed to your account by the payment processor or your bank within their usual timelines. If you need help, contact us with the order number and payment reference.

## Refund Eligibility
Refund requests are reviewed individually. To request a refund, contact us with your registered email address or mobile number, the order number and the reason for the request. We will tell you the outcome of your request.

## Refund Processing
Approved refunds are issued through our payment processor, Razorpay, to the original payment method used for the purchase. After a refund is issued, the time it takes to reach your account depends on your bank or payment provider.

## Access After a Refund
When a payment is fully refunded, the access that payment gave you may end or be limited. We will tell you what happens to your access when your refund is confirmed.

## Contact and Support
For questions about cancellations or refunds, contact us through the Contact Us page (/contact). Please include your registered email address or mobile number, the order number and the payment reference so we can help quickly.

## Changes to This Policy
We may update this policy from time to time. The date above shows when it was last updated.`;
