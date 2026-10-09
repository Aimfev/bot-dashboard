
require('dotenv').config();

const express=require('express');
const cors=require('cors');
const helmet=require('helmet');
const session=require('express-session');
const {Pool}=require('pg');
const {Client,GatewayIntentBits,PermissionFlagsBits}=require('discord.js');

const app=express();
const PORT=process.env.PORT||3000;
const FRONTEND=(process.env.FRONTEND_ORIGIN||'http://localhost:5500').replace(/\/$/,'');

app.set('trust proxy',1);
app.use(helmet({crossOriginResourcePolicy:false}));
app.use(cors({origin:FRONTEND,credentials:true}));
app.use(express.json({limit:'100kb'}));

app.use(session({
name:'ducky.sid',
secret:process.env.SESSION_SECRET||'dev-only-change-this-secret',
resave:false,
saveUninitialized:false,
cookie:{
httpOnly:true,
secure:process.env.NODE_ENV==='production',
sameSite:'none',
maxAge:7*24*60*60*1000
}
}));

const pool=process.env.DATABASE_URL
?new Pool({
connectionString:process.env.DATABASE_URL,
ssl:process.env.DATABASE_URL.includes('localhost')
?false
:{rejectUnauthorized:false}
})
:null;

let bot=null;
let botReady=false;

if(process.env.DISCORD_BOT_TOKEN){
bot=new Client({
intents:[
GatewayIntentBits.Guilds,
GatewayIntentBits.GuildMembers,
GatewayIntentBits.GuildMessages,
GatewayIntentBits.MessageContent
]
});

bot.once('ready',()=>{
botReady=true;
console.log(`DUCKY bot online as ${bot.user.tag}`);
});

bot.on('error',e=>console.error('Discord bot error:',e.message));

bot.login(process.env.DISCORD_BOT_TOKEN)
.catch(e=>console.error('Bot login failed:',e.message));
}

const schema=`
CREATE TABLE IF NOT EXISTS dashboard_settings (
guild_id TEXT NOT NULL,
module TEXT NOT NULL,
config JSONB NOT NULL DEFAULT '{}'::jsonb,
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
PRIMARY KEY(guild_id,module)
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

async function db(sql,args=[]){
if(!pool)throw new Error('Database is not configured. Set DATABASE_URL in backend environment.');
return pool.query(sql,args);
}

async function init(){
if(pool){
try{
await pool.query(schema);
console.log('Database tables checked');
}catch(e){
console.error('Database init failed:',e.message);
}
}
}

init();

function requireAuth(req,res,next){
if(!req.session.user)return res.status(401).json({error:'Connect Discord first.'});
next();
}

function canManage(req,guildId){
return (req.session.guilds||[]).some(g=>
g.id===String(guildId)&&
(g.owner||((BigInt(g.permissions||'0')&BigInt(0x20))===BigInt(0x20)))
);
}

app.get('/health',(req,res)=>{
res.json({
ok:true,
botReady,
dbConfigured:!!pool,
service:'DUCKY API'
});
});

app.get('/auth/discord/url',(req,res)=>{
if(!process.env.DISCORD_CLIENT_ID||!process.env.DISCORD_REDIRECT_URI){
return res.status(503).json({
error:'Set DISCORD_CLIENT_ID and DISCORD_REDIRECT_URI in backend environment.'
});
}

const url=new URL('https://discord.com/oauth2/authorize');
url.searchParams.set('client_id',process.env.DISCORD_CLIENT_ID);
url.searchParams.set('redirect_uri',process.env.DISCORD_REDIRECT_URI);
url.searchParams.set('response_type','code');
url.searchParams.set('scope','identify guilds');

res.json({url:url.toString()});
});

app.get('/auth/discord/callback',async(req,res)=>{
try{
const code=req.query.code;

if(!code)return res.redirect(FRONTEND+'?login=cancelled');

const tokenRes=await fetch('https://discord.com/api/oauth2/token',{
method:'POST',
headers:{
'Content-Type':'application/x-www-form-urlencoded'
},
body:new URLSearchParams({
client_id:process.env.DISCORD_CLIENT_ID,
client_secret:process.env.DISCORD_CLIENT_SECRET,
grant_type:'authorization_code',
code,
redirect_uri:process.env.DISCORD_REDIRECT_URI
})
});

const token=await tokenRes.json();

if(!token.access_token){
console.error(
'OAuth token exchange failed:',
tokenRes.status,
token.error||'unknown error',
token.error_description||''
);
throw new Error(token.error_description||token.error||'OAuth token exchange failed');
}

const headers={
Authorization:`Bearer ${token.access_token}`
};

const [u,g]=await Promise.all([
fetch('https://discord.com/api/users/@me',{headers}),
fetch('https://discord.com/api/users/@me/guilds',{headers})
]);

const user=await u.json();
const allGuilds=await g.json();

if(!user.id||!Array.isArray(allGuilds)){
throw new Error('Could not read Discord account or servers');
}

req.session.user={
id:user.id,
username:user.global_name||user.username,
avatar:user.avatar
?`https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
:null
};

