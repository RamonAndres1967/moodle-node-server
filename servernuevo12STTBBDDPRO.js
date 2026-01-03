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

// ------------------ CARGAR GUION B1–B2 (script PRO) ------------------
const script = JSON.parse(fs.readFileSync("./script_b1_b2.json", "utf8"));

// Estado en memoria por IP
// sessions[ip] = { phase, topic, subtopic, questionIndex, guidedCount, expansionCount, name, userId, lastTopic, lastSubtopic }
const sessions = {};

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

// ------------------ MOTOR PEDAGÓGICO PRO ------------------

function pickRandomTopic(previousTopic = null) {
  const topics = Object.keys(script.topics || {});
  if (topics.length === 0) return null;

  const avoidRepeat = script.flow?.rotation?.avoid_repeating_last_topic;
  let candidates = topics;

  if (avoidRepeat && previousTopic && topics.length > 1) {
    candidates = topics.filter(t => t !== previousTopic);
    if (candidates.length === 0) {
      candidates = topics;
    }
  }

  return candidates[Math.floor(Math.random() * candidates.length)];
}

function pickRandomSubtopic(topicKey, previousSubtopic = null) {
  const topic = script.topics[topicKey];
  if (!topic?.rotation?.subtopics || topic.rotation.subtopics.length === 0) return null;

  const subList = topic.rotation.subtopics;
  const avoidRepeat =
    topic.rotation.avoid_repeating_last_subtopic ||
    script.flow?.rotation?.avoid_repeating_last_subtopic;

  let candidates = subList;

  if (avoidRepeat && previousSubtopic && subList.length > 1) {
    candidates = subList.filter(s => s !== previousSubtopic);
    if (candidates.length === 0) {
      candidates = subList;
    }
  }

  return candidates[Math.floor(Math.random() * candidates.length)];
}

function initSession(ip) {
  const prev = sessions[ip] || {};
  const previousTopic = prev.topic || prev.lastTopic || null;
  const topic = pickRandomTopic(previousTopic);

  const previousSubtopic = prev.subtopic || prev.lastSubtopic || null;
  const subtopic = topic ? pickRandomSubtopic(topic, previousSubtopic) : null;

  sessions[ip] = {
    phase: "warmup",
    topic,
    subtopic,
    questionIndex: 0,
    guidedCount: 0,
    expansionCount: 0,
    name: prev.name || null,
    userId: prev.userId || null,
    lastTopic: topic || previousTopic || null,
    lastSubtopic: subtopic || previousSubtopic || null
  };

  console.log(`🆕 Nueva sesión creada para IP ${ip} → Tema: ${topic}, Subtema: ${subtopic}`);
}

/**
 * Devuelve instrucciones pedagógicas para la fase actual,
 * adaptadas al script PRO.
 */
function getPromptForPhase(ip, userMessage) {
  const session = sessions[ip];
  const phase = session.phase;
  const topicKey = session.topic;
  const subtopicKey = session.subtopic;

  console.log(`📌 Fase actual de IP ${ip}: ${phase}`);

  // Seguridad básica
  if (!script || !script.phases) {
    return "Continue the conversation in a simple, friendly way.";
  }

  // 1. Warmup → usar prompt específico
  if (phase === "warmup") {
    return script.prompts?.warmup ||
      "Ask the student a simple warm-up question about their day or week.";
  }

  // 2. Topic intro → usar prompt + intro del topic
  if (phase === "topic_intro") {
    const topic = script.topics[topicKey];
    const intro = topic?.intro || "Introduce a general topic in a natural way.";
    const basePrompt =
      script.prompts?.topic_intro ||
      "Introduce the topic of the day in a natural and engaging way.";
    return `${basePrompt} Topic: "${intro}"`;
  }

  // 3. Guided questions → usar topic + subtopic + pregunta actual
  if (phase === "guided_questions") {
    const topic = script.topics[topicKey];
    if (!topic?.subtopics) {
      return "Ask an open-ended question about a general topic that fits the student's level.";
    }

    let sub = topic.subtopics[subtopicKey];
    if (!sub) {
      const subKeys = Object.keys(topic.subtopics);
      sub = topic.subtopics[subKeys[0]];
    }

    const questions = sub?.questions || [];
    const idx = session.questionIndex || 0;
    const qObj = questions[idx] || questions[0];

    const qText =
      qObj?.q ||
      "Ask an open-ended question that requires explanation and opinion.";

    console.log(`❓ Pregunta guiada para IP ${ip}:`, qObj || qText);

    const basePrompt =
      script.prompts?.guided_question ||
      "Ask an open-ended question about the topic that requires explanation and opinion.";

    return `${basePrompt} Use this idea as a base: "${qText}"`;
  }

  // 4. Correction → usar prompt de corrección + mensaje del alumno
  if (phase === "correction") {
    const basePrompt =
      script.prompts?.correction ||
      "Correct the student's last message in a friendly way. Explain briefly and give a natural example.";
    return `${basePrompt} Student said: "${userMessage}"`;
  }

  // 5. Expansion → usar expansión del topic si existe
  if (phase === "expansion") {
    const topic = script.topics[topicKey];
    const expList = topic?.expansion || [];
    const expExample =
      expList[0] ||
      "Ask a deeper follow-up question that pushes the student to explain more or think more critically.";

    const basePrompt =
      script.prompts?.expansion ||
      "Ask a deeper follow-up question based on the student's last answer.";

    return `${basePrompt} For example: "${expExample}"`;
  }

  // 6. Wrapup_continue → seguir con preguntas cortas
  if (phase === "wrapup_continue") {
    const ex = script.phases?.wrapup_continue?.examples?.[0];
    const basePrompt =
      script.prompts?.wrapup_continue ||
      "Ask a short, simple follow-up question to keep the conversation going.";
    if (ex) {
      return `${basePrompt} For example: "${ex}"`;
    }
    return basePrompt;
  }

  // 7. Wrapup → resumen y feedback
  if (phase === "wrapup") {
    const ex = script.phases?.wrapup?.examples?.[0];
    const basePrompt =
      script.prompts?.wrapup ||
      "Give positive feedback and summarize what the student practised today.";
    if (ex) {
      return `${basePrompt} For example: "${ex}"`;
    }
    return basePrompt;
  }

  // 8. Fallback seguro
  return "Continue the conversation in a simple, friendly way, asking a clear question.";
}

