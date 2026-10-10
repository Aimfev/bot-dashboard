
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Client, GatewayIntentBits, ActivityType } = require("discord.js");
const { Pool } = require("pg");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const API_KEY = process.env.DASHBOARD_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

const origins = (
  process.env.FRONTEND_ORIGINS || "https://aimfev.github.io"
).split(",").map(value => value.trim());

app.use(cors({
  origin(origin, callback) {
    if (!origin || origins.includes(origin)) return callback(null, true);
    callback(new Error("Origin not allowed"));
  },
  allowedHeaders: ["Content-Type", "x-dashboard-key"],
  methods: ["GET", "PUT", "POST", "OPTIONS"]
}));

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

let botReady = false;
let dbReady = false;
let config = {
  presence: "online",
  activityType: "Playing",
  activityText: "VEYRON Control",
  bioNote: "",
  pronounsNote: "",
  modules: {}
};

const activityTypes = {
  Playing: ActivityType.Playing,
  Listening: ActivityType.Listening,
  Watching: ActivityType.Watching,
  Competing: ActivityType.Competing
};

function requireKey(req, res, next) {
  if (!API_KEY) {
    return res.status(503).json({
      error: "DASHBOARD_API_KEY is missing in Render."
    });
  }

  const supplied = req.get("x-dashboard-key") || "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(API_KEY);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Invalid dashboard API key." });
  }

  next();
}

function statusData() {
  const ping = client.ws?.ping;

  return {
    bot: {
      ready: botReady && Boolean(client.user),
      username: client.user?.username || null,
      guilds: client.guilds.cache.size,
      ping: Number.isFinite(ping) && ping >= 0 ? ping : null
    },
    database: { connected: dbReady }
  };
}

async function initializeDatabase() {
  if (!pool) {
    console.warn("DATABASE_URL missing; configuration will be memory-only.");
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS veyron_config (
      config_key TEXT PRIMARY KEY,
      config_value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const result = await pool.query(
    "SELECT config_value FROM veyron_config WHERE config_key = $1",
    ["main"]
  );

  if (result.rows[0]) {
    config = { ...config, ...result.rows[0].config_value };
    config.modules = config.modules || {};
  } else {
    await pool.query(
      "INSERT INTO veyron_config(config_key, config_value) VALUES($1,$2::jsonb)",
      ["main", JSON.stringify(config)]
    );
  }

  dbReady = true;
  console.log("Supabase PostgreSQL connected.");
}

async function saveConfig(patch) {
  config = { ...config, ...patch };
  config.modules = config.modules || {};

  if (pool && dbReady) {
    await pool.query(
      `INSERT INTO veyron_config(config_key, config_value, updated_at)
       VALUES($1,$2::jsonb,NOW())
       ON CONFLICT(config_key)
       DO UPDATE SET config_value=EXCLUDED.config_value,
                     updated_at=NOW()`,
      ["main", JSON.stringify(config)]
    );
  }

  return config;
}

app.get("/", (_req, res) => {
  res.json({ name: "VEYRON Control API", ok: true });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, status: statusData() });
});

app.get("/api/config", requireKey, (_req, res) => {
  res.json({ config, status: statusData() });
});

app.put("/api/config", requireKey, async (req, res) => {
  try {
    const body = req.body || {};
    const patch = {};

    if (body.modules && typeof body.modules === "object" &&
        !Array.isArray(body.modules)) {
      patch.modules = body.modules;
    }

    if (typeof body.bioNote === "string") patch.bioNote = body.bioNote.slice(0, 500);
    if (typeof body.pronounsNote === "string") patch.pronounsNote = body.pronounsNote.slice(0, 80);

    await saveConfig(patch);
    res.json({ ok: true, config, status: statusData() });
  } catch (error) {
    console.error("Save configuration failed:", error);
    res.status(500).json({ error: "Failed to save configuration." });
  }
});

app.post("/api/status", requireKey, async (req, res) => {
  try {
    const {
      presence,
      activityType,
      activityText,
      bioNote,
      pronounsNote
    } = req.body || {};

    const allowedPresence = ["online", "idle", "dnd", "invisible"];

    if (!allowedPresence.includes(presence)) {
      return res.status(400).json({ error: "Invalid presence." });
    }

    if (activityType && !Object.hasOwn(activityTypes, activityType)) {
      return res.status(400).json({ error: "Invalid activity type." });
    }

    if (typeof activityText === "string" && activityText.length > 128) {
      return res.status(400).json({ error: "Activity text is too long." });
    }

    if (!botReady || !client.user) {
      return res.status(503).json({
        error: "The VEYRON bot is not connected to Discord."
      });
    }

    const patch = {
      presence,
      activityType: activityType || "Playing",
      activityText: typeof activityText === "string" ? activityText : ""
    };

    if (typeof bioNote === "string") patch.bioNote = bioNote.slice(0, 500);
    if (typeof pronounsNote === "string") patch.pronounsNote = pronounsNote.slice(0, 80);

    const type = activityTypes[patch.activityType];

    client.user.setPresence({
      status: patch.presence,
      activities: patch.activityText
        ? [{ name: patch.activityText, type }]
        : []
    });

    await saveConfig(patch);
    res.json({ ok: true, config, status: statusData() });
  } catch (error) {
    console.error("Presence update failed:", error);
    res.status(500).json({ error: "Failed to update presence." });
  }
});

client.once("ready", () => {
  botReady = true;
  console.log(`Connected as ${client.user.tag}`);

  const type = activityTypes[config.activityType] ?? ActivityType.Playing;

  client.user.setPresence({
    status: config.presence || "online",
    activities: config.activityText
      ? [{ name: config.activityText, type }]
      : []
  });
});

client.on("error", error => console.error("Discord client error:", error));
client.on("shardDisconnect", () => { botReady = false; });
client.on("shardReady", () => { botReady = true; });

async function start() {
  try {
    await initializeDatabase();
  } catch (error) {
    dbReady = false;
    console.error("Database connection failed:", error.message);
  }

  if (!BOT_TOKEN) {
    console.error("BOT_TOKEN is missing from Render environment variables.");
  } else {
    client.login(BOT_TOKEN).catch(error => {
      console.error("Discord login failed:", error.message);
    });
  }

  app.listen(PORT, () => {
    console.log(`VEYRON Control API listening on ${PORT}`);
  });
}

process.on("SIGTERM", async () => {
  try { await client.destroy(); } catch {}
  try { if (pool) await pool.end(); } catch {}
  process.exit(0);
});

start();
