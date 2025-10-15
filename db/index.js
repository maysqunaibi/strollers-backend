const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
exports.prisma = prisma;
// Create or update a payment row from Moyasar API response
exports.upsertPaymentFromMoyasar = async function upsertPaymentFromMoyasar(
  pay
) {
  console.log(
    "[DB] upsertPaymentFromMoyasar id:",
    pay?.id,
    "status:",
    pay?.status,
    "amount:",
    pay?.amount,
    "currency:",
    pay?.currency
  );

  // normalize fields
  const id = String(pay.id);
  const status = String(pay.status || "").toLowerCase(); // paid, authorized, failed, etc.
  const mode =
    (pay.source && pay.source.type) ||
    pay.source?.company ||
    pay.method ||
    null; // depends on Moyasar object
  const scheme = pay.source?.scheme || null; // e.g., mada/visa/applepay
  const amount_halalas = Number(pay.amount || 0);
  const currency = (pay.currency || "SAR").toUpperCase();
  const metadata_json = JSON.stringify(pay);

  // idempotent upsert by payment id
  const row = await prisma.payment.upsert({
    where: { id },
    create: {
      id,
      status,
      mode,
      scheme,
      amount_halalas,
      currency,
      metadata_json,
    },
    update: {
      status,
      mode,
      scheme,
      amount_halalas,
      currency,
      metadata_json,
    },
  });
  console.log("[DB] payment upserted:", row.id, row.status);
  return row;
};

// Create/open a rental order tied to a payment (idempotent on payment_id)
exports.openOrderForPayment = async function openOrderForPayment({
  paymentId,
  siteNo,
  deviceNo,
  cartNo,
  cartIndex,
  amountHalalas,
  merchantNo,
}) {
  // If an order already exists for this payment, just return it
  console.log(
    "[DB] openOrderForPayment paymentId:",
    paymentId,
    "deviceNo:",
    deviceNo,
    "cart:",
    cartNo,
    "#",
    cartIndex,
    "amount:",
    amountHalalas
  );

  const existing = await prisma.rentalOrder.findFirst({
    where: { payment_id: paymentId },
  });
  if (existing) {
    console.log("[DB] existing order:", existing.id, existing.status);
    return existing;
  }
  try {
    // Create new order in pending_payment (or unlocking—see below)
    const order = await prisma.rentalOrder.create({
      data: {
        status: "unlocking", // we’re past payment confirmation here
        site_no: siteNo || null,
        device_no: deviceNo,
        cart_no: cartNo,
        cart_index: cartIndex,
        amount_halalas: amountHalalas,
        payment_id: paymentId,
        unlock_requested_at: new Date(),
        merchant_no: merchantNo,
      },
    });
    console.log("[DB] created order:", order.id, order.status);
    return order;
  } catch (e) {
    if (String(e.message).includes("Unique constraint failed")) {
      return await prisma.rentalOrder.findFirst({
        where: { payment_id: paymentId },
      });
    }
    throw e;
  }
};

// Minimal status update helper (if you don’t already have one)
module.exports.updateOrderStatus = async function updateOrderStatus(id, patch) {
  console.log("[DB] updateOrderStatus:", id, patch);
  const row = await prisma.rentalOrder.update({
    where: { id },
    data: patch,
    include: { payment: true },
  });
  console.log("[DB] order updated:", row.id, row.status);
  return row;
};

exports.insertOrUpdatePayment = (p) =>
  prisma.payment.upsert({
    where: { id: p.id },
    update: {
      mode: p.mode,
      status: p.status,
      amount_halalas: p.amount_halalas,
      currency: p.currency,
      scheme: p.scheme,
      customer_ref: p.customer_ref,
      metadata_json: p.metadata_json,
    },
    create: {
      id: p.id,
      mode: p.mode,
      status: p.status,
      amount_halalas: p.amount_halalas,
      currency: p.currency,
      scheme: p.scheme,
      customer_ref: p.customer_ref,
      metadata_json: p.metadata_json,
    },
  });

