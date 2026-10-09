require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const session = require('express-session');
const { Pool } = require('pg');
const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');

const app = express();
const PORT = process.env.PORT || 3000;

const FRONTEND = (
  process.env.FRONTEND_ORIGIN ||
  'https://aimfev.github.io'
).replace(/\/$/, '');

const FRONTEND_URL = FRONTEND + '/bot-dashboard/';

app.set('trust proxy', 1);

app.use(helmet({
  crossOriginResourcePolicy: false
}));

app.use(cors({
  origin: FRONTEND,
  credentials: true
}));

app.use(express.json({
  limit: '100kb'
}));

app.use(session({
  name: 'ducky.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost')
        ? false
        : { rejectUnauthorized: false }
    })
  : null;

let bot = null;
let botReady = false;

if (process.env.DISCORD_BOT_TOKEN) {
  bot = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers
    ]
  });

  bot.once('clientReady', () => {
    botReady = true;
    console.log(`DUCKY bot online as ${bot.user.tag}`);
  });

  bot.on('error', error => {
    console.error('Discord bot error:', error.message);
  });

  bot.login(process.env.DISCORD_BOT_TOKEN).catch(error => {
    console.error('Bot login failed:', error.message);
  });
} else {
  console.warn('DISCORD_BOT_TOKEN is not configured.');
}

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
    throw new Error('Database is not configured.');
  }

  return pool.query(sql, args);
}

async function init() {
  if (!pool) {
    console.warn('DATABASE_URL is not configured.');
    return;
  }

  try {
    await pool.query(schema);
    console.log('Database tables checked');
  } catch (error) {
    console.error('Database init failed:', error.message);
  }
}

init();

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
      (permissions & BigInt(PermissionsBitField.Flags.Administrator)) !== 0n ||
      (permissions & BigInt(PermissionsBitField.Flags.ManageGuild)) !== 0n;
  } catch {
    return false;
  }
}

function canManage(req, guildId) {
  if (!guildId || !/^\d{17,20}$/.test(String(guildId))) {
    return false;
  }

  return (req.session.guilds || []).some(guild =>
    guild.id === String(guildId) &&
    hasManagePermission(guild)
  );
}

async function getBotGuild(guildId) {
  if (!bot || !botReady) {
    return null;
  }

  return bot.guilds.cache.get(String(guildId)) || null;
}

async function requireManagedBotGuild(req, res, guildId) {
  if (!canManage(req, guildId)) {
    res.status(403).json({
      error: 'You need Manage Server permission for this server.'
    });
    return null;
  }

  if (!botReady) {
    res.status(503).json({
      error: 'The Discord bot is not online.'
    });
    return null;
  }

  const guild = await getBotGuild(guildId);

  if (!guild) {
    res.status(404).json({
      error: 'Your bot is not installed in this server.'
    });
    return null;
  }

  return guild;
}

// Health
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    botReady,
    dbConfigured: Boolean(pool),
    service: 'DUCKY API'
  });
});

// OAuth URL
app.get('/auth/discord/url', (req, res) => {
  if (
    !process.env.DISCORD_CLIENT_ID ||
    !process.env.DISCORD_REDIRECT_URI
  ) {
    return res.status(503).json({
      error: 'Discord OAuth environment variables are missing.'
    });
  }

  const url = new URL('https://discord.com/oauth2/authorize');

  url.searchParams.set('client_id', process.env.DISCORD_CLIENT_ID);
  url.searchParams.set('redirect_uri', process.env.DISCORD_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'identify guilds');

  res.json({
    url: url.toString()
  });
});

