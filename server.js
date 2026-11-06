"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === "production";

const APP_PASSWORD = process.env.APP_PASSWORD || "";
const CALLBACK_SECRET = process.env.CALLBACK_SECRET || "";
const JOURNEY_API_TOKEN = process.env.JOURNEY_API_TOKEN || "";
const JOURNEY_PIPELINE_KEY = process.env.JOURNEY_PIPELINE_KEY || "";
const JOURNEY_LANGUAGE = process.env.JOURNEY_LANGUAGE || "en-US";

const JOURNEY_LOOKUP_URL =
  process.env.JOURNEY_LOOKUP_URL ||
  "https://app.journeyid.io/api/system/customers/lookup";

const JOURNEY_EXECUTIONS_URL =
  process.env.JOURNEY_EXECUTIONS_URL ||
  "https://app.journeyid.io/api/system/executions";

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "crm-store.json");

if (IS_PRODUCTION && !APP_PASSWORD) {
  throw new Error("APP_PASSWORD must be set in production.");
}
if (IS_PRODUCTION && !CALLBACK_SECRET) {
  throw new Error("CALLBACK_SECRET must be set in production.");
}

const blankDemoData = {
  esdc: {
    options: {
      standard: {
        semaines_max: null,
        taux_pourcent: null,
        plafond_hebdo_dollars: null
      },
      etendu: {
        semaines_max: null,
        taux_pourcent: null,
        montant_hebdo_dollars: null
      }
    },
    releve_emploi_papier_requis: null,
    delai_traitement_jours: null,
    semaine_carence_non_payee: null
  }
};

function initialStore() {
  return {
    customers: [],
    demoData: blankDemoData
  };
}

function loadStore() {
  try {
    if (!fs.existsSync(DATA_FILE)) return initialStore();
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (error) {
    console.error("Could not read CRM data:", error.message);
    return initialStore();
  }
}

let store = loadStore();

function saveStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(temp, DATA_FILE);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function adminAuth(req, res, next) {
  if (!APP_PASSWORD) {
    if (IS_PRODUCTION) return res.status(503).send("Admin password is not configured.");
    return next();
  }

  const header = req.headers.authorization || "";
  const match = header.match(/^Basic\s+(.+)$/i);

  if (!match) {
    res.set("WWW-Authenticate", 'Basic realm="Journey Demo CRM"');
    return res.status(401).send("Authentication required.");
  }

  let decoded;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return res.status(401).send("Invalid authentication.");
  }

  const separator = decoded.indexOf(":");
  const password = separator >= 0 ? decoded.slice(separator + 1) : "";

  if (!safeEqual(password, APP_PASSWORD)) {
    res.set("WWW-Authenticate", 'Basic realm="Journey Demo CRM"');
    return res.status(401).send("Invalid password.");
  }

  next();
}

function cleanString(value, maxLength = 200) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function publicCustomer(customer) {
  return customer;
}

function findCustomer(id) {
  return store.customers.find((item) => item.id === id);
}

function journeyConfigured() {
  return Boolean(JOURNEY_API_TOKEN);
}

/*
 * Journey calls this route. The secret is part of the callback URL because
 * the supplied Journey docs did not specify a callback signature format.
 * For production, replace this with Journey's documented signature
 * verification mechanism if available.
 */
app.post("/journey-callback/:secret", (req, res) => {
  if (!CALLBACK_SECRET || !safeEqual(req.params.secret, CALLBACK_SECRET)) {
    return res.status(401).json({ error: "Invalid callback secret." });
  }

  const payload = req.body && typeof req.body === "object" ? req.body : {};
  const userUniqueId =
    payload?.user?.uniqueId ??
    payload?.customer?.uniqueId ??
    payload?.uniqueId ??
    null;

  const externalRef =
    payload?.session?.externalRef ??
    payload?.session?.external_ref ??
    payload?.externalRef ??
    null;

  const pipelineKey =
    payload?.pipeline?.key ??
    payload?.pipeline?.pipelineKey ??
    payload?.pipelineKey ??
    null;

  const customer = store.customers.find((item) =>
    item.authAttempts?.some((attempt) =>
      attempt.sessionRef === externalRef &&
      attempt.uniqueId === userUniqueId &&
      attempt.pipelineKey === pipelineKey
    )
  );

  const event = {
    id: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    matched: Boolean(customer),
    correlation: {
      userUniqueId,
      externalRef,
      pipelineKey
    },
    payload
  };

  if (customer) {
    customer.callbackEvents = customer.callbackEvents || [];
    customer.callbackEvents.unshift(event);

    const attempt = customer.authAttempts.find((item) =>
      item.sessionRef === externalRef &&
      item.uniqueId === userUniqueId &&
      item.pipelineKey === pipelineKey
    );

    if (attempt) {
      attempt.callbackReceivedAt = event.receivedAt;
      attempt.callbackMatched = true;
      attempt.callbackPayload = payload;
      attempt.status = "callback_matched_pending_operator_review";
    }

    customer.updatedAt = new Date().toISOString();
    saveStore();
  }

  // Return success to Journey after accepting the notification.
  return res.status(200).json({
    received: true,
    matched: Boolean(customer)
  });
});

