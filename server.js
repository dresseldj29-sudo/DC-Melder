require("dotenv").config();
const express=require("express"), session=require("express-session"), helmet=require("helmet");
const Database=require("better-sqlite3");
const {Client,GatewayIntentBits,EmbedBuilder}=require("discord.js");
const crypto=require("crypto"), path=require("path"), fs=require("fs");
const app=express();
const required=["DISCORD_CLIENT_ID","DISCORD_CLIENT_SECRET","DISCORD_BOT_TOKEN","DISCORD_GUILD_ID","ALLOWED_ROLE_IDS","SESSION_SECRET","FRONTEND_URL","PUBLIC_BASE_URL"];
const missing=required.filter(k=>!process.env[k]);
if(missing.length){console.error("Missing env vars:",missing.join(", "));process.exit(1)}
const PORT=Number(process.env.PORT||3000), FRONTEND=process.env.FRONTEND_URL.replace(/\/$/,""), BASE=process.env.PUBLIC_BASE_URL.replace(/\/$/,"");
const allowedRoles=new Set(process.env.ALLOWED_ROLE_IDS.split(",").map(s=>s.trim()).filter(Boolean));
let testMode=(process.env.TEST_MODE||"true").toLowerCase()!=="false";
const dbPath=process.env.DB_PATH||"./data/freiburg.sqlite";fs.mkdirSync(path.dirname(path.resolve(dbPath)),{recursive:true});
const db=new Database(dbPath);db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS alarms(id TEXT PRIMARY KEY, keyword TEXT NOT NULL, address TEXT NOT NULL, postalCode TEXT, description TEXT, groupsJson TEXT, test INTEGER NOT NULL, status TEXT NOT NULL, createdAt TEXT NOT NULL, closedAt TEXT, createdBy TEXT NOT NULL, lat REAL, lng REAL);
CREATE TABLE IF NOT EXISTS responses(id INTEGER PRIMARY KEY AUTOINCREMENT, alarmId TEXT NOT NULL, userId TEXT NOT NULL, username TEXT NOT NULL, status TEXT NOT NULL, createdAt TEXT NOT NULL);`);
app.set("trust proxy",1);app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:"30kb"}));
app.use((req,res,next)=>{res.setHeader("Access-Control-Allow-Origin",FRONTEND);res.setHeader("Access-Control-Allow-Credentials","true");res.setHeader("Vary","Origin");res.setHeader("Access-Control-Allow-Headers","Content-Type");res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");if(req.method==="OPTIONS")return res.sendStatus(204);next()});
app.use(session({name:"fme.sid",secret:process.env.SESSION_SECRET,resave:false,saveUninitialized:false,cookie:{httpOnly:true,secure:true,sameSite:"none",maxAge:8*60*60*1000}}));
const bot=new Client({intents:[GatewayIntentBits.Guilds]});
bot.once("ready",()=>console.log(`Discord bot online as ${bot.user.tag}`));
bot.login(process.env.DISCORD_BOT_TOKEN).catch(e=>console.error("Bot login failed",e.message));
function userRequired(req,res,next){if(!req.session.user)return res.status(401).json({error:"Bitte mit Discord anmelden."});next()}
async function getGuildMember(userId){const guild=await bot.guilds.fetch(process.env.DISCORD_GUILD_ID);return await guild.members.fetch(userId)}
async function managerRequired(req,res,next){
 try{
  if(!req.session.user)return res.status(401).json({error:"Bitte mit Discord anmelden."});
  const member=await getGuildMember(req.session.user.id);
  if(!member.roles.cache.some(r=>allowedRoles.has(r.id)))return res.status(403).json({error:"Deine Discord-Rolle ist für diese Aktion nicht freigeschaltet."});
  req.isManager=true;next();
 }catch(e){console.error("Permission check failed",e.message);res.status(403).json({error:"Servermitgliedschaft oder Berechtigung konnte nicht bestätigt werden."})}
}
function makeState(){return crypto.randomBytes(24).toString("hex")}
app.get("/api/health",(req,res)=>res.json({ok:true,service:"freiburg-v2-fme"}));
app.get("/auth/login",(req,res)=>{const state=makeState();req.session.oauthState=state;const u=new URL("https://discord.com/oauth2/authorize");u.searchParams.set("client_id",process.env.DISCORD_CLIENT_ID);u.searchParams.set("redirect_uri",BASE+"/auth/callback");u.searchParams.set("response_type","code");u.searchParams.set("scope","identify guilds.members.read");u.searchParams.set("state",state);res.redirect(u.toString())});
app.get("/auth/callback",async(req,res)=>{
 try{
  if(!req.query.code||!req.query.state||req.query.state!==req.session.oauthState)return res.status(400).send("OAuth state invalid. Bitte erneut anmelden.");
  delete req.session.oauthState;
  const body=new URLSearchParams({client_id:process.env.DISCORD_CLIENT_ID,client_secret:process.env.DISCORD_CLIENT_SECRET,grant_type:"authorization_code",code:String(req.query.code),redirect_uri:BASE+"/auth/callback"});
  const tokenRes=await fetch("https://discord.com/api/oauth2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});
  if(!tokenRes.ok)throw new Error("Discord token exchange failed");
  const token=await tokenRes.json();
  const meRes=await fetch("https://discord.com/api/users/@me",{headers:{Authorization:`Bearer ${token.access_token}`}});
  if(!meRes.ok)throw new Error("Discord profile fetch failed");
  const me=await meRes.json();
  // Membership check is performed server-side; OAuth identity alone is insufficient.
  await getGuildMember(me.id);
  req.session.regenerate(err=>{if(err)return res.status(500).send("Session error");req.session.user={id:me.id,username:me.global_name||me.username,avatar:me.avatar||null};req.session.save(()=>res.redirect(FRONTEND))});
 }catch(e){console.error("OAuth callback:",e.message);res.status(403).send("Discord-Anmeldung oder Servermitgliedschaft fehlgeschlagen. Bitte prüfe Server und OAuth-Konfiguration.")}});
app.post("/auth/logout",userRequired,(req,res)=>req.session.destroy(()=>{res.clearCookie("fme.sid",{httpOnly:true,secure:true,sameSite:"none"});res.json({ok:true})}));
app.get("/api/me",userRequired,(req,res)=>res.json({user:req.session.user}));
app.get("/api/mode",userRequired,(req,res)=>res.json({testMode}));
app.post("/api/mode",managerRequired,(req,res)=>{if(typeof req.body.testMode!=="boolean")return res.status(400).json({error:"testMode muss true/false sein"});testMode=req.body.testMode;res.json({testMode})});
function hydrate(row){
 const responses=db.prepare("SELECT userId,username,status,createdAt FROM responses WHERE alarmId=? ORDER BY id").all(row.id);
 return {...row,groups:JSON.parse(row.groupsJson||"[]"),test:!!row.test,responses};
}
app.get("/api/alarms",userRequired,(req,res)=>{const rows=db.prepare("SELECT * FROM alarms WHERE status!='geschlossen' ORDER BY createdAt DESC LIMIT 100").all();res.json({alarms:rows.map(hydrate)})});
app.get("/api/history",userRequired,(req,res)=>{const rows=db.prepare("SELECT * FROM alarms WHERE status='geschlossen' ORDER BY closedAt DESC LIMIT 200").all();res.json({alarms:rows.map(hydrate)})});
app.post("/api/alarms",managerRequired,async(req,res)=>{
 const {keyword,address,postalCode="",description="",groups=[],test=false,lat="",lng=""}=req.body||{};
 if(typeof keyword!=="string"||!keyword.trim()||typeof address!=="string"||!address.trim())return res.status(400).json({error:"Stichwort und Adresse sind erforderlich."});
 if(keyword.length>100||address.length>180||String(description).length>1000||!Array.isArray(groups)||groups.length>12)return res.status(400).json({error:"Eingaben überschreiten die erlaubten Grenzen."});
 const latNum=lat===""?null:Number(lat), lngNum=lng===""?null:Number(lng);
 if((latNum!==null&&(!Number.isFinite(latNum)||latNum < -90||latNum > 90))||(lngNum!==null&&(!Number.isFinite(lngNum)||lngNum < -180||lngNum > 180))||((latNum===null)!==(lngNum===null)))return res.status(400).json({error:"Breiten- und Längengrad müssen beide gültig angegeben werden."});
 const isTest=testMode||test===true;const id=crypto.randomUUID(),createdAt=new Date().toISOString();
 db.prepare("INSERT INTO alarms(id,keyword,address,postalCode,description,groupsJson,test,status,createdAt,createdBy,lat,lng) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(id,keyword.trim(),address.trim(),String(postalCode).slice(0,12),String(description).slice(0,1000),JSON.stringify(groups.map(x=>String(x).slice(0,60))),isTest?1:0,"offen",createdAt,req.session.user.id,latNum,lngNum);
 const row=db.prepare("SELECT * FROM alarms WHERE id=?").get(id);
 if(!isTest && process.env.DISCORD_ALERT_CHANNEL_ID){
  try{const ch=await bot.channels.fetch(process.env.DISCORD_ALERT_CHANNEL_ID);if(!ch||!ch.isTextBased())throw new Error("Target channel unavailable");
   const embed=new EmbedBuilder().setTitle(`🚨 ${keyword.trim()}`).setDescription(String(description||"Keine Zusatzinformationen").slice(0,4000)).addFields({name:"Adresse",value:address.trim().slice(0,1024)},{name:"Postleitzahl",value:String(postalCode||"—").slice(0,1024),inline:true},{name:"Gruppen",value:(groups.join(", ")||"Keine").slice(0,1024),inline:true}).setFooter({text:"Freiburg V2 · RP-interner Alarm"}).setTimestamp(new Date());
   await ch.send({embeds:[embed]});
  }catch(e){console.error("Discord send failed:",e.message);return res.status(502).json({error:"Alarm gespeichert, aber Discord-Nachricht konnte nicht gesendet werden. Bitte Leitstelle informieren."})}
 }
 res.status(201).json({alarm:hydrate(row)});
});
app.post("/api/alarms/:id/responses",userRequired,(req,res)=>{
 const status=String(req.body?.status||"").trim();if(!status||status.length>120)return res.status(400).json({error:"Rückmeldung fehlt oder ist zu lang."});
 const row=db.prepare("SELECT id FROM alarms WHERE id=? AND status!='geschlossen'").get(req.params.id);if(!row)return res.status(404).json({error:"Aktiver Alarm nicht gefunden."});
 db.prepare("INSERT INTO responses(alarmId,userId,username,status,createdAt) VALUES(?,?,?,?,?)").run(row.id,req.session.user.id,req.session.user.username,status,new Date().toISOString());res.json({ok:true});
});
app.post("/api/alarms/:id/close",managerRequired,(req,res)=>{
 const result=db.prepare("UPDATE alarms SET status='geschlossen',closedAt=? WHERE id=? AND status!='geschlossen'").run(new Date().toISOString(),req.params.id);
 if(!result.changes)return res.status(404).json({error:"Aktiver Alarm nicht gefunden."});res.json({ok:true});
});
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:"Interner Serverfehler."})});
app.listen(PORT,()=>console.log(`Freiburg V2 FME backend listening on ${PORT}`));