req.session.guilds=allGuilds
.filter(x=>x.owner||((BigInt(x.permissions||'0')&BigInt(0x20))===BigInt(0x20)))
.map(x=>({
id:x.id,
name:x.name,
owner:x.owner,
permissions:x.permissions,
icon:x.icon
}));

req.session.save(err=>{
if(err){
console.error('Session save failed:',err.message);
return res.status(500).send('Could not save Discord login session.');
}
res.redirect(FRONTEND);
});

}catch(e){
console.error('OAuth callback:',e.message);
res.status(500).send('Discord login failed. Return to the dashboard and check the backend environment settings.');
}
});

app.get('/api/me',requireAuth,(req,res)=>{
res.json({
user:req.session.user,
guilds:req.session.guilds||[]
});
});

app.post('/api/logout',requireAuth,(req,res)=>{
req.session.destroy(()=>res.json({ok:true}));
});

app.get('/api/modules/:module',requireAuth,async(req,res)=>{
try{
const guildId=String(req.query.guildId||'');

if(!canManage(req,guildId)){
return res.status(403).json({
error:'You need Manage Server permission for this server.'
});
}

const r=await db(
'SELECT config,updated_at FROM dashboard_settings WHERE guild_id=$1 AND module=$2',
[guildId,req.params.module]
);

res.json({
config:r.rows[0]?.config||{},
updatedAt:r.rows[0]?.updated_at||null
});

}catch(e){
res.status(500).json({error:e.message});
}
});

app.put('/api/modules/:module',requireAuth,async(req,res)=>{
try{
const guildId=String(req.body.guildId||'');

if(!canManage(req,guildId)){
return res.status(403).json({
error:'You need Manage Server permission for this server.'
});
}

const config={
features:Array.isArray(req.body.features)?req.body.features:[]
};

await db(
'INSERT INTO dashboard_settings(guild_id,module,config) VALUES($1,$2,$3) ON CONFLICT(guild_id,module) DO UPDATE SET config=EXCLUDED.config,updated_at=NOW()',
[guildId,req.params.module,JSON.stringify(config)]
);

res.json({ok:true,message:'Saved module configuration.'});

}catch(e){
res.status(500).json({error:e.message});
}
});

app.put('/api/modules/:module/config',requireAuth,async(req,res)=>{
try{
const guildId=String(req.body.guildId||'');

if(!canManage(req,guildId)){
return res.status(403).json({
error:'You need Manage Server permission for this server.'
});
}

const config={
channelId:String(req.body.channelId||''),
details:String(req.body.details||'').slice(0,4000)
};

await db(
'INSERT INTO dashboard_settings(guild_id,module,config) VALUES($1,$2,$3) ON CONFLICT(guild_id,module) DO UPDATE SET config=EXCLUDED.config,updated_at=NOW()',
[guildId,req.params.module,JSON.stringify(config)]
);

res.json({ok:true,message:'Saved configuration.'});

}catch(e){
res.status(500).json({error:e.message});
}
});