// OAuth callback
app.get('/auth/discord/callback', async (req, res) => {
  try {
    const code = req.query.code;

    if (!code) {
      return res.redirect(`${FRONTEND_URL}?login=cancelled`);
    }

    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID || '',
        client_secret: process.env.DISCORD_CLIENT_SECRET || '',
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.DISCORD_REDIRECT_URI || ''
      })
    });

    const token = await tokenRes.json();

    if (!tokenRes.ok || !token.access_token) {
      if (tokenRes.status === 429) {
        return res.status(429).send(
          'Discord is rate-limiting logins. Wait before trying again.'
        );
      }

      console.error('OAuth exchange failed:', token.error || tokenRes.status);
      throw new Error('Discord authentication failed.');
    }

    const headers = {
      Authorization: `Bearer ${token.access_token}`
    };

    const [userRes, guildRes] = await Promise.all([
      fetch('https://discord.com/api/users/@me', { headers }),
      fetch('https://discord.com/api/users/@me/guilds', { headers })
    ]);

    if (!userRes.ok || !guildRes.ok) {
      throw new Error('Could not retrieve your Discord account or servers.');
    }

    const user = await userRes.json();
    const allGuilds = await guildRes.json();

    if (!user.id || !Array.isArray(allGuilds)) {
      throw new Error('Invalid Discord response.');
    }

    req.session.user = {
      id: user.id,
      username: user.global_name || user.username,
      avatar: user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
        : null
    };

    // Only servers the user owns or can manage.
    req.session.guilds = allGuilds
      .filter(hasManagePermission)
      .map(guild => ({
        id: guild.id,
        name: guild.name,
        owner: guild.owner,
        permissions: guild.permissions,
        icon: guild.icon
      }));

    req.session.save(error => {
      if (error) {
        console.error('Session save failed:', error.message);
        return res.status(500).send('Could not save your login session.');
      }

      res.redirect(FRONTEND_URL);
    });
  } catch (error) {
    console.error('OAuth callback:', error.message);
    res.status(500).send(
      'Discord login failed. Check the backend environment settings.'
    );
  }
});

// Current user and dynamically detected bot servers
app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const manageableGuilds = req.session.guilds || [];

    const guilds = manageableGuilds.map(guild => {
      const botGuild = botReady
        ? bot.guilds.cache.get(guild.id)
        : null;

      return {
        id: guild.id,
        name: guild.name,
        owner: guild.owner,
        icon: guild.icon,
        botInstalled: Boolean(botGuild),
        botReady,
        canManage: true
      };
    });

    res.set('Cache-Control', 'no-store');

    res.json({
      user: req.session.user,
      guilds,
      botReady
    });
  } catch (error) {
    console.error('/api/me failed:', error.message);

    res.status(500).json({
      error: 'Could not load your Discord servers.'
    });
  }
});

// Logout
app.post('/api/logout', requireAuth, (req, res) => {
  req.session.destroy(error => {
    if (error) {
      return res.status(500).json({
        error: 'Could not log out.'
      });
    }

    res.clearCookie('ducky.sid', {
      httpOnly: true,
      secure: true,
      sameSite: 'none'
    });

    res.json({ ok: true });
  });
});

