import express from "express";
import cors from "cors";
import PDFDocument from "pdfkit";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { MongoClient } from "mongodb";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || "JSB IT Ticketing <onboarding@resend.dev>";
const TECH_EMAIL = process.env.TECH_EMAIL || "tech@armoroctrading.com";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CALLMEBOT_PHONE = process.env.CALLMEBOT_PHONE;
const CALLMEBOT_APIKEY = process.env.CALLMEBOT_APIKEY;
const MONGODB_URI = process.env.MONGODB_URI;
// Default close-ticket PIN is "2003". To change it, compute a new SHA-256 hex hash
// (e.g. in a browser console: crypto.subtle.digest(...)) and set TECH_PASSWORD_HASH on Render.
const TECH_PASSWORD_HASH =
  process.env.TECH_PASSWORD_HASH || "77459b9b941bcb4714d0c121313c900ecf30541d158eb2b9b178cdb8eca6457e";

const MAX_ATTACHMENTS = 5;

const app = express();
app.use(cors());
app.use(express.json({ limit: "40mb" }));

let ticketsCollection = null;
let employeesCollection = null;
let assetsCollection = null;
if (MONGODB_URI) {
  const client = new MongoClient(MONGODB_URI);
  client
    .connect()
    .then(async () => {
      const db = client.db("jsb_it_ticketing");
      ticketsCollection = db.collection("tickets");
      await ticketsCollection.createIndex({ id: 1 }, { unique: true });
      employeesCollection = db.collection("it_employees");
      await employeesCollection.createIndex({ id: 1 }, { unique: true });
      assetsCollection = db.collection("it_assets");
      await assetsCollection.createIndex({ id: 1 }, { unique: true });
      console.log("Connected to MongoDB — shared ticket + IT asset storage is active.");
    })
    .catch((err) => {
      console.error("MongoDB connection failed — shared storage disabled:", err.message);
    });
} else {
  console.warn("MONGODB_URI not set — shared ticket + IT asset storage disabled (email/Telegram still work).");
}

