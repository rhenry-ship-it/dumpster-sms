const express = require('express');
const fs = require('fs');
const path = require('path');
const twilio = require('twilio');
const ExcelJS = require('exceljs');

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
  lines.push('NEW SLIP');
  if (job.tripLabel) lines.push(job.tripLabel);
  lines.push(`Date: ${job.dropDate || ''}`);
  lines.push(`Customer: ${job.customer}`);
  lines.push(`Address: ${job.address}`);
  if (job.type === 'delivery') {
    if (job.material) lines.push(`Material: ${job.material}`);
    if (job.yards) lines.push(`Yards: ${job.yards} YD`);
  } else if (job.size) {
    lines.push(`Size: ${job.size}`);
  }
  if (job.price) lines.push(`Price: $${job.price}`);
  lines.push(`Instructions: ${job.notes || 'None'}`);
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

function getEmailRecipients() {
  const raw = process.env.EMAIL_RECIPIENTS || '';
  return raw.split(',').map(e => e.trim()).filter(Boolean);
}

async function sendGroupEmail(message, job) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  const recipients = getEmailRecipients();

  if (!apiKey || !from) {
    return { sent: false, reason: 'Resend not configured (missing RESEND_API_KEY/EMAIL_FROM)' };
  }
  if (recipients.length === 0) {
    return { sent: false, reason: 'No EMAIL_RECIPIENTS configured' };
  }

  const subject = job.type === 'delivery' ? 'New Delivery' : 'New Rental';

  const results = await Promise.allSettled(
    recipients.map(to =>
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to,
          subject,
          text: message,
        }),
      }).then(async (res) => {
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`${res.status}: ${body}`);
        }
        return res.json();
      })
    )
  );

  const failures = results
    .map((r, i) => ({ r, to: recipients[i] }))
    .filter(x => x.r.status === 'rejected')
    .map(x => ({ to: x.to, error: x.r.reason?.message || 'unknown error' }));

  return { sent: failures.length < recipients.length, failures };
}

// ---- routes ----
app.post('/api/verify-pin', (req, res) => {
  const { pin } = req.body;
  const adminPin = process.env.ADMIN_PIN;
  const driverPin = process.env.DRIVER_PIN;

  if (!adminPin && !driverPin) {
    // Nothing configured yet — don't lock anyone out, just default to admin access
    return res.json({ ok: true, role: 'admin' });
  }
  if (adminPin && pin === adminPin) {
    return res.json({ ok: true, role: 'admin' });
  }
  if (driverPin && pin === driverPin) {
    return res.json({ ok: true, role: 'driver' });
  }
  res.json({ ok: false });
});

app.get('/api/jobs', (req, res) => {
  const jobs = loadJobs().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(jobs);
});

const TRUCK_CAPACITY_YARDS = 5;

app.post('/api/jobs', async (req, res) => {
  const { type, customer, address, size, material, yards, dropDate, pickupDate, price, notes } = req.body;

  if (!customer || !address) {
    return res.status(400).json({ error: 'Customer and address are required' });
  }

  const isDelivery = type === 'delivery';
  const yardsNum = isDelivery ? parseInt(yards, 10) || 0 : 0;
  const tripsNeeded = isDelivery && yardsNum > TRUCK_CAPACITY_YARDS
    ? Math.ceil(yardsNum / TRUCK_CAPACITY_YARDS)
    : 1;

  const jobs = loadJobs();
  const trips = [];

  for (let i = 0; i < tripsNeeded; i++) {
    let tripYards = null;
    if (isDelivery) {
      const remaining = yardsNum - i * TRUCK_CAPACITY_YARDS;
      tripYards = Math.min(TRUCK_CAPACITY_YARDS, remaining);
    }

    const job = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '-' + i,
      type: type || 'rental',
      customer,
      address,
      size: isDelivery ? '' : (size || ''),
      material: isDelivery ? (material || '') : '',
      yards: isDelivery ? tripYards : null,
      dropDate: dropDate || '',
      pickupDate: isDelivery ? '' : (pickupDate || ''),
      price: i === 0 ? (price || '') : '',
      notes: notes || '',
      tripLabel: tripsNeeded > 1 ? `Trip ${i + 1} of ${tripsNeeded}` : '',
      dumpsterId: '',
      dropoffCompleted: isDelivery ? true : false,
      dropoffTime: '',
      dropoffActualDate: '',
      completed: false,
      completedAt: '',
      pickupWeight: '',
      dumpCost: '',
      actualPickupDate: '',
      createdAt: new Date().toISOString(),
    };

    const message = buildMessage(job);

    let twilioResult;
    try {
      twilioResult = await sendGroupText(message);
    } catch (e) {
      twilioResult = { sent: false, reason: e.message };
    }

    let emailResult;
    try {
      emailResult = await sendGroupEmail(message, job);
    } catch (e) {
      emailResult = { sent: false, reason: e.message };
    }

    const textResult = {
      sent: twilioResult.sent || emailResult.sent,
      twilio: twilioResult,
      email: emailResult,
    };

    jobs.push({ ...job, textResult });
    trips.push({ job, textResult, message });
  }

  saveJobs(jobs);
  res.json({ trips });
});

