const express = require('express');
const app = express();

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

const preCallStore  = new Map();
const windsorQueue  = [];
const knownGclids   = new Set();
let lastWindsorPoll = 0;

setInterval(() => {
  const limit = Date.now() - 5 * 60 * 1000;
  for (const [k, v] of preCallStore) {
    if (v.ts < limit) preCallStore.delete(k);
  }
}, 60000);

async function pollWindsor() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const filters = encodeURIComponent(JSON.stringify(
      [["click_type","eq","CALLS"],"and",["adgroup","notnull",null]]
    ));
    const url = `https://connectors.windsor.ai/google_ads` +
      `?api_key=${WINDSOR_API_KEY}` +
      `&date_from=${today}&date_to=${today}` +
      `&fields=click_view_gclid,campaign,adgroup,click_type` +
      `&filters=${filters}` +
      `&accounts=${encodeURIComponent(JSON.stringify([WINDSOR_ACCOUNT]))}`;

    const res = await fetch(url);
    if (!res.ok) { console.error('[windsor] HTTP:', res.status); return; }

    const json = await res.json();
    const data = Array.isArray(json) ? json : (json.data || []);
    let newCount = 0;

    for (const row of data) {
      const gclid = row.click_view_gclid || row.gclid;
      if (!gclid || knownGclids.has(gclid)) continue;
      knownGclids.add(gclid);
      windsorQueue.push({
        gclid,
        campaign: row.campaign || null,
        adgroup:  row.adgroup  || null,
        keyword:  null,
        ts:       Date.now(),
        source:   'windsor'
      });
      newCount++;
    }

    if (newCount > 0) console.log(`[windsor] +${newCount} clic(s) | File: ${windsorQueue.length}`);
    lastWindsorPoll = Date.now();

  } catch (err) {
    console.error('[windsor] Erreur:', err.message);
  }
}

pollWindsor();
setInterval(pollWindsor, 2 * 60 * 1000);

app.get('/pre-call-pixel', (req, res) => {
  try {
    const entry = {
      gclid:    req.query.gclid    || null,
      campaign: req.query.campaign || null,
      adgroup:  req.query.adgroup  || null,
      keyword:  req.query.keyword  || null,
      ts:       Date.now(),
      source:   'pixel'
    };
    if (entry.campaign || entry.gclid) {
      if (entry.gclid) preCallStore.set('gclid_' + entry.gclid, entry);
      preCallStore.set('last', entry);
      console.log('[pixel] Recu:', JSON.stringify(entry));
    }
  } catch(e) {}
  res.set('Content-Type', 'image/gif');
  res.send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
});

app.post('/pre-call', (req, res) => {
  try {
    const raw  = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const data = JSON.parse(raw);
    if (!data.campaign && !data.adgroup && !data.gclid) return res.sendStatus(200);
    const entry = {
      gclid:    data.gclid    || null,
      campaign: data.campaign || null,
      adgroup:  data.adgroup  || null,
      keyword:  data.keyword  || null,
      ts:       Date.now(),
      source:   'post'
    };
    if (data.gclid) preCallStore.set('gclid_' + data.gclid, entry);
    preCallStore.set('last', entry);
    console.log('[pre-call] Recu:', JSON.stringify(entry));
    res.sendStatus(200);
  } catch (err) {
    res.sendStatus(400);
  }
});

app.post('/aircall-webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const { event, data } = req.body;
    if (!data || event !== 'call.created') return;
    if (data.direction !== 'inbound') return;

    console.log('[webhook] Appel ID:', data.id, '| De:', data.raw_digits || data.from);

    let tracking = null;
    const limit3 = Date.now() - 3 * 60 * 1000;
    for (const [k, v] of preCallStore) {
      if (v.ts > limit3 && (v.campaign || v.adgroup)) {
        if (!tracking || v.ts > tracking.ts) tracking = v;
      }
    }
    if (tracking) preCallStore.delete('last');

    if (!tracking && windsorQueue.length > 0) {
      tracking = windsorQueue.shift();
      console.log(`[windsor] Clic consomme | File restante: ${windsorQueue.length}`);
    }

    if (!tracking) { console.log('[webhook] Aucun tracking disponible.'); return; }

    console.log(`[webhook] Source: ${tracking.source} | Adgroup: ${tracking.adgroup}`);
    await sendInsightCard(data.id, tracking);

  } catch(err) {
    console.error('[webhook] Erreur:', err.message);
  }
});