/**
 * Avanzar fase según lógica PRO
 */
function advancePhase(ip) {
  const session = sessions[ip];
  const phase = session.phase;
  const topicKey = session.topic;
  const subtopicKey = session.subtopic;

  if (!script || !script.phases) return;

  if (phase === "warmup") {
    session.phase = "topic_intro";
  } else if (phase === "topic_intro") {
    session.phase = "guided_questions";
    session.guidedCount = 0;
    session.questionIndex = 0;
  } else if (phase === "guided_questions") {
    const topic = script.topics[topicKey];
    const sub = topic?.subtopics?.[subtopicKey];
    const totalQuestions = sub?.questions?.length || 0;

    session.guidedCount = (session.guidedCount || 0) + 1;
    session.questionIndex = (session.questionIndex || 0) + 1;

    const minQ = script.phases.guided_questions?.min_questions || 3;
    const maxQ = script.phases.guided_questions?.max_questions || 6;

    const askedEnough = session.guidedCount >= minQ;
    const reachedEndOfSubtopic = session.questionIndex >= totalQuestions;
    const reachedMax = session.guidedCount >= maxQ;

    if (reachedMax || (askedEnough && reachedEndOfSubtopic)) {
      session.phase = "expansion";
      session.expansionCount = 0;
    } else {
      if (session.questionIndex >= totalQuestions && totalQuestions > 0) {
        session.questionIndex = totalQuestions - 1;
      }
    }
  } else if (phase === "expansion") {
    session.expansionCount = (session.expansionCount || 0) + 1;
    const maxExp = script.phases.expansion?.rules?.max_questions || 2;

    if (session.expansionCount >= maxExp) {
      session.phase = "wrapup";
    }
  } else if (phase === "wrapup_continue") {
    session.phase = "wrapup";
  } else if (phase === "wrapup") {
    initSession(ip);
  }

  console.log(`➡️ IP ${ip} avanza a fase: ${sessions[ip].phase}`);
}

