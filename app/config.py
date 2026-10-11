"""Env-driven configuration + model routing. Change a slot by env var, not code."""
import os
from dotenv import load_dotenv

load_dotenv()

class cfg:
    # strong lane: judge (and nothing else)
    OPENAI_API_KEY: str = os.getenv("OPENAI_API_KEY", "")
    JUDGE_MODEL: str = os.getenv("JUDGE_MODEL", "gpt-5.6-sol")
    CROWD_OPENAI_MODEL: str = os.getenv("CROWD_OPENAI_MODEL", "gpt-4o-mini")

    # crowd lane: luminal, openai-compatible. fallback: groq (also openai-compatible)
    LUMINAL_BASE_URL: str = os.getenv("LUMINAL_BASE_URL", "")
    LUMINAL_API_KEY: str = os.getenv("LUMINAL_API_KEY", "")
    CROWD_MODEL: str = os.getenv("CROWD_MODEL", "deepseek-v3")
    GROQ_API_KEY: str = os.getenv("GROQ_API_KEY", "")
    GROQ_BASE_URL: str = "https://api.groq.com/openai/v1"
    GROQ_MODEL: str = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")

    TAVILY_API_KEY: str = os.getenv("TAVILY_API_KEY", "")
    MONGO_URI: str = os.getenv("MONGO_URI", "")
    SCRAPER_SIDECAR_URL: str = os.getenv("SCRAPER_SIDECAR_URL", "http://127.0.0.1:8300")

    CONCURRENCY: int = int(os.getenv("CONCURRENCY", "20"))
    DEBATE_ROUNDS: int = int(os.getenv("DEBATE_ROUNDS", "2"))

    @staticmethod
    def crowd_lanes() -> list[tuple[str, str]]:
        """(base_url, model) pairs in priority order; all OpenAI-compatible.
        gpt-4o-mini first: cents per run, tier-1 RPM headroom. Groq free tier
        (8k TPM on_demand) can't sustain a full debate; kept as fallback."""
        lanes = []
        if cfg.OPENAI_API_KEY:
            lanes.append(("https://api.openai.com/v1", cfg.CROWD_OPENAI_MODEL))
        if cfg.LUMINAL_BASE_URL and cfg.LUMINAL_API_KEY:
            lanes.append((cfg.LUMINAL_BASE_URL, cfg.CROWD_MODEL))
        if cfg.GROQ_API_KEY:
            lanes.append((cfg.GROQ_BASE_URL, cfg.GROQ_MODEL))
        return lanes

    @staticmethod
    def strong_lane() -> tuple[str, str] | None:
        if cfg.OPENAI_API_KEY:
            return ("https://api.openai.com/v1", cfg.JUDGE_MODEL)
        return None