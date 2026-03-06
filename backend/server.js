// server.js
const express = require("express");
const app = express();
require('dotenv').config();

const RECALL_API_BASE = "https://us-west-2.recall.ai";
const RECALL_API_KEY = process.env.RECALL_API_KEY;
const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
app.use(express.json()); // lets you read JSON bodies

const completedRecordings = new Set(); // sdk_upload.complete seen
const transcriptStateByRecordingId = new Map();
// recordingId -> { status: "starting" | "processing" | "complete" | "failed", transcriptId?: string, error?: string }

const transcriptCache = new Map(); // transcriptId -> retrieved transcript object

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

  const recordingId = evt?.data?.recording?.id ? String(evt.data.recording.id) : null;
  const transcriptId = evt?.data?.transcript?.id ? String(evt.data.transcript.id) : null;

  console.log("webhook:", eventName, { recordingId, transcriptId });

  const isUploadDone =
    eventName === "sdk_upload.complete" || eventName === "sdk_upload.completed";

  if (isUploadDone && recordingId) {
    completedRecordings.add(recordingId);

    // Start async transcription exactly once per recording
    if (!transcriptStateByRecordingId.has(recordingId)) {
      transcriptStateByRecordingId.set(recordingId, { status: "starting" });

      try {
        const job = await createTranscript(recordingId);
        const createdTranscriptId = job?.id ?? job?.transcript?.id ?? null;

        transcriptStateByRecordingId.set(recordingId, {
          status: "processing",
          transcriptId: createdTranscriptId ? String(createdTranscriptId) : undefined,
        });
      } catch (e) {
        transcriptStateByRecordingId.set(recordingId, {
          status: "failed",
          error: e?.message ?? String(e),
        });
        console.error("createTranscript failed:", e);
      }
    }
  }

  if (eventName === "transcript.done" && recordingId && transcriptId) {
    try {
      const tRes = await fetch(`${RECALL_API_BASE}/api/v1/transcript/${transcriptId}/`, {
        headers: {
          accept: "application/json",
          Authorization: `Token ${RECALL_API_KEY}`,
        },
      });

      const tText = await tRes.text();
      if (!tRes.ok) {
        console.error("transcript retrieve failed:", tRes.status, tText);
      } else {
        const transcript = JSON.parse(tText);
        transcriptCache.set(transcriptId, transcript);

        transcriptStateByRecordingId.set(recordingId, {
          status: "complete",
          transcriptId,
        });
      }
    } catch (e) {
      transcriptStateByRecordingId.set(recordingId, {
        status: "failed",
        transcriptId,
        error: e?.message ?? String(e),
      });
      console.error("transcript retrieve failed:", e);
    }
  }

  if (eventName === "transcript.failed" && recordingId) {
    transcriptStateByRecordingId.set(recordingId, {
      status: "failed",
      transcriptId: transcriptId ?? undefined,
      error: evt?.data?.data?.sub_code ?? "transcript.failed",
    });
  }

  res.sendStatus(200);
});

app.get("/api/transcript_for_recording/:recordingId", (req, res) => {
  const recordingId = String(req.params.recordingId);
  if (!recordingId) {
    return res.status(400).json({ error: "Missing recordingId" });
  }

  // Step 1: wait for upload completion
  if (!completedRecordings.has(recordingId)) {
    return res.status(409).json({ status: "processing_upload" });
  }

  // Step 2: wait for transcript creation / processing
  const state = transcriptStateByRecordingId.get(recordingId);
  if (!state) {
    return res.status(409).json({ status: "creating_transcript" });
  }

  if (state.status === "failed") {
    return res.status(500).json({
      status: "transcript_failed",
      error: state.error ?? "unknown",
      transcript_id: state.transcriptId ?? null,
    });
  }

  if (state.status !== "complete") {
    return res.status(409).json({
      status: "processing_transcript",
      transcript_id: state.transcriptId ?? null,
    });
  }

  // Step 3: return the retrieved transcript artifact
  const transcript = state.transcriptId ? transcriptCache.get(state.transcriptId) : null;
  if (!transcript) {
    return res.status(409).json({
      status: "processing_transcript",
      transcript_id: state.transcriptId ?? null,
    });
  }

  return res.json({
    status: "complete",
    recording_id: recordingId,
    transcript_id: state.transcriptId,
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

app.get("/api/recording/:recordingId", async (req, res) => {
  const recordingId = String(req.params.recordingId);
  if (!recordingId) {
    return res.status(400).json({ error: "Missing recordingId" });
  }

  // Wait until sdk_upload.complete webhook has arrived for this recording
  if (!completedRecordings.has(recordingId)) {
    return res.status(409).json({ status: "processing_upload", recording_id: recordingId });
  }

  try {
    const recRes = await fetch(`${RECALL_API_BASE}/api/v1/recording/${recordingId}/`, {
      headers: {
        accept: "application/json",
        Authorization: `Token ${RECALL_API_KEY}`,
      },
    });

    const recText = await recRes.text();
    if (!recRes.ok) return res.status(recRes.status).send(recText);

    const recording = JSON.parse(recText);
    const videoUrl =
      recording?.media_shortcuts?.video_mixed?.data?.download_url ?? null;

    if (!videoUrl) {
      return res.status(409).json({
        status: "processing_video",
        recording_id: recordingId,
      });
    }

    return res.json({
      status: "complete",
      recording_id: recordingId,
      video_download_url: videoUrl,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});