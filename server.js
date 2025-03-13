const startOutboundCall = (userId, numberToCallback) => {
  const apiId = YOUR_API_ID;
  const apiToken = YOUR_API_TOKEN;

  let apiUrl = 'https://api.aircall.io/v1/users/' + userId + '/calls';

  // Définir l'en-tête d'autorisation HTTP
  let options = {
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${apiId}:${apiToken}`).toString('base64')
    }
  };

  // Corps de la requête avec le number_id correct
  let body = {
    'number_id': 599594, // Remplacé par ton vrai number_id
    'to': numberToCallback
  };

  axios.post(apiUrl, body, options);
};
