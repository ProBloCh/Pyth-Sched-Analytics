# Use Python 3.11 slim image (updated from 3.9)
FROM python:3.11-slim

# Install system dependencies for health checks
RUN apt-get update && apt-get install -y \
    curl \
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
RUN rm -rf venv antenv __pycache__ *.pyc .venv

# Azure App Service expects port 8000 (not 5000)
EXPOSE 8000

# Set environment variables
ENV PORT=8000
ENV PYTHONUNBUFFERED=1

# Add health check for Azure monitoring
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# Use gunicorn instead of python directly (production-ready)
# Matches your Azure deployment: 2 workers, 2 threads
CMD ["gunicorn", "--workers", "2", "--threads", "2", "--bind", "0.0.0.0:8000", "--timeout", "120", "app:app"]