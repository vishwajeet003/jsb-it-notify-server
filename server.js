import express from "express";
import cors from "cors";
import PDFDocument from "pdfkit";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || "JSB IT Ticketing <onboarding@resend.dev>";
const TECH_EMAIL = process.env.TECH_EMAIL || "tech@armoroctrading.com";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

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
  return lines;
}

async function sendEmail(t, pdfBuffer) {
  const subject = `IT Ticket ${t.id} [${t.priority}] - ${t.category}`;
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

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Failed to generate or send the ticket notification." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Notify server listening on port ${PORT}`));
