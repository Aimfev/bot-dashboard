
'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const session = require('express-session');
const { Pool } = require('pg');
const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  SlashCommandBuilder,
  REST,
  Routes
} = require('discord.js');

const app = express();
const PORT = process.env.PORT || 10000;

// VEYRON Control: serve frontend and API from Render.
const FRONTEND_URL = 'https://bot-dashboard-w9zw.onrender.com/';
const FRONTEND_ORIGIN = 'https://bot-dashboard-w9zw.onrender.com';
const FRONTEND_PATH = path.resolve(__dirname, '../frontend');

const {
  SESSION_SECRET,
  DATABASE_URL,
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_BOT_TOKEN,
  DISCORD_REDIRECT_URI
} = process.env;

if (!SESSION_SECRET) {
  console.error('SESSION_SECRET is missing.');
  process.exit(1);
}

if (
  !DISCORD_CLIENT_ID ||
  !DISCORD_CLIENT_SECRET ||
  !DISCORD_REDIRECT_URI
) {
  console.error('Discord OAuth environment variables are missing.');
  process.exit(1);
}

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: false
}));

app.use(cors({
  origin: FRONTEND_ORIGIN,
  credentials: true
}));

app.use(express.json({ limit: '100kb' }));

app.use(session({
  name: 'veyron.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

// PostgreSQL
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes('localhost')
        ? false
        : { rejectUnauthorized: false }
    })
  : null;

const schema = `
CREATE TABLE IF NOT EXISTS dashboard_settings (
  guild_id TEXT NOT NULL,
  module TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, module)
);

CREATE TABLE IF NOT EXISTS moderation_cases (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  actor_id TEXT,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS server_logs (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

async function db(sql, args = []) {
  if (!pool) {
    throw new Error('DATABASE_URL is not configured.');
  }

  return pool.query(sql, args);
}

async function initializeDatabase() {
  if (!pool) {
    console.warn('DATABASE_URL is not configured.');
    return;
  }

  try {
    await pool.query(schema);
    console.log('Database tables checked.');
  } catch (error) {
    console.error('Database initialization failed:', error.message);
  }
}

// Discord slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('say')
    .setDescription('Send a message as VEYRON')
    .addStringOption(option =>
      option
        .setName('message')
        .setDescription('Message to send')
        .setRequired(true)
        .setMaxLength(1800)
    )
    .setDefaultMemberPermissions(
      PermissionsBitField.Flags.ManageMessages
    ),

  new SlashCommandBuilder()
    .setName('serverinfo')
    .setDescription('Show information about this server'),

  new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription('Show information about a member')
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription('Member to inspect')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check VEYRON latency')
];

const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

let botReady = false;

bot.once('clientReady', async () => {
  botReady = true;
  console.log(`VEYRON online as ${bot.user.tag}`);

  try {
    const rest = new REST({ version: '10' })
      .setToken(DISCORD_BOT_TOKEN);

    await rest.put(
      Routes.applicationCommands(DISCORD_CLIENT_ID),
      {
        body: commands.map(command => command.toJSON())
      }
    );

    console.log('Slash commands registered.');
  } catch (error) {
    console.error('Command registration failed:', error.message);
  }
});

bot.on('error', error => {
  console.error('Discord bot error:', error.message);
});

bot.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'ping') {
      return interaction.reply({
        content: `Pong! ${Math.round(bot.ws.ping)}ms`,
        ephemeral: true
      });
    }

    if (interaction.commandName === 'say') {
      if (!interaction.memberPermissions?.has(
        PermissionsBitField.Flags.ManageMessages
      )) {
        return interaction.reply({
          content: 'You need Manage Messages permission.',
          ephemeral: true
        });
      }

      return interaction.reply({
        content: interaction.options.getString('message', true),
        allowedMentions: { parse: [] }
      });
    }

    if (interaction.commandName === 'serverinfo') {
      const guild = interaction.guild;
      const icon = guild.iconURL();

      return interaction.reply({
        embeds: [{
          color: 0x61ed94,
          title: guild.name,
          ...(icon ? { thumbnail: { url: icon } } : {}),
          fields: [
            {
              name: 'Server ID',
              value: guild.id,
              inline: true
            },
            {
              name: 'Members',
              value: String(guild.memberCount),
              inline: true
            },
            {
              name: 'Created',
              value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`,
              inline: true
            }
          ]
        }],
        ephemeral: true
      });
    }

    if (interaction.commandName === 'userinfo') {
      const user =
        interaction.options.getUser('user') || interaction.user;

      return interaction.reply({
        embeds: [{
          color: 0x61ed94,
          title: user.tag || user.username,
          thumbnail: { url: user.displayAvatarURL() },
          fields: [
            {
              name: 'User ID',
              value: user.id,
              inline: true
            },
            {
              name: 'Created',
              value: `<t:${Math.floor(user.createdTimestamp / 1000)}:D>`,
              inline: true
            }
          ]
        }],
        ephemeral: true
      });
    }
  } catch (error) {
    console.error('Command failed:', error.message);

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: 'Command failed. Check bot permissions.',
        ephemeral: true
      }).catch(() => {});
    }
  }
});

