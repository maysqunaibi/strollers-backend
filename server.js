// server.js
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const crypto = require("crypto");
require("dotenv").config();
const store = require("./db");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const {
  PORT = 4000,
  BASE_URL,
  MERCHANT_NO,
  DEVICE_TYPE = "CHILD_MACHINE",
  MERCHANT_PRIVATE_KEY_B64,
  CALLBACK_VERIFY,
} = process.env;

if (!BASE_URL || !MERCHANT_NO || !MERCHANT_PRIVATE_KEY_B64) {
  console.error(
    "❌ Missing env vars. Check BASE_URL, MERCHANT_NO, MERCHANT_PRIVATE_KEY_B64"
  );
  process.exit(1);
}

const PEM_PRIVATE =
  "-----BEGIN PRIVATE KEY-----\n" +
  MERCHANT_PRIVATE_KEY_B64.match(/.{1,64}/g).join("\n") +
  "\n-----END PRIVATE KEY-----";

const VENDOR_PUBLIC_KEY_B64 = process.env.VENDOR_PUBLIC_KEY_B64;

const VENDOR_PUBLIC_PEM =
  "-----BEGIN PUBLIC KEY-----\n" +
  VENDOR_PUBLIC_KEY_B64.match(/.{1,64}/g).join("\n") +
  "\n-----END PUBLIC KEY-----";

function stableStringify(obj) {
  const sort = (x) => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === "object") {
      return Object.keys(x)
        .sort()
        .reduce((acc, k) => {
          const v = x[k];
          if (v !== null && v !== undefined) acc[k] = sort(v);
          return acc;
        }, {});
    }
    return x;
  };
  return JSON.stringify(sort(obj));
}

// Try verifying the signature over `originalData` (most likely), falling back to whole body if needed.
function verifyVendorCallbackSignature({ merchantNo, sign, originalData }) {
  const candidates = [
    stableStringify(originalData), // common pattern
    stableStringify({ merchantNo, originalData }), // fallback pattern
  ];
  for (const s of candidates) {
    const v = crypto.createVerify("RSA-SHA256");
    v.update(s);
    v.end();
    if (v.verify(VENDOR_PUBLIC_PEM, Buffer.from(sign, "base64"))) {
      return true;
    }
  }
  return false;
}

function sortObject(obj) {
  if (Array.isArray(obj)) return obj.map(sortObject);
  if (obj && typeof obj === "object") {
    return Object.keys(obj)
      .sort()
      .reduce((acc, k) => {
        const v = obj[k];
        if (v !== null && v !== undefined) acc[k] = sortObject(v);
        return acc;
      }, {});
  }
  return obj;
}

async function postSigned(path, value) {
  const body = {
    nonce: Math.random().toString(36).slice(2, 12),
    timestamp: Date.now(),
    value,
  };
  const sorted = sortObject(body);
  const jsonString = JSON.stringify(sorted);

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(jsonString);
  signer.end();
  const signature = signer.sign(PEM_PRIVATE, "base64");
  const url = `${BASE_URL}${path}`;
  const res = await axios.post(url, sorted, {
    headers: { "Content-Type": "application/json", Authorization: signature },
    timeout: 20000,
  });
  return res.data;
}

/* ------------------------ API FACADES USED BY UI ------------------------ */

// slots at a site
app.get("/api/site/:siteNo/slots", async (req, res) => {
  try {
    const data = await postSigned(
      "/trx/interface/device/getSiteLocationNumByMch",
      {
        merchantNo: MERCHANT_NO,
        siteNo: req.params.siteNo,
      }
    );
    res.json(data);
  } catch (e) {
    res
      .status(500)
      .json(e?.response?.data || { code: "LOCAL_ERROR", msg: e.message });
  }
});

// Local packages catalog (Model A - Mall). Optional site override.
app.get("/api/catalog/packages", async (req, res) => {
  try {
    const siteNo = req.query.siteNo || null;
    const siteType = req.query.siteType || "SHOPPING_MALL";
    const { prisma } = require("./db");

    let rows = [];
    if (siteNo) {
      // 1) try site-specific
      rows = await prisma.package.findMany({
        where: { active: 1, site_no: siteNo },
        orderBy: { display_order: "asc" },
      });
      // 2) fallback to defaults for that siteType
      if (rows.length === 0) {
        rows = await prisma.package.findMany({
          where: { active: 1, site_type: siteType, site_no: null },
          orderBy: { display_order: "asc" },
        });
      }
    } else {
      // 🔧 change here: when no siteNo, return ALL active packages (site-specific + defaults)
      rows = await prisma.package.findMany({
        where: { active: 1 },
        orderBy: [{ site_no: "asc" }, { display_order: "asc" }],
      });
    }

    res.json({ code: "00000", msg: "success", data: rows });
  } catch (e) {
    console.error("[catalog/packages] error:", e);
    res.status(500).json({ code: "LOCAL_ERROR", msg: e.message });
  }
});