app.patch('/api/jobs/:id', (req, res) => {
  const jobs = loadJobs();
  const job = jobs.find(j => j.id === req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  if (typeof req.body.completed === 'boolean') {
    job.completed = req.body.completed;
    job.completedAt = req.body.completed ? new Date().toISOString() : '';
  }
  if (req.body.pickupWeight !== undefined) {
    job.pickupWeight = req.body.pickupWeight;
  }
  if (req.body.pickupDate !== undefined) {
    job.pickupDate = req.body.pickupDate;
  }
  if (req.body.dumpCost !== undefined) {
    job.dumpCost = req.body.dumpCost;
  }
  if (req.body.actualPickupDate !== undefined) {
    job.actualPickupDate = req.body.actualPickupDate;
  }
  if (req.body.dumpsterId !== undefined) {
    job.dumpsterId = req.body.dumpsterId;
  }
  if (typeof req.body.dropoffCompleted === 'boolean') {
    job.dropoffCompleted = req.body.dropoffCompleted;
    if (req.body.dropoffCompleted) {
      job.dropoffActualDate = new Date().toISOString().slice(0, 10);
    }
  }
  if (req.body.dropoffTime !== undefined) {
    job.dropoffTime = req.body.dropoffTime;
  }
  if (req.body.dropoffActualDate !== undefined) {
    job.dropoffActualDate = req.body.dropoffActualDate;
  }
  if (req.body.customer !== undefined) {
    job.customer = req.body.customer;
  }
  if (req.body.address !== undefined) {
    job.address = req.body.address;
  }
  if (req.body.size !== undefined) {
    job.size = req.body.size;
  }
  if (req.body.price !== undefined) {
    job.price = req.body.price;
  }
  saveJobs(jobs);
  res.json({ job });
});

app.get('/api/export.xlsx', async (req, res) => {
  const jobs = loadJobs().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Jobs');

  sheet.columns = [
    { header: 'Date Logged', key: 'createdAt', width: 18 },
    { header: 'Type', key: 'type', width: 10 },
    { header: 'Trip', key: 'tripLabel', width: 14 },
    { header: 'Customer', key: 'customer', width: 22 },
    { header: 'Address', key: 'address', width: 36 },
    { header: 'Size', key: 'size', width: 10 },
    { header: 'Dumpster ID', key: 'dumpsterId', width: 14 },
    { header: 'Material', key: 'material', width: 12 },
    { header: 'Yards', key: 'yards', width: 8 },
    { header: 'Drop-off Date', key: 'dropDate', width: 14 },
    { header: 'Actual Drop-off Date', key: 'dropoffActualDate', width: 18 },
    { header: 'Drop-off Time', key: 'dropoffTime', width: 14 },
    { header: 'Scheduled Pickup', key: 'pickupDate', width: 16 },
    { header: 'Actual Pickup Date', key: 'actualPickupDate', width: 16 },
    { header: 'Price', key: 'price', width: 10 },
    { header: 'Pickup Weight (tons)', key: 'pickupWeight', width: 18 },
    { header: 'Dump Cost', key: 'dumpCost', width: 12 },
    { header: 'Completed', key: 'completed', width: 12 },
    { header: 'Instructions', key: 'notes', width: 30 },
    { header: 'Crew Texted', key: 'textSent', width: 12 },
  ];
  sheet.getRow(1).font = { bold: true };

  jobs.forEach(j => {
    sheet.addRow({
      createdAt: j.createdAt ? new Date(j.createdAt).toLocaleString() : '',
      type: j.type === 'delivery' ? 'Delivery' : 'Rental',
      tripLabel: j.tripLabel || '',
      customer: j.customer || '',
      address: j.address || '',
      size: j.size || '',
      dumpsterId: j.dumpsterId || '',
      material: j.material || '',
      yards: j.yards || '',
      dropDate: j.dropDate || '',
      dropoffActualDate: j.dropoffActualDate || '',
      dropoffTime: j.dropoffTime || '',
      pickupDate: j.pickupDate || '',
      actualPickupDate: j.actualPickupDate || '',
      price: j.price ? Number(j.price) : '',
      pickupWeight: j.pickupWeight ? Number(j.pickupWeight) : '',
      dumpCost: j.dumpCost ? Number(j.dumpCost) : '',
      completed: j.completed ? 'Yes' : 'No',
      notes: j.notes || '',
      textSent: j.textResult?.sent ? 'Yes' : 'No',
    });
  });

  const dumpsterRevenue = jobs.filter(j => j.type !== 'delivery').reduce((s, j) => s + (parseFloat(j.price) || 0), 0);
  const materialRevenue = jobs.filter(j => j.type === 'delivery').reduce((s, j) => s + (parseFloat(j.price) || 0), 0);
  const totalDumpFees = jobs.reduce((s, j) => s + (parseFloat(j.dumpCost) || 0), 0);

  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.columns = [
    { header: 'Metric', key: 'metric', width: 28 },
    { header: 'Value', key: 'value', width: 16 },
  ];
  summarySheet.getRow(1).font = { bold: true };
  summarySheet.addRow({ metric: 'Dumpster Revenue', value: dumpsterRevenue });
  summarySheet.addRow({ metric: 'Material Delivery Revenue', value: materialRevenue });
  summarySheet.addRow({ metric: 'Total Dump Fees Paid', value: totalDumpFees });
  summarySheet.addRow({ metric: 'Net (Revenue - Dump Fees)', value: dumpsterRevenue + materialRevenue - totalDumpFees });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="job-log-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
});

function safeIsoDateTime(val) {
  const d = new Date(val);
  if (isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

app.post('/api/import-assets', (req, res) => {
  const { assets, mode } = req.body;
  if (!Array.isArray(assets)) {
    return res.status(400).json({ error: 'assets array required' });
  }

  const isHistory = mode === 'history';
  const jobs = loadJobs();
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const today = new Date().toISOString().slice(0, 10);

  assets.forEach((a, i) => {
    try {
      if (!a.address) { skipped++; return; }

      const isCompleted = isHistory && !!a.pickedUp;
      let existing = null;

      if (isHistory) {
        // Historical rows: a dumpster ID gets reused over time, so match a specific
        // instance by dumpster + drop-off date together, not just the ID alone.
        if (a.dumpsterId && a.dropoffActualDate) {
          existing = jobs.find(j =>
            j.type === 'rental' &&
            j.dumpsterId &&
            j.dumpsterId.toLowerCase() === a.dumpsterId.toLowerCase() &&
            j.dropoffActualDate === a.dropoffActualDate
          );
        }
        if (!existing) {
          existing = jobs.find(j =>
            j.type === 'rental' &&
            j.address.toLowerCase() === a.address.toLowerCase() &&
            j.dropoffActualDate === a.dropoffActualDate &&
            (a.customer ? (j.customer || '').toLowerCase() === a.customer.toLowerCase() : true)
          );
        }
      } else {
        if (a.dumpsterId) {
          existing = jobs.find(j =>
            j.type === 'rental' &&
            j.dumpsterId &&
            j.dumpsterId.toLowerCase() === a.dumpsterId.toLowerCase() &&
            !j.completed
          );
        }
        if (!existing) {
          existing = jobs.find(j =>
            j.type === 'rental' &&
            !j.completed &&
            j.address.toLowerCase() === a.address.toLowerCase() &&
            (a.customer ? (j.customer || '').toLowerCase() === a.customer.toLowerCase() : true)
          );
        }
      }

      if (existing) {
        existing.customer = a.customer || existing.customer;
        existing.address = a.address;
        existing.size = a.size || existing.size;
        existing.dumpsterId = a.dumpsterId || existing.dumpsterId;
        if (a.price) existing.price = a.price;
        if (a.dropoffActualDate) {
          existing.dropoffActualDate = a.dropoffActualDate;
          existing.dropDate = a.dropoffActualDate;
        }
        existing.dropoffCompleted = true;
        if (isHistory && isCompleted) {
          existing.completed = true;
          existing.actualPickupDate = a.pickedUp;
          existing.completedAt = safeIsoDateTime(a.pickedUp);
          if (a.weight) existing.pickupWeight = a.weight;
        }
        updated++;
      } else {
        jobs.push({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '-imp' + i,
          type: 'rental',
          customer: a.customer || 'Imported',
          address: a.address,
          size: a.size || '',
          material: '',
          yards: null,
          dropDate: a.dropoffActualDate || '',
          pickupDate: '',
          price: a.price || '',
          notes: 'Imported from spreadsheet',
          tripLabel: '',
          dumpsterId: a.dumpsterId || '',
          dropoffCompleted: true,
          dropoffTime: '',
          dropoffActualDate: a.dropoffActualDate || today,
          completed: isCompleted,
          completedAt: isCompleted ? safeIsoDateTime(a.pickedUp) : '',
          pickupWeight: isCompleted ? (a.weight || '') : '',
          dumpCost: '',
          actualPickupDate: isCompleted ? a.pickedUp : '',
          textResult: { sent: false, reason: 'Imported record — no text sent' },
          createdAt: new Date().toISOString(),
        });
        created++;
      }
    } catch (rowErr) {
      skipped++;
    }
  });

  saveJobs(jobs);
  res.json({ created, updated, skipped, count: created + updated });
});

app.delete('/api/import-assets', (req, res) => {
  const jobs = loadJobs();
  const remaining = jobs.filter(j => j.notes !== 'Imported from spreadsheet');
  const removed = jobs.length - remaining.length;
  saveJobs(remaining);
  res.json({ removed });
});

app.delete('/api/jobs/:id', (req, res) => {
  const jobs = loadJobs().filter(j => j.id !== req.params.id);
  saveJobs(jobs);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dumpster SMS app running on port ${PORT}`));
