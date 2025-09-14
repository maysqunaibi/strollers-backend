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

app.listen(PORT, () =>
  console.log(`MVP server running: http://localhost:${PORT}`)
);