async function sendInsightCard(callId, tracking) {
  const adgroup  = formatLabel(tracking.adgroup);
  const product  = detectProduct(tracking.campaign, tracking.adgroup);
  const campaign = (tracking.campaign || '-').replace(/#/g, 'N°').substring(0, 28);

  const card = {
    contents: [
      { type: 'title',     text: adgroup },
      { type: 'shortText', label: 'Compagnie', text: adgroup },
      { type: 'shortText', label: 'Produit',   text: product },
      { type: 'shortText', label: 'Campagne',  text: campaign },
      { type: 'shortText', label: 'Mot-cle',   text: (tracking.keyword || 'non renseigne').substring(0, 25) },
      { type: 'shortText', label: 'Source',    text: tracking.source === 'windsor' ? 'Ext. appel Google' : 'Site web' },
      { type: 'shortText', label: 'Action',    text: 'Proposer SI CLAIRE' }
    ]
  };

  const credentials = Buffer.from(AIRCALL_API_ID + ':' + AIRCALL_API_TOKEN).toString('base64');

  try {
    const response = await fetch(
      `${AIRCALL_BASE_URL}/calls/${callId}/insight_cards`,
      {
        method:  'POST',
        headers: { 'Authorization': 'Basic ' + credentials, 'Content-Type': 'application/json' },
        body:    JSON.stringify(card)
      }
    );
    if (response.ok) {
      console.log('[card] OK — ID:', callId, '|', adgroup);
    } else {
      const err = await response.text();
      console.error('[card] Erreur:', response.status, err);
    }
  } catch (err) {
    console.error('[card] Fetch echoue:', err.message);
  }
}

function formatLabel(adgroup) {
  if (!adgroup) return 'Compagnie inconnue';
  return adgroup
    .replace(/^(Alt |Alternative |SOUS |Sous |ALT |NEW |CALLS )/i, '')
    .replace(/\s+\d{4}$/, '')
    .replace(/\s+#\d+$/, '')
    .replace(/\s+PERF$/i, '')
    .trim();
}

function detectProduct(campaign, adgroup) {
  const str = ((campaign || '') + ' ' + (adgroup || '')).toLowerCase();
  if (str.includes('sante') || str.includes('mutuelle')) return 'Sante / Mutuelle';
  if (str.includes('iard') || str.includes('auto') || str.includes('moto')) return 'IARD / Auto';
  if (str.includes('decennale')) return 'Decennale';
  if (str.includes('vtc') || str.includes('taxi')) return 'VTC / Taxi';
  if (str.includes('mrh') || str.includes('habitation')) return 'MRH / Habitation';
  return 'Assurance';
}

app.get('/health', (req, res) => {
  res.json({
    status:        'ok',
    pixel_store:   preCallStore.size,
    windsor_queue: windsorQueue.length,
    last_poll:     new Date(lastWindsorPoll).toISOString(),
    time:          new Date().toISOString()
  });
});

// ============================================================
// WHATSAPP — Vérification webhook Meta
// ============================================================
app.get('/whatsapp/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
    console.log('[WA] Webhook Meta vérifié');
    return res.status(200).send(challenge);
  }
  console.warn('[WA] Vérification échouée — token incorrect');
  res.sendStatus(403);
});

// ============================================================
// WHATSAPP — Réception message entrant → Zoho Deluge
// ============================================================
app.post('/whatsapp/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;
    const value = body.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages) return;
    const msg = value.messages[0];
    if (msg.type !== 'text') { console.log('[WA IN] Type non géré:', msg.type); return; }

    const payload = {
      phone:         msg.from,
      message:       msg.text.body,
      wa_message_id: msg.id,
      timestamp:     msg.timestamp
    };
    console.log('[WA IN]', JSON.stringify(payload));

    const zohoResp = await fetch(process.env.ZOHO_WEBHOOK_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });
    const zohoData = await zohoResp.json();
    console.log('[WA→ZOHO]', JSON.stringify(zohoData));

  } catch (err) {
    console.error('[WA webhook error]', err.message);
  }
});

// ============================================================
// WHATSAPP — Envoi message sortant (appelé par Deluge)
// ============================================================
app.post('/whatsapp/send', async (req, res) => {
  const key = req.headers['x-internal-key'];
  if (key !== process.env.INTERNAL_KEY) {
    console.warn('[WA SEND] Clé interne invalide');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { to, message, agent } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'Paramètres manquants: to, message' });

  if (!process.env.WA_PHONE_NUMBER_ID || !process.env.WA_ACCESS_TOKEN) {
    console.error('[WA SEND] Variables WA non configurées');
    return res.status(500).json({ error: 'WhatsApp non configuré' });
  }

  try {
    const response = await fetch(
      `https://graph.facebook.com/v19.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
      {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${process.env.WA_ACCESS_TOKEN}`,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to:   to,
          type: 'text',
          text: { body: message }
        })
      }
    );

    const data = await response.json();
    if (!response.ok) {
      console.error('[WA SEND] Erreur Meta:', JSON.stringify(data));
      return res.status(500).json({ status: 'error', error: data.error?.message || 'Meta API error' });
    }

    const waMessageId = data.messages?.[0]?.id || '';
    console.log(`[WA SEND] ✓ Agent: ${agent || 'inconnu'} → ${to} | ID: ${waMessageId}`);
    res.json({ status: 'ok', wa_message_id: waMessageId });

  } catch (err) {
    console.error('[WA SEND] Erreur:', err.message);
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('Serveur SI CLAIRE port', PORT));
