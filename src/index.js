const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const RecallAiSdk = require('@recallai/desktop-sdk');

RecallAiSdk.init({
  apiUrl: "https://us-west-2.recall.ai"
});

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

const BACKEND_API_BASE = "http://localhost:3000";

const recordingIdByWindowId = new Map();

let mainWindow;

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, // recommended
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.webContents.openDevTools();
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  createWindow();

  RecallAiSdk.requestPermission("accessibility");
  RecallAiSdk.requestPermission("microphone");
  RecallAiSdk.requestPermission("screen-capture");
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

const createSdkRecording = async () => {
  const res = await fetch(`${BACKEND_API_BASE}/api/create_sdk_recording`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  })
  return res.json();
};

async function waitForTranscriptUrl(recordingId, { intervalMs = 3000, timeoutMs = 5 * 60 * 1000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${BACKEND_API_BASE}/api/transcript_for_recording/${recordingId}`);
    if (res.status === 409) { await sleep(intervalMs); continue; }

    const text = await res.text();
    if (!res.ok) throw new Error(`backend ${res.status}: ${text}`);

    const data = JSON.parse(text);
    return data.transcript_download_url;
  }
  throw new Error("Timed out waiting for transcript url");
}

const startRecording = async (windowId, uploadToken) => {
  await RecallAiSdk.startRecording({
    windowId: windowId,
    uploadToken: uploadToken
  });
}

RecallAiSdk.addEventListener("meeting-detected", async (evt) => {
  console.log("meeting-detected", evt);

  const payload = await createSdkRecording();
  console.log("payload", payload);

  const upload_token = payload.upload_token;
  const recordingId = payload.recording_id;

  if (!upload_token) throw new Error("Missing upload_token from backend");
  if (!recordingId) throw new Error("Missing payload.recording_id (recording_id) from backend");

  const windowId = evt.window.id;
  recordingIdByWindowId.set(windowId, recordingId);

  await startRecording(windowId, upload_token);

  console.log(`Started recording for window ${windowId}`);
  console.log(`Upload token: ${upload_token}`);
  console.log(`Recording ID: ${recordingId}`);
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitForVideoUrl(recordingId, { intervalMs = 3000, timeoutMs = 5 * 60 * 1000 } = {}) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${BACKEND_API_BASE}/api/recording/${recordingId}`);

    if (res.status === 409) {        // webhook not arrived yet
      await sleep(intervalMs);
      continue;
    }

    const text = await res.text();
    if (!res.ok) throw new Error(`backend ${res.status}: ${text}`);

    const data = JSON.parse(text);
    return data.video_download_url;
  }

  throw new Error("Timed out waiting for sdk_upload.complete / video url");
}

function wordsToText(words) {
  const punct = new Set([",", ".", "!", "?", ":", ";", ")", "]", "}", "%"]);
  const open = new Set(["(", "[", "{", "“", "\"", "‘", "'"]);
  let out = "";

  for (const w of words) {
    const t = w?.text ?? "";
    if (!t) continue;
    if (!out) { out = t; continue; }

    const lastChar = out[out.length - 1];
    if (punct.has(t)) { out += t; continue; }
    if (open.has(lastChar)) { out += t; continue; }

    out += " " + t;
  }

  return out
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim();
}

function cleanTranscriptParts(parts, { mergeGapSeconds = 1.25 } = {}) {
  const utterances = [];

  for (const part of parts || []) {
    const speaker = part?.participant?.name ?? "Unknown";
    const words = Array.isArray(part?.words) ? part.words : [];
    if (!words.length) continue;

    const start = words[0]?.start_timestamp?.relative ?? null;
    const end = words[words.length - 1]?.end_timestamp?.relative ?? null;
    const text = wordsToText(words);
    if (!text) continue;

    const prev = utterances[utterances.length - 1];
    if (
      prev &&
      prev.speaker === speaker &&
      prev.end != null &&
      start != null &&
      (start - prev.end) <= mergeGapSeconds
    ) {
      prev.text = (prev.text + " " + text).trim();
      prev.end = end;
    } else {
      utterances.push({ speaker, start, end, text });
    }
  }

  return utterances;
}

RecallAiSdk.addEventListener("recording-ended", async (evt) => {
  try {
    console.log("Meeting has ended");

    const windowId = evt.window.id;
    const recordingId = recordingIdByWindowId.get(windowId);
    if (!recordingId) throw new Error(`No recordingId for windowId=${windowId}`);

    const videoUrl = await waitForVideoUrl(recordingId);
    console.log("✅ Video URL ready:", videoUrl);

    const transcriptUrl = await waitForTranscriptUrl(recordingId);
    console.log("✅ Transcript URL ready:", transcriptUrl);

    const parts = await fetch(transcriptUrl).then(r => r.json());
    const utterances = cleanTranscriptParts(parts);

    const sumRes = await fetch(`${BACKEND_API_BASE}/api/summarize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ utterances }),
    });

    const sumText = await sumRes.text();
    if (!sumRes.ok) throw new Error(`summarize ${sumRes.status}: ${sumText}`);
    const { summary } = JSON.parse(sumText);

    mainWindow?.webContents.send("videoUrl:ready", { recordingId, videoUrl });
    mainWindow?.webContents.send("transcript:ready", { recordingId, utterances });
    mainWindow?.webContents.send("summary:ready", { recordingId, summary });

    recordingIdByWindowId.delete(windowId);
  } catch (e) {
    console.error("recording-ended failed:", e);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
