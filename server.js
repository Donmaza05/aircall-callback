const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Tes identifiants Aircall API
const AIRCALL_API_ID = "71f04116bc8cc19965b0b43e78abfc14";
const AIRCALL_API_TOKEN = "098dbad72a34e56440a3032291bb19aa";

// Endpoint pour rappel automatique
app.post('/callback_request', async (req, res) => {
  const { name, email, phone_number } = req.body;

  try {
    const availableAgents = await getAvailableAgents();
    if (!availableAgents.length) {
      return res.status(503).send("Aucun agent disponible actuellement, réessayez plus tard.");
    }

    const selectedAgent = availableAgents[Math.floor(Math.random() * availableAgents.length)];
    await startOutboundCall(selectedAgent.id, phone_number);

    res.status(200).send("Votre rappel est en cours.");

  } catch (error) {
    console.error(error);
    res.status(500).send("Erreur serveur.");
  }
});

async function getAvailableAgents() {
  const { data } = await axios.get('https://api.aircall.io/v1/users/availabilities', {
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${AIRCALL_API_ID}:${AIRCALL_API_TOKEN}`).toString('base64')
    }
  });
  return data.users.filter(u => u.availability === 'available');
}

async function startOutboundCall(agentId, phoneNumber) {
  await axios.post(`https://api.aircall.io/v1/users/${agentId}/calls`, {
    to: phoneNumber
  }, {
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${AIRCALL_API_ID}:${AIRCALL_API_TOKEN}`).toString('base64')
    }
  });
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Serveur actif sur port ${PORT}`));
