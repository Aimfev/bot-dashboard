require("dotenv").config();
const express=require("express"),cors=require("cors"),crypto=require("crypto");
const{GoogleGenAI}=require("@google/genai");
const{Client,GatewayIntentBits,ActivityType,SlashCommandBuilder,REST,Routes,PermissionFlagsBits,EmbedBuilder,ChannelType}=require("discord.js");
const{Pool}=require("pg");
const app=express();
app.disable("x-powered-by");
app.use(express.json({limit:"1mb"}));
const PORT=process.env.PORT||3000,BOT_TOKEN=process.env.BOT_TOKEN,API_KEY=process.env.DASHBOARD_API_KEY,DATABASE_URL=process.env.DATABASE_URL;
const genAI=process.env.GEMINI_API_KEY?new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY}):null;
const origins=(process.env.FRONTEND_ORIGINS||"https://dashboard.pntr.dev").split(",").map(v=>v.trim());
app.use(cors({origin(origin,cb){if(!origin||origins.includes(origin))return cb(null,true);cb(new Error("Origin not allowed"));},allowedHeaders:["Content-Type","x-dashboard-key"],methods:["GET","PUT","POST","OPTIONS"]}));
const pool=DATABASE_URL?new Pool({connectionString:DATABASE_URL,ssl:{rejectUnauthorized:false}}):null;
const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent]});
let botReady=false,dbReady=false;
let config={presence:"online",activityType:"Playing",activityText:"VEYRON Control",bioNote:"",pronounsNote:"",modules:{}};
const activityTypes={Playing:ActivityType.Playing,Listening:ActivityType.Listening,Watching:ActivityType.Watching,Competing:ActivityType.Competing};
function requireKey(req,res,next){
if(!API_KEY)return res.status(503).json({error:"DASHBOARD_API_KEY is missing in Render."});
const a=Buffer.from(req.get("x-dashboard-key")||""),b=Buffer.from(API_KEY);
if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return res.status(401).json({error:"Invalid dashboard API key."});
next();
}
function statusData(){
const ping=client.ws?.ping;
return{bot:{ready:botReady&&Boolean(client.user),username:client.user?.username||null,guilds:client.guilds.cache.size,ping:Number.isFinite(ping)&&ping>=0?ping:null},database:{connected:dbReady},ai:{configured:Boolean(genAI)}};
}
async function initializeDatabase(){
if(!pool){console.warn("DATABASE_URL missing; configuration will be memory-only.");return;}
await pool.query("CREATE TABLE IF NOT EXISTS veyron_config (config_key TEXT PRIMARY KEY,config_value JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
const r=await pool.query("SELECT config_value FROM veyron_config WHERE config_key=$1",["main"]);
if(r.rows[0]){config={...config,...r.rows[0].config_value};config.modules=config.modules||{};}
else await pool.query("INSERT INTO veyron_config(config_key,config_value) VALUES($1,$2::jsonb)",["main",JSON.stringify(config)]);
dbReady=true;
console.log("PostgreSQL connected.");
}
async function saveConfig(patch){
config={...config,...patch};
config.modules=config.modules||{};
if(pool&&dbReady)await pool.query("INSERT INTO veyron_config(config_key,config_value,updated_at) VALUES($1,$2::jsonb,NOW()) ON CONFLICT(config_key) DO UPDATE SET config_value=EXCLUDED.config_value,updated_at=NOW()",["main",JSON.stringify(config)]);
return config;
}
app.get("/",(_req,res)=>res.json({name:"VEYRON Control API",ok:true}));
app.get("/health",(_req,res)=>res.json({ok:true,status:statusData()}));
app.get("/api/config",requireKey,(_req,res)=>res.json({config,status:statusData()}));
app.put("/api/config",requireKey,async(req,res)=>{
try{
const b=req.body||{},p={};
if(b.modules&&typeof b.modules==="object"&&!Array.isArray(b.modules))p.modules=b.modules;
if(typeof b.bioNote==="string")p.bioNote=b.bioNote.slice(0,500);
if(typeof b.pronounsNote==="string")p.pronounsNote=b.pronounsNote.slice(0,80);
await saveConfig(p);
res.json({ok:true,config,status:statusData()});
}catch(e){console.error("Save config:",e);res.status(500).json({error:"Failed to save configuration."});}
});
app.post("/api/status",requireKey,async(req,res)=>{
try{
const{presence,activityType,bioNote,pronounsNote}=req.body||{},activityText=req.body?.activityText;
if(!["online","idle","dnd","invisible"].includes(presence))return res.status(400).json({error:"Invalid presence."});
if(activityType&&!Object.hasOwn(activityTypes,activityType))return res.status(400).json({error:"Invalid activity type."});
if(typeof activityText==="string"&&activityText.length>128)return res.status(400).json({error:"Activity text too long."});
if(!botReady||!client.user)return res.status(503).json({error:"Bot is not connected."});
const p={presence,activityType:activityType||"Playing",activityText:typeof activityText==="string"?activityText:""};
if(typeof bioNote==="string")p.bioNote=bioNote.slice(0,500);
if(typeof pronounsNote==="string")p.pronounsNote=pronounsNote.slice(0,80);
client.user.setPresence({status:p.presence,activities:p.activityText?[{name:p.activityText,type:activityTypes[p.activityType]}]:[]});
await saveConfig(p);
res.json({ok:true,config,status:statusData()});
}catch(e){console.error("Presence update:",e);res.status(500).json({error:"Failed to update presence."});}
});

const P=PermissionFlagsBits;
const commands=[
new SlashCommandBuilder().setName("say").setDescription("Make VEYRON send a message").addStringOption(o=>o.setName("message").setDescription("Message to send").setRequired(true)),
new SlashCommandBuilder().setName("ping").setDescription("Check bot latency"),
new SlashCommandBuilder().setName("help").setDescription("Show VEYRON commands"),
new SlashCommandBuilder().setName("userinfo").setDescription("Show user information").addUserOption(o=>o.setName("user").setDescription("User to inspect")),
new SlashCommandBuilder().setName("serverinfo").setDescription("Show server information"),
new SlashCommandBuilder().setName("avatar").setDescription("Show a user's avatar").addUserOption(o=>o.setName("user").setDescription("User to view")),
new SlashCommandBuilder().setName("clear").setDescription("Delete recent messages").setDefaultMemberPermissions(P.ManageMessages).addIntegerOption(o=>o.setName("amount").setDescription("Number of messages (1-100)").setMinValue(1).setMaxValue(100).setRequired(true)),
new SlashCommandBuilder().setName("kick").setDescription("Kick a member").setDefaultMemberPermissions(P.KickMembers).addUserOption(o=>o.setName("user").setDescription("Member to kick").setRequired(true)).addStringOption(o=>o.setName("reason").setDescription("Reason")),
new SlashCommandBuilder().setName("ban").setDescription("Ban a member").setDefaultMemberPermissions(P.BanMembers).addUserOption(o=>o.setName("user").setDescription("Member to ban").setRequired(true)).addStringOption(o=>o.setName("reason").setDescription("Reason")),
new SlashCommandBuilder().setName("timeout").setDescription("Timeout a member").setDefaultMemberPermissions(P.ModerateMembers).addUserOption(o=>o.setName("user").setDescription("Member to timeout").setRequired(true)).addIntegerOption(o=>o.setName("minutes").setDescription("Duration in minutes (1-40320)").setMinValue(1).setMaxValue(40320).setRequired(true)).addStringOption(o=>o.setName("reason").setDescription("Reason")),
new SlashCommandBuilder().setName("role").setDescription("Add or remove a role").setDefaultMemberPermissions(P.ManageRoles).addUserOption(o=>o.setName("user").setDescription("Target member").setRequired(true)).addRoleOption(o=>o.setName("role").setDescription("Role to change").setRequired(true)).addStringOption(o=>o.setName("action").setDescription("Add or remove").setRequired(true).addChoices({name:"Add",value:"add"},{name:"Remove",value:"remove"})),
new SlashCommandBuilder().setName("announce").setDescription("Send an announcement").setDefaultMemberPermissions(P.ManageMessages).addChannelOption(o=>o.setName("channel").setDescription("Announcement channel").addChannelTypes(ChannelType.GuildText).setRequired(true)).addStringOption(o=>o.setName("message").setDescription("Announcement text").setRequired(true)),
new SlashCommandBuilder().setName("lock").setDescription("Lock a text channel").setDefaultMemberPermissions(P.ManageChannels).addChannelOption(o=>o.setName("channel").setDescription("Channel to lock").addChannelTypes(ChannelType.GuildText)),
new SlashCommandBuilder().setName("unlock").setDescription("Unlock a text channel").setDefaultMemberPermissions(P.ManageChannels).addChannelOption(o=>o.setName("channel").setDescription("Channel to unlock").addChannelTypes(ChannelType.GuildText)),
new SlashCommandBuilder().setName("8ball").setDescription("Ask the magic 8-ball").addStringOption(o=>o.setName("question").setDescription("Your question").setRequired(true)),
new SlashCommandBuilder().setName("poll").setDescription("Create a reaction poll").addStringOption(o=>o.setName("question").setDescription("Poll question").setRequired(true)).addStringOption(o=>o.setName("option1").setDescription("First option").setRequired(true)).addStringOption(o=>o.setName("option2").setDescription("Second option").setRequired(true)).addStringOption(o=>o.setName("option3").setDescription("Third option (optional)")).addStringOption(o=>o.setName("option4").setDescription("Fourth option (optional)"))
].map(c=>c.toJSON());

async function registerCommands(){
if(!client.user)return;
const rest=new REST({version:"10"}).setToken(BOT_TOKEN),guildId=process.env.DISCORD_GUILD_ID;
const route=guildId?Routes.applicationGuildCommands(client.user.id,guildId):Routes.applicationCommands(client.user.id);
await rest.put(route,{body:commands});
console.log(`Registered ${commands.length} slash commands ${guildId?"for guild "+guildId:"globally"}.`);
}
function can(i,permission){
if(!i.memberPermissions?.has(permission)){i.reply({content:"❌ You don't have permission to use this command.",ephemeral:true}).catch(()=>{});return false;}
return true;
}
async function getMember(i,user){return i.guild.members.fetch(user.id).catch(()=>null);}

const aiCooldown=new Map();
client.on("messageCreate",async m=>{
if(m.author.bot||!m.guild||!genAI||!client.user)return;
const content=m.content.trim();
if(!content||content.length>2000)return;
const mentioned=m.mentions.has(client.user);
const startsWithBot=content.toLowerCase().startsWith("veyron,");
if(!mentioned&&!startsWithBot)return;
const now=Date.now(),last=aiCooldown.get(m.author.id)||0;
if(now-last<5000)return;
aiCooldown.set(m.author.id,now);
try{
await m.channel.sendTyping();
const prompt=content.replace(new RegExp(`<@!?${client.user.id}>`,"g"),"").replace(/^veyron,\s*/i,"").trim();
if(!prompt)return;
const response=await genAI.models.generateContent({
model:process.env.GEMINI_MODEL||"gemini-3.8-flash",
contents:prompt,
config:{
systemInstruction:"You are VEYRON, a helpful, friendly Discord server AI assistant. Reply naturally and concisely. Follow Discord formatting conventions. Do not claim to have permissions or perform actions you have not performed.",
maxOutputTokens:500
}
});
const answer=response.text?.trim();
if(answer)await m.reply({content:answer.slice(0,2000),allowedMentions:{repliedUser:false}});
else await m.reply("I couldn't generate a response. Please try again.").catch(()=>{});
}catch(e){
console.error("Gemini reply failed:",e?.message||e);
await m.reply("AI is temporarily unavailable. Please try again shortly.").catch(()=>{});
}
});

client.on("interactionCreate",async i=>{
if(!i.isChatInputCommand())return;
try{
const name=i.commandName;
if(name==="ping")return i.reply(`🏓 Pong! WebSocket: ${Math.round(client.ws.ping)}ms`);
if(name==="help"){
const e=new EmbedBuilder().setColor(0x35d07f).setTitle("VEYRON Commands").setDescription("General\n/say · /ping · /help · /userinfo · /serverinfo · /avatar · /8ball · /poll\n\nModeration\n/clear · /kick · /ban · /timeout · /role · /announce · /lock · /unlock\n\nAI\nMention @VEYRON or start a message with Veyron,\n\nModeration commands require the appropriate permissions.");
return i.reply({embeds:[e],ephemeral:true});
}
if(name==="say"){
const message=i.options.getString("message",true);
if(message.length>2000)return i.reply({content:"Message too long (max 2000 characters).",ephemeral:true});
await i.reply({content:"✅ Message sent.",ephemeral:true});
return i.channel.send({content:message,allowedMentions:{parse:[]}});
}
if(name==="userinfo"){
const u=i.options.getUser("user")||i.user,member=i.guild?await getMember(i,u):null;
const e=new EmbedBuilder().setColor(0x35d07f).setTitle(`User Information: ${u.username}`).setThumbnail(u.displayAvatarURL({size:256})).addFields({name:"Username",value:u.tag||u.username,inline:true},{name:"User ID",value:u.id,inline:true},{name:"Account Created",value:`<t:${Math.floor(u.createdTimestamp/1000)}:F>`});
if(member?.joinedTimestamp)e.addFields({name:"Joined Server",value:`<t:${Math.floor(member.joinedTimestamp/1000)}:F>`});
return i.reply({embeds:[e]});
}
if(name==="serverinfo"){
if(!i.guild)return i.reply({content:"Use this command in a server.",ephemeral:true});
const g=i.guild,e=new EmbedBuilder().setColor(0x35d07f).setTitle(g.name).setThumbnail(g.iconURL({size:256})).addFields({name:"Server ID",value:g.id,inline:true},{name:"Members",value:String(g.memberCount),inline:true},{name:"Created",value:`<t:${Math.floor(g.createdTimestamp/1000)}:D>`,inline:true},{name:"Channels",value:String(g.channels.cache.size),inline:true},{name:"Roles",value:String(g.roles.cache.size),inline:true});
return i.reply({embeds:[e]});
}
if(name==="avatar"){
const u=i.options.getUser("user")||i.user,url=u.displayAvatarURL({size:1024,extension:"png"});
return i.reply({embeds:[new EmbedBuilder().setColor(0x35d07f).setTitle(`${u.username}'s Avatar`).setImage(url).setURL(url)]});
}
if(name==="8ball"){
const answers=["It is certain.","Without a doubt.","Most likely.","Yes!","Signs point to yes.","Ask again later.","Cannot predict now.","Reply hazy, try again.","Don't count on it.","Very unlikely.","My answer is no.","Absolutely not."];
return i.reply(`🎱 **${answers[Math.floor(Math.random()*answers.length)]}**`);
}
if(name==="poll"){
const q=i.options.getString("question",true),opts=[1,2,3,4].map(n=>i.options.getString(`option${n}`)).filter(Boolean);
if(opts.length<2)return i.reply({content:"Provide at least two options.",ephemeral:true});
const emojis=["1️⃣","2️⃣","3️⃣","4️⃣"],e=new EmbedBuilder().setColor(0x35d07f).setTitle("📊 "+q).setDescription(opts.map((v,n)=>`${emojis[n]} ${v}`).join("\n")).setFooter({text:`Poll by ${i.user.username}`});
await i.reply({content:"Poll created!",ephemeral:true});
const msg=await i.channel.send({embeds:[e]});
for(let n=0;n<opts.length;n++)await msg.react(emojis[n]);
return;
}
if(name==="clear"){
if(!can(i,P.ManageMessages))return;
if(!i.guild.members.me.permissions.has(P.ManageMessages))return i.reply({content:"Bot needs Manage Messages permission.",ephemeral:true});
await i.deferReply({ephemeral:true});
const deleted=await i.channel.bulkDelete(i.options.getInteger("amount",true),true);
return i.editReply(`🧹 Deleted ${deleted.size} message(s). Messages older than 14 days cannot be bulk-deleted.`);
}
if(["kick","ban","timeout"].includes(name)){
const perm=name==="kick"?P.KickMembers:name==="ban"?P.BanMembers:P.ModerateMembers;
if(!can(i,perm))return;
const user=i.options.getUser("user",true),reason=i.options.getString("reason")||`Action by ${i.user.tag}`;
if(user.id===i.user.id||user.id===client.user.id)return i.reply({content:"You cannot target yourself or the bot.",ephemeral:true});
const member=await getMember(i,user);
if(!member)return i.reply({content:"That user is not a member of this server.",ephemeral:true});
if(!member.manageable)return i.reply({content:"That member's role is too high for the bot.",ephemeral:true});
if(name==="kick")await member.kick(reason);
if(name==="ban")await member.ban({reason});
if(name==="timeout")await member.timeout(i.options.getInteger("minutes",true)*60000,reason);
return i.reply(`✅ ${user.tag} ${name==="timeout"?"timed out":name==="ban"?"banned":"kicked"} successfully. Reason: ${reason}`);
}
if(name==="role"){
if(!can(i,P.ManageRoles))return;
const user=i.options.getUser("user",true),role=i.options.getRole("role",true),action=i.options.getString("action",true),member=await getMember(i,user),me=i.guild.members.me;
if(!member)return i.reply({content:"Member not found.",ephemeral:true});
if(role.managed||role.position>=me.roles.highest.position)return i.reply({content:"The bot cannot manage that role. Check role hierarchy.",ephemeral:true});
if(member.id===i.guild.ownerId)return i.reply({content:"Cannot modify the server owner's roles.",ephemeral:true});
if(action==="add")await member.roles.add(role);else await member.roles.remove(role);
return i.reply(`✅ ${action==="add"?"Added":"Removed"} ${role} ${action==="add"?"to":"from"} ${user.tag}.`);
}
if(name==="announce"){
if(!can(i,P.ManageMessages))return;
const channel=i.options.getChannel("channel",true),message=i.options.getString("message",true);
if(!channel.isTextBased()||!channel.send)return i.reply({content:"Choose a text channel.",ephemeral:true});
await i.deferReply({ephemeral:true});
await channel.send({content:message,allowedMentions:{parse:[]}});
return i.editReply(`📢 Announcement sent to ${channel}.`);
}
if(name==="lock"||name==="unlock"){
if(!can(i,P.ManageChannels))return;
const channel=i.options.getChannel("channel")||i.channel;
if(!channel?.isTextBased()||!channel.permissionOverwrites)return i.reply({content:"Choose a text channel.",ephemeral:true});
await i.deferReply({ephemeral:true});
await channel.permissionOverwrites.edit(i.guild.roles.everyone,{SendMessages:name==="lock"?false:null});
return i.editReply(`${name==="lock"?"🔒 Locked":"🔓 Unlocked"} ${channel}.`);
}
}catch(e){
console.error(`/${i.commandName} failed:`,e);
const msg={content:"❌ Command failed. Check bot permissions, role hierarchy, and channel access.",ephemeral:true};
if(i.deferred||i.replied)await i.followUp(msg).catch(()=>{});
else await i.reply(msg).catch(()=>{});
}
});

client.once("ready",async()=>{
botReady=true;
console.log(`Connected as ${client.user.tag}`);
const type=activityTypes[config.activityType]??ActivityType.Playing;
client.user.setPresence({status:config.presence||"online",activities:config.activityText?[{name:config.activityText,type}]:[]});
try{await registerCommands();}catch(e){console.error("Slash command registration failed:",e);}
});
client.on("error",e=>console.error("Discord client error:",e));
client.on("shardDisconnect",()=>{botReady=false;});
client.on("shardReady",()=>{botReady=true;});

async function start(){
try{await initializeDatabase();}catch(e){dbReady=false;console.error("Database connection failed:",e.message);}
if(!BOT_TOKEN)console.error("BOT_TOKEN is missing from Render.");
else client.login(BOT_TOKEN).catch(e=>console.error("Discord login failed:",e.message));
app.listen(PORT,()=>console.log(`VEYRON Control API listening on ${PORT}`));
}
process.on("SIGTERM",async()=>{
try{await client.destroy();}catch{}
try{if(pool)await pool.end();}catch{}
process.exit(0);
});
start();