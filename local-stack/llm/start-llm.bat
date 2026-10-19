@echo off
REM Local LLM — gpt-oss:20b on llama.cpp's llama-server (:8013).
REM
REM VRAM strategy (tuned on a 16GB card shared with Chatterbox ~3.5GB + Whisper ~1.7GB +
REM nomic/qwen3:1.7b ~2GB): -ngl 99 puts attention/dense/KV on the GPU while
REM --n-cpu-moe keeps the first N layers' MoE expert weights in system RAM (the CPU
REM serves them). gpt-oss:20b has 24 layers; N=24 = all experts on CPU (lowest
REM VRAM), smaller N = more experts on GPU (faster). N is the tuning dial —
REM override with:  set LLM_NCMOE=16 & start-llm.bat
REM
REM The harmony chat template is embedded in the official ggml-org GGUF; the
REM sidecar gpt-oss-harmony.jinja stays as a backup (--chat-template-file).
REM
REM -ub 2048: large ubatch amortizes CPU expert-weight streaming across the
REM batch — measured prompt eval ~1100 → ~3400 tok/s (cold 5.9k-token Spectre
REM prompt: 6.8s → 1.7s to first token) at +0.25GB VRAM. Generation unchanged.
setlocal
cd /d %~dp0
REM Current tuning: with TTS on Cartesia (cloud), the ~3.5GB of
REM Chatterbox VRAM is free, so HALF the experts go on the GPU (N=12 vs N=24).
REM Measured: generation 32 -> ~55 tok/s. Q8 KV-cache (-ctk/-ctv q8_0) then makes
REM context almost free: N=12 + 64k ctx = ~12.6GB, and even 128k fits at ~13.5GB
REM (2.7GB headroom). LLM_N_CTX is the context dial (default 128k = full native
REM window; lower to 65536 for 64k). Keep the app's LLM_N_CTX (.env.local) matched.
if "%LLM_NCMOE%"=="" set LLM_NCMOE=12
if "%LLM_N_CTX%"=="" set LLM_N_CTX=131072
bin\llama-server.exe ^
  -m models\gpt-oss-20b-mxfp4.gguf ^
  --port 8013 --host 127.0.0.1 ^
  -ngl 99 --n-cpu-moe %LLM_NCMOE% ^
  -c %LLM_N_CTX% -fa on --jinja ^
  -ctk q8_0 -ctv q8_0 ^
  -ub 2048 -b 2048 ^
  --reasoning-format auto
