// ------------------ RUTA CHAT (LIMITACIÓN SOLO POR IP) ------------------
app.post("/chat", async (req, res) => {
  const { message, history } = req.body;

  // 🔥 Capturar IP real del usuario
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip;
  console.log("🌍 IP del usuario:", ip);

  const today = getToday();

  // Crear sesión si no existe (solo para fases pedagógicas)
  if (!sessions[ip]) initSession(ip);

  db.get(
    "SELECT seconds FROM usage WHERE ip = ? AND date = ?",
    [ip, today],
    async (err, row) => {
      const used = row?.seconds || 0;

      console.log(`⏱ Tiempo usado hoy por IP ${ip}: ${used}s`);

      if (used >= SESSION_LIMIT) {
        console.log("⛔ Límite diario alcanzado por IP");
        return res.json({
          reply: "You have reached your 5‑minute practice limit for today.",
          timeSpentToday: used
        });
      }

      const prompt = getPromptForPhase(ip, message);
      console.log("🧠 Prompt pedagógico:", prompt);

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
        { role: "system", content: prompt },
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
    }
  );
});

// ------------------ RUTA PARA SUMAR TIEMPO (SOLO IP) ------------------
app.post("/ttsTime", (req, res) => {
  const { seconds } = req.body;

  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip;
  const today = getToday();

  db.get(
    "SELECT seconds FROM usage WHERE ip = ? AND date = ?",
    [ip, today],
    (err, row) => {
      const previous = row?.seconds || 0;
      const newTotal = previous + seconds;

      console.log(`🔊 TTS sumado para IP ${ip}: +${seconds}s → total ${newTotal}s`);

      db.run(
        "INSERT OR REPLACE INTO usage (ip, date, seconds) VALUES (?, ?, ?)",
        [ip, today, newTotal]
      );

      res.json({ ok: true, total: newTotal });
    }
  );
});
