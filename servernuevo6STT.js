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

// ------------------ BASE DE DATOS PERSISTENTE ------------------
// 🔥 NO crear /var/data manualmente → Render lo hace automáticamente
const DB_PATH = "/var/data/usage.db";

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error("Error abriendo SQLite:", err);
  } else {
    console.log("SQLite cargado desde:", DB_PATH);
  }
});

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

const SESSION_LIMIT = 300; // 🔥 5 minutos

// ------------------ MULTER ------------------
const upload = multer({ dest: "uploads/" });

// ------------------ RUTA STT ------------------
app.post("/stt", upload.single("audio"), async (req, res) => {
  try {
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
    console.error(err);
    res.json({ text: "" });
  }
});

// ------------------ RUTA CHAT ------------------
app.post("/chat", async (req, res) => {
  const { userId, message } = req.body;
  const today = getToday();

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

      const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4.1",
          messages: [
            { role: "system", content: "You are an English teacher." },
            { role: "user", content: message }
          ]
        })
      });

      const data = await openaiRes.json();

      res.json({
        reply: data.choices?.[0]?.message?.content || "Error",
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

// ------------------ ENDPOINT ADMIN: VER USO DE TODOS LOS ALUMNOS ------------------
app.get("/admin/usage", (req, res) => {
  const today = getToday();

  db.all(
    "SELECT userId, seconds FROM usage WHERE date = ? ORDER BY seconds DESC",
    [today],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "Database error" });
      }

      const result = rows.map(r => ({
        userId: r.userId,
        usedSeconds: Math.floor(r.seconds),
        remainingSeconds: Math.max(300 - Math.floor(r.seconds), 0)
      }));

      res.json(result);
    }
  );
});

// ------------------ INICIAR SERVIDOR ------------------
app.listen(3000, () => console.log("Servidor listo en puerto 3000"));