// Keep the callback route above adminAuth so Journey can reach it.
app.use(adminAuth);
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/state", (req, res) => {
  res.json({
    customers: store.customers.map(publicCustomer),
    demoData: store.demoData,
    journey: {
      apiTokenConfigured: journeyConfigured(),
      pipelineKeyConfigured: Boolean(JOURNEY_PIPELINE_KEY),
      language: JOURNEY_LANGUAGE
    }
  });
});

app.post("/api/customers", (req, res) => {
  const firstName = cleanString(req.body.firstName, 80);
  const lastName = cleanString(req.body.lastName, 80);
  const uniqueId = cleanString(req.body.uniqueId, 64);
  const phoneNumber = cleanString(req.body.phoneNumber, 30);

  if (!firstName || !uniqueId || !phoneNumber) {
    return res.status(400).json({
      error: "First name, Journey unique ID, and phone number are required."
    });
  }

  if (!/^[A-Za-z0-9_-]{1,64}$/.test(uniqueId)) {
    return res.status(400).json({
      error: "Unique ID must be up to 64 letters, numbers, dashes, or underscores."
    });
  }

  if (store.customers.some((item) => item.uniqueId === uniqueId)) {
    return res.status(409).json({ error: "That Journey unique ID already exists." });
  }

  const customer = {
    id: crypto.randomUUID(),
    firstName,
    lastName,
    uniqueId,
    phoneNumber,
    identityVerified: false,
    biometricConfirmed: false,
    employmentHistoryAvailable: false,
    choiceSaved: false,
    selectedPlan: "aucun",
    journeyProfileFound: null,
    journeyProfile: null,
    lookupCheckedAt: null,
    journeyError: null,
    authenticationStatus: "not_started",
    authAttempts: [],
    callbackEvents: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  store.customers.unshift(customer);
  saveStore();
  res.status(201).json(customer);
});

app.put("/api/customers/:id", (req, res) => {
  const customer = findCustomer(req.params.id);
  if (!customer) return res.status(404).json({ error: "Caller not found." });

  const allowedStrings = ["firstName", "lastName", "uniqueId", "phoneNumber"];
  for (const key of allowedStrings) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) {
      customer[key] = cleanString(req.body[key], key === "uniqueId" ? 64 : 200);
    }
  }

  if (Object.prototype.hasOwnProperty.call(req.body, "uniqueId") &&
      !/^[A-Za-z0-9_-]{1,64}$/.test(customer.uniqueId)) {
    return res.status(400).json({ error: "Invalid unique ID format." });
  }

  const allowedBooleans = [
    "identityVerified",
    "biometricConfirmed",
    "employmentHistoryAvailable",
    "choiceSaved"
  ];

  for (const key of allowedBooleans) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) {
      customer[key] = Boolean(req.body[key]);
    }
  }

  if (Object.prototype.hasOwnProperty.call(req.body, "selectedPlan")) {
    const plan = req.body.selectedPlan;
    if (!["aucun", "standard", "etendu"].includes(plan)) {
      return res.status(400).json({ error: "Invalid plan choice." });
    }
    customer.selectedPlan = plan;
  }

  customer.updatedAt = new Date().toISOString();
  saveStore();
  res.json(customer);
});

app.delete("/api/customers/:id", (req, res) => {
  const index = store.customers.findIndex((item) => item.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: "Caller not found." });

  store.customers.splice(index, 1);
  saveStore();
  res.status(204).end();
});

app.put("/api/demo-data", (req, res) => {
  const candidate = req.body?.demoData;

  if (!candidate || !candidate.esdc) {
    return res.status(400).json({ error: "Expected demoData.esdc object." });
  }

  store.demoData = candidate;
  saveStore();
  res.json({ demoData: store.demoData });
});

