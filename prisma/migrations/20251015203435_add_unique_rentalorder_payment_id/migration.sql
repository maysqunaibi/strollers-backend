/*
  Warnings:

  - A unique constraint covering the columns `[payment_id]` on the table `RentalOrder` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "RentalOrder_payment_id_key" ON "RentalOrder"("payment_id");
