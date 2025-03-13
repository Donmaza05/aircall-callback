const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const API_ID = '71f04116bc8cc19965b0b43e78abfc14';
const API_TOKEN = '098dbad72a34e56440a3032291bb19aa';
const AIRCALL_NUMBER_ID = 599594; // ID du numéro Aircall +33189711220

const AIRCALL_API_URL = 'https://api.aircall.io/v1';

app.post('/callback_request', async (req, res) => {
    try {
        const { name, email, phone_number } = req.body;
        
        // Récupérer les agents disponibles
        const availableAgents = await fetchAircallAvailableAgents();
        if (!availableAgents.length) {
            return res.status(400).json({ error: 'Aucun agent disponible pour le moment' });
        }

        // Sélectionner un agent disponible au hasard
        const selectedAgent = availableAgents[Math.floor(Math.random() * availableAgents.length)];
        
        // Démarrer un appel sortant
        await startOutboundCall(selectedAgent.id, phone_number);

        res.status(200).json({ success: true, message: 'Appel programmé avec succès' });
    } catch (error) {
        console.error('Erreur serveur:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

async function fetchAircallAvailableAgents() {
    try {
        const response = await axios.get(`${AIRCALL_API_URL}/users/availabilities`, {
            headers: {
                'Authorization': 'Basic ' + Buffer.from(`${API_ID}:${API_TOKEN}`).toString('base64')
            }
        });
        return response.data.users.filter(user => user.availability === 'available');
    } catch (error) {
        console.error('Erreur lors de la récupération des agents disponibles:', error);
        return [];
    }
}

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
                    'Authorization': 'Basic ' + Buffer.from(`${API_ID}:${API_TOKEN}`).toString('base64')
                }
            }
        );
        console.log('Appel démarré avec succès:', response.data);
    } catch (error) {
        console.error('Erreur lors du démarrage de l'appel:', error.response ? error.response.data : error);
    }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Serveur actif sur port ${PORT}`);
});