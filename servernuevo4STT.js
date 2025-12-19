const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const sqlite3 = require("sqlite3").verbose();
const multer = require("multer");
const fs = require("fs");
const FormData = require("form-data");

const app = express();
app.use(express.json());
app.use(cors());

// Para recibir archivos de audio
const upload = multer({ dest: "uploads/" });

// 📦 Inicializar base de datos SQLite
const db = new sqlite3.Database("./usage.db");

// Crear tabla si no existe
db.run(`
  CREATE TABLE IF NOT EXISTS usage (
    userId TEXT,
    date TEXT,
    seconds INTEGER,
    PRIMARY KEY(userId, date)
  )
`);

// Ruta de prueba
app.get("/ping", (req, res) => {
  res.send("Servidor activo en Render con CORS abierto + SQLite");
});


// ------------------------------------------------------
// 🔊 NUEVA RUTA: STT (Speech-to-Text con OpenAI Whisper)
// ------------------------------------------------------
app.post("/stt", upload.single("audio"), async (req, res) => {
  try {
    const filePath = req.file.path;

    // Crear form-data para enviar a OpenAI
    const formData = new FormData();
    formData.append("file", fs.createReadStream(filePath));
    formData.append("model", "gpt-4o-mini-tts"); // Whisper STT

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: formData
    });

    const data = await response.json();

    // Borrar archivo temporal
    fs.unlinkSync(filePath);

    if (!data.text) {
      console.error("Respuesta STT inesperada:", data);
      return res.json({ text: "" });
    }

    res.json({ text: data.text });

  } catch (err) {
    console.error("Error en STT:", err);
    res.status(500).json({ error: "Error en STT" });
  }
});


// ------------------------------------------------------
// 🧠 RUTA PRINCIPAL DEL CHATBOT (SIN CAMBIOS)
// ------------------------------------------------------
app.post("/chat", async (req, res) => {
  console.log("Mensaje recibido:", req.body);

  const { userId, message } = req.body;
  const today = new Date().toDateString();

  const increment = 5;

  db.get("SELECT seconds FROM usage WHERE userId = ? AND date = ?", [userId, today], (err, row) => {
    if (err) {
      console.error("Error en SQLite:", err);
    } else {
      if (row) {
        db.run("UPDATE usage SET seconds = ? WHERE userId = ? AND date = ?", [row.seconds + increment, userId, today]);
      } else {
        db.run("INSERT INTO usage (userId, date, seconds) VALUES (?, ?, ?)", [userId, today, increment]);
      }
    }
  });

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4.1",
        messages: [
          {
            role: "system",
            content: "Eres profesor de inglés virtual. Responde de forma clara, educativa y motivadora, siempre en inglés, propon temas e inicia conversaciones."
          },
          {
            role: "user",
            content: `UserId: ${userId}\nMessage: ${message}`
          }
        ],
        max_tokens: 80,
        temperature: 0.7,
        user: userId
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Error en OpenAI:", errorText);
      return res.status(response.status).json({ error: errorText });
    }

    const data = await response.json();
    console.log("Respuesta de OpenAI:", data);

    db.get("SELECT seconds FROM usage WHERE userId = ? AND date = ?", [userId, today], (err, row) => {
      const timeSpentToday = row ? row.seconds : increment;
      res.json({
        ...data,
        timeSpentToday
      });
    });

  } catch (err) {
    console.error("Error en backend:", err);
    res.status(500).json({ error: "Error interno en el servidor" });
  }
});


// Puerto dinámico para Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
