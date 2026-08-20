export {};

import { MAX_IMAGE_BYTES, SETTINGS_SCHEMA, type SettingField, type SettingsValues } from "./settingsSchema";

interface WebhookEvent {
  id: string;
  receivedUtc: string;
  method: string;
  headers: Record<string, string>;
  bodyText: string | null;
}

const TOKEN_STORAGE_KEY = "nocp-admin-token";

function getStoredToken(): string {
  return sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
}

function setStoredToken(token: string): void {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
}

function clearStoredToken(): void {
  sessionStorage.removeItem(TOKEN_STORAGE_KEY);
}

async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(path, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      "X-NOCP-Admin-Token": getStoredToken(),
    },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function showToast(message: string, kind: "success" | "error" = "success"): void {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast ${kind} visible`;
  window.setTimeout(() => {
    toast.className = "toast";
  }, 4000);
}

// --- Token gate ------------------------------------------------------

function renderTokenGate(onSubmit: (token: string) => void): void {
  const root = document.getElementById("app");
  if (!root) return;
  root.innerHTML = `
    <div class="token-gate">
      <label for="admin-token-input">Admin token</label>
      <input type="password" id="admin-token-input" placeholder="X-NOCP-Admin-Token value" autocomplete="off">
      <button type="button" id="admin-token-submit">Continue</button>
    </div>
  `;
  const input = document.getElementById("admin-token-input") as HTMLInputElement;
  const submit = document.getElementById("admin-token-submit") as HTMLButtonElement;

  function submitToken(): void {
    const value = input.value.trim();
    if (value) onSubmit(value);
  }

  submit.addEventListener("click", submitToken);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submitToken();
  });
  input.focus();
}

// --- Settings form, rendered from SETTINGS_SCHEMA ---------------------
//
// Every field type SETTINGS_SCHEMA supports gets a case here — a future
// app adding a field of a type already in SettingFieldType doesn't need to
// touch this function, it already knows how to render one. A genuinely
// new type needs a case added here (and mirrored across every app copying
// this pattern, same as any other change to this file).

type FieldValue = string | number | boolean;

// Holds each "image" field's current effective value (a data: URI, or ""
// for none) — separate from the DOM, since a file input's own .value can't
// be set programmatically (browser security restriction), so it can't be
// the source of truth the way a text input's value is. Seeded from the
// loaded settings in renderSettingsSection, updated by the file-picker's
// change handler and the Remove button, read back out in readFormValues().
const imageFieldValues = new Map<string, string>();

function fieldInputHtml(field: SettingField, value: FieldValue | undefined): string {
  const regenerateBtn = field.regenerable
    ? `<button type="button" class="regenerate" data-key="${field.key}">Regenerate</button>`
    : "";

  let inputHtml: string;
  if (field.type === "toggle") {
    inputHtml = `<input type="checkbox" id="field-${field.key}" data-key="${field.key}" ${value === true ? "checked" : ""}>`;
  } else if (field.type === "number") {
    const min = field.min !== undefined ? ` min="${field.min}"` : "";
    const max = field.max !== undefined ? ` max="${field.max}"` : "";
    inputHtml = `<input type="number" id="field-${field.key}" data-key="${field.key}" value="${escapeAttr(String(value ?? ""))}"${min}${max}>`;
  } else if (field.type === "image") {
    const current = typeof value === "string" ? value : "";
    const hasImage = current.length > 0;
    inputHtml = `
      <div class="image-field">
        <img id="preview-${field.key}" class="image-preview" src="${escapeAttr(current)}" style="${hasImage ? "" : "display:none;"}">
        <input type="file" id="field-${field.key}" data-key="${field.key}" accept="image/png,image/jpeg,image/webp">
        <button type="button" class="remove-image" data-key="${field.key}" style="${hasImage ? "" : "display:none;"}">Remove</button>
      </div>
    `;
  } else {
    // "secret" is shown in plain text, not masked — the point of that type
    // is making a value we generated ourselves easy to see. "secret-masked"
    // (e.g. a pasted-in third-party API key) gets the same monospace
    // styling but shows whatever masked/plain string the server chose to
    // send back — this function doesn't decide that, it just displays it.
    const cls = field.type === "secret" || field.type === "secret-masked" ? ' class="mono"' : "";
    inputHtml = `<input type="text" id="field-${field.key}" data-key="${field.key}" value="${escapeAttr(String(value ?? ""))}"${cls}>`;
  }

  return `
    <div class="field">
      <label for="field-${field.key}">${escapeHtml(field.label)}</label>
      <div class="field-row">
        ${inputHtml}
        ${regenerateBtn}
      </div>
      ${field.help ? `<p class="help">${escapeHtml(field.help)}</p>` : ""}
    </div>
  `;
}

function readFormValues(): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {};
  for (const field of SETTINGS_SCHEMA) {
    if (field.type === "image") {
      values[field.key] = imageFieldValues.get(field.key) ?? "";
      continue;
    }
    const el = document.getElementById(`field-${field.key}`) as HTMLInputElement | null;
    if (!el) continue;
    if (field.type === "toggle") {
      values[field.key] = el.checked;
    } else if (field.type === "number") {
      values[field.key] = el.value === "" ? 0 : Number(el.value);
    } else {
      values[field.key] = el.value;
    }
  }
  return values;
}

function setImagePreview(key: string, dataUri: string): void {
  imageFieldValues.set(key, dataUri);
  const preview = document.getElementById(`preview-${key}`) as HTMLImageElement | null;
  const removeBtn = document.querySelector<HTMLButtonElement>(`.remove-image[data-key="${key}"]`);
  const hasImage = dataUri.length > 0;
  if (preview) {
    preview.src = dataUri;
    preview.style.display = hasImage ? "" : "none";
  }
  if (removeBtn) removeBtn.style.display = hasImage ? "" : "none";
}

function applyFormValues(values: SettingsValues): void {
  const record = values as unknown as Record<string, FieldValue>;
  for (const field of SETTINGS_SCHEMA) {
    if (field.type === "image") {
      setImagePreview(field.key, typeof record[field.key] === "string" ? (record[field.key] as string) : "");
      continue;
    }
    const el = document.getElementById(`field-${field.key}`) as HTMLInputElement | null;
    if (!el) continue;
    const raw = record[field.key];
    if (field.type === "toggle") {
      el.checked = raw === true;
    } else {
      el.value = raw === undefined ? "" : String(raw);
    }
  }
}

// Fields render grouped under their `section` (first-appearance order),
// each getting one heading — a form with one implicit section (no field
// sets `section`) just gets no heading at all, so an app with a single
// flat settings list isn't forced to invent a section name.
async function renderSettingsSection(container: HTMLElement, initial: SettingsValues): Promise<void> {
  const record = initial as unknown as Record<string, FieldValue>;
  // Seed BEFORE rendering — readFormValues() reads image fields from this
  // map, not the DOM (a file input's .value can't be set programmatically),
  // so an untouched image field must already hold its loaded value here or
  // a Save that never touches the icon would submit "" and wipe it.
  for (const field of SETTINGS_SCHEMA) {
    if (field.type === "image") {
      imageFieldValues.set(field.key, typeof record[field.key] === "string" ? (record[field.key] as string) : "");
    }
  }
  const order: string[] = [];
  const bySection = new Map<string, SettingField[]>();
  for (const field of SETTINGS_SCHEMA) {
    const key = field.section ?? "";
    if (!bySection.has(key)) {
      bySection.set(key, []);
      order.push(key);
    }
    bySection.get(key)!.push(field);
  }

  const fieldsHtml = order
    .map((sectionName) => {
      const heading = sectionName ? `<div class="section-title">${escapeHtml(sectionName)}</div>` : "";
      const fields = bySection.get(sectionName)!.map((field) => fieldInputHtml(field, record[field.key])).join("");
      return heading + fields;
    })
    .join("");

  container.innerHTML = `
    ${fieldsHtml}
    <button type="button" id="save-settings" class="save">Save</button>
  `;

  container.querySelectorAll<HTMLInputElement>('input[type="file"]').forEach((input) => {
    input.addEventListener("change", () => {
      const key = input.dataset.key!;
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > MAX_IMAGE_BYTES) {
        showToast(`Image must be under ${Math.floor(MAX_IMAGE_BYTES / 1024)}KB.`, "error");
        input.value = "";
        return;
      }
      const reader = new FileReader();
      reader.onload = () => setImagePreview(key, String(reader.result ?? ""));
      reader.onerror = () => showToast("Could not read that file.", "error");
      reader.readAsDataURL(file);
    });
  });

  container.querySelectorAll<HTMLButtonElement>(".remove-image").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.key!;
      setImagePreview(key, "");
      const fileInput = document.getElementById(`field-${key}`) as HTMLInputElement | null;
      // Cleared so re-selecting the exact same file still fires "change".
      if (fileInput) fileInput.value = "";
    });
  });

  container.querySelectorAll<HTMLButtonElement>(".regenerate").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = btn.dataset.key!;
      btn.disabled = true;
      try {
        const res = await apiFetch("/admin/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "regenerate", key }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const updated = (await res.json()) as SettingsValues;
        applyFormValues(updated);
        showToast(
          key === "frameToken"
            ? "Frame token regenerated — update the extension's app card to match, or it'll be blocked."
            : "Admin token regenerated — this session stays valid, but you'll need the new value next time.",
          "success",
        );
        if (key === "adminToken") {
          setStoredToken(updated.adminToken);
        }
      } catch (err) {
        showToast(`Regenerate failed: ${String(err)}`, "error");
      } finally {
        btn.disabled = false;
      }
    });
  });

  document.getElementById("save-settings")!.addEventListener("click", async () => {
    const button = document.getElementById("save-settings") as HTMLButtonElement;
    button.disabled = true;
    try {
      const res = await apiFetch("/admin/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "save", values: readFormValues() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const updated = (await res.json()) as SettingsValues;
      applyFormValues(updated);
      if (updated.adminToken !== getStoredToken()) setStoredToken(updated.adminToken);
      showToast("Saved");
    } catch (err) {
      showToast(`Save failed: ${String(err)}`, "error");
    } finally {
      button.disabled = false;
    }
  });
}

// --- Recent webhooks section -------------------------------------------

function renderWebhooksSection(container: HTMLElement, events: WebhookEvent[]): void {
  const rows = events.length
    ? events
        .map(
          (evt) => `
        <div class="webhook-row">
          <div class="webhook-meta">${escapeHtml(evt.method)} · ${escapeHtml(evt.receivedUtc)}</div>
          <pre class="webhook-body">${escapeHtml(evt.bodyText ?? "(no body)")}</pre>
        </div>
      `,
        )
        .join("")
    : `<p class="help">No webhooks received yet.</p>`;

  container.innerHTML = `<div class="section-title">Recent webhooks</div>${rows}`;
}

// --- Bootstrap ---------------------------------------------------------

async function loadAdminPage(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) return;

  const [settingsRes, webhooksRes] = await Promise.all([
    apiFetch("/admin/settings"),
    apiFetch("/admin/webhooks"),
  ]);

  if (settingsRes.status === 403 || webhooksRes.status === 403) {
    clearStoredToken();
    showTokenGateWithError("That token was rejected.");
    return;
  }
  if (!settingsRes.ok || !webhooksRes.ok) {
    root.innerHTML = `<p class="help">Failed to load: settings ${settingsRes.status}, webhooks ${webhooksRes.status}</p>`;
    return;
  }

  const settings = (await settingsRes.json()) as SettingsValues;
  const webhooks = (await webhooksRes.json()) as WebhookEvent[];

  root.innerHTML = `<div id="settings-section"></div><div id="webhooks-section"></div>`;
  await renderSettingsSection(document.getElementById("settings-section")!, settings);
  renderWebhooksSection(document.getElementById("webhooks-section")!, webhooks);
}

function showTokenGateWithError(message: string): void {
  renderTokenGate((token) => {
    setStoredToken(token);
    loadAdminPage();
  });
  showToast(message, "error");
}

const existingToken = getStoredToken();
if (existingToken) {
  loadAdminPage();
} else {
  renderTokenGate((token) => {
    setStoredToken(token);
    loadAdminPage();
  });
}
