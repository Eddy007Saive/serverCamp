const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/workflow', async (req, res) => {
  // Headers SSE + CORS
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // ✅ Important pour CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Si c’est une requête OPTIONS, répondre immédiatement
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  const sendEvent = (eventType, data) => {
    res.write(`event: ${eventType}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const webhookUrl = 'https://n8n.srv903010.hstgr.cloud/webhook-test/test';
  const payload = { name: 'Serge' };

  try {
    sendEvent('start', { message: 'Workflow démarré...' });

    // Lancer le workflow
    let response = await axios.post(webhookUrl, payload);
    let data = response.data;
    sendEvent('progress', { data });

    // Polling du workflow tant qu'il n'est pas terminé
    while (data.executionUrl && !data.finished) {
      const path = data.executionUrl.split('/').slice(3).join('/');
      data.executionUrl = `https://n8n.srv903010.hstgr.cloud/${path}`;

      sendEvent('step', { message: "Vérification de l'état...", executionUrl: data.executionUrl });

      const statusRes = await axios.get(data.executionUrl);
      data = statusRes.data;
      sendEvent('update', { data });

      // Attendre 1 seconde avant la prochaine vérification
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    sendEvent('completed', { result: data });
    res.end();
  } catch (err) {
    sendEvent('error', { error: err.message });
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`🚀 SSE Node.js server running on port ${PORT}`);
});
