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

# Create non-root user before copying application code
RUN useradd --create-home --shell /bin/bash appuser

# Copy the rest of the application
COPY --chown=appuser:appuser . .

# Remove any old virtual environments or build artifacts
RUN rm -rf venv antenv __pycache__ *.pyc .venv

# Switch to non-root user
USER appuser

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

# Add health check for Azure monitoring
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# Use gunicorn with dynamic configuration
CMD ["sh", "-c", "gunicorn --workers ${WEB_CONCURRENCY:-2} --threads 2 --bind 0.0.0.0:8000 --timeout ${REQUEST_TIMEOUT:-120} --worker-tmp-dir /dev/shm --log-level warning app:app"]