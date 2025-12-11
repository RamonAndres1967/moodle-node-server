const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

// 🔧 Configuración de CORS: permite peticiones desde tu Moodle online
app.use(cors({
  origin: [
    "http://localhost",                         // Moodle local
    "https://virtualacademy.mylanguagecoach.net" // Moodle online
  ],
  methods: ["GET","POST"],
  credentials: true
}));

// Ruta de prueba
app.get("/ping", (req, res) => {
  res.send("Servidor activo en Render con CORS habilitado");
});

// Ruta principal del chatbot
app.post("/chat", async (req, res) => {
  console.log("Mensaje recibido:", req.body);

  const { userId, message } = req.body;

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
        user: userId // 👈 identificador para trazabilidad
      })
    });

    // Procesar respuesta de OpenAI
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Error en OpenAI:", errorText);
      return res.status(response.status).json({ error: errorText });
    }

    const data = await response.json();
    console.log("Respuesta de OpenAI:", data);

    // Devolver al cliente Moodle
    res.json(data);

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