if (DISCORD_BOT_TOKEN) {
  bot.login(DISCORD_BOT_TOKEN).catch(error => {
    console.error('Bot login failed:', error.message);
  });
} else {
  console.warn('DISCORD_BOT_TOKEN is not configured.');
}

// Authentication helpers
function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({
      error: 'Connect Discord first.'
    });
  }

  next();
}

function hasManagePermission(guild) {
  try {
    const permissions = BigInt(guild.permissions || '0');

    return Boolean(guild.owner) ||
      (permissions & BigInt(
        PermissionsBitField.Flags.Administrator
      )) !== 0n ||
      (permissions & BigInt(
        PermissionsBitField.Flags.ManageGuild
      )) !== 0n;
  } catch {
    return false;
  }
}

function canManage(req, id) {
  return /^\d{17,20}$/.test(String(id || '')) &&
    (req.session.guilds || []).some(guild =>
      guild.id === String(id) && hasManagePermission(guild)
    );
}

async function requireGuild(req, res, id) {
  if (!canManage(req, id)) {
    res.status(403).json({
      error: 'You need Manage Server permission for this server.'
    });
    return null;
  }

  if (!botReady) {
    res.status(503).json({
      error: 'VEYRON bot is not online.'
    });
    return null;
  }

  const guild = bot.guilds.cache.get(String(id));

  if (!guild) {
    res.status(404).json({
      error: 'VEYRON is not installed in this server.'
    });
    return null;
  }

  return guild;
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    botReady,
    dbConfigured: Boolean(pool),
    service: 'VEYRON Control'
  });
});

// Discord OAuth login URL
app.get('/auth/discord/url', (req, res) => {
  const url = new URL('https://discord.com/oauth2/authorize');

  url.searchParams.set('client_id', DISCORD_CLIENT_ID);
  url.searchParams.set('redirect_uri', DISCORD_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'identify guilds');

  res.set('Cache-Control', 'no-store');
  res.json({ url: url.toString() });
});

// Discord OAuth callback
app.get('/auth/discord/callback', async (req, res) => {
  try {
    const code = req.query.code;

    if (!code) {
      return res.redirect(`${FRONTEND_URL}?login=cancelled`);
    }

    const tokenResponse = await fetch(
      'https://discord.com/api/oauth2/token',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          client_id: DISCORD_CLIENT_ID,
          client_secret: DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code: String(code),
          redirect_uri: DISCORD_REDIRECT_URI
        })
      }
    );

    const token = await tokenResponse.json();

    if (!tokenResponse.ok || !token.access_token) {
      console.error(
        'OAuth exchange failed:',
        token.error || tokenResponse.status
      );

      return res.status(502).send(
        'Discord login failed. Check your OAuth settings.'
      );
    }

    const headers = {
      Authorization: `Bearer ${token.access_token}`
    };

    const [userResponse, guildResponse] = await Promise.all([
      fetch('https://discord.com/api/users/@me', { headers }),
      fetch('https://discord.com/api/users/@me/guilds', { headers })
    ]);

    if (!userResponse.ok || !guildResponse.ok) {
      throw new Error('Failed to fetch Discord profile or servers.');
    }

    const user = await userResponse.json();
    const guilds = await guildResponse.json();

    const sessionUser = {
      id: user.id,
      username: user.global_name || user.username,
      avatar: user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
        : null
    };

    const manageableGuilds = guilds
      .filter(hasManagePermission)
      .map(guild => ({
        id: guild.id,
        name: guild.name,
        owner: guild.owner,
        permissions: guild.permissions,
        icon: guild.icon
      }));

    // Regenerate session after successful OAuth to reduce fixation risk.
    req.session.regenerate(error => {
      if (error) {
        console.error('Session regeneration failed:', error.message);
        return res.status(500).send('Could not create login session.');
      }

      req.session.user = sessionUser;
      req.session.guilds = manageableGuilds;

      req.session.save(saveError => {
        if (saveError) {
          console.error('Session save failed:', saveError.message);
          return res.status(500).send('Could not save login session.');
        }

        res.redirect(FRONTEND_URL);
      });
    });
  } catch (error) {
    console.error('OAuth callback failed:', error.message);
    res.status(500).send(
      'Discord login failed. Check the Render logs and OAuth settings.'
    );
  }
});

