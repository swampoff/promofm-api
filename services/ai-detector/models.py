"""Pydantic models for request/response."""
from pydantic import BaseModel
from typing import Optional


class AnalyzeRequest(BaseModel):
    file_path: str
    track_id: Optional[str] = None


class AnalysisResult(BaseModel):
    ai_score: int  # 0-100
    confidence: float  # 0.0-1.0
    verdict: str  # likely_human | uncertain | likely_ai | highly_likely_ai
    breakdown: dict[str, float]
    analysis_time_seconds: float
    analyzer_version: str


class HealthResponse(BaseModel):
    status: str
    version: str
    analyzers: list[str]
