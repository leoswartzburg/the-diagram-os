# Local LLM — gpt-oss:20b on llama-server

`bin/` and `models/` are gitignored (binaries + 12.1GB of weights). To rebuild
this directory on a fresh clone:

1. **llama.cpp** (Windows CUDA 13 build — Blackwell/sm_120 native):
   download `llama-<build>-bin-win-cuda-13.3-x64.zip` AND
   `cudart-llama-bin-win-cuda-13.3-x64.zip` from
   https://github.com/ggml-org/llama.cpp/releases and extract BOTH into `bin/`.
   (Built and tested with b9592.)
2. **Weights**: `gpt-oss-20b-mxfp4.gguf` (12.1GB) from
   https://huggingface.co/ggml-org/gpt-oss-20b-GGUF into `models/`.
   The Ollama gpt-oss blob does NOT work — Ollama renames the architecture
   to `gptoss`, which upstream llama.cpp rejects.
3. Run `start-llm.bat` (start-diagram.bat runs it for you).

Serving: OpenAI-compatible `/v1/chat/completions` on `http://127.0.0.1:8013`,
consumed by `/api/spectre`'s LOCAL branch (`lib/spectreLocal.ts`) with native
harmony tool calls. `--n-cpu-moe` (env `LLM_NCMOE`, default 12 = half the expert
weights on the GPU; 24 = all of them in system RAM) is the VRAM↔speed dial — see
start-llm.bat.
