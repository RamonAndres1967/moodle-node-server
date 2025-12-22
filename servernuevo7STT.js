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
    console.log("📥 /stt fue llamado");

    if (!req.file) {
      console.log("❌ No se recibió archivo en STT");
      return res.json({ text: "" });
    }

    console.log("🎧 STT recibido:", {
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      tempPath: req.file.path
    });

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

    console.log("📝 STT → Texto transcrito:", data.text);
    console.log("📄 STT → Respuesta completa:", JSON.stringify(data, null, 2));

    fs.unlinkSync(filePath);

    res.json({ text: data.text || "" });
  } catch (err) {
    console.error("❌ Error en STT:", err);
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

  console.log(`🆕 Nueva sesión para ${userId} → Tema: ${sessions[userId].topic}`);
}

function pickRandomTopic() {
  const keys = Object.keys(script.topics);
  return keys[Math.floor(Math.random() * keys.length)];
}

function getPromptForPhase(userId, userMessage) {
  const session = sessions[userId];
  const phase = session.phase;

  console.log(`📌 Fase actual de ${userId}: ${phase}`);

  // 1. Warm-up
  if (phase === "warmup") {
    return script.prompts.warmup;
  }

  // 2. Introducción del tema
  if (phase === "topic_intro") {
    return `Introduce the topic: ${session.topic}`;
  }

  // 3. Preguntas guiadas
  if (phase === "guided_questions") {
    const questions = script.topics[session.topic].questions;
    const q = questions[session.questionIndex];

    console.log(`❓ Pregunta guiada para ${userId}: ${q}`);

    return `Ask this question naturally: "${q}"`;
  }

  // 4. Corrección
  if (phase === "correction") {
    return `Correct the student's message in a friendly way. Explain briefly and give an example. Student said: "${userMessage}"`;
  }

  // 5. Expansión
  if (phase === "expansion") {
    return script.prompts.expansion;
  }

  // 6. Wrap-up
  if (phase === "wrapup") {
    return script.prompts.wrapup;
  }
}

// Avance de fase
function advancePhase(userId) {
  const session = sessions[userId];

  if (session.phase === "warmup") {
    session.phase = "topic_intro";
  } else if (session.phase === "topic_intro") {
    session.phase = "guided_questions";
  } else if (session.phase === "guided_questions") {
    session.questionIndex++;
    const total = script.topics[session.topic].questions.length;

    if (session.questionIndex >= total) {
      session.phase = "expansion";
    }
  } else if (session.phase === "expansion") {
    session.phase = "wrapup";
  } else if (session.phase === "wrapup") {
    initSession(userId);
    return;
  }

  console.log(`➡️ Usuario ${userId} avanza a fase: ${session.phase}`);
}

// ------------------ RUTA CHAT ------------------
app.post("/chat", async (req, res) => {
  const { userId, message } = req.body;
  const today = getToday();

  if (!sessions[userId]) initSession(userId);

  db.get(
    "SELECT seconds FROM usage WHERE userId = ? AND date = ?",
    [userId, today],
    async (err, row) => {
      const used = row?.seconds || 0;

      if (used >= SESSION_LIMIT) {
        return res.json({
          reply: "You have reached your 5‑minute practice limit for today.",
          timeSpentToday: used
        });
      }

      const prompt = getPromptForPhase(userId, message);

      console.log("📢 PROMPT enviado a OpenAI:", prompt);
      console.log("👤 Mensaje del alumno:", message);

      const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4.1",
          max_tokens: 120,
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: message }
          ]
        })
      });

      const data = await openaiRes.json();
      const reply = data.choices?.[0]?.message?.content || "Error";

      console.log("🤖 BOT → Respuesta generada:", reply);
      console.log("📄 BOT → Respuesta completa:", JSON.stringify(data, null, 2));

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
