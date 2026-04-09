const express = require('express');
const app = express();
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

app.use(express.json());
app.use(express.text({ type: '*/*' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-internal-key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const AIRCALL_API_ID    = '6fc70e4e7cbd62083547e0a79612b161';
const AIRCALL_API_TOKEN = 'f86b32f5db4d2f2808eb554f01812be5';
const WINDSOR_API_KEY   = '6ae9cb5c4bdcf3caf35b3bae60ca63736e00';
const WINDSOR_ACCOUNT   = '824-247-6325';
const AIRCALL_BASE_URL  = 'https://api.aircall.io/v1';
const preCallStore = new Map();
const windsorQueue = [];
const knownGclids  = new Set();
let lastWindsorPoll = 0;

setInterval(() => {
  const limit = Date.now() - 5*60*1000;
  for (const [k,v] of preCallStore) if (v.ts < limit) preCallStore.delete(k);
}, 60000);

async function pollWindsor() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const filters = encodeURIComponent(JSON.stringify([["click_type","eq","CALLS"],"and",["adgroup","notnull",null]]));
    const url = "https://connectors.windsor.ai/google_ads?api_key="+WINDSOR_API_KEY+"&date_from="+today+"&date_to="+today+"&fields=click_view_gclid,campaign,adgroup,click_type&filters="+filters+"&accounts="+encodeURIComponent(JSON.stringify([WINDSOR_ACCOUNT]));
    const res = await fetch(url);
    if (!res.ok) return;
    const json = await res.json();
    const data = Array.isArray(json) ? json : (json.data || []);
    for (const row of data) {
      const gclid = row.click_view_gclid || row.gclid;
      if (!gclid || knownGclids.has(gclid)) continue;
      knownGclids.add(gclid);
      windsorQueue.push({ gclid, campaign: row.campaign||null, adgroup: row.adgroup||null, keyword: null, ts: Date.now(), source: 'windsor' });
    }
    lastWindsorPoll = Date.now();
  } catch(e) {}
}
pollWindsor();
setInterval(pollWindsor, 2*60*1000);

app.get('/pre-call-pixel', (req, res) => {
  try {
    const entry = { gclid: req.query.gclid||null, campaign: req.query.campaign||null, adgroup: req.query.adgroup||null, keyword: req.query.keyword||null, ts: Date.now(), source: 'pixel' };
    if (entry.campaign || entry.gclid) { if (entry.gclid) preCallStore.set('gclid_'+entry.gclid, entry); preCallStore.set('last', entry); }
  } catch(e) {}
  res.set('Content-Type','image/gif');
  res.send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64'));
});

app.post('/pre-call', (req, res) => {
  try {
    const data = JSON.parse(typeof req.body==='string'?req.body:JSON.stringify(req.body));
    if (!data.campaign && !data.adgroup && !data.gclid) return res.sendStatus(200);
    const entry = { gclid: data.gclid||null, campaign: data.campaign||null, adgroup: data.adgroup||null, keyword: data.keyword||null, ts: Date.now(), source: 'post' };
    if (data.gclid) preCallStore.set('gclid_'+data.gclid, entry);
    preCallStore.set('last', entry);
    res.sendStatus(200);
  } catch(e) { res.sendStatus(400); }
});

app.post('/aircall-webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const { event, data } = req.body;
    if (!data || event !== 'call.created' || data.direction !== 'inbound') return;
    let tracking = null;
    const limit3 = Date.now() - 3*60*1000;
    for (const [k,v] of preCallStore) { if (v.ts > limit3 && (v.campaign||v.adgroup)) { if (!tracking || v.ts > tracking.ts) tracking = v; } }
    if (tracking) preCallStore.delete('last');
    if (!tracking && windsorQueue.length > 0) tracking = windsorQueue.shift();
    if (!tracking) return;
    await sendInsightCard(data.id, tracking);
  } catch(e) {}
});