// bind / unbind
app.post("/api/bind", async (req, res) => {
  try {
    const { deviceNo, siteNo, orders, coinsPerTime } = req.body;
    const data = await postSigned("/trx/interface/device/bind", {
      coinsPerTime,
      deviceNo,
      deviceType: DEVICE_TYPE,
      merchantNo: MERCHANT_NO,
      orders,
      siteNo,
    });
    res.json(data);
  } catch (e) {
    res
      .status(500)
      .json(e?.response?.data || { code: "LOCAL_ERROR", msg: e.message });
  }
});

app.post("/api/unbind", async (req, res) => {
  try {
    const { deviceNo } = req.body;
    const data = await postSigned("/trx/interface/device/unbind", {
      deviceNo,
      merchantNo: MERCHANT_NO,
    });
    res.json(data);
  } catch (e) {
    res
      .status(500)
      .json(e?.response?.data || { code: "LOCAL_ERROR", msg: e.message });
  }
});

// device info / status / params / score
app.get("/api/device/:deviceNo/info", async (req, res) => {
  try {
    const data = await postSigned("/trx/interface/device/deviceInfo", {
      deviceNo: req.params.deviceNo,
      merchantNo: MERCHANT_NO,
    });
    res.json(data);
  } catch (e) {
    res
      .status(500)
      .json(e?.response?.data || { code: "LOCAL_ERROR", msg: e.message });
  }
});

app.post("/api/device-status", async (req, res) => {
  try {
    const { deviceNo } = req.body;
    const data = await postSigned("/trx/interface/device/getDeviceInfo", {
      deviceNo,
      merchantNo: MERCHANT_NO,
    });
    res.json(data);
  } catch (e) {
    res
      .status(500)
      .json(e?.response?.data || { code: "LOCAL_ERROR", msg: e.message });
  }
});

app.get("/api/device/:deviceNo/params", async (req, res) => {
  try {
    const data = await postSigned("/trx/interface/device/getDeviceParamList", {
      deviceNo: req.params.deviceNo,
      merchantNo: MERCHANT_NO,
    });
    res.json(data);
  } catch (e) {
    res
      .status(500)
      .json(e?.response?.data || { code: "LOCAL_ERROR", msg: e.message });
  }
});

app.post("/api/device/score", async (req, res) => {
  try {
    const { deviceNo, coinNum, amount } = req.body;
    const data = await postSigned("/trx/interface/device/score", {
      deviceNo,
      merchantNo: MERCHANT_NO,
      coinNum,
      amount,
    });
    res.json(data);
  } catch (e) {
    res
      .status(500)
      .json(e?.response?.data || { code: "LOCAL_ERROR", msg: e.message });
  }
});

// site: add/list/update/remove
app.post("/api/site/add", async (req, res) => {
  try {
    const { address, city, county, province, siteName, siteType } = req.body;
    const data = await postSigned("/trx/interface/site/addSite", {
      address,
      city,
      county,
      province,
      siteName,
      siteType,
      merchantNo: MERCHANT_NO,
    });
    res.json(data);
  } catch (e) {
    res
      .status(500)
      .json(e?.response?.data || { code: "LOCAL_ERROR", msg: e.message });
  }
});

app.get("/api/site/list", async (req, res) => {
  try {
    const data = await postSigned("/trx/interface/site/getSiteList", {
      merchantNo: MERCHANT_NO,
    });
    res.json(data);
  } catch (e) {
    res
      .status(500)
      .json(e?.response?.data || { code: "LOCAL_ERROR", msg: e.message });
  }
});

app.post("/api/site/update", async (req, res) => {
  try {
    const { siteNo, address, city, county, province, siteName, siteType } =
      req.body;
    const data = await postSigned("/trx/interface/site/updateSite", {
      address,
      city,
      county,
      province,
      siteName,
      siteType,
      siteNo,
      merchantNo: MERCHANT_NO,
    });
    res.json(data);
  } catch (e) {
    res
      .status(500)
      .json(e?.response?.data || { code: "LOCAL_ERROR", msg: e.message });
  }
});

