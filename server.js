// server.js
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const crypto = require("crypto");
require("dotenv").config();

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

/* ------------------------ Orders in the Memmory ------------------------ */

const orders = new Map(); // key: cartNo, value: { deviceNo, cartIndex, siteNo, startAt, endAt, status, electricity }

// call this when you unlock (after mock payment succeeds)
function openOrder({ deviceNo, cartNo, cartIndex, siteNo }) {
  if (!cartNo) return; // we key by cartNo; if you only know index, you can map by (deviceNo,index) instead
  orders.set(cartNo, {
    deviceNo,
    cartNo,
    cartIndex,
    siteNo,
    startAt: Date.now(),
    endAt: null,
    status: "in_use",
  });
}

// call this in the callback
function closeOrderOnReturn({ cartNo, cartIndex, electricity, deviceNo }) {
  const o = cartNo ? orders.get(cartNo) : null;
  if (o && o.status === "in_use") {
    o.endAt = Date.now();
    o.status = "returned";
    o.electricity = electricity;
    o.returnDeviceNo = deviceNo;
    orders.set(cartNo, o);
  } else {
    // no open order found: still create a terminal record for reconciliation
    orders.set(cartNo || `unknown_${Date.now()}`, {
      deviceNo,
      cartNo,
      cartIndex,
      startAt: null,
      endAt: Date.now(),
      status: "returned",
      electricity,
    });
  }
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

// site meals (LAUNCH)
app.get("/api/site/:siteNo/meals", async (req, res) => {
  try {
    const data = await postSigned("/trx/interface/setMeal/query", {
      deviceType: DEVICE_TYPE,
      merchantNo: MERCHANT_NO,
      siteNo: req.params.siteNo,
      siteOrderType: "LAUNCH",
      type: "SITE",
    });
    res.json(data);
  } catch (e) {
    res
      .status(500)
      .json(e?.response?.data || { code: "LOCAL_ERROR", msg: e.message });
  }
});

// default meals (templates)
app.get("/api/site/:siteNo/default-meals", async (req, res) => {
  try {
    const data = await postSigned("/trx/interface/setMeal/defaultMeal", {
      deviceType: DEVICE_TYPE,
      merchantNo: MERCHANT_NO,
      siteNo: req.params.siteNo,
      siteOrderType: "LAUNCH",
      type: "SITE",
    });
    res.json(data);
  } catch (e) {
    res
      .status(500)
      .json(e?.response?.data || { code: "LOCAL_ERROR", msg: e.message });
  }
});

// save meal(s)
app.post("/api/setMeal/save", async (req, res) => {
  try {
    const {
      siteNo,
      setMeals = [],
      siteOrderType = "LAUNCH",
      type = "SITE",
    } = req.body;
    const value = {
      deviceType: DEVICE_TYPE,
      merchantNo: MERCHANT_NO,
      setMealList: setMeals.map((m) => ({
        amount: m.amount,
        amountType: "decimal",
        amountUnit: "元",
        coin: m.coin,
        coinUnit: "币",
        deviceType: DEVICE_TYPE,
        merchantNo: MERCHANT_NO,
        orders: String(m.coin), // convention; can be any sequence
        setMealName: m.setMealName,
        siteNo,
        siteOrderType,
        status: m.status || "ENABLE",
        type,
        whetherRecommend: 0,
        whetherRecommendExt: 0,
      })),
      siteNo,
      siteNoList: [siteNo],
      siteOrderType,
      type,
    };
    const data = await postSigned("/trx/interface/setMeal/save", value);
    res.json(data);
  } catch (e) {
    res
      .status(500)
      .json(e?.response?.data || { code: "LOCAL_ERROR", msg: e.message });
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
    openOrder({ deviceNo, cartNo, cartIndex, siteNo: "S001585" });
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

// 5) Return callback (还车回调) — vendor -> your server
// we provide this URL; vendor sends:
// { merchantNo, sign, originalData: { cartNo, cartIndex, electricity, deviceNo } }
app.post("/api/handcart/callback", async (req, res) => {
  try {
    const { merchantNo, sign, originalData } = req.body || {};
    if (!merchantNo || !sign || !originalData) {
      return res.status(400).type("text/plain").send("bad request");
    }
    if (CALLBACK_VERIFY === "true") {
      const ok = verifyVendorCallbackSignature({
        merchantNo,
        sign,
        originalData,
      });
      if (!ok) {
        return res.status(401).type("text/plain").send("invalid sign");
      }
    }
    // Process the return
    closeOrderOnReturn(originalData);

    // IMPORTANT: reply exactly the text "success"
    return res.json({ code: "00000", msg: "success" });
  } catch (e) {
    console.error("[HANDCART CALLBACK] error:", e);
    // Do not send "success" on error; they will retry
    res.status(500).type("text/plain").send("error");
  }
});
app.get("/api/orders/open", (req, res) => {
  res.json([...orders.values()].filter((o) => o.status === "in_use"));
});
app.get("/api/orders/recent", (req, res) => {
  const list = [...orders.values()]
    .sort((a, b) => (b.endAt || 0) - (a.endAt || 0))
    .slice(0, 50);
  res.json(list);
});

app.listen(PORT, () =>
  console.log(`MVP server running: http://localhost:${PORT}`)
);
