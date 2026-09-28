/**
 * Payment-capable legal documents for MockTestSeries.in — Terms &
 * Conditions, Privacy Policy and Refund & Cancellation Policy. Seeded into
 * the admin-managed Contact / About / Legal content by
 * scripts/apply-payment-legal-content.ts; after that the text is owned and
 * edited in Admin → Website → Homepage, never in code.
 *
 * Built on the original (pre-payments) Terms / Privacy text — every original
 * statement is kept — with the placeholder payment paragraphs replaced and
 * the missing sections added. Deliberately factual: it describes what the
 * platform actually does (Razorpay checkout, webhook + scheduled
 * reconciliation, digital access to one account, invoices, refunds to the
 * original method via Razorpay, MSG91 OTP, Google Gemini explanations) and
 * makes no promise that needs an owner decision — no refund windows, no
 * guaranteed refunds, no "no refunds" rule, no legal entity, no GST claims,
 * no exclusive court. Business name / address / support contacts are shown
 * beside each page from Admin → Payments → Settings, not written in here.
 * Admin → Payments → Live Launch Readiness keeps every document at "Owner
 * review required" until a Master Admin reviews it.
 */

/** Payment paragraphs of the original (pre-payments) Terms / Privacy text — their presence marks an un-migrated document. */
export const LEGACY_TERMS_PAYMENT_BLOCK =
  "## No Payment Obligation Today\nThe Platform does not currently charge for access. If paid plans are introduced, separate terms covering payment, refunds, and cancellation will be published before checkout is enabled. [Requires owner/legal review before payments launch.]";

export const LEGACY_PRIVACY_PAYMENT_BLOCK =
  "## Payments\nMockTestSeries.in does not currently process payments. All content on the Platform is available without a paid checkout flow. If paid plans are introduced in the future, this policy will be updated before any payment information is collected. [Requires owner/legal review before payments launch.]";