function genTicketId() {
  const now = new Date();
  const ymd = now.getFullYear() + String(now.getMonth() + 1).padStart(2, "0") + String(now.getDate()).padStart(2, "0");
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `TCK-${ymd}-${rand}`;
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function stripMongoId(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return rest;
}

function genId(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`;
}

// Same PIN as the ticket-close/IT-update passcode ("2003" by default) — intentionally shared,
// not a typo. See TECH_PASSWORD_HASH above.
function checkPin(password) {
  return !!password && sha256Hex(password) === TECH_PASSWORD_HASH;
}

function staticHolderLabel(holderType) {
  if (holderType === "IT_ROOM") return "IT Room";
  if (holderType === "STORAGE") return "In Storage";
  return null;
}

async function resolveHolderLabel(holderType, holderId) {
  if (holderType === "employee" && holderId && employeesCollection) {
    const emp = await employeesCollection.findOne({ id: holderId });
    return emp ? emp.name : null;
  }
  return staticHolderLabel(holderType);
}

const IMAGE_DATA_URL_RE = /^data:image\/(png|jpe?g|webp|gif);base64,/i;
const DOC_DATA_URL_RE =
  /^data:(application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)|application\/vnd\.ms-excel|application\/vnd\.ms-powerpoint|text\/plain|text\/csv);base64,/i;

function isImageDataUrl(dataUrl) {
  return typeof dataUrl === "string" && IMAGE_DATA_URL_RE.test(dataUrl);
}

function sanitizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((a) => a && typeof a.dataUrl === "string" && (IMAGE_DATA_URL_RE.test(a.dataUrl) || DOC_DATA_URL_RE.test(a.dataUrl)))
    .slice(0, MAX_ATTACHMENTS)
    .map((a) => ({ name: String(a.name || "attachment").slice(0, 200), dataUrl: a.dataUrl }));
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildTicketPdf(ticket) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      doc.image(path.join(__dirname, "assets", "logo.png"), 50, 42, { width: 44 });
    } catch (e) {
      console.warn("Could not embed logo in PDF:", e.message);
    }

    doc.fontSize(16).fillColor("#0A1442").text("JSB Investments Inc. — IT Support Ticket", 108, 48);
    doc.fontSize(10).fillColor("#5A6B8C").text("Group of Companies · IT Support Desk", 108, 70);
    doc.moveTo(50, 100).lineTo(545, 100).strokeColor("#0A1442").lineWidth(2).stroke();

    doc.fontSize(13).fillColor("#0A1442").text(`Ticket ${ticket.id}`, 50, 122);

    const rows = [["Employee Name", ticket.employeeName], ["Problem Type", ticket.category]];
    if (ticket.otherDescription) rows.push(["Problem Description", ticket.otherDescription]);
    if (ticket.description) rows.push(["Additional Details", ticket.description]);
    rows.push(["Priority", ticket.priority]);
    rows.push(["Needed By", formatDate(ticket.neededBy)]);
    rows.push(["Opened At", formatDate(ticket.openedAt)]);

    let y = 152;
    rows.forEach(([label, value]) => {
      doc.fontSize(11).font("Helvetica-Bold").fillColor("#0A1442").text(label, 50, y, { width: 150 });
      doc.fontSize(11).font("Helvetica").fillColor("#16213E").text(String(value || "—"), 210, y, { width: 335 });
      y += 26;
    });

    const attachments = sanitizeAttachments(ticket.attachments);
    const imageAttachments = attachments.filter((a) => isImageDataUrl(a.dataUrl));
    const docAttachments = attachments.filter((a) => !isImageDataUrl(a.dataUrl));

    if (imageAttachments.length) {
      y += 8;
      doc.fontSize(11).font("Helvetica-Bold").fillColor("#0A1442").text("Attached Photos", 50, y);
      y += 20;
      const imgSize = 140;
      const gap = 14;
      let x = 50;
      imageAttachments.forEach((att) => {
        try {
          const base64 = att.dataUrl.split(",")[1];
          const buf = Buffer.from(base64, "base64");
          if (x + imgSize > 545) { x = 50; y += imgSize + gap; }
          if (y + imgSize > 700) { doc.addPage(); x = 50; y = 50; }
          doc.image(buf, x, y, { fit: [imgSize, imgSize] });
          x += imgSize + gap;
        } catch (e) {
          console.warn("Could not embed attachment image in PDF:", e.message);
        }
      });
      y += imgSize + gap;
    }

    if (docAttachments.length) {
      if (y > 700) { doc.addPage(); y = 50; }
      y += 8;
      doc.fontSize(11).font("Helvetica-Bold").fillColor("#0A1442").text("Attached Documents", 50, y);
      y += 18;
      docAttachments.forEach((att) => {
        if (y > 740) { doc.addPage(); y = 50; }
        doc.fontSize(10).font("Helvetica").fillColor("#16213E").text(`• ${att.name} (see email attachments)`, 60, y);
        y += 16;
      });
    }

    doc
      .fontSize(9)
      .fillColor("#8896AA")
      .text(
        `Generated on ${formatDate(new Date().toISOString())} · JSB Investments Inc. IT Support Ticketing System`,
        50,
        760
      );

    doc.end();
  });
}

function ticketSummaryLines(t) {
  const lines = [
    "New IT Support Ticket",
    `Ticket ID: ${t.id}`,
    `Employee: ${t.employeeName}`,
    `Problem: ${t.category}${t.otherDescription ? " — " + t.otherDescription : ""}`,
  ];
  if (t.description) lines.push(`Description: ${t.description}`);
  lines.push(`Priority: ${t.priority}`, `Needed by: ${formatDate(t.neededBy)}`, `Opened at: ${formatDate(t.openedAt)}`);
  const attachments = sanitizeAttachments(t.attachments);
  const imageCount = attachments.filter((a) => isImageDataUrl(a.dataUrl)).length;
  const docCount = attachments.length - imageCount;
  if (imageCount) lines.push(`Photos attached: ${imageCount} (see PDF)`);
  if (docCount) lines.push(`Documents attached: ${docCount} (see email attachments)`);
  return lines;
}

async function sendEmail(t, pdfBuffer) {
  const subject = `IT Ticket ${t.id} [${t.priority}] - ${t.category}`;
  const docAttachments = sanitizeAttachments(t.attachments)
    .filter((a) => !isImageDataUrl(a.dataUrl))
    .map((a) => ({ filename: a.name, content: a.dataUrl.split(",")[1] }));
  const resendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [TECH_EMAIL],
      subject,
      text: ticketSummaryLines(t).join("\n"),
      attachments: [
        {
          filename: `${t.id}.pdf`,
          content: pdfBuffer.toString("base64"),
        },
        ...docAttachments,
      ],
    }),
  });

  if (!resendRes.ok) {
    const errText = await resendRes.text();
    console.error("Resend rejected the request:", errText);
    throw new Error("Email provider rejected the request.");
  }
}

async function sendTelegram(t, pdfBuffer) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const caption = ticketSummaryLines(t).join("\n").slice(0, 1024);
  const form = new FormData();
  form.append("chat_id", TELEGRAM_CHAT_ID);
  form.append("caption", caption);
  form.append("document", new Blob([pdfBuffer], { type: "application/pdf" }), `${t.id}.pdf`);

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("Telegram rejected the request:", errText);
  }
}

async function sendWhatsapp(t) {
  if (!CALLMEBOT_PHONE || !CALLMEBOT_APIKEY) return;

  const text = ticketSummaryLines(t).join("\n").slice(0, 1000);
  const url =
    "https://api.callmebot.com/whatsapp.php?" +
    new URLSearchParams({ phone: CALLMEBOT_PHONE, text, apikey: CALLMEBOT_APIKEY }).toString();

  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text();
    console.error("CallMeBot rejected the request:", errText);
  }
}

app.get("/", (req, res) => {
  res.send("JSB IT Ticketing notify server is running.");
});

app.post("/api/tickets/notify", async (req, res) => {
  const t = req.body || {};
  if (!t.id || !t.employeeName || !t.category || !t.priority) {
    return res.status(400).json({ ok: false, error: "Missing required ticket fields." });
  }
  if (!RESEND_API_KEY) {
    return res.status(500).json({ ok: false, error: "Server is missing RESEND_API_KEY." });
  }

  try {
    const pdfBuffer = await buildTicketPdf(t);
    await sendEmail(t, pdfBuffer);

    try {
      await sendTelegram(t, pdfBuffer);
    } catch (telegramErr) {
      console.error("Telegram notification failed (non-fatal):", telegramErr);
    }
    try {
      await sendWhatsapp(t);
    } catch (whatsappErr) {
      console.error("WhatsApp notification failed (non-fatal):", whatsappErr);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Failed to generate or send the ticket notification." });
  }
});

async function notifyAll(ticket) {
  try {
    const pdfBuffer = await buildTicketPdf(ticket);
    await sendEmail(ticket, pdfBuffer);
    try {
      await sendTelegram(ticket, pdfBuffer);
    } catch (telegramErr) {
      console.error("Telegram notification failed (non-fatal):", telegramErr);
    }
    try {
      await sendWhatsapp(ticket);
    } catch (whatsappErr) {
      console.error("WhatsApp notification failed (non-fatal):", whatsappErr);
    }
    return true;
  } catch (err) {
    console.error("Notification failed:", err);
    return false;
  }
}

app.get("/api/tickets", async (req, res) => {
  if (!ticketsCollection) {
    return res.status(503).json({ ok: false, error: "Shared ticket storage isn't set up yet (MONGODB_URI missing)." });
  }
  try {
    const docs = await ticketsCollection.find({}).sort({ openedAt: -1 }).toArray();
    return res.json({ ok: true, tickets: docs.map(stripMongoId) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Failed to load tickets." });
  }
});

app.post("/api/tickets", async (req, res) => {
  const body = req.body || {};
  if (!body.employeeName || !body.category || !body.priority) {
    return res.status(400).json({ ok: false, error: "Missing required ticket fields." });
  }

  const ticket = {
    id: genTicketId(),
    employeeName: body.employeeName,
    category: body.category,
    otherDescription: body.otherDescription || "",
    description: body.description || "",
    neededBy: body.neededBy || "",
    priority: body.priority,
    attachments: sanitizeAttachments(body.attachments),
    status: "Open",
    openedAt: new Date().toISOString(),
    closedAt: null,
  };

  let persisted = false;
  if (ticketsCollection) {
    try {
      await ticketsCollection.insertOne({ ...ticket });
      persisted = true;
    } catch (err) {
      console.error("Failed to persist ticket:", err);
    }
  }

  const notified = RESEND_API_KEY ? await notifyAll(ticket) : false;

  return res.json({ ok: true, ticket, persisted, notified });
});

app.post("/api/tickets/:id/note", async (req, res) => {
  if (!ticketsCollection) {
    return res.status(503).json({ ok: false, error: "Shared ticket storage isn't set up yet (MONGODB_URI missing)." });
  }
  const password = (req.body || {}).password;
  if (!password || sha256Hex(password) !== TECH_PASSWORD_HASH) {
    return res.status(403).json({ ok: false, error: "Incorrect IT passcode." });
  }
  const text = ((req.body || {}).note || "").toString().trim();
  if (!text) {
    return res.status(400).json({ ok: false, error: "Update text is required." });
  }

  try {
    const note = { text, at: new Date().toISOString() };
    const updatedTicket = await ticketsCollection.findOneAndUpdate(
      { id: req.params.id },
      { $push: { itNotes: { $each: [note], $position: 0 } } },
      { returnDocument: "after" }
    );
    if (!updatedTicket) {
      return res.status(404).json({ ok: false, error: "Ticket not found." });
    }
    return res.json({ ok: true, ticket: stripMongoId(updatedTicket) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Failed to post the update." });
  }
});

app.post("/api/tickets/:id/close", async (req, res) => {
  if (!ticketsCollection) {
    return res.status(503).json({ ok: false, error: "Shared ticket storage isn't set up yet (MONGODB_URI missing)." });
  }
  const password = (req.body || {}).password;
  if (!password || sha256Hex(password) !== TECH_PASSWORD_HASH) {
    return res.status(403).json({ ok: false, error: "Incorrect technician password." });
  }

  try {
    // mongodb driver v6 returns the updated document directly (not wrapped in { value })
    const updatedTicket = await ticketsCollection.findOneAndUpdate(
      { id: req.params.id, status: "Open" },
      { $set: { status: "Closed", closedAt: new Date().toISOString() } },
      { returnDocument: "after" }
    );
    if (!updatedTicket) {
      return res.status(404).json({ ok: false, error: "Ticket not found or already closed." });
    }
    return res.json({ ok: true, ticket: stripMongoId(updatedTicket) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Failed to close ticket." });
  }
});

/* ---------- IT Assets: employees ---------- */
app.get("/api/it-assets/employees", async (req, res) => {
  if (!employeesCollection) {
    return res.status(503).json({ ok: false, error: "Shared IT asset storage isn't set up yet (MONGODB_URI missing)." });
  }
  try {
    const docs = await employeesCollection.find({}).sort({ name: 1 }).toArray();
    return res.json({ ok: true, employees: docs.map(stripMongoId) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Failed to load employees." });
  }
});

app.post("/api/it-assets/employees", async (req, res) => {
  if (!employeesCollection) {
    return res.status(503).json({ ok: false, error: "Shared IT asset storage isn't set up yet (MONGODB_URI missing)." });
  }
  const body = req.body || {};
  if (!checkPin(body.password)) {
    return res.status(403).json({ ok: false, error: "Incorrect PIN." });
  }
  const name = (body.name || "").toString().trim();
  if (!name) {
    return res.status(400).json({ ok: false, error: "Employee name is required." });
  }
  const employee = {
    id: genId("EMP"),
    name,
    jobRole: (body.jobRole || "").toString().trim(),
    companyNumber: (body.companyNumber || "").toString().trim(),
    companyEmail: (body.companyEmail || "").toString().trim(),
    joinDate: (body.joinDate || "").toString().trim(),
    photo: isImageDataUrl(body.photo) ? body.photo : "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  try {
    await employeesCollection.insertOne({ ...employee });
    return res.json({ ok: true, employee });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Failed to save employee." });
  }
});

app.put("/api/it-assets/employees/:id", async (req, res) => {
  if (!employeesCollection) {
    return res.status(503).json({ ok: false, error: "Shared IT asset storage isn't set up yet (MONGODB_URI missing)." });
  }
  const body = req.body || {};
  if (!checkPin(body.password)) {
    return res.status(403).json({ ok: false, error: "Incorrect PIN." });
  }
  const name = (body.name || "").toString().trim();
  if (!name) {
    return res.status(400).json({ ok: false, error: "Employee name is required." });
  }
  const update = {
    name,
    jobRole: (body.jobRole || "").toString().trim(),
    companyNumber: (body.companyNumber || "").toString().trim(),
    companyEmail: (body.companyEmail || "").toString().trim(),
    joinDate: (body.joinDate || "").toString().trim(),
    updatedAt: new Date().toISOString(),
  };
  if (isImageDataUrl(body.photo)) update.photo = body.photo;
  try {
    const updated = await employeesCollection.findOneAndUpdate(
      { id: req.params.id },
      { $set: update },
      { returnDocument: "after" }
    );
    if (!updated) return res.status(404).json({ ok: false, error: "Employee not found." });
    return res.json({ ok: true, employee: stripMongoId(updated) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Failed to update employee." });
  }
});

/* ---------- IT Assets: assets ---------- */
app.get("/api/it-assets/assets", async (req, res) => {
  if (!assetsCollection) {
    return res.status(503).json({ ok: false, error: "Shared IT asset storage isn't set up yet (MONGODB_URI missing)." });
  }
  try {
    const docs = await assetsCollection.find({}).sort({ name: 1 }).toArray();
    return res.json({ ok: true, assets: docs.map(stripMongoId) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Failed to load assets." });
  }
});

app.post("/api/it-assets/assets", async (req, res) => {
  if (!assetsCollection) {
    return res.status(503).json({ ok: false, error: "Shared IT asset storage isn't set up yet (MONGODB_URI missing)." });
  }
  const body = req.body || {};
  if (!checkPin(body.password)) {
    return res.status(403).json({ ok: false, error: "Incorrect PIN." });
  }
  const name = (body.name || "").toString().trim();
  if (!name) {
    return res.status(400).json({ ok: false, error: "Asset name is required." });
  }
  const holderType = ["employee", "IT_ROOM", "STORAGE"].includes(body.holderType) ? body.holderType : "UNASSIGNED";
  const holderId = holderType === "employee" ? (body.holderId || "").toString().trim() : null;

  let previousOwnerLabel = null;
  if (typeof body.previousOwnerLabel === "string" && body.previousOwnerLabel.trim()) {
    previousOwnerLabel = body.previousOwnerLabel.trim();
  }

  const asset = {
    id: genId("AST"),
    name,
    photo: isImageDataUrl(body.photo) ? body.photo : "",
    holderType,
    holderId: holderType === "employee" ? holderId : null,
    previousOwnerLabel,
    assignedAt: holderType === "UNASSIGNED" ? null : new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  try {
    await assetsCollection.insertOne({ ...asset });
    return res.json({ ok: true, asset });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Failed to save asset." });
  }
});

app.put("/api/it-assets/assets/:id", async (req, res) => {
  if (!assetsCollection) {
    return res.status(503).json({ ok: false, error: "Shared IT asset storage isn't set up yet (MONGODB_URI missing)." });
  }
  const body = req.body || {};
  if (!checkPin(body.password)) {
    return res.status(403).json({ ok: false, error: "Incorrect PIN." });
  }

  try {
    const existing = await assetsCollection.findOne({ id: req.params.id });
    if (!existing) return res.status(404).json({ ok: false, error: "Asset not found." });

    const update = { updatedAt: new Date().toISOString() };
    if (typeof body.name === "string" && body.name.trim()) update.name = body.name.trim();
    if (isImageDataUrl(body.photo)) update.photo = body.photo;

    if (body.holderType && ["employee", "IT_ROOM", "STORAGE", "UNASSIGNED"].includes(body.holderType)) {
      const newHolderType = body.holderType;
      const newHolderId = newHolderType === "employee" ? (body.holderId || "").toString().trim() : null;
      const holderChanged = newHolderType !== existing.holderType || newHolderId !== (existing.holderId || null);
      if (holderChanged) {
        const prevLabel = await resolveHolderLabel(existing.holderType, existing.holderId);
        update.previousOwnerLabel = prevLabel;
        update.assignedAt = new Date().toISOString();
      }
      update.holderType = newHolderType;
      update.holderId = newHolderType === "employee" ? newHolderId : null;
    }

    const updated = await assetsCollection.findOneAndUpdate(
      { id: req.params.id },
      { $set: update },
      { returnDocument: "after" }
    );
    return res.json({ ok: true, asset: stripMongoId(updated) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Failed to update asset." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Notify server listening on port ${PORT}`));
