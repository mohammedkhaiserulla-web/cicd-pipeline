const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Hello from cicd-pipeline'
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy'
  });
});

module.exports = app;