export const TERMS_DOCUMENT = `## Acceptance of Terms
These Terms & Conditions govern your use of MockTestSeries.in ("MockTestSeries.in", "we", "us", "the Platform"). By creating an account or using MockTestSeries.in, you agree to these terms, together with our Privacy Policy and our Refund & Cancellation Policy. If you do not agree, please do not use the Platform.

## Who Can Use This Platform
The Platform is intended for students preparing for competitive exams. You are responsible for the accuracy of the information you provide when registering. If you are under 18, please use the Platform with the involvement of a parent or guardian, who should also review these terms.

## Your Account
You are responsible for keeping your login credentials secure. Notify us if you suspect unauthorized access to your account. Your account is personal to you: do not share your login or let anyone else use your account, and do not create accounts in another person's name.

## Educational Nature of the Service
MockTestSeries.in is an online practice and self-assessment service for competitive exam preparation. Using the Platform does not guarantee any exam result, score, rank, qualification, selection or other outcome.

Unless expressly stated otherwise, MockTestSeries.in is an independent platform. It is not affiliated with, endorsed by, or acting on behalf of any university, examination-conducting authority or recruitment body (such as RUHS, RPSC or NTA). Exam names are used only to describe the exams our practice content is designed for. Always rely on the official notifications of the conducting authority for exam dates, patterns, syllabus and eligibility.

## Exams, Mock Tests and Digital Content
Mock tests, previous year papers, and questions on the Platform are provided for practice and self-assessment. Content may include mock tests, previous year papers, subject tests, custom practice modules, solutions, performance analysis, AI-generated explanations and downloadable practice resources. Some tests are released on a schedule and may be available only during the window shown for them.

## Accuracy and Availability of Content
We work to keep questions, answers and explanations accurate, but errors can occur. AI-generated explanations are produced automatically and may occasionally be inaccurate — verify important concepts against your study material. You can report a question you believe is wrong from the test or review screen.

We may add, update, correct, reschedule or withdraw content, and the number of tests planned for a series may change. Where you bought a paid plan, what it includes is described on the plan and checkout pages at the time of purchase.

## Plans, Pricing and Access Duration
MockTestSeries.in may offer both free and paid educational content, and some content may be made free for a limited period. Paid content is sold as plans. The price, what the plan includes (its access scope) and how long access lasts are shown on the plan and checkout pages. The price, duration and access scope displayed at checkout at the time of purchase are the applicable commercial terms for that order. Prices are in Indian Rupees (INR). Changes to prices or plans apply to future purchases, not to orders already paid.

## Payments
Payment is made online at checkout, before access to a paid plan is given. The amount shown at checkout, after any valid coupon, is the amount charged. There are no automatic recurring charges: each purchase, extension or renewal is a separate payment that you start yourself.

## Payment Processing by Razorpay
Payments are processed by Razorpay or another payment processor enabled by MockTestSeries.in, using the payment methods it offers at checkout (for example UPI, cards or net banking). Your payment is also subject to the terms of the payment processor and of your bank or payment provider. MockTestSeries.in does not receive or store your full card number, CVV, UPI PIN, OTP or banking passwords.

## Payment Confirmation and Activation of Access
A paid plan is a digital access right for your own student account. Access is activated once the payment is confirmed and lasts for the period shown on the plan. It is personal to your account and may not be shared, resold or transferred. An invoice for each successful payment is available in your account under Payments & Invoices.

A successful payment never requires you to pay a second time if its confirmation is delayed. We verify transactions through the payment confirmation received at checkout, signed notifications (webhooks) from the payment processor and/or regular reconciliation with the payment processor's records, and activate access as soon as a successful payment is confirmed.

## Failed, Pending or Interrupted Payments
If a payment fails, is cancelled, or is interrupted (for example, the checkout window closes or your connection drops), no access is given for that attempt. If money was debited but your purchase is not yet confirmed, please do not pay again straight away: the payment is re-checked automatically with the payment processor, and access is activated if the payment was successfully completed. Amounts debited for payments that were not successfully completed are normally reversed by the payment processor or your bank within their usual timelines. An unpaid checkout order expires after a short time; you can then start a new one.

## Duplicate Payments
If you are charged more than once for the same purchase, contact us with the order number or payment reference. Duplicate payments are handled as described in our Refund & Cancellation Policy.

## Coupons and Discounts
Where coupons or discounts are offered, their value and conditions (such as validity dates, eligible plans or usage limits) are shown or applied at checkout, and every coupon is validated when you pay. Coupons have no cash value, cannot be exchanged for money, and apply only to the order they were used on. We may withdraw a coupon that was issued in error or misused.

## Access Expiry and Renewal
Access to a paid plan ends on the end date shown in your account (My Subscriptions), unless the plan provides access without an end date. After access ends, the paid content is locked again; your account, test history and invoices remain available. If you extend a plan that is still active, the extension is added to your current access end date, as shown on the checkout page before you pay. If you renew after access has ended, the new period starts from the date of the renewal payment.

## Refunds and Cancellations
Cancellations and refunds are governed by our Refund & Cancellation Policy, available at /refund-policy.

## Technical Problems and Service Availability
We aim to keep the Platform available and working correctly, but it may occasionally be unavailable or slow because of maintenance, updates, technical faults or events outside our control, including problems with internet connections, devices, payment processors or other third-party services. If a technical problem on our side affects a test you are taking or content you paid for, contact us and we will look into it. Where appropriate, we may restore an attempt, extend access or take another reasonable step to resolve it.

## Content Ownership
Questions, papers, and other content on the Platform belong to MockTestSeries.in or its licensors. You may use them for your own exam preparation, not for redistribution. The MockTestSeries.in name, logo and website design are also protected. Nothing in these terms transfers any ownership to you.

## Acceptable Use
Do not attempt to disrupt the Platform, access another student's data, or misuse the Contact Us / Grow with Us forms (for example, automated or abusive submissions). You must also not:
- copy, download in bulk, scrape, record, publish, sell or otherwise redistribute questions, solutions or other Platform content;
- share your account or paid access with others, or use another person's account;
- use bots, scripts or other automated means to access the Platform or take tests;
- try to get around access controls, payment checks or security measures;
- make fraudulent payments, misuse coupons, or raise false payment disputes or chargebacks;
- use the Platform for any unlawful purpose.

## Suspension and Termination
We may suspend or close an account, or withdraw access to content, if these terms are seriously or repeatedly breached, if there is fraud or misuse, or where required by law. Where appropriate, we will tell you why and give you a chance to respond. Any refund in such a case is handled under our Refund & Cancellation Policy and applicable law.

## Account Deletion
You may request deletion of your account at any time; see our Privacy Policy for how that works. Once an account is deleted, access to any paid plan held by that account ends. Records we must keep, such as payment and invoice records, are retained as described in the Privacy Policy.

## Limitation of Liability
The Platform and its content are provided for practice and self-assessment, on an "as available" basis. To the extent permitted by applicable law, MockTestSeries.in is not liable for any indirect or consequential loss, or for any loss arising from exam results, rankings, selections or decisions you make based on Platform content. To the extent permitted by applicable law, our total liability to you for any claim relating to a paid plan is limited to the amount you paid for that plan. Nothing in these terms limits any right you have under applicable consumer protection law.

## Changes to the Service or These Terms
We may update these terms as the Platform evolves. The date above reflects the last update. Changes do not affect orders already paid, except where required by law. By continuing to use the Platform after a change, you accept the updated terms.

## Governing Law
These terms are governed by the laws of India. Disputes relating to these terms or the Platform are subject to the jurisdiction of the competent courts in India, without affecting any right you have under applicable law to bring a claim elsewhere. We encourage you to contact us first so that we can try to resolve any concern quickly.

## Contact
Questions about these terms can be sent through our Contact Us page (/contact). For payment, access, refund or invoice questions, please include your registered email address or mobile number and, where relevant, the order number and payment reference.`;

