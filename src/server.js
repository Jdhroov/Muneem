'use strict';

require('dotenv').config();

const express  = require('express');
const { dispatch } = require('./handlers');

const app  = express();
const PORT = process.env.PORT || 3000;

// Parse Twilio's application/x-www-form-urlencoded bodies
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.send('Muneem is running. Send a WhatsApp message to get started.');
});

// ─── Twilio WhatsApp webhook ──────────────────────────────────────────────────

app.post('/webhook', async (req, res) => {
  const {
    From,
    Body,
    MediaUrl0,
    MediaContentType0,
    NumMedia,
  } = req.body;

  console.log(`[webhook] From: ${From} | Body: "${Body}" | Media: ${NumMedia > 0 ? MediaUrl0 : 'none'}`);

  const hasMedia = parseInt(NumMedia || '0', 10) > 0;

  // For media messages: ack immediately, process async, send follow-up via Twilio REST
  if (hasMedia) {
    // Acknowledge receipt immediately so Twilio doesn't retry
    res.type('text/xml').send(twiml('⏳ Dekh raha hoon... ek second mein batata hoon.'));

    // Process and send follow-up
    dispatch(From, Body, MediaUrl0, MediaContentType0)
      .then(text => sendFollowUp(From, text))
      .catch(err => {
        console.error('[async] error:', err.message);
        sendFollowUp(From, '❌ Kuch gadbad ho gayi. Dobara try karein.').catch(() => {});
      });

    return;
  }

  // Text messages: process synchronously (fast enough)
  try {
    const responseText = await dispatch(From, Body, null, null);
    res.type('text/xml').send(twiml(responseText));
  } catch (err) {
    console.error('[sync] error:', err.message);
    res.type('text/xml').send(twiml('❌ Kuch gadbad ho gayi. Dobara try karein.'));
  }
});

// ─── TwiML helper ─────────────────────────────────────────────────────────────

function twiml(body) {
  // Escape XML special characters
  const safe = String(body)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`;
}

// ─── Twilio REST API for async follow-ups ────────────────────────────────────

function sendFollowUp(to, body) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886';

  if (!sid || !token || sid.startsWith('YOUR_')) {
    // Dev mode: just log
    console.log(`[followup → ${to}]:\n${body}`);
    return Promise.resolve();
  }

  const twilio = require('twilio')(sid, token);
  return twilio.messages.create({ from, to, body: String(body) });
}

// ─── Start server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🏪 Muneem server running on port ${PORT}`);
  console.log(`   Webhook: http://localhost:${PORT}/webhook`);
  console.log(`   Use ngrok to expose: ngrok http ${PORT}`);
  console.log(`   Then set Twilio sandbox webhook to: https://<ngrok-id>.ngrok.io/webhook\n`);
});
