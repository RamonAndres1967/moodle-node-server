import express from "express";
import multer from "multer";
import fs from "fs";
import fetch from "node-fetch";
import sqlite3 from "sqlite3";
import cors from "cors";
import FormData from "form-data";

const app = express();
app.use(cors());
app.use(express.json());

// ------------------ CARGAR GUION B1–B2 ------------------
const script = JSON.parse(fs.readFileSync("./script_b1_b2.json", "utf8"));

// Estado en memoria por usuario
const sessions = {}; 
// sessions[userId] = { phase, topic, questionIndex }

// ------------------ BASE DE DATOS ------------------
const db = new sqlite3.Database("usage.db");

db.run(`
  CREATE TABLE IF NOT EXISTS usage (
    userId TEXT,
    date TEXT,
    seconds REAL,
    PRIMARY KEY (userId, date)
  )
`);

function getToday() {
  return new Date().toISOString().split("T")[0];
}

const SESSION_LIMIT = 300; // 5 minutos

// ------------------ MULTER ------------------
const upload = multer({ dest: "uploads/" });

// ------------------ RUTA STT ------------------
app.post("/stt", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.json({ text: "" });

    const filePath = req.file.path;

    const formData = new FormData();
    formData.append("file", fs.createReadStream(filePath), {
      filename: "audio.webm",
      contentType: "audio/webm"
    });
    formData.append("model", "whisper-1");
    formData.append("language", "en");

    const openaiRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: formData
    });

    const data = await openaiRes.json();
    fs.unlinkSync(filePath);

    res.json({ text: data.text || "" });
  } catch (err) {
    res.json({ text: "" });
  }
});

// ------------------ MOTOR PEDAGÓGICO ------------------
function initSession(userId) {
  sessions[userId] = {
    phase: "warmup",
    topic: pickRandomTopic(),
    questionIndex: 0
  };

  console.log(`🆕 Nueva sesión creada para ${userId} → Tema: ${sessions[userId].topic}`);
}

function pickRandomTopic() {
  const keys = Object.keys(script.topics);
  return keys[Math.floor(Math.random() * keys.length)];
}

function getPromptForPhase(userId, userMessage) {
  const session = sessions[userId];
  const phase = session.phase;

  console.log(`📌 Fase actual de ${userId}: ${phase}`);

  if (phase === "warmup") return script.prompts.warmup;
  if (phase === "topic_intro") return `Introduce the topic: ${session.topic}`;

  if (phase === "guided_questions") {
    const questions = script.topics[session.topic].questions;
    const q = questions[session.questionIndex];
    console.log(`❓ Pregunta guiada para ${userId}: ${q}`);
    return `Ask this question naturally: "${q}"`;
  }

  if (phase === "correction") {
    return `Correct the student's message in a friendly way. Explain briefly and give an example. Student said: "${userMessage}"`;
  }

  if (phase === "expansion") return script.prompts.expansion;
  if (phase === "wrapup") return script.prompts.wrapup;
}

function advancePhase(userId) {
  const session = sessions[userId];

  if (session.phase === "warmup") session.phase = "topic_intro";
  else if (session.phase === "topic_intro") session.phase = "guided_questions";
  else if (session.phase === "guided_questions") {
    session.questionIndex++;
    const total = script.topics[session.topic].questions.length;
    if (session.questionIndex >= total) session.phase = "expansion";
  }
  else if (session.phase === "expansion") session.phase = "wrapup";
  else if (session.phase === "wrapup") initSession(userId);

  console.log(`➡️ Usuario ${userId} avanza a fase: ${session.phase}`);
}

// ------------------ RUTA CHAT (CON LOGS) ------------------
app.post("/chat", async (req, res) => {
  const { userId, message, history } = req.body;
  const today = getToday();

  console.log("📥 /chat fue llamado");
  console.log("👤 Usuario:", userId);
  console.log("💬 Mensaje del alumno:", message);
  console.log("📜 Historial recibido:", history);

  if (!sessions[userId]) initSession(userId);

  db.get(
    "SELECT seconds FROM usage WHERE userId = ? AND date = ?",
    [userId, today],
    async (err, row) => {
      const used = row?.seconds || 0;

      console.log(`⏱ Tiempo usado hoy por ${userId}: ${used}s`);

      if (used >= SESSION_LIMIT) {
        console.log("⛔ Límite diario alcanzado");
        return res.json({
          reply: "You have reached your 5‑minute practice limit for today.",
          timeSpentToday: used
        });
      }

      const prompt = getPromptForPhase(userId, message);
      console.log("🧠 Prompt pedagógico enviado a OpenAI:", prompt);

      // ---------- Construir mensajes con historial ----------
      let historyMessages = [];

      if (Array.isArray(history)) {
        history.forEach(turn => {
          if (turn.user) historyMessages.push({ role: "user", content: turn.user });
          if (turn.bot) historyMessages.push({ role: "assistant", content: turn.bot });
        });
      }

      console.log("📚 Mensajes enviados a OpenAI:", historyMessages);

      const messages = [
        { role: "system", content: prompt },
        ...historyMessages,
        { role: "user", content: message }
      ];

      console.log("🚀 Payload final enviado a OpenAI:", messages);

      const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4.1",
          max_tokens: 120,
          messages
        })
      });

      const data = await openaiRes.json();
      const reply = data.choices?.[0]?.message?.content || "Error";

      console.log("🤖 Respuesta generada por OpenAI:", reply);

      advancePhase(userId);

      res.json({
        reply,
        timeSpentToday: used
      });
    }
  );
});

// ------------------ RUTA PARA SUMAR TIEMPO DEL BOT ------------------
app.post("/ttsTime", (req, res) => {
  const { userId, seconds } = req.body;
  const today = getToday();

  db.get(
    "SELECT seconds FROM usage WHERE userId = ? AND date = ?",
    [userId, today],
    (err, row) => {
      const previous = row?.seconds || 0;
      const newTotal = previous + seconds;

      console.log(`🔊 TTS sumado para ${userId}: +${seconds}s → total ${newTotal}s`);

      db.run(
        "INSERT OR REPLACE INTO usage (userId, date, seconds) VALUES (?, ?, ?)",
        [userId, today, newTotal]
      );

      res.json({ ok: true, total: newTotal });
    }
  );
});

// ------------------ INICIAR SERVIDOR ------------------
app.listen(3000, () => console.log("🚀 Servidor listo en puerto 3000"));