export const PRIVACY_DOCUMENT = `## Who We Are
MockTestSeries.in ("we", "us", "the Platform") provides online mock tests, previous year question papers, and AI-generated explanations for competitive exam preparation. This policy explains what information we collect from visitors and registered students, and how we use it. It also explains the choices you have.

## Information You Provide
When you create a student account, we collect your name and, depending on how you sign up, your email address or mobile number. If you sign in with Google, we receive your Google account's email address to link your account. If you sign in with a mobile number, we send a one-time password (OTP) to verify it — OTP codes are never stored in plain text. OTPs are sent by SMS through our SMS delivery provider (MSG91). If you sign up with a password, it is stored only in hashed form.

If you contact us through the Contact Us → Message Us form or the Grow with Us dialog, we collect the name, email, phone number (if provided), and message you submit.

## Information We Collect Automatically
We record your test attempts, answers, scores, and time taken so you can review your results and track your progress. We also record which questions you save for later. If you report a question, we record the report. If you sign in, we log basic authentication activity (method used, timestamp, and IP address) to protect your account against abuse.

## Payment Information
When you buy a plan, we keep a record of each order and payment — the plan, amount, any coupon applied, date and time, order and payment reference numbers, payment status, the type of payment method used (for example "card" or "UPI"), any refund, and the invoice issued (which includes your name and contact details). We do not receive or store your full card number, CVV, UPI PIN, OTP or banking passwords.

## Payments
When you buy a plan, your payment transaction is processed by Razorpay, our payment processor. The card, UPI or bank details you enter at checkout are collected and processed by Razorpay under its own terms and privacy policy, as part of the payment flow. MockTestSeries.in does not receive or store your full card number, CVV, UPI PIN or OTP.

To prefill the checkout form, your name, email address and mobile number (where available) are shared with Razorpay, together with our order number and the plan being bought. Razorpay sends us the result of the payment (for example, whether it succeeded, the payment reference and the method type) so that we can confirm it, activate your access and issue an invoice.

## AI-Generated Explanations
When you request an AI explanation for a question, the question text is sent to our AI provider (Google Gemini) to generate an explanation. We do not send your name, email, or other personal information as part of that request.

## Cookies and Sessions
We use cookies to keep you signed in (separate session cookies for students and administrators) and to remember your light/dark theme preference. The Razorpay checkout may set its own cookies while you pay. We do not use third-party advertising or analytics tracking cookies at this time.

## How We Use Your Information
We use your information to operate your account, show you your test history and performance, respond to messages you send us, and keep the Platform secure. In particular, we use it to:
- create and operate your account and keep it secure (including sign-in verification and abuse prevention);
- run tests, show your results, test history and performance analysis, and personalise your practice (for example, highlighting weak topics);
- provide AI-generated explanations when you request them;
- process payments, activate and manage your access, issue invoices, and handle refunds, duplicate payments and payment disputes;
- respond to messages and support requests you send us;
- send you service messages, such as OTPs and important account or payment notices;
- keep records required for accounting and legal purposes, and keep the Platform secure.

We do not sell your personal information.

## Service Providers
We share only the information needed for each purpose with the providers that help us run the Platform: our payment processor (Razorpay), our SMS delivery provider for OTPs (MSG91), Google (only if you choose Google sign-in), our AI provider (Google Gemini, which receives question text only), and the hosting and backup-storage providers that store the Platform and its data securely. They may use this information only to provide their service.

## Who Can See Your Information
Contact Us and Grow with Us submissions, and your account details, are visible only to authorized administrators — never displayed publicly. We may disclose information where required by law, by a court or government authority, or where necessary to prevent fraud or protect the rights and safety of our students, the Platform or others.

## Data Retention
We keep your account information and test history while your account is active. Order, payment, refund and invoice records are kept for as long as needed for accounting, tax and legal requirements and to resolve disputes, even after an account is deleted. Security logs are kept to protect accounts against abuse. Backups are kept for a limited period and then removed.

## Security
We protect your information with measures such as encrypted connections (HTTPS), hashed passwords and one-time codes, encrypted storage of payment-gateway credentials, role-based access for administrators, and regular backups. No online service can be completely secure, so please keep your login details private and tell us if you suspect unauthorized access.

## Account Deletion and Your Choices
You can view and update your profile details in your account. You can request deletion of your account from your profile. An administrator reviews and processes deletion requests; once approved, your account data is removed according to our internal process, except for records we must keep as described under Data Retention. For any other question or request about your personal information, contact us through the Contact Us page.

## Changes to This Policy
We may update this policy as the Platform changes. The date above reflects the last update.

## Contact
Questions about this policy can be sent through our Contact Us page (/contact).`;

