import express from "express";
import multer from "multer";
import fs from "fs";
import fetch from "node-fetch";
import cors from "cors";
import FormData from "form-data";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json());

// ------------------ SUPABASE ------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ------------------ CARGAR GUION B1–B2 ------------------
const script = JSON.parse(fs.readFileSync("./script_b1_b2.json", "utf8"));

// Estado en memoria por IP
const sessions = {}; 
// sessions[ip] = { phase, topic, questionIndex }

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
    formData.append("task", "transcribe");
    formData.append("temperature", "0");

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
function initSession(ip) {
  sessions[ip] = {
    phase: "warmup",
    topic: pickRandomTopic(),
    questionIndex: 0
  };

  console.log(`🆕 Nueva sesión creada para IP ${ip} → Tema: ${sessions[ip].topic}`);
}

function pickRandomTopic() {
  const keys = Object.keys(script.topics);
  return keys[Math.floor(Math.random() * keys.length)];
}

function getPromptForPhase(ip, userMessage) {
  const session = sessions[ip];
  const phase = session.phase;

  console.log(`📌 Fase actual de IP ${ip}: ${phase}`);

  if (phase === "warmup") return script.prompts.warmup;
  if (phase === "topic_intro") return `Introduce the topic: ${session.topic}`;

  if (phase === "guided_questions") {
    const questions = script.topics[session.topic].questions;
    const q = questions[session.questionIndex];
    console.log(`❓ Pregunta guiada para IP ${ip}: ${q}`);
    return `Ask this question naturally: "${q}"`;
  }

  if (phase === "correction") {
    return `Correct the student's message in a friendly way. Explain briefly and give an example. Student said: "${userMessage}"`;
  }

  if (phase === "expansion") return script.prompts.expansion;
  if (phase === "wrapup") return script.prompts.wrapup;
}

function advancePhase(ip) {
  const session = sessions[ip];

  if (session.phase === "warmup") session.phase = "topic_intro";
  else if (session.phase === "topic_intro") session.phase = "guided_questions";
  else if (session.phase === "guided_questions") {
    session.questionIndex++;
    const total = script.topics[session.topic].questions.length;
    if (session.questionIndex >= total) session.phase = "expansion";
  }
  else if (session.phase === "expansion") session.phase = "wrapup";
  else if (session.phase === "wrapup") initSession(ip);

  console.log(`➡️ IP ${ip} avanza a fase: ${session.phase}`);
}

// ------------------ RUTA CHAT (SOLO IP + CORRECCIÓN SIEMPRE) ------------------
app.post("/chat", async (req, res) => {
  const { message, history } = req.body;

  // 🔥 Capturar IP real del usuario
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip;
  console.log("🌍 IP del usuario:", ip);

  const today = getToday();

  if (!sessions[ip]) initSession(ip);

  // ------------------ LEER TIEMPO DESDE SUPABASE ------------------
  const { data: usageRow, error: usageError } = await supabase
    .from("usage")
    .select("seconds")
    .eq("ip", ip)
    .eq("date", today)
    .maybeSingle();

  const used = usageRow?.seconds || 0;

  console.log(`⏱ Tiempo usado hoy por IP ${ip}: ${used}s`);

  if (used >= SESSION_LIMIT) {
    console.log("⛔ Límite diario alcanzado por IP");
    return res.json({
      reply: "You have reached your 5‑minute practice limit for today.",
      timeSpentToday: used
    });
  }

  const phasePrompt = getPromptForPhase(ip, message);
  console.log("🧠 Prompt pedagógico:", phasePrompt);

  // 🔥 Prompt híbrido: corrección SIEMPRE + fase pedagógica
  const systemPrompt = `
You are an English tutor.

Correct the student ONLY when there is a clear, important mistake that a learner at A2–B1 level should genuinely fix.

Ignore:
- minor mistakes that do not affect meaning,
- natural variations of English,
- stylistic preferences,
- errors that are typical or expected at A2/B1,
- sentences that are already acceptable or natural.

If the student's message is correct or acceptable for their level, do NOT provide any correction. Just continue the conversation normally.

When a correction is truly needed, keep it brief, friendly, and focused on one key point.

After that, continue with the pedagogical task of the current phase.
Current phase instructions: ${phasePrompt}

`;

  // Construir historial
  let historyMessages = [];
  if (Array.isArray(history)) {
    history.forEach(turn => {
      if (turn.user) historyMessages.push({ role: "user", content: turn.user });
      if (turn.bot) historyMessages.push({ role: "assistant", content: turn.bot });
    });
  }

  console.log("📚 Historial enviado a OpenAI:", historyMessages);

  const messages = [
    { role: "system", content: systemPrompt },
    ...historyMessages,
    { role: "user", content: message }
  ];

  console.log("🚀 Payload final:", messages);

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

  console.log("🤖 Respuesta OpenAI:", reply);

  advancePhase(ip);

  res.json({
    reply,
    timeSpentToday: used
  });
});

// ------------------ RUTA PARA SUMAR TIEMPO (SOLO IP) ------------------
app.post("/ttsTime", async (req, res) => {
  const { seconds } = req.body;

  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip;
  const today = getToday();

  // Leer tiempo previo
  const { data: usageRow } = await supabase
    .from("usage")
    .select("seconds")
    .eq("ip", ip)
    .eq("date", today)
    .maybeSingle();

  const previous = usageRow?.seconds || 0;
  const newTotal = previous + seconds;

  console.log(`🔊 TTS sumado para IP ${ip}: +${seconds}s → total ${newTotal}s`);

  // UPSERT en Supabase
  await supabase
    .from("usage")
    .upsert({
      ip,
      date: today,
      seconds: newTotal
    });

  res.json({ ok: true, total: newTotal });
});

// ------------------ INICIAR SERVIDOR ------------------
app.listen(3000, () => console.log("🚀 Servidor listo en puerto 3000"));