// Current user and manageable Discord servers
app.get('/api/me', requireAuth, (req, res) => {
  const guilds = (req.session.guilds || []).map(guild => ({
    id: guild.id,
    name: guild.name,
    owner: guild.owner,
    icon: guild.icon,
    botInstalled: bot.guilds.cache.has(guild.id),
    botReady,
    canManage: true
  }));

  res.set('Cache-Control', 'no-store');

  res.json({
    user: req.session.user,
    guilds,
    botReady
  });
});

// Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy(error => {
    if (error) {
      return res.status(500).json({
        error: 'Could not log out.'
      });
    }

    res.clearCookie('veyron.sid', {
      httpOnly: true,
      secure: true,
      sameSite: 'lax'
    });

    res.json({ ok: true });
  });
});

// Read module settings
app.get('/api/modules/:module', requireAuth, async (req, res) => {
  try {
    const id = String(req.query.guildId || '');

    if (!await requireGuild(req, res, id)) return;

    const result = await db(
      `SELECT config, updated_at
       FROM dashboard_settings
       WHERE guild_id=$1 AND module=$2`,
      [id, req.params.module]
    );

    res.json({
      config: result.rows[0]?.config || {},
      updatedAt: result.rows[0]?.updated_at || null
    });
  } catch (error) {
    console.error('Read module failed:', error.message);
    res.status(500).json({
      error: 'Could not read module settings.'
    });
  }
});

// Save module settings
app.put('/api/modules/:module', requireAuth, async (req, res) => {
  try {
    const id = String(req.body.guildId || '');

    if (!await requireGuild(req, res, id)) return;

    const config = {
      features: Array.isArray(req.body.features)
        ? req.body.features
        : [],
      enabled: Boolean(req.body.enabled)
    };

    await db(
      `INSERT INTO dashboard_settings(guild_id,module,config)
       VALUES($1,$2,$3)
       ON CONFLICT(guild_id,module)
       DO UPDATE SET
         config=EXCLUDED.config,
         updated_at=NOW()`,
      [id, req.params.module, JSON.stringify(config)]
    );

    res.json({
      ok: true,
      message: 'Module settings saved.'
    });
  } catch (error) {
    console.error('Save module failed:', error.message);
    res.status(500).json({
      error: 'Could not save module settings.'
    });
  }
});

// Save module configuration
app.put('/api/modules/:module/config', requireAuth, async (req, res) => {
  try {
    const id = String(req.body.guildId || '');

    if (!await requireGuild(req, res, id)) return;

    const config = {
      channelId: String(req.body.channelId || ''),
      details: String(req.body.details || '').slice(0, 4000)
    };

    await db(
      `INSERT INTO dashboard_settings(guild_id,module,config)
       VALUES($1,$2,$3)
       ON CONFLICT(guild_id,module)
       DO UPDATE SET
         config=EXCLUDED.config,
         updated_at=NOW()`,
      [id, req.params.module, JSON.stringify(config)]
    );

    res.json({
      ok: true,
      message: 'Configuration saved.'
    });
  } catch (error) {
    console.error('Save config failed:', error.message);
    res.status(500).json({
      error: 'Could not save configuration.'
    });
  }
});

// Moderation history
app.get('/api/moderation', requireAuth, async (req, res) => {
  try {
    const id = String(req.query.guildId || '');

    if (!await requireGuild(req, res, id)) return;

    const result = await db(
      `SELECT id,
              actor_id AS "actorId",
              target_id AS "targetId",
              action,
              reason,
              created_at AS "createdAt"
       FROM moderation_cases
       WHERE guild_id=$1
       ORDER BY id DESC
       LIMIT 100`,
      [id]
    );

    res.json({ cases: result.rows });
  } catch (error) {
    console.error('Moderation history failed:', error.message);
    res.status(500).json({
      error: 'Could not load moderation history.'
    });
  }
});

