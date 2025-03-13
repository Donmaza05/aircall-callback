const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const AIRCALL_API_URL = "https://api.aircall.io/v1"; // Assurez-vous que c'est bien la bonne URL
const API_ID = "71f04116bc8cc19965b0b43e78abfc14"; // Remplace avec ton API ID
const API_TOKEN = "098dbad72a34e56440a3032291bb19aa"; // Remplace avec ton API Token
const AIRCALL_NUMBER_ID = 599594; // ID du numéro Aircall +33189711220

// Fonction pour déclencher l'appel
async function startOutboundCall(userId, numberToCallback) {
    try {
        const response = await axios.post(
            `${AIRCALL_API_URL}/calls`,
            {
                number_id: AIRCALL_NUMBER_ID, // Numéro Aircall utilisé pour l'appel
                user_id: userId,
                to: numberToCallback
            },
            {
                headers: {
                    'Authorization': `Basic ${Buffer.from(`${API_ID}:${API_TOKEN}`).toString('base64')}`
                }
            }
        );
        console.log('✅ Appel démarré avec succès:', response.data);
    } catch (error) {
        console.error('❌ Erreur lors du démarrage de l\'appel:', error.response ? error.response.data : error);
    }
}

// Endpoint pour recevoir une demande de rappel
app.post('/callback_request', async (req, res) => {
    const { userId, phoneNumber } = req.body;
    
    if (!userId || !phoneNumber) {
        return res.status(400).json({ error: "userId et phoneNumber sont requis" });
    }

    console.log(`📞 Demande de rappel reçue pour ${phoneNumber} par l'utilisateur ${userId}`);
    await startOutboundCall(userId, phoneNumber);
    res.status(200).json({ message: "L'appel est en cours de traitement." });
});

// Démarrage du serveur
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 Serveur actif sur port ${PORT}`);
});
