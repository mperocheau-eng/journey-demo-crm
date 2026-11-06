"use strict";

let state = { customers: [], demoData: {} };
let selectedId = null;

const $ = (selector) => document.querySelector(selector);
const customerList = $("#customerList");
const details = $("#details");

function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.className = isError ? "error" : "success";
  window.setTimeout(() => {
    el.textContent = "";
    el.className = "";
  }, 5000);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (response.status === 204) return null;

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

function selectedCustomer() {
  return state.customers.find((customer) => customer.id === selectedId);
}

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function renderCustomerList() {
  if (!state.customers.length) {
    customerList.innerHTML = `<p class="muted">No callers yet. Create a fictional caller above.</p>`;
    return;
  }

  customerList.innerHTML = state.customers.map((customer) => `
    <button class="customer-card ${customer.id === selectedId ? "selected" : ""}"
            data-id="${escapeHtml(customer.id)}">
      <strong>${escapeHtml(customer.firstName)} ${escapeHtml(customer.lastName || "")}</strong>
      <span>${escapeHtml(customer.uniqueId)}</span>
      <small>${escapeHtml(customer.phoneNumber)} · ${escapeHtml(customer.authenticationStatus)}</small>
    </button>
  `).join("");

  customerList.querySelectorAll("[data-id]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedId = button.dataset.id;
      renderCustomerList();
      renderDetails();
    });
  });
}

function renderDetails() {
  const customer = selectedCustomer();

  if (!customer) {
    details.innerHTML = `<p class="muted">Select a caller to view or edit their demo state.</p>`;
    return;
  }

  const profile = customer.journeyProfile
    ? JSON.stringify(customer.journeyProfile, null, 2)
    : "No profile lookup result yet.";

  const latestAttempt = customer.authAttempts?.[0];
  const callback = latestAttempt?.callbackPayload
    ? JSON.stringify(latestAttempt.callbackPayload, null, 2)
    : "No matched callback payload yet.";

  details.innerHTML = `
    <div class="record-heading">
      <div>
        <h3>${escapeHtml(customer.firstName)} ${escapeHtml(customer.lastName || "")}</h3>
        <p class="muted">${escapeHtml(customer.uniqueId)} · ${escapeHtml(customer.phoneNumber)}</p>
      </div>
      <button class="danger" id="deleteCustomer">Delete caller</button>
    </div>

    <div class="actions">
      <button class="secondary" id="lookupButton">Journey profile lookup</button>
      <button class="primary" id="authButton">Start SMS authentication</button>
    </div>

    <label>Session reference for this authentication
      <input id="sessionRef" value="call-${escapeHtml(cryptoRandomShort())}">
    </label>
    <p class="muted">
      Use a unique call or engagement reference. The same reference is used to correlate
      the callback.
    </p>

    <h3>Prompt/session state</h3>
    <div class="flags">
      ${flagInput("identityVerified", "Identity verified", customer.identityVerified)}
      ${flagInput("biometricConfirmed", "Biometric confirmed", customer.biometricConfirmed)}
      ${flagInput("employmentHistoryAvailable", "Employment history available", customer.employmentHistoryAvailable)}
      ${flagInput("choiceSaved", "Choice saved", customer.choiceSaved)}
    </div>

    <label>Selected plan
      <select id="selectedPlan">
        <option value="aucun" ${customer.selectedPlan === "aucun" ? "selected" : ""}>No choice</option>
        <option value="standard" ${customer.selectedPlan === "standard" ? "selected" : ""}>Standard</option>
        <option value="etendu" ${customer.selectedPlan === "etendu" ? "selected" : ""}>Extended</option>
      </select>
    </label>
    <button class="secondary" id="saveState">Save caller state</button>

    <h3>Journey status</h3>
    <p><strong>Profile lookup:</strong> ${customer.journeyProfileFound === null ? "Not checked" : customer.journeyProfileFound ? "Profile returned" : "Not found"}</p>
    <p><strong>Last lookup:</strong> ${formatDate(customer.lookupCheckedAt)}</p>
    <p><strong>Authentication status:</strong> ${escapeHtml(customer.authenticationStatus || "not_started")}</p>
    <p><strong>Latest session reference:</strong> ${escapeHtml(latestAttempt?.sessionRef || "—")}</p>
    <p><strong>Callback received:</strong> ${formatDate(latestAttempt?.callbackReceivedAt)}</p>
    <p><strong>Callback correlation matched:</strong> ${latestAttempt?.callbackMatched ? "Yes" : "No"}</p>

    ${latestAttempt?.callbackMatched && customer.authenticationStatus !== "operator_confirmed_for_demo" ? `
      <div class="review-box">
        <strong>Operator review required</strong>
        <p>Review the callback payload below and confirm the result through your demo process.</p>
        <label class="inline">
          <input id="reviewConfirm" type="checkbox">
          I reviewed the callback and confirm authentication for this demo.
        </label>
        <button class="primary" id="confirmAuth">Confirm for demo</button>
      </div>
    ` : ""}

    <details class="payload">
      <summary>Journey profile response</summary>
      <pre>${escapeHtml(profile)}</pre>
    </details>
    <details class="payload">
      <summary>Latest callback payload</summary>
      <pre>${escapeHtml(callback)}</pre>
    </details>
    <details class="payload">
      <summary>Latest Journey execution response</summary>
      <pre>${escapeHtml(JSON.stringify(latestAttempt?.journeyResponse || {}, null, 2))}</pre>
    </details>
  `;

  $("#lookupButton").addEventListener("click", doLookup);
  $("#authButton").addEventListener("click", doAuthenticate);
  $("#saveState").addEventListener("click", saveCustomerState);
  $("#deleteCustomer").addEventListener("click", deleteCustomer);

  const confirmButton = $("#confirmAuth");
  if (confirmButton) confirmButton.addEventListener("click", confirmAuthentication);
}

