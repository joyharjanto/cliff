// server.js
const express = require("express");
const app = express();
require('dotenv').config();

const RECALL_API_BASE = "https://us-west-2.recall.ai";
const RECALL_API_KEY = process.env.RECALL_API_KEY;
const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
app.use(express.json()); // lets you read JSON bodies

const uploadToRecording = new Map(); // sdk_upload_id -> recording_id
const recordingToTranscript = new Map(); // recording_id -> transcript_id
const transcriptCache = new Map(); 

app.post("/api/summarize", async (req, res) => {
    try {
      const { utterances } = req.body;
  
      if (!Array.isArray(utterances) || utterances.length === 0) {
        return res.status(400).json({ error: "Missing utterances[]" });
      }
  
      const transcriptText = utterances
        .slice(0, 300) // keep it reasonable at first
        .map(u => `${u.speaker}: ${u.text}`)
        .join("\n");
  
      const response = await openai.responses.create({
        model: "gpt-5.2",
        input: [
          { role: "system", content: "Summarize the meeting. Include key decisions, action items, and open questions." },
          { role: "user", content: transcriptText },
        ],
        max_output_tokens: 500,
      });
  
      return res.json({ summary: response.output_text });
    } catch (e) {
      return res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

async function createTranscript(recordingId) {
const res = await fetch(`${RECALL_API_BASE}/api/v1/recording/${recordingId}/create_transcript/`, {
    method: "POST",
    headers: {
    accept: "application/json",
    "content-type": "application/json",
    Authorization: `Token ${RECALL_API_KEY}`,
    },
    body: JSON.stringify({
    provider: { recallai_async: { language_code: "en" } }, // example
    }),
});

const text = await res.text();
if (!res.ok) throw new Error(`create_transcript ${res.status}: ${text}`);
return JSON.parse(text);
}  

// IMPORTANT: For signature verification you often need the raw body,
// but start simple first, then harden with verification.
app.post("/webhooks/recall", express.json(), async (req, res) => {
    const evt = req.body;
    const eventName = evt?.event;
  
    const sdkUploadId = evt?.data?.sdk_upload?.id;
    const recordingId = evt?.data?.recording?.id;
  
    const isUploadDone =
      eventName === "sdk_upload.complete" || eventName === "sdk_upload.completed";
  
    if (isUploadDone && sdkUploadId && recordingId) {
      uploadToRecording.set(String(sdkUploadId), String(recordingId));
  
      // start transcript creation once
      if (!recordingToTranscript.has(String(recordingId))) {
        try {
          const job = await createTranscript(recordingId);
          const transcriptId = job?.id ?? job?.transcript?.id;
          if (transcriptId) recordingToTranscript.set(String(recordingId), String(transcriptId));
        } catch (e) {
          console.error("createTranscript failed:", e);
        }
      }
    }
  
    // 2) When transcript is done, fetch and cache the download link
    if (eventName === "transcript.done") {
      const transcriptId = evt?.data?.transcript?.id;
      if (transcriptId) {
        const tRes = await fetch(`${RECALL_API_BASE}/api/v1/transcript/${transcriptId}/`, {
          headers: { accept: "application/json", Authorization: `Token ${RECALL_API_KEY}` },
        });
  
        const tText = await tRes.text();
        if (tRes.ok) transcriptCache.set(String(transcriptId), JSON.parse(tText));
        else console.error("transcript retrieve failed:", tRes.status, tText);
      }
    }
  
    res.sendStatus(200);
  });

  app.get("/api/transcript_for_sdk_upload/:sdkUploadId", (req, res) => {
    const sdkUploadId = String(req.params.sdkUploadId);
    const recordingId = uploadToRecording.get(sdkUploadId);
    if (!recordingId) return res.status(409).json({ status: "processing_upload" });
  
    const transcriptId = recordingToTranscript.get(recordingId);
    if (!transcriptId) return res.status(409).json({ status: "creating_transcript" });
  
    const transcript = transcriptCache.get(transcriptId);
    if (!transcript) return res.status(409).json({ status: "processing_transcript", transcript_id: transcriptId });
  
    return res.json({
      status: "complete",
      recording_id: recordingId,
      transcript_id: transcriptId,
      transcript_download_url: transcript?.data?.download_url ?? null,
    });
  });

app.post("/api/create_sdk_recording", async (req, res) => {
    console.log("HIT /api/create_sdk_recording");  // <--- add this

    try {
        
      if (!RECALL_API_KEY) {
        return res.status(500).json({ error: "Missing RECALL_API_KEY env var" });
      }
      console.log("Calling Recall:", `${RECALL_API_BASE}/api/v1/sdk_upload/`);

      const recallRes = await fetch(`${RECALL_API_BASE}/api/v1/sdk_upload/`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          Authorization: `Token ${RECALL_API_KEY}`,
        },
      });
      console.log("Recall status:", recallRes.status);

      const text = await recallRes.text();
      console.log("Text:", text);
      // If Recall returned an error, forward it so you can see it
      if (!recallRes.ok) {
        return res.status(recallRes.status).send(text || "Recall API error (empty body)");
      }
  
      const payload = JSON.parse(text);
      return res.json(payload);
    } catch (err) {
      console.error("create_sdk_recording failed:", err);
      return res.status(500).json({ error: String(err) });
    }
  });

app.get("/api/sdk_upload/:id", async (req, res) => {
    const id = req.params.id;

    const recallRes = await fetch(`${RECALL_API_BASE}/api/v1/sdk_upload/${id}/`, {
        headers: { Authorization: `Token ${RECALL_API_KEY}`, accept: "application/json" },
    });

    const text = await recallRes.text();
    if (!recallRes.ok) return res.status(recallRes.status).send(text);

    res.json(JSON.parse(text));
});

app.get("/api/recording/:sdkUploadId", async (req, res) => {
    const sdkUploadId = String(req.params.sdkUploadId);
  
    // ✅ Gate: webhook must have arrived first
    const recordingId = uploadToRecording.get(sdkUploadId);
    if (!recordingId) {
      return res.status(409).json({ status: "processing" }); // not ready yet
    }
  
    // ✅ Now safe to retrieve the recording
    const recRes = await fetch(`${RECALL_API_BASE}/api/v1/recording/${recordingId}/`, {
      headers: { accept: "application/json", Authorization: `Token ${RECALL_API_KEY}` },
    });
  
    const recText = await recRes.text();
    if (!recRes.ok) return res.status(recRes.status).send(recText);
  
    const recording = JSON.parse(recText);
    return res.json({
      status: "complete",
      recording_id: recordingId,
      video_download_url: recording?.media_shortcuts?.video_mixed?.data?.download_url ?? null,
      recording,
    });
  });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});