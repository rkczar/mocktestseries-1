-- Rajasthan FSO launch: per-product coupon switch. Additive; every existing product keeps coupons (DEFAULT true).
ALTER TABLE "Product" ADD COLUMN     "couponsAllowed" BOOLEAN NOT NULL DEFAULT true;