app.post("/api/site/remove", async (req, res) => {
  try {
    const { siteNo } = req.body;
    const data = await postSigned("/trx/interface/site/removeSite", {
      merchantNo: MERCHANT_NO,
      siteNo,
    });
    res.json(data);
  } catch (e) {
    res
      .status(500)
      .json(e?.response?.data || { code: "LOCAL_ERROR", msg: e.message });
  }
});

/* =========================
   HANDCART (strollers) API
   ========================= */

// 1) Get cart list (车辆列表)
// Doc: POST /trx/interface/handCart/getCartList
// value: { merchantNo, deviceNo }
app.post("/api/handcart/list", async (req, res) => {
  try {
    const { deviceNo } = req.body;
    const data = await postSigned("/trx/interface/handCart/getCartList", {
      merchantNo: MERCHANT_NO,
      deviceNo,
    });
    res.json(data);
  } catch (e) {
    res
      .status(500)
      .json(e?.response?.data || { code: "LOCAL_ERROR", msg: e.message });
  }
});
// 2) Unlock cart (车辆解锁)
// Doc: POST /trx/interface/handCart/unlock
// value: { merchantNo, deviceNo, cartIndex(int) }
app.post("/api/handcart/unlock", async (req, res) => {
  try {
    const { deviceNo, cartIndex, cartNo } = req.body || {};
    const cartIndexNum = Number(cartIndex);

    if (!deviceNo)
      return res.json({ code: "20001", msg: "deviceNo 不能为空", data: null });
    if (!cartNo)
      return res.json({
        code: "20001",
        msg: "value.cartNo 不能为空",
        data: null,
      });
    if (!Number.isInteger(cartIndexNum)) {
      return res.json({
        code: "20001",
        msg: "value.cartIndex 不能为空",
        data: null,
      });
    }

    const value = {
      merchantNo: MERCHANT_NO,
      deviceNo,
      cartNo: String(cartNo).trim(),
      cartIndex: cartIndexNum,
    };
    console.log("[SERVER unlock] payload->vendor:", value);
    const data = await postSigned("/trx/interface/handCart/unlock", value);
    console.log("[SERVER unlock] vendor response:", data);
    res.json(data);
  } catch (e) {
    res
      .status(500)
      .json(e?.response?.data || { code: "LOCAL_ERROR", msg: e.message });
  }
});

// 3) Bind carts (绑定车辆) — one-time association to merchant
// Doc: POST /trx/interface/handCart/bind
// value: { merchantNo, cartNo: [ "IC卡号", ... ] }
app.post("/api/handcart/bind", async (req, res) => {
  try {
    const { cartNo } = req.body; // array of IC numbers
    const list = Array.isArray(cartNo) ? cartNo : [cartNo].filter(Boolean);
    console.log("[SERVER bind] incoming cartNo:", cartNo, "normalized:", list);
    const data = await postSigned("/trx/interface/handCart/bind", {
      merchantNo: MERCHANT_NO,
      cartNo: list,
    });
    console.log("[SERVER bind] vendor response:", data);
    res.json(data);
  } catch (e) {
    res
      .status(500)
      .json(e?.response?.data || { code: "LOCAL_ERROR", msg: e.message });
  }
});

// 4) Unbind carts (解绑车辆)
// Doc: POST /trx/interface/handCart/unbind
// value: { merchantNo, cartNo: [ "IC卡号", ... ] }
app.post("/api/handcart/unbind", async (req, res) => {
  try {
    const { cartNo } = req.body; // array of IC numbers
    const data = await postSigned("/trx/interface/handCart/unbind", {
      merchantNo: MERCHANT_NO,
      cartNo: Array.isArray(cartNo) ? cartNo : [cartNo].filter(Boolean),
    });
    res.json(data);
  } catch (e) {
    res
      .status(500)
      .json(e?.response?.data || { code: "LOCAL_ERROR", msg: e.message });
  }
});

// Return callback (还车回调) — vendor -> your server
// Expected request JSON: { merchantNo, sign, originalData:{ cartNo, cartIndex, electricity, deviceNo } }
// Expected success JSON response: { code:"00000", msg:"success" }
app.post("/api/handcart/callback", async (req, res) => {
  try {
    const { merchantNo, sign, originalData } = req.body || {};
    if (!merchantNo || !sign || !originalData) {
      // respond JSON (not plain text) so vendor sees a structured error
      return res.status(400).json({ code: "400", msg: "bad request" });
    }

    // Optional signature check — keep it quick
    if (CALLBACK_VERIFY === "true") {
      const ok = verifyVendorCallbackSignature({
        merchantNo,
        sign,
        originalData,
      });
      if (!ok)
        return res.status(401).json({ code: "401", msg: "invalid sign" });
    }

    // ✅ Respond immediately so vendor does not time out
    res.status(200).json({ code: "00000", msg: "success" });

    // 🔧 Process in background (won’t block the response)
    setImmediate(async () => {
      try {
        const { deviceNo, cartNo, cartIndex, electricity } = originalData || {};
        const result = await store.closeOrderOnReturnFromVendor({
          merchantNo,
          deviceNo,
          cartNo,
          cartIndex,
          electricity,
        });
        console.log("[HANDCART CALLBACK] DB result:", result);
      } catch (e) {
        console.error("[HANDCART CALLBACK] background error:", e?.message || e);
      }
    });
  } catch (e) {
    console.error("[HANDCART CALLBACK] handler error:", e?.message || e);
    // still JSON on error
    return res.status(500).json({ code: "500", msg: "error" });
  }
});

