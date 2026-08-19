import express from "express";

const app = express();

app.get("/", (req, res) => {
  res.send("Marcel WhatsApp Bot läuft.");
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Server läuft auf Port ${port}`);
});