// Perform moderation action
app.post('/api/moderation', requireAuth, async (req, res) => {
  try {
    const {
      guildId,
      action,
      targetId,
      reason,
      durationMinutes
    } = req.body;

    const guild = await requireGuild(req, res, guildId);
    if (!guild) return;

    if (!['warn', 'timeout', 'kick', 'ban'].includes(action)) {
      return res.status(400).json({
        error: 'Unsupported moderation action.'
      });
    }

    if (!/^\d{17,20}$/.test(String(targetId || ''))) {
      return res.status(400).json({
        error: 'Enter a valid Discord user ID.'
      });
    }

    const why = String(reason || 'No reason provided').slice(0, 500);

    const member = await guild.members
      .fetch(String(targetId))
      .catch(() => null);

    if (action !== 'ban' && !member) {
      return res.status(404).json({
        error: 'Member not found in this server.'
      });
    }

    if (action === 'warn') {
      // Warning is recorded in the database.
    }

    if (action === 'timeout') {
      if (!member.moderatable) {
        return res.status(403).json({
          error: 'Bot cannot timeout this member. Check role hierarchy.'
        });
      }

      const minutes = Math.max(
        1,
        Math.min(40320, Number(durationMinutes) || 10)
      );

      await member.timeout(minutes * 60000, why);
    }

    if (action === 'kick') {
      if (!member.kickable) {
        return res.status(403).json({
          error: 'Bot cannot kick this member. Check role hierarchy.'
        });
      }

      await member.kick(why);
    }

    if (action === 'ban') {
      if (member && !member.bannable) {
        return res.status(403).json({
          error: 'Bot cannot ban this member. Check role hierarchy.'
        });
      }

      await guild.members.ban(String(targetId), { reason: why });
    }

    await db(
      `INSERT INTO moderation_cases
       (guild_id,actor_id,target_id,action,reason)
       VALUES($1,$2,$3,$4,$5)`,
      [
        String(guildId),
        req.session.user.id,
        String(targetId),
        action,
        why
      ]
    );

    await db(
      `INSERT INTO server_logs(guild_id,type,message)
       VALUES($1,$2,$3)`,
      [
        String(guildId),
        'moderation',
        `${action} ${targetId}: ${why}`
      ]
    );

    res.json({
      ok: true,
      message: action === 'warn'
        ? 'Warning recorded (no DM sent).'
        : `${action} action completed.`
    });
  } catch (error) {
    console.error('Moderation failed:', error.message);
    res.status(500).json({
      error: 'Moderation action failed.'
    });
  }
});

// Dashboard server logs
app.get('/api/logs', requireAuth, async (req, res) => {
  try {
    const id = String(req.query.guildId || '');

    if (!await requireGuild(req, res, id)) return;

    const result = await db(
      `SELECT type,
              message,
              created_at AS "createdAt"
       FROM server_logs
       WHERE guild_id=$1
       ORDER BY id DESC
       LIMIT 100`,
      [id]
    );

    res.json({ logs: result.rows });
  } catch (error) {
    console.error('Load logs failed:', error.message);
    res.status(500).json({
      error: 'Could not load server logs.'
    });
  }
});

// Serve the frontend AFTER the API routes.
app.use(express.static(FRONTEND_PATH, {
  index: 'index.html',
  etag: true,
  maxAge: 0
}));

app.get('/', (req, res) => {
  res.sendFile(path.join(FRONTEND_PATH, 'index.html'));
});

// Unknown routes
app.use((req, res) => {
  if (req.path.startsWith('/api/') ||
      req.path.startsWith('/auth/')) {
    return res.status(404).json({
      error: 'Endpoint not found.'
    });
  }

  res.status(404).send('Page not found.');
});

async function start() {
  await initializeDatabase();

  app.listen(PORT, () => {
    console.log(`VEYRON Control listening on port ${PORT}`);
    console.log(`Frontend directory: ${FRONTEND_PATH}`);
  });
}

start().catch(error => {
  console.error('Startup failed:', error.message);
  process.exit(1);
});