/****************************************ORDERS AND PAYMENTS ENDPOINTS *******************************************/
// List orders (optionally filter by status, search by cartNo/paymentId)
app.get("/api/orders/list", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const rows = await store.prisma.rentalOrder.findMany({
      include: { payment: true },
      orderBy: { created_at: "desc" },
      take: limit,
    });

    console.log("[ORDERS] list ->", rows.length);
    return res.json({ code: "00000", msg: "success", data: rows });
  } catch (e) {
    console.error("[ORDERS] list error:", e.message);
    return res.status(500).json({ code: "LOCAL_ERROR", msg: "Server error" });
  }
});
app.get("/api/orders", async (req, res) => {
  try {
    const { status, q, limit = 50 } = req.query;
    const where = {};
    if (status) where.status = status;
    if (q) {
      // simple OR search (cart_no or payment_id or device_no)
      where.OR = [
        { cart_no: { contains: q } },
        { payment_id: { contains: q } },
        { device_no: { contains: q } },
      ];
    }
    const rows = await store.prisma.rentalOrder.findMany({
      where,
      orderBy: { created_at: "desc" },
      take: Number(limit),
      include: { payment: true },
    });
    res.json({ code: "00000", msg: "success", data: rows });
  } catch (e) {
    res.status(500).json({ code: "LOCAL_ERROR", msg: e.message });
  }
});

// Active orders (in_use)
app.get("/api/orders/active", async (req, res) => {
  try {
    const rows = await store.prisma.rentalOrder.findMany({
      where: { status: "in_use" },
      orderBy: { unlock_confirmed_at: "desc" },
      include: { payment: true },
    });
    res.json({ code: "00000", msg: "success", data: rows });
  } catch (e) {
    res.status(500).json({ code: "LOCAL_ERROR", msg: e.message });
  }
});

// Order detail
app.get("/api/orders/:id", async (req, res) => {
  try {
    const row = await store.prisma.rentalOrder.findUnique({
      where: { id: req.params.id },
      include: { payment: true },
    });
    if (!row) return res.status(404).json({ code: "404", msg: "Not found" });
    res.json({ code: "00000", msg: "success", data: row });
  } catch (e) {
    res.status(500).json({ code: "LOCAL_ERROR", msg: e.message });
  }
});

// Admin: mark returned (manual close in case callback missed)
// body: { note?: string }
app.post("/api/orders/:id/mark-returned", async (req, res) => {
  try {
    const id = req.params.id;
    const note = req.body?.note || null;
    const updated = await store.updateOrderStatus(id, {
      status: "returned",
      returned_at: new Date(),
      notes: note,
    });
    res.json({ code: "00000", msg: "success", data: updated });
  } catch (e) {
    res.status(500).json({ code: "LOCAL_ERROR", msg: e.message });
  }
});

// Admin: cancel (only allowed if pending_payment)
app.post("/api/orders/:id/cancel", async (req, res) => {
  try {
    const id = req.params.id;
    const order = await store.prisma.rentalOrder.findUnique({ where: { id } });
    if (!order) return res.status(404).json({ code: "404", msg: "Not found" });
    if (order.status !== "pending_payment") {
      return res
        .status(400)
        .json({ code: "400", msg: "Only pending_payment can be canceled" });
    }
    const updated = await store.updateOrderStatus(id, { status: "canceled" });
    res.json({ code: "00000", msg: "success", data: updated });
  } catch (e) {
    res.status(500).json({ code: "LOCAL_ERROR", msg: e.message });
  }
});

