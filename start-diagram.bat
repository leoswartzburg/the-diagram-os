@echo off
REM One-click launcher for Windows: Docker services, Ollama warmup, the local LLM,
REM the dev server, and (optionally) Tailscale Serve for remote access.
REM Edit to taste; every step is optional except the dev server.
cd /d "%~dp0"
start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
timeout /t 20 /nobreak

REM Memory + research services. Voice defaults to the cloud (Cartesia TTS + Groq STT);
REM to run voice locally too: docker compose up -d chatterbox whisper
docker compose up -d mem0 qdrant playwright

REM --- Warm Ollama BEFORE the dev server boots ---
REM instrumentation.ts runs the vault's initial index pass on startup, which needs
REM the embedding model. Warm it synchronously so it's ready before the index pass.
ollama run nomic-embed-text "warmup" --keepalive 24h >nul 2>&1
start "Ollama Warmup - qwen3:1.7b" cmd /c "ollama run qwen3:1.7b "warmup" --keepalive 24h"

REM --- Local LLM: gpt-oss:20b on llama-server (:8013) - optional ---
REM If it isn't running, LOCAL turns degrade to Claude automatically.
if exist "local-stack\llm\bin" start "Local LLM - gpt-oss 20b" cmd /k "local-stack\llm\start-llm.bat"

start "Diagram Dev Server" cmd /k "npm run dev"
timeout /t 15 /nobreak

REM --- Optional: Tailscale Serve (private remote access from your other devices) ---
where tailscale >nul 2>&1
if %ERRORLEVEL% NEQ 0 goto open_browser
set /a TS_TRIES=0
:ts_loop
tailscale status --json | findstr /C:"\"BackendState\": \"Running\"" >nul
if %ERRORLEVEL%==0 goto ts_ready
set /a TS_TRIES+=1
if %TS_TRIES% GEQ 30 goto open_browser
tailscale up >nul 2>&1
ping -n 4 127.0.0.1 >nul
goto ts_loop
:ts_ready
start "Tailscale Serve" cmd /k "tailscale serve --bg --https=443 http://127.0.0.1:3000"
timeout /t 5 /nobreak

:open_browser
start http://localhost:3000