async function sendInsightCard(callId, tracking) {
  const adgroup = formatLabel(tracking.adgroup);
  const product = detectProduct(tracking.campaign, tracking.adgroup);
  const campaign = (tracking.campaign||'-').replace(/#/g,'N°').substring(0,28);
  const card = { contents: [
    { type:'title', text: adgroup },
    { type:'shortText', label:'Compagnie', text: adgroup },
    { type:'shortText', label:'Produit', text: product },
    { type:'shortText', label:'Campagne', text: campaign },
    { type:'shortText', label:'Mot-cle', text: (tracking.keyword||'non renseigne').substring(0,25) },
    { type:'shortText', label:'Source', text: tracking.source==='windsor'?'Ext. appel Google':'Site web' },
    { type:'shortText', label:'Action', text: 'Proposer SI CLAIRE' }
  ]};
  const cred = Buffer.from(AIRCALL_API_ID+':'+AIRCALL_API_TOKEN).toString('base64');
  try {
    const r = await fetch(AIRCALL_BASE_URL+'/calls/'+callId+'/insight_cards', { method:'POST', headers:{'Authorization':'Basic '+cred,'Content-Type':'application/json'}, body:JSON.stringify(card) });
    if (!r.ok) console.error('[card]', r.status);
  } catch(e) {}
}

function formatLabel(ag) { if (!ag) return 'Compagnie inconnue'; return ag.replace(/^(Alt |Alternative |SOUS |Sous |ALT |NEW |CALLS )/i,'').replace(/\s+\d{4}$/,'').replace(/\s+#\d+$/,'').replace(/\s+PERF$/i,'').trim(); }
function detectProduct(c,a) { const s=((c||'')+' '+(a||'')).toLowerCase(); if(s.includes('sante')||s.includes('mutuelle')) return 'Sante / Mutuelle'; if(s.includes('iard')||s.includes('auto')||s.includes('moto')) return 'IARD / Auto'; if(s.includes('decennale')) return 'Decennale'; if(s.includes('vtc')||s.includes('taxi')) return 'VTC / Taxi'; if(s.includes('mrh')||s.includes('habitation')) return 'MRH / Habitation'; return 'Assurance'; }

app.get('/health', (req, res) => res.json({ status:'ok', wa_status:waStatus, pixel_store:preCallStore.size, windsor_queue:windsorQueue.length, time:new Date().toISOString() }));

let waClient=null, waStatus='disconnected', waQRCode=null;

function initWhatsApp() {
  waClient = new Client({ authStrategy: new LocalAuth({ dataPath:'/tmp/wa-session' }), puppeteer:{ headless:true, args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--single-process'] } });
  waClient.on('qr', async qr => { waStatus='qr_ready'; waQRCode=await QRCode.toDataURL(qr); console.log('[WA] QR pret /whatsapp/qr'); });
  waClient.on('ready', () => { waStatus='connected'; waQRCode=null; console.log('[WA] Connecte!'); });
  waClient.on('disconnected', () => { waStatus='disconnected'; setTimeout(initWhatsApp,10000); });
  waClient.on('message', async msg => {
    if (msg.fromMe) return;
    const phone = msg.from.replace('@c.us','').replace('@g.us','');
    try {
      const payload = { phone, message:msg.body, wa_message_id:msg.id._serialized, timestamp:Math.floor(msg.timestamp).toString() };
      await fetch(process.env.ZOHO_WEBHOOK_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
    } catch(e) {}
  });
  waClient.initialize();
}
initWhatsApp();

app.get('/whatsapp/qr', (req, res) => {
  if (waStatus==='connected') return res.send('<html><body style="text-align:center;padding:40px"><h2 style="color:green">WhatsApp SI CLAIRE connecte!</h2></body></html>');
  if (waStatus==='qr_ready' && waQRCode) return res.send('<html><body style="text-align:center;font-family:sans-serif;padding:40px;background:#f0f2f5"><div style="background:white;padding:30px;border-radius:12px;display:inline-block"><h2 style="color:#16294F">Scanner avec WhatsApp SI CLAIRE</h2><p>Menu &gt; Appareils lies &gt; Lier un appareil</p><img src="'+waQRCode+'" style="width:280px"/><script>setTimeout(()=>location.reload(),20000)<\/script></div></body></html>');
  res.send('<html><body style="text-align:center;padding:40px"><h3>Initialisation... attendez 30 sec</h3><script>setTimeout(()=>location.reload(),8000)<\/script></body></html>');
});

app.get('/whatsapp/status', (req,res) => res.json({ status:waStatus, time:new Date().toISOString() }));

app.post('/whatsapp/send', async (req, res) => {
  if (req.headers['x-internal-key'] !== process.env.INTERNAL_KEY) return res.status(401).json({ error:'Unauthorized' });
  if (waStatus !== 'connected') return res.status(503).json({ error:'WA non connecte', status:waStatus });
  const { to, message, agent } = req.body;
  if (!to || !message) return res.status(400).json({ error:'Params manquants' });
  try {
    await waClient.sendMessage(to.replace(/\+/g,'').replace(/\s/g,'')+'@c.us', message);
    res.json({ status:'ok', wa_message_id:'out_'+Date.now() });
  } catch(e) { res.status(500).json({ status:'error', error:e.message }); }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('Serveur SI CLAIRE port', PORT));
