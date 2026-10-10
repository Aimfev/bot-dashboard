
const API = "https://bot-dashboard-w9zw.onrender.com";
const KEY_NAME = "veyron_dashboard_api_key";

let apiKey = localStorage.getItem(KEY_NAME) || "";
let currentPage = "Overview & Bot Status";
let config = {
  presence: "online",
  activityType: "Playing",
  activityText: "VEYRON Control",
  bioNote: "",
  pronounsNote: "",
  modules: {}
};

let runtime = {};

const groups = {
  "CORE MODULES": [
    "Overview & Bot Status", "Welcomer", "Goodbye Messages",
    "Boost Messages", "Auto Roles", "Reaction Roles",
    "Moderation", "AutoMod & Anti-Spam", "Warnings & Cases",
    "Logging", "Tickets", "Suggestions"
  ],
  "COMMANDS & BUILDERS": [
    "Slash Commands", "Custom Commands", "Command Builder",
    "Event Builder", "Message Builder", "Embeds & Components",
    "Scheduled Tasks", "Autoresponder", "Variables & Conditions",
    "Custom Events"
  ],
  "COMMUNITY MODULES": [
    "Leveling & XP", "Rank Cards", "Leaderboards", "Economy",
    "Giveaways", "Polls", "Starboard", "Counting",
    "Invites & Tracking", "Birthdays", "Reminders", "Sticky Messages"
  ],
  "SERVER TOOLS": [
    "Server Statistics", "Member Counter", "Reaction Management",
    "Temporary Voice Channels", "Role Management", "Channel Management",
    "Mass Actions", "Utility Commands", "Information Commands",
    "Verification"
  ],
  "ADVANCED & SETTINGS": [
    "AI Integrations", "API Requests", "Data Storage",
    "Custom Status", "Activity & Analytics", "Audit Logs",
    "Error Logs", "Permissions & Access", "Bot Settings",
    "Premium-Style Features"
  ]
};

const $ = selector => document.querySelector(selector);

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;"
  })[char]);
}

function notify(message, error = false) {
  const box = $("#notice");
  box.textContent = message;
  box.classList.remove("hidden");
  box.style.borderColor = error ? "#a34747" : "";
  box.style.color = error ? "#ffbaba" : "";
  setTimeout(() => box.classList.add("hidden"), 5000);
}