// Read module settings
app.get('/api/modules/:module', requireAuth, async (req, res) => {
  try {
    const guildId = String(req.query.guildId || '');

    const guild = await requireManagedBotGuild(req, res, guildId);
    if (!guild) return;

    const result = await db(
      'SELECT config, updated_at FROM dashboard_settings WHERE guild_id=$1 AND module=$2',
      [guildId, req.params.module]
    );

    res.json({
      config: result.rows[0]?.config || {},
      updatedAt: result.rows[0]?.updated_at || null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save module settings
app.put('/api/modules/:module', requireAuth, async (req, res) => {
  try {
    const guildId = String(req.body.guildId || '');

    const guild = await requireManagedBotGuild(req, res, guildId);
    if (!guild) return;

    const config = {
      features: Array.isArray(req.body.features)
        ? req.body.features
        : []
    };

    await db(
      `INSERT INTO dashboard_settings (guild_id, module, config)
       VALUES ($1, $2, $3)
       ON CONFLICT (guild_id, module)
       DO UPDATE SET config=EXCLUDED.config, updated_at=NOW()`,
      [guildId, req.params.module, JSON.stringify(config)]
    );

    res.json({
      ok: true,
      message: 'Saved module configuration.'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save module configuration
app.put('/api/modules/:module/config', requireAuth, async (req, res) => {
  try {
    const guildId = String(req.body.guildId || '');

    const guild = await requireManagedBotGuild(req, res, guildId);
    if (!guild) return;

    const config = {
      channelId: String(req.body.channelId || ''),
      details: String(req.body.details || '').slice(0, 4000)
    };

    await db(
      `INSERT INTO dashboard_settings (guild_id, module, config)
       VALUES ($1, $2, $3)
       ON CONFLICT (guild_id, module)
       DO UPDATE SET config=EXCLUDED.config, updated_at=NOW()`,
      [guildId, req.params.module, JSON.stringify(config)]
    );

    res.json({
      ok: true,
      message: 'Saved configuration.'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Moderation history
app.get('/api/moderation', requireAuth, async (req, res) => {
  try {
    const guildId = String(req.query.guildId || '');

    const guild = await requireManagedBotGuild(req, res, guildId);
    if (!guild) return;

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
      [guildId]
    );

    res.json({ cases: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
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

    const guild = await requireManagedBotGuild(req, res, guildId);
    if (!guild) return;

    if (!['warn', 'timeout', 'kick', 'ban'].includes(action)) {
      return res.status(400).json({ error: 'Unsupported action.' });
    }

    if (!/^\d{17,20}$/.test(String(targetId || ''))) {
      return res.status(400).json({ error: 'Enter a valid Discord user ID.' });
    }

    const member = await guild.members.fetch(String(targetId)).catch(() => null);

    if (action !== 'ban' && !member) {
      return res.status(404).json({
        error: 'Member not found in this server.'
      });
    }

    const why = String(reason || 'No reason provided').slice(0, 500);

    if (action === 'warn') {
      // Record the warning without sending a DM.
    } else if (action === 'timeout') {
      if (!member.moderatable) {
        return res.status(403).json({
          error: 'Bot cannot timeout this member. Check role hierarchy and permissions.'
        });
      }

      const mins = Math.max(1, Math.min(40320, Number(durationMinutes) || 10));
      await member.timeout(mins * 60000, why);
    } else if (action === 'kick') {
      if (!member.kickable) {
        return res.status(403).json({
          error: 'Bot cannot kick this member. Check role hierarchy and permissions.'
        });
      }

      await member.kick(why);
    } else if (action === 'ban') {
      if (member && !member.bannable) {
        return res.status(403).json({
          error: 'Bot cannot ban this member. Check role hierarchy and permissions.'
        });
      }

      await guild.members.ban(String(targetId), { reason: why });
    }

    await db(
      `INSERT INTO moderation_cases
       (guild_id, actor_id, target_id, action, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [String(guildId), req.session.user.id, String(targetId), action, why]
    );

    await db(
      'INSERT INTO server_logs (guild_id, type, message) VALUES ($1, $2, $3)',
      [String(guildId), 'moderation', `${action} ${targetId}: ${why}`]
    );

    res.json({
      ok: true,
      message: action === 'warn'
        ? 'Warning recorded (no DM sent).'
        : `${action} action completed.`
    });
  } catch (error) {
    console.error('Moderation action failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Server logs
app.get('/api/logs', requireAuth, async (req, res) => {
  try {
    const guildId = String(req.query.guildId || '');

    const guild = await requireManagedBotGuild(req, res, guildId);
    if (!guild) return;

    const result = await db(
      `SELECT type,
              message,
              created_at AS "createdAt"
       FROM server_logs
       WHERE guild_id=$1
       ORDER BY id DESC
       LIMIT 100`,
      [guildId]
    );

    res.json({ logs: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// General error handler
app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    error: 'Unexpected server error.'
  });
});

// Start backend
app.listen(PORT, () => {
  console.log(`DUCKY backend listening on ${PORT}`);
});