// Payments list (optionally filter by status)
app.get("/api/payments", async (req, res) => {
  try {
    const { status, limit = 50 } = req.query;
    const where = {};
    if (status) where.status = status;
    const rows = await store.prisma.payment.findMany({
      where,
      orderBy: { created_at: "desc" },
      take: Number(limit),
    });
    res.json({ code: "00000", msg: "success", data: rows });
  } catch (e) {
    res.status(500).json({ code: "LOCAL_ERROR", msg: e.message });
  }
});

// Payment detail
app.get("/api/payments/:id", async (req, res) => {
  try {
    const row = await store.prisma.payment.findUnique({
      where: { id: req.params.id },
    });
    if (!row) return res.status(404).json({ code: "404", msg: "Not found" });
    res.json({ code: "00000", msg: "success", data: row });
  } catch (e) {
    res.status(500).json({ code: "LOCAL_ERROR", msg: e.message });
  }
});

const axiosBase = require("axios");
const MOYASAR_SECRET_KEY = process.env.MOYASAR_SECRET_KEY;

async function moyasarFetchPayment(paymentId) {
  const url = `https://api.moyasar.com/v1/payments/${paymentId}`;
  const auth = Buffer.from(`${MOYASAR_SECRET_KEY}:`).toString("base64"); // Basic with secret only
  const res = await axiosBase.get(url, {
    headers: { Authorization: `Basic ${auth}` },
    timeout: 15000,
  });
  return res.data;
}
/***********************************************ORDERS WITH DATABASE ***************************************/
// Confirm the payment with Moyasar, then unlock the cart
app.post("/api/payments/confirm-and-unlock", async (req, res) => {
  try {
    console.log("[CONFIRM] req.body:", req.body);

    let { paymentId, deviceNo, cartNo, cartIndex, siteNo, amountHalalas } =
      req.body || {};
    cartIndex = Number(cartIndex);
    amountHalalas = Number(amountHalalas);

    if (!paymentId || !deviceNo || !cartNo || !Number.isFinite(cartIndex)) {
      console.warn("[CONFIRM] missing params:", {
        paymentId,
        deviceNo,
        cartNo,
        cartIndex,
      });
      return res.status(400).json({
        code: "400",
        msg: "Missing params: paymentId, deviceNo, cartNo, cartIndex",
      });
    }

    // 1) Fetch payment
    const pay = await moyasarFetchPayment(paymentId);
    console.log("[CONFIRM] moyasar pay:", JSON.stringify(pay));

    // 2) Validate status & amount
    const okStatus = pay?.status === "paid" || pay?.status === "authorized";
    const okCurrency = (pay?.currency || "").toUpperCase() === "SAR";
    const okAmount = Number(pay?.amount) === amountHalalas;

    console.log("[CONFIRM] checks:", {
      okStatus,
      okCurrency,
      okAmount,
      want: amountHalalas,
    });

    if (!okStatus || !okCurrency || !okAmount) {
      return res.status(400).json({
        code: "PAY_INVALID",
        msg: `Invalid payment: status=${pay?.status}, currency=${pay?.currency}, amount=${pay?.amount}`,
      });
    }

    // 3) Upsert payment in DB
    const paymentRow = await store.upsertPaymentFromMoyasar(pay);

    // 4) Create/reuse order in "unlocking"
    const order = await store.openOrderForPayment({
      paymentId: paymentRow.id,
      siteNo: siteNo || null,
      merchantNo: MERCHANT_NO,
      deviceNo,
      cartNo,
      cartIndex,
      amountHalalas,
    });

    // 5) Call vendor unlock
    console.log("[CONFIRM] calling vendor unlock:", {
      deviceNo,
      cartNo,
      cartIndex,
    });
    const unlockRes = await postSigned("/trx/interface/handCart/unlock", {
      merchantNo: MERCHANT_NO,
      deviceNo,
      cartNo,
      cartIndex,
    });
    console.log("[CONFIRM] vendor unlock response:", unlockRes);

    // 6) Update order status
    if (unlockRes?.code === "00000") {
      await store.updateOrderStatus(order.id, {
        status: "in_use",
        unlock_confirmed_at: new Date(),
      });
    } else {
      await store.updateOrderStatus(order.id, {
        status: "unlock_failed",
        notes: `[vendor] code=${unlockRes?.code} msg=${unlockRes?.msg || ""}`,
      });
    }

    return res.json({
      code: "00000",
      msg: "success",
      data: { orderId: order.id, payment: paymentRow, vendor: unlockRes },
    });
  } catch (e) {
    console.error("[CONFIRM] error:", e?.response?.data || e.message);
    return res.status(500).json({ code: "LOCAL_ERROR", msg: "Server error" });
  }
});

app.listen(PORT, () =>
  console.log(`MVP server running: http://localhost:${PORT}`)
);
