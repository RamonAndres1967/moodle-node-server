const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json());

// Ruta de prueba
app.get("/ping", (req, res) => {
  res.send("Servidor activo en puerto 3000");
});

// Ruta principal del chatbot
app.post("/chat", async (req, res) => {
  console.log("Mensaje recibido:", req.body);

  //const { message } = req.body;
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
            content: "Eres profesor de inglés virtual. Responde de forma clara, educativa y motivadora,siempre en ingles, propon temas e inicia conversaciones."
          },
          {
            role: "user",
            //content: message
             content: `UserId: ${userId}\nMessage: ${message}`
          }
        ],
        max_tokens: 80,
        temperature: 0.7
      })
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Error en la llamada a OpenAI:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => {
  console.log("Servidor escuchando en http://localhost:3000");
});
