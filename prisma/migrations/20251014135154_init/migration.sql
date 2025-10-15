-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "amount_halalas" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "scheme" TEXT,
    "customer_ref" TEXT,
    "metadata_json" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RentalOrder" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "merchant_no" TEXT NOT NULL,
    "site_no" TEXT NOT NULL,
    "device_no" TEXT NOT NULL,
    "cart_no" TEXT,
    "cart_index" INTEGER NOT NULL,
    "set_meal_id" TEXT,
    "amount_halalas" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "unlock_requested_at" TIMESTAMP(3),
    "unlock_confirmed_at" TIMESTAMP(3),
    "return_device_no" TEXT,
    "returned_at" TIMESTAMP(3),
    "electricity" INTEGER,
    "deposit_halalas" INTEGER,
    "refund_halalas" INTEGER,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RentalOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Package" (
    "id" SERIAL NOT NULL,
    "set_key" TEXT NOT NULL,
    "site_type" TEXT NOT NULL,
    "site_no" TEXT,
    "name" TEXT NOT NULL,
    "amount_halalas" INTEGER NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "recommended" INTEGER NOT NULL DEFAULT 0,
    "active" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Package_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RentalOrder_status_idx" ON "RentalOrder"("status");

-- CreateIndex
CREATE INDEX "RentalOrder_cart_no_idx" ON "RentalOrder"("cart_no");

-- CreateIndex
CREATE INDEX "Package_site_type_site_no_idx" ON "Package"("site_type", "site_no");

-- CreateIndex
CREATE INDEX "Package_set_key_active_idx" ON "Package"("set_key", "active");

-- AddForeignKey
ALTER TABLE "RentalOrder" ADD CONSTRAINT "RentalOrder_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
