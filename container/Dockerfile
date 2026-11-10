FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# install the libraries first, so rebuilds are fast when only your code changes
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# never run the server as root
RUN useradd --create-home appuser && chown -R appuser /app
USER appuser

EXPOSE 8080

# one worker on purpose: the transfer messages live in this process's memory
CMD ["gunicorn", "app:app", "--worker-class", "gthread", "--workers", "1", "--threads", "16", "--bind", "0.0.0.0:8080", "--timeout", "120", "--access-logfile", "-"]