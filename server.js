const express = require('express');
const app = express();

app.use(express.json());
app.use(express.text({ type: '*/*' }));

const AIRCALL_API_ID    = '6fc70e4e7cbd62083547e0a79612b161';
const AIRCALL_API_TOKEN = 'f86b32f5db4d2f2808eb554f01812be5';
const AIRCALL_BASE_URL  = 'https://api.aircall.io/v1';

const preCallStore = new Map();

setInterval(() => {
  const limit = Date.now() - 5 * 60 * 1000;
  for (const [k, v] of preCallStore) {
    if (v.ts < limit) preCallStore.delete(k);
  }
}, 60000);

app.post('/pre-call', (req, res) => {
  try {
    const raw  = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const data = JSON.parse(raw);
    if (!data.campaign && !data.adgroup) return res.sendStatus(200);
    const entry = {
      gclid:    data.gclid    || null,
      campaign: data.campaign || null,
      adgroup:  data.adgroup  || null,
      keyword:  data.keyword  || null,
      ts:       Date.now()
    };
    if (data.gclid) preCallStore.set('gclid_' + data.gclid, entry);
    preCallStore.set('last', entry);
    console.log('[pre-call]', new Date().toISOString(), entry);
    res.sendStatus(200);
  } catch (err) {
    console.error('[pre-call] Erreur:', err.message);
    res.sendStatus(400);
  }
});

app.post('/aircall-webhook', async (req, res) => {
  res.sendStatus(200);
  const { event, data } = req.body;
  if (!data || event !== 'call.created') return;
  if (data.direction !== 'inbound') return;
  console.log('[webhook] Appel entrant ID:', data.id, '| De:', data.from);
  const limit = Date.now() - 3 * 60 * 1000;
  let tracking = null;
  for (const [k, v] of preCallStore) {
    if (v.ts > limit && v.campaign) {
      if (!tracking || v.ts > tracking.ts) tracking = v;
    }
  }
  if (!tracking) {
    console.log('[webhook] Aucun tracking trouvé.');
    return;
  }
  console.log('[webhook] Tracking trouvé:', tracking);
  await sendInsightCard(data.id, tracking);
});

async function sendInsightCard(callId, tracking) {
  const label   = formatLabel(tracking.adgroup);
  const product = detectProduct(tracking.campaign, tracking.adgroup);
  const card = {
    contents: [
      { type: 'title',     text: label },
      { type: 'shortText', label: 'Produit',   text: product },
      { type: 'shortText', label: 'Campagne',  text: tracking.campaign || '-' },
      { type: 'shortText', label: 'Mot-cle',   text: tracking.keyword  || 'non renseigne' },
      { type: 'shortText', label: 'Action',    text: 'Proposer alternative SI CLAIRE' }
    ]
  };
  const credentials = Buffer.from(AIRCALL_API_ID + ':' + AIRCALL_API_TOKEN).toString('base64');
  try {
    const response = await fetch(`${AIRCALL_BASE_URL}/calls/${callId}/insight_cards`, {
      method:  'POST',
      headers: { 'Authorization': 'Basic ' + credentials, 'Content-Type': 'application/json' },
      body:    JSON.stringify(card)
    });
    if (response.ok) {
      console.log('[insight_card] Envoyee ✓ Call ID:', callId, '|', label);
    } else {
      const err = await response.text();
      console.error('[insight_card] Erreur API Aircall:', response.status, err);
    }
  } catch (err) {
    console.error('[insight_card] Fetch echoue:', err.message);
  }
}

function formatLabel(adgroup) {
  if (!adgroup) return 'Compagnie inconnue';
  return adgroup
    .replace(/^(Alt |Alternative |SOUS |Sous |ALT |NEW )/i, '')
    .replace(/\s+\d{4}$/, '')
    .replace(/\s+#\d+$/, '')
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
  res.json({ status: 'ok', store: preCallStore.size, time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('Serveur SI CLAIRE demarre sur port', PORT));