exports.getPayment = (id) => prisma.payment.findUnique({ where: { id } });

exports.createPendingOrder = (o) => prisma.rentalOrder.create({ data: o });

exports.findActiveOrderByCart = ({ cartNo, cartIndex }) => {
  if (cartNo) {
    return prisma.rentalOrder.findFirst({
      where: { status: "in_use", cart_no: cartNo },
      orderBy: { unlock_confirmed_at: "desc" },
    });
  }
  return prisma.rentalOrder.findFirst({
    where: { status: "in_use", cart_index: cartIndex },
    orderBy: { unlock_confirmed_at: "desc" },
  });
};

exports.getActiveOrders = () =>
  prisma.rentalOrder.findMany({
    where: { status: "in_use" },
    orderBy: { unlock_confirmed_at: "desc" },
  });

exports.listPackages = async ({
  siteType = "SHOPPING_MALL",
  siteNo = null,
} = {}) => {
  if (siteNo) {
    const siteRows = await prisma.package.findMany({
      where: { active: 1, site_no: siteNo },
      orderBy: { display_order: "asc" },
    });
    if (siteRows.length) return siteRows;
  }
  return prisma.package.findMany({
    where: { active: 1, site_type: siteType, site_no: null },
    orderBy: { display_order: "asc" },
  });
};

/**
 * Find the active (in_use) order for this return and mark it returned.
 * Search priority:
 *   1) cart_no match (most reliable)
 *   2) device_no + cart_index
 */
module.exports.closeOrderOnReturnFromVendor =
  async function closeOrderOnReturnFromVendor({
    merchantNo,
    deviceNo,
    cartNo,
    cartIndex,
    electricity, // may be number or string
  }) {
    console.log("[DB] closeOrderOnReturnFromVendor input:", {
      merchantNo,
      deviceNo,
      cartNo,
      cartIndex,
      electricity,
    });

    // normalize values
    const cartIndexNum = Number(cartIndex);
    const elecNum = electricity == null ? null : Number(electricity);

    // 1) try by cart_no
    let order = null;
    if (cartNo) {
      order = await prisma.rentalOrder.findFirst({
        where: {
          merchant_no: merchantNo,
          cart_no: cartNo,
          status: "in_use",
        },
        orderBy: { created_at: "desc" },
      });
    }

    // 2) fallback by device + index
    if (!order && deviceNo && Number.isFinite(cartIndexNum)) {
      order = await prisma.rentalOrder.findFirst({
        where: {
          merchant_no: merchantNo,
          device_no: deviceNo,
          cart_index: cartIndexNum,
          status: "in_use",
        },
        orderBy: { created_at: "desc" },
      });
    }

    if (!order) {
      console.warn(
        "[DB] No in_use order found for return. Creating audit log row."
      );
      // Optional: store a lightweight audit record or just return.
      return { updated: 0, note: "no_active_order" };
    }

    const updated = await prisma.rentalOrder.update({
      where: { id: order.id },
      data: {
        status: "returned",
        return_device_no: deviceNo || order.return_device_no,
        electricity: Number.isFinite(elecNum) ? elecNum : order.electricity,
        returned_at: new Date(),
        notes: order.notes ?? "",
      },
      include: { payment: true },
    });

    console.log("[DB] order returned:", updated.id, {
      device_no: updated.device_no,
      cart_no: updated.cart_no,
      cart_index: updated.cart_index,
      electricity: updated.electricity,
    });

    return { updated: 1, order: updated };
  };

/** List open (in_use) orders for operator panel */
module.exports.listOpenOrders = async function listOpenOrders(limit = 100) {
  const rows = await prisma.rentalOrder.findMany({
    where: { status: "in_use" },
    include: { payment: true },
    orderBy: { created_at: "desc" },
    take: Math.min(limit, 200),
  });
  return rows;
};
