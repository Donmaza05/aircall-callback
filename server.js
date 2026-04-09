// Ajouter en haut du fichier
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

// ============================================================
// CLIENT WHATSAPP WEB
// ============================================================
let waClient = null;
let waStatus  = 'disconnected'; // disconnected | qr_ready | connected
let waQRCode  = null;

function initWhatsApp() {
  waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: '/tmp/wa-session' }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    }
  });

  waClient.on('qr', async (qr) => {
    waStatus = 'qr_ready';
    waQRCode = await QRCode.toDataURL(qr);
    console.log('[WA] QR Code généré — scannez depuis /whatsapp/qr');
  });

  waClient.on('ready', () => {
    waStatus = 'connected';
    waQRCode  = null;
    console.log('[WA] ✅ WhatsApp connecté !');
  });

  waClient.on('disconnected', (reason) => {
    waStatus = 'disconnected';
    console.log('[WA] Déconnecté:', reason);
    setTimeout(initWhatsApp, 5000); // Reconnexion auto
  });

  waClient.on('message', async (msg) => {
    if (msg.fromMe) return;
    console.log('[WA IN]', msg.from, ':', msg.body);

    // Envoyer à Zoho Deluge
    try {
      const payload = {
        phone:         msg.from.replace('@c.us', ''),
        message:       msg.body,
        wa_message_id: msg.id._serialized,
        timestamp:     Math.floor(msg.timestamp).toString()
      };

      const zohoResp = await fetch(process.env.ZOHO_WEBHOOK_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload)
      });
      const zohoData = await zohoResp.json();
      console.log('[WA→ZOHO]', JSON.stringify(zohoData));
    } catch (err) {
      console.error('[WA→ZOHO error]', err.message);
    }
  });

  waClient.initialize();
}

initWhatsApp();

// ============================================================
// WHATSAPP — Afficher le QR Code (à scanner depuis le téléphone)
// ============================================================
app.get('/whatsapp/qr', (req, res) => {
  if (waStatus === 'connected') {
    return res.send('<h2 style="color:green">✅ WhatsApp connecté !</h2>');
  }
  if (waStatus === 'qr_ready' && waQRCode) {
    return res.send(`
      <html><body style="text-align:center;font-family:sans-serif">
        <h2>📱 Scannez ce QR avec WhatsApp SI CLAIRE</h2>
        <p>WhatsApp → Appareils liés → Lier un appareil</p>
        <img src="${waQRCode}" style="width:300px"/>
        <p><small>Cette page se rafraîchit automatiquement...</small></p>
        <script>setTimeout(()=>location.reload(), 15000)</script>
      </body></html>
    `);
  }
  res.send('<h3>⏳ Initialisation WhatsApp en cours... Réessayez dans 30 secondes.</h3><script>setTimeout(()=>location.reload(),5000)</script>');
});

// ============================================================
// WHATSAPP — Statut
// ============================================================
app.get('/whatsapp/status', (req, res) => {
  res.json({ status: waStatus, time: new Date().toISOString() });
});

// ============================================================
// WHATSAPP — Envoi message sortant (appelé par Deluge)
// ============================================================
app.post('/whatsapp/send', async (req, res) => {
  const key = req.headers['x-internal-key'];
  if (key !== process.env.INTERNAL_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (waStatus !== 'connected') {
    return res.status(503).json({ error: 'WhatsApp non connecté', status: waStatus });
  }

  const { to, message, agent } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'Paramètres manquants' });

  try {
    // Formater le numéro : 33612345678 → 33612345678@c.us
    const chatId = to.replace(/\+/g, '') + '@c.us';
    await waClient.sendMessage(chatId, message);

    const waMessageId = `out_${Date.now()}`;
    console.log(`[WA SEND] ✓ ${agent || 'agent'} → ${to}`);
    res.json({ status: 'ok', wa_message_id: waMessageId });

  } catch (err) {
    console.error('[WA SEND] Erreur:', err.message);
    res.status(500).json({ status: 'error', error: err.message });
  }
});
