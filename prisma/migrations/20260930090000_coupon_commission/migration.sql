-- Optional creator/collaborator commission on coupons (reporting only). Additive.
CREATE TYPE "CouponCommissionType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT');

ALTER TABLE "Coupon" ADD COLUMN "commissionType" "CouponCommissionType",
ADD COLUMN "commissionValue" INTEGER;
