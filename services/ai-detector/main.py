"""PromoFM AI Music Detector — FastAPI service."""
import os
import asyncio
from concurrent.futures import ProcessPoolExecutor
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from models import AnalyzeRequest, AnalysisResult, HealthResponse
from config import VERSION, WEIGHTS


executor = ProcessPoolExecutor(max_workers=1)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Warm up librosa on startup (first import is slow)
    import librosa  # noqa: F401
    yield
    executor.shutdown(wait=False)


app = FastAPI(
    title='PromoFM AI Music Detector',
    version=VERSION,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_methods=['*'],
    allow_headers=['*'],
)


def _run_analysis(file_path: str) -> dict:
    """Run in separate process to avoid blocking event loop."""
    from ensemble import run_analysis
    result = run_analysis(file_path)
    return result.model_dump()


@app.post('/analyze', response_model=AnalysisResult)
async def analyze_track(req: AnalyzeRequest):
    """Analyze an audio file for AI-generation probability."""
    if not os.path.isfile(req.file_path):
        raise HTTPException(status_code=404, detail=f'File not found: {req.file_path}')

    # Check file size (skip files > 100MB)
    file_size = os.path.getsize(req.file_path)
    if file_size > 100 * 1024 * 1024:
        raise HTTPException(status_code=413, detail='File too large (max 100MB)')

    loop = asyncio.get_event_loop()
    try:
        result_dict = await loop.run_in_executor(executor, _run_analysis, req.file_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f'Analysis failed: {str(e)}')

    return AnalysisResult(**result_dict)


@app.get('/health', response_model=HealthResponse)
async def health():
    return HealthResponse(
        status='ok',
        version=VERSION,
        analyzers=list(WEIGHTS.keys()),
    )


@app.get('/version')
async def version():
    return {'version': VERSION, 'analyzers': list(WEIGHTS.keys())}


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=8085)