// ------------------ RUTA CHAT (con antifraude IP + userId) ------------------
app.post("/chat", async (req, res) => {
  const { message, history, firstname, lastname, userId, email } = req.body;

  // --- Guardar o actualizar datos del usuario ---
  await supabase
    .from("users")
    .upsert({ userId, firstname, lastname, email });

  // IP real del usuario
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip;
  console.log("🌍 IP del usuario:", ip);

  const today = getToday();

  if (!sessions[ip]) {
    initSession(ip);
  }

  // Nombre "humano"
  const studentName = `${firstname || ""} ${lastname || ""}`.trim() || null;

  // ---------- LÓGICA ANTIFRAUDE: ENLAZAR IP ↔ userId ----------
  if (!sessions[ip].userId && userId) {
    sessions[ip].userId = userId;
    console.log(`🔐 IP ${ip} vinculada a userId ${userId}`);
  }

  if (sessions[ip].userId && userId && sessions[ip].userId !== userId) {
    console.log(
      `⚠️ Posible fraude: IP ${ip} ya ligada a userId ${sessions[ip].userId} y ha llegado userId ${userId}. Ignorando el nuevo userId.`
    );
  }

  const effectiveUserId = sessions[ip].userId || userId || null;

  if (!effectiveUserId) {
    console.log("⚠️ No hay userId válido. Usando solo control por IP (modo degradado).");
  }

  if (studentName && !sessions[ip].name) {
    sessions[ip].name = studentName;
    console.log(`👤 Nombre guardado para IP ${ip}: ${studentName}`);
  }

  // ------------------ LEER TIEMPO DESDE SUPABASE POR userId ------------------
  let used = 0;

  if (effectiveUserId) {
    const { data: usageRow, error: usageError } = await supabase
      .from("usage")
      .select("seconds")
      .eq("userId", effectiveUserId)
      .eq("date", today)
      .maybeSingle();

    if (usageError) {
      console.error("❌ Error leyendo usage por userId:", usageError);
    }

    used = usageRow?.seconds || 0;
    console.log(`⏱ Tiempo usado hoy por userId ${effectiveUserId}: ${used}s`);
  } else {
    const { data: usageRow, error: usageError } = await supabase
      .from("usage")
      .select("seconds")
      .eq("ip", ip)
      .eq("date", today)
      .maybeSingle();

    if (usageError) {
      console.error("❌ Error leyendo usage por IP:", usageError);
    }

    used = usageRow?.seconds || 0;
    console.log(`⏱ Tiempo usado hoy por IP ${ip} (fallback): ${used}s`);
  }

  // ---------- COMPROBAR LÍMITE ----------
  if (used >= SESSION_LIMIT) {
    console.log("⛔ Límite diario alcanzado");

    const nameForMessage = sessions[ip]?.name || "there";

    return res.json({
      reply: `I'm sorry ${nameForMessage}, but we have reached your 5‑minute practice limit for today. 
But don't be sad — I will be here tomorrow waiting for you. Bye!`,
      timeSpentToday: used
    });
  }

  const phasePrompt = getPromptForPhase(ip, message);
  console.log("🧠 Prompt pedagógico:", phasePrompt);

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

  const messages = [
    { role: "system", content: systemPrompt },
    ...historyMessages,
    { role: "user", content: message }
  ];

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

  advancePhase(ip);

  res.json({
    reply,
    timeSpentToday: used
  });
});

// ------------------ RUTA PARA SUMAR TIEMPO (usa userId como clave) ------------------
app.post("/ttsTime", async (req, res) => {
  const { seconds, userId } = req.body;

  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip;
  const today = getToday();

  if (!sessions[ip]) {
    initSession(ip);
  }

  if (!sessions[ip].userId && userId) {
    sessions[ip].userId = userId;
    console.log(`🔐 (ttsTime) IP ${ip} vinculada a userId ${userId}`);
  } else if (sessions[ip].userId && userId && sessions[ip].userId !== userId) {
    console.log(
      `⚠️ (ttsTime) Posible fraude: IP ${ip} ya ligada a userId ${sessions[ip].userId} y ha llegado userId ${userId}. Ignorando el nuevo userId.`
    );
  }

  const effectiveUserId = sessions[ip].userId || userId || null;

  let previous = 0;

  if (effectiveUserId) {
    const { data: usageRow, error: usageError } = await supabase
      .from("usage")
      .select("seconds")
      .eq("userId", effectiveUserId)
      .eq("date", today)
      .maybeSingle();

    if (usageError) {
      console.error("❌ Error leyendo usage por userId (ttsTime):", usageError);
    }

    previous = usageRow?.seconds || 0;

    const newTotal = previous + seconds;

    console.log(
      `🔊 TTS sumado para userId ${effectiveUserId}: +${seconds}s → total ${newTotal}s`
    );

    await supabase.from("usage").upsert({
      userId: effectiveUserId,
      ip: ip || null,
      date: today,
      seconds: newTotal
    });

    return res.json({ ok: true, total: newTotal });
  } else {
    const { data: usageRow, error: usageError } = await supabase
      .from("usage")
      .select("seconds")
      .eq("ip", ip)
      .eq("date", today)
      .maybeSingle();

    if (usageError) {
      console.error("❌ Error leyendo usage por IP (ttsTime):", usageError);
    }

    previous = usageRow?.seconds || 0;
    const newTotal = previous + seconds;

    console.log(
      `🔊 (fallback) TTS sumado para IP ${ip}: +${seconds}s → total ${newTotal}s`
    );

    await supabase.from("usage").upsert({
      ip,
      date: today,
      seconds: newTotal
    });

    return res.json({ ok: true, total: newTotal });
  }
});

// ------------------ INICIAR SERVIDOR ------------------
app.listen(3000, () => console.log("🚀 Servidor listo en puerto 3000"));