async function request(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  if (apiKey) headers["x-dashboard-key"] = apiKey;

  const response = await fetch(API + path, {
    ...options,
    headers
  });

  const data = await response.json().catch(() => ({}));

  if (response.status === 401) {
    apiKey = prompt("Enter your Render DASHBOARD_API_KEY") || "";
    if (!apiKey) throw new Error("Dashboard API key required.");
    localStorage.setItem(KEY_NAME, apiKey);
    return request(path, options);
  }

  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function renderNavigation() {
  const nav = $("#navigation");

  nav.innerHTML = Object.entries(groups).map(([heading, items]) => `
    <div class="nav-group">
      <div class="nav-heading">${escapeHTML(heading)}</div>
      ${items.map(item => `
        <button class="nav-item ${item === currentPage ? "active" : ""}"
                data-page="${escapeHTML(item)}">
          ${escapeHTML(item)}
        </button>
      `).join("")}
    </div>
  `).join("");

  document.querySelectorAll("[data-page]").forEach(button => {
    button.onclick = () => navigate(button.dataset.page);
  });
}

function navigate(page) {
  currentPage = page;
  $("#pageTitle").textContent = page;
  $("#sidebar").classList.remove("open");
  renderNavigation();
  renderPage();
}

function updateConnection() {
  const ready = Boolean(runtime.bot?.ready);
  $("#connection").textContent = ready ? "Bot connected" : "Bot not connected";
  $("#statusDot").className = `dot ${ready ? "online" : "offline"}`;
}

async function loadConfig() {
  try {
    const result = await request("/api/config");
    config = { ...config, ...(result.config || {}) };
    config.modules = config.modules || {};
    runtime = result.status || {};
    updateConnection();
    renderPage();
  } catch (error) {
    $("#connection").textContent = "Connection error";
    $("#statusDot").className = "dot offline";
    notify(error.message, true);
  }
}

async function saveConfig(patch) {
  try {
    const result = await request("/api/config", {
      method: "PUT",
      body: JSON.stringify(patch)
    });

    config = { ...config, ...(result.config || {}) };
    notify("Configuration saved.");
    renderPage();
  } catch (error) {
    notify(error.message, true);
  }
}

function statusPage() {
  const bot = runtime.bot || {};
  const db = runtime.database || {};

  return `
    <div class="grid four">
      <div class="card">
        <div class="stat-label">Discord bot</div>
        <div class="stat-value">${bot.ready ? "Online" : "Offline"}</div>
      </div>
      <div class="card">
        <div class="stat-label">Gateway latency</div>
        <div class="stat-value">${Number.isFinite(bot.ping) ? Math.round(bot.ping) + " ms" : "—"}</div>
      </div>
      <div class="card">
        <div class="stat-label">Servers</div>
        <div class="stat-value">${bot.guilds ?? "—"}</div>
      </div>
      <div class="card">
        <div class="stat-label">Database</div>
        <div class="stat-value">${db.connected ? "Ready" : "Unknown"}</div>
      </div>
    </div>

    <div class="section-title">
      <h2>Bot Presence</h2>
      <p>Change the live presence of your existing VEYRON bot.</p>
    </div>

    <form id="statusForm" class="grid two">
      <div class="card">
        <h2>Presence and activity</h2>

        <div class="field">
          <label for="presence">Online status</label>
          <select id="presence">
            ${[
              ["online", "🟢 Online"],
              ["idle", "🌙 Idle"],
              ["dnd", "⛔ Do Not Disturb"],
              ["invisible", "⚫ Invisible"]
            ].map(([value, label]) => `
              <option value="${value}" ${config.presence === value ? "selected" : ""}>
                ${label}
              </option>
            `).join("")}
          </select>
        </div>

        <div class="field">
          <label for="activityType">Activity type</label>
          <select id="activityType">
            ${["Playing", "Watching", "Listening", "Competing"].map(value => `
              <option ${config.activityType === value ? "selected" : ""}>${value}</option>
            `).join("")}
          </select>
        </div>

        <div class="field">
          <label for="activityText">Activity text</label>
          <input id="activityText" maxlength="128"
                 value="${escapeHTML(config.activityText)}">
        </div>

        <div class="form-actions">
          <button class="primary" type="submit">Save & Apply Status</button>
        </div>
      </div>

      <div class="card">
        <h2>Bio and pronouns</h2>
        <p class="muted">
          Discord's supported bot API cannot edit the bot's About Me or pronouns.
          These values are saved as dashboard-only notes.
        </p>

        <div class="field">
          <label for="bioNote">Bio note</label>
          <textarea id="bioNote" maxlength="500">${escapeHTML(config.bioNote)}</textarea>
        </div>

        <div class="field">
          <label for="pronounsNote">Pronouns note</label>
          <input id="pronounsNote" maxlength="80"
                 value="${escapeHTML(config.pronounsNote)}">
        </div>

        <div class="form-actions">
          <button class="secondary" type="button" id="saveNotes">
            Save dashboard notes
          </button>
        </div>
      </div>
    </form>
  `;
}

function renderPage() {
  const content = $("#content");

  if (currentPage === "Overview" ||
      currentPage === "Overview & Bot Status") {
    content.innerHTML = statusPage();
    attachStatusEvents();
    return;
  }

  if (currentPage === "API & Access" ||
      currentPage === "Permissions & Access") {
    content.innerHTML = `
      <div class="card">
        <h2>API & Access</h2>
        <p class="muted">Existing Render API connection.</p>
        <div class="field">
          <label>Backend URL</label>
          <input readonly value="${API}">
        </div>
        <button class="secondary" id="changeKey">Change dashboard API key</button>
        <p class="muted">Never place your bot token in frontend files.</p>
      </div>
    `;

    $("#changeKey").onclick = () => {
      const value = prompt("Enter DASHBOARD_API_KEY");
      if (value) {
        apiKey = value;
        localStorage.setItem(KEY_NAME, value);
        loadConfig();
      }
    };
    return;
  }

  const values = config.modules[currentPage] || {};

  content.innerHTML = `
    <div class="card">
      <h2>${escapeHTML(currentPage)}</h2>
      <p class="muted">
        Configure this module. Saving stores its configuration;
        the corresponding bot event handler or worker must also be implemented
        for actions to run in Discord.
      </p>

      <form id="moduleForm">
        <div class="field">
          <label>Enable module configuration</label>
          <select id="moduleEnabled">
            <option value="false" ${values.enabled ? "" : "selected"}>Disabled</option>
            <option value="true" ${values.enabled ? "selected" : ""}>Enabled</option>
          </select>
        </div>

        <div class="field">
          <label>Channel ID (optional)</label>
          <input id="channelId" value="${escapeHTML(values.channelId || "")}"
                 placeholder="Discord channel ID">
        </div>

        <div class="field">
          <label>Role IDs (optional)</label>
          <input id="roleIds" value="${escapeHTML(values.roleIds || "")}"
                 placeholder="Role IDs separated by commas">
        </div>

        <div class="field">
          <label>Message / settings / notes</label>
          <textarea id="moduleNotes">${escapeHTML(values.notes || values.message || "")}</textarea>
        </div>

        <div class="form-actions">
          <button class="primary" type="submit">Save ${escapeHTML(currentPage)}</button>
        </div>
      </form>
    </div>
  `;

  $("#moduleForm").onsubmit = async event => {
    event.preventDefault();

    const modules = {
      ...config.modules,
      [currentPage]: {
        enabled: $("#moduleEnabled").value === "true",
        channelId: $("#channelId").value.trim(),
        roleIds: $("#roleIds").value.trim(),
        notes: $("#moduleNotes").value
      }
    };

    await saveConfig({ modules });
  };
}

function attachStatusEvents() {
  const form = $("#statusForm");

  form.onsubmit = async event => {
    event.preventDefault();

    try {
      const result = await request("/api/status", {
        method: "POST",
        body: JSON.stringify({
          presence: $("#presence").value,
          activityType: $("#activityType").value,
          activityText: $("#activityText").value.trim(),
          bioNote: $("#bioNote").value,
          pronounsNote: $("#pronounsNote").value
        })
      });

      config = { ...config, ...(result.config || {}) };
      runtime = result.status || runtime;
      updateConnection();
      notify("Bot presence updated.");
      renderPage();
    } catch (error) {
      notify(error.message, true);
    }
  };

  $("#saveNotes").onclick = () => saveConfig({
    bioNote: $("#bioNote").value,
    pronounsNote: $("#pronounsNote").value
  });
}

$("#menuButton").onclick = () => $("#sidebar").classList.toggle("open");
$("#refreshButton").onclick = loadConfig;

renderNavigation();
loadConfig();
setInterval(loadConfig, 30000);
