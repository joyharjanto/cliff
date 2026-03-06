const videoCard = document.getElementById("videoCard");
const videoLinkEl = document.getElementById("videoLink");

const summaryCard = document.getElementById("summaryCard");
const summaryEl = document.getElementById("summary");

const transcriptCard = document.getElementById("transcriptCard");
const transcriptEl = document.getElementById("transcript");

const participantsCard = document.getElementById("participantsCard");
const participantsTextEl = document.getElementById("participantsText");

function renderLink(url) {
  videoLinkEl.innerHTML = "";
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noreferrer";
  a.textContent = "Meeting Link"; // <- plain text label
  videoLinkEl.appendChild(a);
}

function renderParticipants(utterances) {
  const seen = new Set();
  const speakers = [];

  for (const u of utterances) {
    const name = u?.speaker ?? "Unknown";
    if (!seen.has(name)) {
      seen.add(name);
      speakers.push(name);
    }
  }

  participantsTextEl.textContent = `This is a meeting between ${speakers.join(", ")}.`;
  participantsCard.style.display = "block";
}

function renderTranscript(utterances) {
  transcriptEl.innerHTML = "";

  for (const u of utterances) {
    const line = document.createElement("div");
    line.className = "line";

    const speaker = document.createElement("span");
    speaker.className = "speaker";
    speaker.textContent = (u.speaker ?? "Unknown") + ":"; // <- same labeling

    const text = document.createElement("span");
    text.textContent = " " + (u.text ?? ""); // <- space after colon

    line.appendChild(speaker);
    line.appendChild(text);
    transcriptEl.appendChild(line);
  }
}

window.cliff.onVideoReady(({ videoUrl }) => {
  if (!videoUrl) return;
  videoCard.style.display = "block";
  renderLink(videoUrl);
});

window.cliff.onTranscriptReady(({ utterances }) => {
  if (!utterances?.length) return;
  renderParticipants(utterances);
  transcriptCard.style.display = "block";
  renderTranscript(utterances);
});

window.cliff.onSummaryReady(({ summary }) => {
  if (!summary) return;
  summaryCard.style.display = "block";
  summaryEl.textContent = summary;
});