function flagInput(name, label, checked) {
  return `
    <label class="check">
      <input type="checkbox" data-flag="${name}" ${checked ? "checked" : ""}>
      ${label}
    </label>`;
}

function cryptoRandomShort() {
  return Math.random().toString(36).slice(2, 10);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

async function refresh() {
  state = await api("/api/state");
  renderCustomerList();
  renderDetails();
  renderDemoData();

  const config = state.journey;
  $("#connectionStatus").textContent =
    config.apiTokenConfigured && config.pipelineKeyConfigured
      ? "Journey configured"
      : "Mock mode · Journey credentials not configured";
}

async function doLookup() {
  const customer = selectedCustomer();
  if (!customer) return;

  try {
    await api(`/api/customers/${customer.id}/lookup`, { method: "POST", body: "{}" });
    await refresh();
    toast("Journey profile lookup completed.");
  } catch (error) {
    await refresh();
    toast(error.message, true);
  }
}

async function doAuthenticate() {
  const customer = selectedCustomer();
  if (!customer) return;

  const sessionRef = $("#sessionRef").value.trim();
  if (!sessionRef) {
    toast("Enter a unique session reference.", true);
    return;
  }

  try {
    await api(`/api/customers/${customer.id}/authenticate`, {
      method: "POST",
      body: JSON.stringify({ method: "sms", sessionRef })
    });
    await refresh();
    toast("Authentication request sent to Journey.");
  } catch (error) {
    toast(error.message, true);
  }
}

async function saveCustomerState() {
  const customer = selectedCustomer();
  if (!customer) return;

  const flags = {};
  document.querySelectorAll("[data-flag]").forEach((input) => {
    flags[input.dataset.flag] = input.checked;
  });
  flags.selectedPlan = $("#selectedPlan").value;

  try {
    await api(`/api/customers/${customer.id}`, {
      method: "PUT",
      body: JSON.stringify(flags)
    });
    await refresh();
    toast("Caller state saved.");
  } catch (error) {
    toast(error.message, true);
  }
}

async function confirmAuthentication() {
  const customer = selectedCustomer();
  if (!customer) return;

  if (!$("#reviewConfirm")?.checked) {
    toast("Review the callback and check the confirmation box first.", true);
    return;
  }

  try {
    await api(`/api/customers/${customer.id}/confirm-authentication`, {
      method: "POST",
      body: JSON.stringify({ confirmed: true })
    });
    await refresh();
    toast("Authentication marked as confirmed for this demo.");
  } catch (error) {
    toast(error.message, true);
  }
}

async function deleteCustomer() {
  const customer = selectedCustomer();
  if (!customer) return;
  if (!window.confirm(`Delete ${customer.firstName}'s demo record?`)) return;

  try {
    await api(`/api/customers/${customer.id}`, { method: "DELETE" });
    selectedId = null;
    await refresh();
    toast("Caller deleted.");
  } catch (error) {
    toast(error.message, true);
  }
}

function getNum(id, integer = false) {
  const value = $(id).value.trim();
  if (value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || (integer && !Number.isInteger(number))) {
    throw new Error(`Check the value in ${id}.`);
  }
  return number;
}

function getBool(id) {
  const value = $(id).value;
  return value === "" ? null : value === "true";
}

function renderDemoData() {
  const esdc = state.demoData?.esdc || {};
  const standard = esdc.options?.standard || {};
  const extended = esdc.options?.etendu || {};

  $("#stdWeeks").value = standard.semaines_max ?? "";
  $("#stdRate").value = standard.taux_pourcent ?? "";
  $("#stdCap").value = standard.plafond_hebdo_dollars ?? "";
  $("#extWeeks").value = extended.semaines_max ?? "";
  $("#extRate").value = extended.taux_pourcent ?? "";
  $("#extAmount").value = extended.montant_hebdo_dollars ?? "";
  $("#paperRequired").value =
    esdc.releve_emploi_papier_requis === null ? "" : String(esdc.releve_emploi_papier_requis);
  $("#processingDays").value = esdc.delai_traitement_jours ?? "";
  $("#waitingWeek").value =
    esdc.semaine_carence_non_payee === null ? "" : String(esdc.semaine_carence_non_payee);

  $("#demoDataOutput").textContent = JSON.stringify(state.demoData, null, 2);
}

async function saveDemoData() {
  try {
    const demoData = {
      esdc: {
        options: {
          standard: {
            semaines_max: getNum("#stdWeeks", true),
            taux_pourcent: getNum("#stdRate"),
            plafond_hebdo_dollars: getNum("#stdCap")
          },
          etendu: {
            semaines_max: getNum("#extWeeks", true),
            taux_pourcent: getNum("#extRate"),
            montant_hebdo_dollars: getNum("#extAmount")
          }
        },
        releve_emploi_papier_requis: getBool("#paperRequired"),
        delai_traitement_jours: getNum("#processingDays", true),
        semaine_carence_non_payee: getBool("#waitingWeek")
      }
    };

    await api("/api/demo-data", {
      method: "PUT",
      body: JSON.stringify({ demoData })
    });

    await refresh();
    toast("Demo benefit data saved.");
  } catch (error) {
    toast(error.message, true);
  }
}

$("#createForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = Object.fromEntries(form.entries());

  try {
    const customer = await api("/api/customers", {
      method: "POST",
      body: JSON.stringify(body)
    });
    selectedId = customer.id;
    event.currentTarget.reset();
    await refresh();
    toast("Demo caller created.");
  } catch (error) {
    toast(error.message, true);
  }
});

$("#refreshButton").addEventListener("click", () => refresh().catch((error) => toast(error.message, true)));
$("#saveDemoData").addEventListener("click", saveDemoData);

refresh().catch((error) => toast(error.message, true));