export const REFUND_POLICY_DOCUMENT = `## About This Policy
This policy explains how cancellations and refunds work for paid plans bought on MockTestSeries.in. Please read it together with our Terms & Conditions. Nothing in this policy limits any right you have under applicable law.

## Nature of the Service
Paid plans give your student account digital access to online educational content — such as mock tests, previous year papers, solutions and performance analysis — for the period shown on the plan. Nothing is delivered physically.

## When Access Is Activated
Access is activated in your account as soon as the payment is confirmed — usually within moments of a successful payment. You can see your active plans and their end dates under My Subscriptions, and your payments and invoices under Payments & Invoices.

## Cancellation
You can abandon a payment at any time before it is completed, and nothing is charged. Once a payment is completed, access is activated straight away. If you want to cancel a plan after buying it, contact us using the details below and your request will be handled as described under Refund Eligibility.

## Refund Eligibility
Because paid plans give immediate access to digital content, refund requests are reviewed individually. When reviewing a request we consider, for example, whether you were charged in error or more than once, whether access was delivered as described, whether a technical problem on our side prevented you from using what you paid for, and how much of the paid content has already been used. We will tell you the outcome of your request.

## Duplicate Payments and Incorrect Charges
If you are charged more than once for the same purchase, or charged an amount different from the amount shown at checkout, contact us with the order number or payment reference. We will check it against our payment records and the payment processor's records and refund any confirmed duplicate or incorrect charge to the original payment method.

## Successful Payment but Access Not Activated
If your payment succeeded but your access is not active, please do not pay again. Our system automatically re-checks payments with the payment processor and activates access when a successful payment is confirmed. If access is still not active after some time, contact us with the order number and payment reference, and we will activate your access or, if that is not possible, refund the payment.

## Failed or Pending Payments
If money was debited but your purchase was not confirmed, please do not pay again straight away. Our system automatically re-checks such payments with the payment processor and activates your access if the payment was successfully completed. Amounts that were debited but not successfully completed are normally reversed to your account by the payment processor or your bank within their usual timelines. If you need help, contact us with the order number and payment reference.

## Technical Problems
If a technical problem on our side prevents you from using content you paid for, contact us. We will first try to fix the problem or restore your access; where appropriate we may extend your access period, or consider a full or partial refund.

## How to Request a Refund
Contact us through the Contact Us page (/contact), or at the support email shown on this page, with the subject "Refund / cancellation request". Please include:
- your registered email address or mobile number;
- the order number and/or payment reference (shown in your account under Payments & Invoices or in the payment confirmation);
- the date and amount of the payment;
- the reason for your request, with any helpful details (for example, a screenshot of a duplicate debit).

Never share your card number, CVV, UPI PIN, OTP or passwords with anyone, including us.

## Review of Refund Requests
We review each request against our payment records and the payment processor's records, and may contact you for more information. We will tell you whether the request is approved.

## Refund Processing
Approved refunds are issued through our payment processor, Razorpay, to the original payment method used for the purchase. We do not refund to a different account or method. A refund takes place in two stages:
- our processing — reviewing the request and issuing the refund through the payment processor; and
- the additional time taken by the payment processor and your bank or payment provider to credit the amount to your account after the refund is issued.

The second stage depends on your bank or payment provider and is outside our control.

## Access After a Refund
When a payment is fully refunded, the access that payment gave you may end or be limited. We will tell you what happens to your access when your refund is confirmed. A partial refund does not by itself change your access.

## Contact and Support
For questions about cancellations or refunds, contact us through the Contact Us page (/contact). Please include your registered email address or mobile number, the order number and the payment reference so we can help quickly.

## Changes to This Policy
We may update this policy from time to time. The date above shows when it was last updated. Refund requests are handled under the policy that applied when the payment was made.`;
