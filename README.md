**Flash — Flashcard Generator**  
Turn your notes (a PDF or photos of a notebook) into AI-generated flashcards  
   
 you can study or quiz yourself on. Full-stack app — Express + SQLite on the  
   
 backend, a vanilla-JS single-page app on the frontend — served from one  
   
 server on one port.  
**Features**  
- Sign up / log in (JWT-based auth, passwords hashed with bcrypt)  
- Upload one PDF **or** up to 10 images as a "note set"  
- Automatic flashcard generation via the Google Gemini API  
- Live status (processing → ready / failed) with retry and regenerate  
- Study mode (flip cards) and Quiz mode (multiple choice)  
**Tech stack**  
| | |  
|-|-|  
| **Layer** | **Technology** |   
| Frontend | Plain HTML / CSS / JavaScript (no framework) |   
| Backend | Node.js + Express |   
| Database | SQLite (Node's built-in node:sqlite) |   
| Auth | JWT + bcryptjs |   
| Uploads | Multer |   
| AI | Google Gemini API (free tier) |   
   
**Prerequisites**  
- **Node.js 22.5 or newer** (Node 24 works fine). This project uses Node's  
   
 built-in node:sqlite module, which requires this version — you'll see  
   
 an "experimental feature" warning on startup, which is expected and  
   
 harmless.  
- A free Google account, to get a Gemini API key (see below).  
**Setup**  
# 1. Install dependencies  
 npm install  
   
   
 # 2. Open .env and fill in the values (see "Environment variables" below)  
   
 # 3. Start the server  
 npm start           # or: npm run dev   (auto-restarts on file changes)  
   
Open **http://localhost:5000** — the frontend and API are served from the  
   
 same origin, same port.  
**Environment variables**  
The .env.example file lists everything the app needs. Copy it to .env  
   
 and fill in real values:  
| | | |  
|-|-|-|  
| **Variable** | **Required?** | **What it's for** |   
| JWT_SECRET | Yes | Signs login tokens. Use a long random string — e.g. generate one with openssl rand -hex 32. |   
| DATABASE_URL | No | Path to the SQLite file. Defaults to ./data.sqlite if unset. |   
| LLM_API_KEY | Yes | Your **Google Gemini API key** — see the next section for how to get one. Without it, uploads fail at the generation step and the note set's status flips to "failed". |   
| PORT | No | Port the server listens on. Defaults to 5000. |   
   
**Getting a free Gemini API key (and where it goes)**  
Flashcard generation is powered by Google's Gemini API. The free tier  
   
 needs no credit card — just a Google account.  
1. Go to [**aistudio.google.com/apikey**.](https://aistudio.google.com/apikey "https://aistudio.google.com/apikey")  
2. Sign in with your Google account if prompted.  
3. Click **"Create API key"**.  
  - If asked to choose a Google Cloud project, you can select an existing  
   
 one or let Google create a new one for you automatically — either  
   
 works fine for the free tier.  
4. Copy the key that appears (it looks like AIzaSy..., a long string of  
   
 letters, numbers, and dashes).  
5. Open the **.env** file in the project root (create it from  
   
 .env.example first if you haven't already — see Setup above).  
6. Paste your key as the value of **LLM_API_KEY**, with no quotes and no  
   
 spaces around the =:  
7. LLM_API_KEY=AIzaSyD4xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx  
   
8. Save the file and (re)start the server with npm start.  
**Keep this key secret.** .env is already listed in .gitignore, so it  
   
 won't be committed to version control — never paste your real key into  
   
 .env.example, a commit, or a shared chat.  
**Quick way to check it worked:** upload a note set from the UI (or via  
   
 the curl commands in "Quick manual test" below). If the key is missing  
   
 or invalid, the note set's status will flip to "failed" and the exact  
   
 error (e.g. an authentication error from Gemini) will be printed in the  
   
 terminal where npm start is running.  
**Project structure**  
server.js                       app setup, mounts API + static frontend  
 public/                         frontend (index.html, style.css, app.js)  
 config/db.js                    SQLite connection + table creation  
 models/                         User / NoteSet / Flashcard table queries  
 middleware/                     auth (JWT), upload (multer), error handler  
 routes/                         /api/auth/*, /api/notesets/*  
 controllers/                    register/login, upload/list/cards/retry  
 services/  
   textExtraction.js             pdf-parse for PDFs, passes images through  
   generateFlashcards.js         Calls Google Gemini to turn notes into flashcards  
 uploads/                        uploaded files land here (gitignored)  
   
**Quick manual test**  
# Register  
 curl -X POST http://localhost:5000/api/auth/register \  
   -H "Content-Type: application/json" \  
   -d '{"name":"Ada","email":"ada@example.com","password":"hunter2"}'  
   
 # Upload a note set (replace TOKEN with the token from above)  
 curl -X POST http://localhost:5000/api/notesets \  
   -H "Authorization: Bearer TOKEN" \  
   -F "title=Bio Chapter 3" \  
   -F "file=@/path/to/some.pdf"  
   
 # List note sets  
 curl http://localhost:5000/api/notesets -H "Authorization: Bearer TOKEN"  
   
 # Get cards (poll until status is "ready")  
 curl http://localhost:5000/api/notesets/NOTESET_ID/cards -H "Authorization: Bearer TOKEN"  
   
 # Retry a failed set  
 curl -X POST http://localhost:5000/api/notesets/NOTESET_ID/retry -H "Authorization: Bearer TOKEN"  
   
**Notes / known follow-ups**  
- multer@1.x and uuid@9 print deprecation warnings on npm install  
   
 (pre-existing dependency choices) — worth bumping to multer@2.x when  
   
 you have time to retest the upload path.  
- A note set is built from **either** one PDF  **or** up to 10 images, never  
   
 both — if you attach both, the PDF is used and the images are ignored.  
   
 True mixed-source note sets would need a backend change.  
- Scanned/image-only PDFs have no extractable text layer — upload those as  
   
 images instead so Gemini can read them directly.  
