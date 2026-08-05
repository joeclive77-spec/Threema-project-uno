require('dotenv').config();

const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// Basic health check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Root
app.get('/', (req, res) => {
  res.json({
    message: 'Secure Shop API',
    endpoints: ['/health', '/api/products', '/api/checkout', '/webhook/stripe']
  });
});

// API routes placeholder
app.get('/api/*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not implemented' });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
