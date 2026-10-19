import os
import time
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from mem0 import Memory

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

OLLAMA_URL = os.getenv("OLLAMA_BASE_URL", "http://host.docker.internal:11434")
QDRANT_HOST = os.getenv("QDRANT_HOST", "qdrant")
QDRANT_PORT = int(os.getenv("QDRANT_PORT", "6333"))
# Single-user system: every memory is stored under this id. Keep in sync with lib/mem0.ts.
DEFAULT_USER_ID = os.getenv("MEM0_USER_ID", "default")

CONFIG = {
    "llm": {
        "provider": "ollama",
        "config": {
            "model": "qwen3:1.7b",
            "ollama_base_url": OLLAMA_URL,
        },
    },
    "embedder": {
        "provider": "ollama",
        "config": {
            "model": "nomic-embed-text",
            "ollama_base_url": OLLAMA_URL,
            "embedding_dims": 768,
        },
    },
    "vector_store": {
        "provider": "qdrant",
        "config": {
            "host": QDRANT_HOST,
            "port": QDRANT_PORT,
            "collection_name": "spectre_memory",
            "embedding_model_dims": 768,
        },
    },
}

mem: Memory = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global mem
    for attempt in range(10):
        try:
            mem = Memory.from_config(CONFIG)
            logger.info("Mem0 initialized successfully")
            break
        except Exception as e:
            logger.warning(f"Init attempt {attempt + 1}/10 failed: {e}")
            if attempt < 9:
                time.sleep(3)
            else:
                raise RuntimeError(f"Could not initialize Mem0 after 10 attempts: {e}")
    yield


app = FastAPI(title="Mem0 Server", lifespan=lifespan)


class AddRequest(BaseModel):
    messages: List[dict]
    user_id: str = DEFAULT_USER_ID
    metadata: Optional[dict] = None


class SearchRequest(BaseModel):
    query: str
    user_id: str = DEFAULT_USER_ID
    limit: int = 10


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/v1/memories")
async def add_memory(request: AddRequest):
    try:
        result = mem.add(
            request.messages,
            user_id=request.user_id,
            metadata=request.metadata or {},
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/v1/memories")
async def get_memories(user_id: str = DEFAULT_USER_ID):
    try:
        return mem.get_all(filters={"user_id": user_id})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/v1/memories/search")
async def search_memories(request: SearchRequest):
    try:
        return mem.search(
            request.query,
            filters={"user_id": request.user_id},
            top_k=request.limit,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/v1/memories/{memory_id}")
async def delete_memory(memory_id: str):
    try:
        mem.delete(memory_id)
        return {"message": "deleted", "id": memory_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
