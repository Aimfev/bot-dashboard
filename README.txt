DUCKY REAL DASHBOARD - MOBILE/SPCK + BACKEND

IMPORTANT
This is a real full-stack starter, not just a static mockup. It includes a frontend, Express backend, Discord OAuth login, server permission filtering, PostgreSQL/Supabase persistence, real bot moderation actions (when configured), and logs.
Not every MEE6-like module is implemented yet. AutoMod/welcome/levels/tickets/community UI currently saves module configuration; it does not enforce those features automatically. Add those bot handlers before relying on them.

FILES
frontend/index.html, style.css, app.js: edit these in SPCK Editor.
backend/server.js: Node backend + Discord bot
backend/package.json: dependencies
backend/.env.example: required environment variables

SPCK
1. Extract this ZIP.
2. Open the frontend folder as your SPCK project to edit/preview the interface.
3. The frontend alone cannot run Discord login or moderation actions. Deploy the backend separately to Render or another Node.js host.
4. Set the frontend API URL in dashboard Settings after deploying the backend.

BACKEND SETUP
1. Create a Discord application at https://discord.com/developers/applications
2. Create a bot, enable only required intents, invite it with the required permissions (Manage Server, Moderate Members, Kick Members, Ban Members as needed).
3. Set OAuth redirect URI to https://YOUR-BACKEND.onrender.com/auth/discord/callback
4. Create a Supabase project. Use its PostgreSQL connection URI for DATABASE_URL. Do not put the database password or service-role key in frontend files.
5. Deploy the backend folder as a Node web service. Build command: npm install. Start command: npm start.
6. Add all variables from backend/.env.example to the host's environment settings.
7. Set FRONTEND_ORIGIN to the exact published frontend origin. For GitHub Pages, include repository path if applicable, e.g. https://username.github.io/repository.
8. Ensure your host supports HTTPS. Cross-site OAuth session cookies require secure SameSite=None cookies.
9. Open the frontend and enter the deployed backend URL in Settings. Then connect Discord.

ENVIRONMENT VARIABLES
DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI, DISCORD_BOT_TOKEN, SESSION_SECRET, DATABASE_URL, FRONTEND_ORIGIN, PORT, NODE_ENV.

SECURITY NOTES
- Never publish .env or secrets in GitHub.
- This is intended for your own servers. Do not give the bot Administrator permission unless you truly need it.
- Bot role must be above members it moderates.
- Current warn action records a warning but does not DM the target.
- Settings UI is not the same as an active feature: automod, welcome, levels, roles, tickets, and community features require additional bot event/command handlers to execute their saved configs.