app.post("/api/customers/:id/lookup", async (req, res) => {
  const customer = findCustomer(req.params.id);
  if (!customer) return res.status(404).json({ error: "Caller not found." });

  if (!JOURNEY_API_TOKEN) {
    return res.status(503).json({
      error: "Journey API is not configured. Set JOURNEY_API_TOKEN."
    });
  }

  try {
    const url = new URL(JOURNEY_LOOKUP_URL);
    url.searchParams.set("unique_id", customer.uniqueId);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${JOURNEY_API_TOKEN}`,
        Accept: "application/json"
      }
    });

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { rawResponse: text.slice(0, 5000) };
    }

    customer.lookupCheckedAt = new Date().toISOString();
    customer.journeyError = response.ok ? null : {
      status: response.status,
      response: data
    };

    if (response.ok) {
      customer.journeyProfile = data;
      customer.journeyProfileFound = true;
    } else if (response.status === 404) {
      customer.journeyProfile = null;
      customer.journeyProfileFound = false;
    }

    customer.updatedAt = new Date().toISOString();
    saveStore();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Journey lookup returned an error.",
        journeyStatus: response.status,
        result: data
      });
    }

    res.json({
      found: true,
      profile: data,
      checkedAt: customer.lookupCheckedAt
    });
  } catch (error) {
    customer.journeyError = { message: error.message };
    customer.updatedAt = new Date().toISOString();
    saveStore();

    res.status(502).json({ error: `Journey lookup failed: ${error.message}` });
  }
});

app.post("/api/customers/:id/authenticate", async (req, res) => {
  const customer = findCustomer(req.params.id);
  if (!customer) return res.status(404).json({ error: "Caller not found." });

  if (!JOURNEY_API_TOKEN || !JOURNEY_PIPELINE_KEY) {
    return res.status(503).json({
      error: "Set JOURNEY_API_TOKEN and JOURNEY_PIPELINE_KEY to enable authentication."
    });
  }

  const method = req.body?.method || "sms";
  if (method !== "sms") {
    return res.status(400).json({
      error: "This demo currently supports SMS delivery only."
    });
  }

  if (!customer.phoneNumber.startsWith("+")) {
    return res.status(400).json({
      error: "Phone number must be in E.164 format, including its leading +."
    });
  }

  const sessionRef = cleanString(req.body?.sessionRef, 120) || crypto.randomUUID();

  const callbackUrl = process.env.PUBLIC_URL
    ? `${process.env.PUBLIC_URL.replace(/\/$/, "")}/journey-callback/${encodeURIComponent(CALLBACK_SECRET)}`
    : null;

  if (!callbackUrl) {
    return res.status(503).json({
      error: "Set PUBLIC_URL to your deployed HTTPS base URL before starting authentication."
    });
  }

  const payload = {
    pipelineKey: JOURNEY_PIPELINE_KEY,
    delivery: {
      method: "sms",
      phoneNumber: customer.phoneNumber
    },
    customer: {
      uniqueId: customer.uniqueId,
      phoneNumber: customer.phoneNumber
    },
    session: {
      externalRef: sessionRef
    },
    callbackUrls: [callbackUrl],
    language: JOURNEY_LANGUAGE
  };

  try {
    const response = await fetch(JOURNEY_EXECUTIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${JOURNEY_API_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { rawResponse: text.slice(0, 5000) };
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Journey authentication request failed.",
        journeyStatus: response.status,
        result: data
      });
    }

    const attempt = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      uniqueId: customer.uniqueId,
      phoneNumber: customer.phoneNumber,
      sessionRef,
      pipelineKey: JOURNEY_PIPELINE_KEY,
      status: "request_sent_waiting_for_callback",
      callbackReceivedAt: null,
      callbackMatched: false,
      callbackPayload: null,
      journeyResponse: data
    };

    customer.authAttempts.unshift(attempt);
    customer.authenticationStatus = attempt.status;
    customer.updatedAt = new Date().toISOString();
    saveStore();

    res.json({
      sent: true,
      sessionRef,
      callbackUrl,
      result: data,
      attempt
    });
  } catch (error) {
    res.status(502).json({ error: `Journey request failed: ${error.message}` });
  }
});

app.post("/api/customers/:id/confirm-authentication", (req, res) => {
  const customer = findCustomer(req.params.id);
  if (!customer) return res.status(404).json({ error: "Caller not found." });

  const attempt = customer.authAttempts?.[0];
  if (!attempt || !attempt.callbackMatched) {
    return res.status(400).json({
      error: "No correlated callback is available for review."
    });
  }

  if (req.body?.confirmed !== true) {
    return res.status(400).json({
      error: "Operator must explicitly confirm after reviewing the callback."
    });
  }

  customer.authenticationStatus = "operator_confirmed_for_demo";
  customer.identityVerified = true;
  attempt.status = "operator_confirmed_for_demo";
  attempt.operatorConfirmedAt = new Date().toISOString();
  customer.updatedAt = new Date().toISOString();
  saveStore();

  res.json({ customer });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Journey Demo CRM listening on port ${PORT}`);
});
