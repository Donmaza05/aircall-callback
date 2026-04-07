const express = require('express');
const app = express();

app.use(express.json());
app.use(express.text({ type: '*/*' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const AIRCALL_API_ID    = '6fc70e4e7cbd62083547e0a79612b161';
const AIRCALL_API_TOKEN = 'f86b32f5db4d2f2808eb554f01812be5';
const WINDSOR_API_KEY   = '6ae9cb5c4bdcf3caf35b3bae60ca63736e00';
const WINDSOR_ACCOUNT   = '824-247-6325';
const AIRCALL_BASE_URL  = 'https://api.aircall.io/v1';

// Store principal — clics pixel GTM (temps réel)
const preCallStore = new Map();

// Store Windsor — clics extension d'appel (polling)
const windsorCallsCache = new Map();
let lastWindsorPoll = 0;
let lastKnownGclids = new Set();

// Nettoyer le preCallStore toutes les 5 minutes
setInterval(() => {
  const limit = Date.now() - 5 * 60 * 1000;
  for (const [k, v] of preCallStore) {
    if (v.ts < limit) preCallStore.delete(k);
  }
}, 60000);

// ============================================================
// POLLING WINDSOR — toutes les 2 minutes
// ============================================================
async function pollWindsor() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const url = `https://connectors.windsor.ai/google_ads?` +
      `api_key=${WINDSOR_API_KEY}` +
      `&date_from=${today}` +
      `&date_to=${today}` +
      `&fields=click_view_gclid,campaign,adgroup,click_type` +
      `&filters=${encodeURIComponent(JSON.stringify([["click_type","eq","CALLS"],
        "and",["adgroup","notnull",null]]))}` +
      `&accounts=${encodeURIComponent(JSON.stringify([WINDSOR_ACCOUNT]))}`;

    const res = await fetch(url);
    if (!res.ok) {
      console.error('[windsor] Erreur HTTP:', res.status);
      return;
    }

    const json = await res.json();
    const data = json.data || json || [];
    if (!Array.isArray(data)) return;

    let newCount = 0;
    for (const row of data) {
      const gclid = row.click_view_gclid || row.gclid;
      if (!gclid || lastKnownGclids.has(gclid)) continue;

      // Nouveau GCLID découvert — l'enregistrer avec timestamp serveur
      lastKnownGclids.add(gclid);
      const entry = {
        gclid,
        campaign: row.campaign || null,
        adgroup:  row.adgroup  || null,
        keyword:  null,
        ts:       Date.now(),
        source:   'windsor'
      };
      windsorCallsCache.set(gclid, entry);
      preCallStore.set('last_windsor', entry);
      newCount++;
    }

    if (newCount > 0) {
      console.log(`[windsor] ${newCount} nouveau(x) clic(s) d'appel detecte(s)`);
    }

    lastWindsorPoll = Date.now();

    // Nettoyer les anciens GCLIDs Windsor (> 24h)
    const limit = Date.now() - 24 * 60 * 60 * 1000;
    for (const [k, v] of windsorCallsCache) {
      if (v.ts < limit) {
        windsorCallsCache.delete(k);
        lastKnownGclids.delete(k);
      }
    }

  } catch (err) {
    console.error('[windsor] Erreur polling:', err.message);
  }
}

// Démarrer le polling immédiatement puis toutes les 2 minutes
pollWindsor();
setInterval(pollWindsor, 2 * 60 * 1000);

// ============================================================
// ROUTE PIXEL — clics depuis siclaire.fr (temps réel)
// ============================================================
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
      console.log('[pre-call-pixel] Recu:', JSON.stringify(entry));
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
    console.error('[pre-call] Erreur:', err.message);
    res.sendStatus(400);
  }
});

// ============================================================
// WEBHOOK AIRCALL
// ============================================================
app.post('/aircall-webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const { event, data } = req.body;
    if (!data || event !== 'call.created') return;
    if (data.direction !== 'inbound') return;

    console.log('[webhook] Appel entrant ID:', data.id, '| De:', data.raw_digits || data.from);

    const limit = Date.now() - 3 * 60 * 1000;
    let tracking = null;

    // Priorité 1 — pixel GTM (temps réel, plus précis)
    for (const [k, v] of preCallStore) {
      if (v.ts > limit && (v.campaign || v.adgroup)) {
        if (!tracking || v.ts > tracking.ts) tracking = v;
      }
    }

    // Priorité 2 — Windsor polling (extension d'appel directe)
    if (!tracking) {
      const windsorLimit = Date.now() - 5 * 60 * 1000;
      for (const [k, v] of windsorCallsCache) {
        if (v.ts > windsorLimit && v.adgroup) {
          if (!tracking || v.ts > tracking.ts) tracking = v;
        }
      }
    }

    if (!tracking) {
      console.log('[webhook] Aucun tracking trouve.');
      return;
    }

    console.log(`[webhook] Tracking trouve (source: ${tracking.source}):`, JSON.stringify(tracking));
    await sendInsightCard(data.id, tracking);

  } catch(err) {
    console.error('[webhook] Erreur:', err.message);
  }
});

// ============================================================
// INSIGHT CARD
// ============================================================
async function sendInsightCard(callId, tracking) {
  const adgroup = formatLabel(tracking.adgroup);
  const product = detectProduct(tracking.campaign, tracking.adgroup);

  const card = {
    contents: [
      { type: 'title',     text: adgroup },
      { type: 'shortText', label: 'Produit',   text: product },
      { type: 'shortText', label: 'Campagne',  text: tracking.campaign || '-' },
      { type: 'shortText', label: 'Mot-cle',   text: tracking.keyword  || 'non renseigne' },
      { type: 'shortText', label: 'Source',    text: tracking.source === 'windsor' ? 'Extension appel' : 'Site web' },
      { type: 'shortText', label: 'Action',    text: 'Proposer alternative SI CLAIRE' }
    ]
  };

  const credentials = Buffer.from(AIRCALL_API_ID + ':' + AIRCALL_API_TOKEN).toString('base64');
  try {
    const response = await fetch(`${AIRCALL_BASE_URL}/calls/${callId}/insight_cards`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + credentials,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify(card)
    });
    if (response.ok) {
      console.log('[insight_card] Envoyee OK — Call ID:', callId, '|', adgroup);
    } else {
      const err = await response.text();
      console.error('[insight_card] Erreur Aircall:', response.status, err);
    }
  } catch (err) {
    console.error('[insight_card] Fetch echoue:', err.message);
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

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    status:        'ok',
    store:         preCallStore.size,
    windsor_cache: windsorCallsCache.size,
    last_poll:     new Date(lastWindsorPoll).toISOString(),
    time:          new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('Serveur SI CLAIRE demarre sur port', PORT));
