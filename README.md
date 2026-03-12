# Cliff Notetaker

Cliff Notetaker is an invisible meeting assistant built on Recall’s Desktop SDK, using Electron and Express, that listens to your meetings and summarizes key points. 

Follow the steps below to get it running on your machine!

[How to use the repo](https://www.loom.com/share/c7331e36d6334467b98b065b8a919cba)

---

## Features

- Automatic meeting detection
- Background recording using Recall Desktop SDK
- Transcript generation
- AI meeting summaries using OpenAI
- Displays:
  - Meeting participants
  - Meeting link
  - Transcript
  - AI summary

---

# Setup

## 1. Clone the repository

```bash
git clone <your-repo-url>
cd <repo-name>
```

---

## 2. Download the Desktop recording SDK on your computer

```bash
npm install @recallai/desktop-sdk
```

---


## 3. Create API Keys

Create accounts and API keys from:

- Recall.ai → https://recall.ai  
- OpenAI Platform → https://platform.openai.com

---

## 4. Add Environment Variables

Copy the env.example file to a .env file inside of the backend folder and replace the following

```
RECALL_API_KEY=your_recall_api_key
OPENAI_API_KEY=your_openai_api_key
RECALL_API_BASE=your_api_base_when_you_signup
```

---

## 5. Install Dependencies

From the project root:

```bash
npm install
```

---

## 6. Start an ngrok Tunnel

Recall requires a **public webhook endpoint**, so we expose the backend with ngrok. 

First make sure you add the authtoken on ngrok:

```bash
ngrok config add-authtoken <token>
```

Open a new terminal in your root directory, run:

```bash
ngrok http 3000
```

You will receive a URL similar to:

```
https://abc123.ngrok-free.app
```

---

## 7. Configure Recall Webhooks

Go to your **Recall Dashboard** and configure the webhook URL.

Add the following endpoint:

```
https://YOUR_NGROK_URL/webhooks/recall
```

Example:

```
https://abc123.ngrok-free.app/webhooks/recall
```

Add events such as: 

- `sdk_upload.completed`
- `transcript.done`

These events allow the backend to:

- retrieve the recording
- create a transcript
- retrieve the transcript
- trigger AI summarization

---

## 8. Run the Backend Server

Open a new terminal in your root directory:

```bash
cd backend
node server.js
```

The backend will run at:

```
http://localhost:3000
```

---

## 9. Start the Electron App

Open another terminal from the **root directory**:

```bash
npm start
```

---

# How It Works

1. The Electron app detects a meeting window.
2. A recording starts using **Recall Desktop SDK**.
3. When the meeting ends, Recall sends:

```
sdk_upload.complete
```

4. The backend retrieves the **recording ID**.
5. A transcript job is created.
6. Recall sends:

```
transcript.done
```

7. The backend retrieves the transcript.
8. The transcript is sent to **OpenAI** for summarization.
9. The UI displays:

- Meeting participants
- Meeting link
- Transcript
- AI summary

---

# Tech Stack

- Recall Desktop SDK
- Electron
- Express
- OpenAI API
- ngrok