app.get('/api/moderation',requireAuth,async(req,res)=>{
try{
const guildId=String(req.query.guildId||'');

if(!canManage(req,guildId)){
return res.status(403).json({
error:'You need Manage Server permission.'
});
}

const r=await db(
'SELECT id,actor_id AS "actorId",target_id AS "targetId",action,reason,created_at AS "createdAt" FROM moderation_cases WHERE guild_id=$1 ORDER BY id DESC LIMIT 100',
[guildId]
);

res.json({cases:r.rows});

}catch(e){
res.status(500).json({error:e.message});
}
});

app.post('/api/moderation',requireAuth,async(req,res)=>{
try{
const {guildId,action,targetId,reason,durationMinutes}=req.body;

if(!canManage(req,guildId)){
return res.status(403).json({
error:'You need Manage Server permission.'
});
}

if(!['warn','timeout','kick','ban'].includes(action)){
return res.status(400).json({error:'Unsupported action.'});
}

if(!/^\d{17,20}$/.test(String(targetId||''))){
return res.status(400).json({error:'Enter a valid Discord user ID.'});
}

if(!bot||!botReady){
return res.status(503).json({
error:'The Discord bot is not online. Configure DISCORD_BOT_TOKEN.'
});
}

const guild=await bot.guilds.fetch(String(guildId));
const member=await guild.members.fetch(String(targetId)).catch(()=>null);

if(action!=='ban'&&!member){
return res.status(404).json({error:'Member not found in this server.'});
}

const why=String(reason||'No reason provided').slice(0,500);

if(action==='warn'){
// Warning is recorded only; no DM is sent.
}else if(action==='timeout'){
if(!member.moderatable){
return res.status(403).json({
error:'Bot cannot timeout this member. Check permissions and role hierarchy.'
});
}

const mins=Math.max(1,Math.min(40320,Number(durationMinutes)||10));
await member.timeout(mins*60000,why);

}else if(action==='kick'){
if(!member.kickable){
return res.status(403).json({
error:'Bot cannot kick this member. Check permissions and role hierarchy.'
});
}

await member.kick(why);

}else if(action==='ban'){
const target=member||String(targetId);

if(member&&!member.bannable){
return res.status(403).json({
error:'Bot cannot ban this member. Check permissions and role hierarchy.'
});
}

await guild.members.ban(target,{reason:why});
}

await db(
'INSERT INTO moderation_cases(guild_id,actor_id,target_id,action,reason) VALUES($1,$2,$3,$4,$5)',
[String(guildId),req.session.user.id,String(targetId),action,why]
);

await db(
'INSERT INTO server_logs(guild_id,type,message) VALUES($1,$2,$3)',
[String(guildId),'moderation',`${action} ${targetId}: ${why}`]
);

res.json({
ok:true,
message:action==='warn'
?'Warning recorded (no DM sent).'
:`${action} action completed.`
});

}catch(e){
console.error('Moderation action failed:',e.message);
res.status(500).json({error:e.message});
}
});

app.get('/api/logs',requireAuth,async(req,res)=>{
try{
const guildId=String(req.query.guildId||'');

if(!canManage(req,guildId)){
return res.status(403).json({
error:'You need Manage Server permission.'
});
}

const r=await db(
'SELECT type,message,created_at AS "createdAt" FROM server_logs WHERE guild_id=$1 ORDER BY id DESC LIMIT 100',
[guildId]
);

res.json({logs:r.rows});

}catch(e){
res.status(500).json({error:e.message});
}
});

app.use((err,req,res,next)=>{
console.error(err);
res.status(500).json({error:'Unexpected server error.'});
});

app.listen(PORT,()=>{
console.log(`DUCKY backend listening on ${PORT}`);
});
