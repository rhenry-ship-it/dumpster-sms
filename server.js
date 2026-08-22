const express = require('express');
const fs = require('fs');
const path = require('path');
const twilio = require('twilio');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'data.json');

// ---- storage helpers ----
function loadJobs() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}
function saveJobs(jobs) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(jobs, null, 2));
}

// ---- twilio ----
function getTwilioClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  return twilio(sid, token);
}

function getRecipients() {
  const raw = process.env.RECIPIENTS || '';
  return raw.split(',').map(n => n.trim()).filter(Boolean);
}

function buildMessage(job) {
  const lines = [];
  lines.push(job.type === 'delivery' ? '📦 NEW DELIVERY' : '🗑️ NEW RENTAL');
  lines.push(`Customer: ${job.customer}`);
  lines.push(`Address: ${job.address}`);
  if (job.size) lines.push(`Size: ${job.size}`);
  if (job.dropDate) lines.push(`Drop-off: ${job.dropDate}`);
  if (job.pickupDate) lines.push(`Pickup: ${job.pickupDate}`);
  if (job.price) lines.push(`Price: $${job.price}`);
  if (job.notes) lines.push(`Notes: ${job.notes}`);
  return lines.join('\n');
}

async function sendGroupText(message) {
  const client = getTwilioClient();
  const from = process.env.TWILIO_FROM_NUMBER;
  const recipients = getRecipients();

  if (!client || !from) {
    return { sent: false, reason: 'Twilio not configured (missing TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER)' };
  }
  if (recipients.length === 0) {
    return { sent: false, reason: 'No RECIPIENTS configured' };
  }

  const results = await Promise.allSettled(
    recipients.map(to => client.messages.create({ body: message, from, to }))
  );

  const failures = results
    .map((r, i) => ({ r, to: recipients[i] }))
    .filter(x => x.r.status === 'rejected')
    .map(x => ({ to: x.to, error: x.r.reason?.message || 'unknown error' }));

  return { sent: failures.length < recipients.length, failures };
}

// ---- routes ----
app.get('/api/jobs', (req, res) => {
  const jobs = loadJobs().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(jobs);
});

app.post('/api/jobs', async (req, res) => {
  const { type, customer, address, size, dropDate, pickupDate, price, notes } = req.body;

  if (!customer || !address) {
    return res.status(400).json({ error: 'Customer and address are required' });
  }

  const job = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type: type || 'rental',
    customer,
    address,
    size: size || '',
    dropDate: dropDate || '',
    pickupDate: pickupDate || '',
    price: price || '',
    notes: notes || '',
    createdAt: new Date().toISOString(),
  };

  const message = buildMessage(job);
  let textResult;
  try {
    textResult = await sendGroupText(message);
  } catch (e) {
    textResult = { sent: false, reason: e.message };
  }

  const jobs = loadJobs();
  jobs.push({ ...job, textResult });
  saveJobs(jobs);

  res.json({ job, textResult, message });
});

app.delete('/api/jobs/:id', (req, res) => {
  const jobs = loadJobs().filter(j => j.id !== req.params.id);
  saveJobs(jobs);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dumpster SMS app running on port ${PORT}`));
