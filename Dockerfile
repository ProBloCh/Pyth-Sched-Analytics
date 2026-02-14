# Use Python 3.12 slim image (updated from 3.9)
FROM python:3.12-slim

# Install system dependencies including build tools for networkit
RUN apt-get update && apt-get install -y \
    curl \
    gcc \
    g++ \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory in the container
WORKDIR /app

# Copy requirements first (better Docker layer caching)
COPY requirements.txt .

# Install Python packages
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application
COPY . .

# Remove any old virtual environments or build artifacts
RUN rm -rf venv antenv __pycache__ *.pyc .venv tests/

# Azure App Service expects port 8000
EXPOSE 8000

# Set environment variables
ENV PORT=8000
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONOPTIMIZE=1

# Performance settings
ENV OMP_NUM_THREADS=1
ENV MKL_NUM_THREADS=1
ENV NUMEXPR_NUM_THREADS=1
ENV OPENBLAS_NUM_THREADS=1
ENV WEB_CONCURRENCY=2
ENV DEBUG=false

# Enterprise defaults (override via Azure App Settings / env vars)
ENV REQUIRE_AUTH=false
ENV RATE_LIMIT_ENABLED=true
ENV RATE_LIMIT_REQUESTS=100
ENV RATE_LIMIT_WINDOW=60
ENV MAX_CONTENT_LENGTH_MB=50
ENV MAX_NODES=50000
ENV MAX_LINKS=200000
ENV AUDIT_LOG_ENABLED=true
ENV LOG_FORMAT=json
ENV ALLOWED_ORIGINS=*

# Add health check for Azure monitoring
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# Use gunicorn with dynamic configuration
CMD ["sh", "-c", "gunicorn --workers ${WEB_CONCURRENCY:-2} --threads 2 --bind 0.0.0.0:8000 --timeout ${REQUEST_TIMEOUT:-120} --worker-tmp-dir /dev/shm --log-level warning app:app"]