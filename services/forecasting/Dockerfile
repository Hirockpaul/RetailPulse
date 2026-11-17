# RetailPulse forecasting service (internal, no login of its own — never publish its port).
# Build context: services/forecasting.

# ---- build: install pinned dependencies into a virtualenv
FROM python:3.12-slim AS build
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1
RUN python -m venv /opt/venv
COPY requirements.txt .
RUN /opt/venv/bin/pip install -r requirements.txt

# ---- runtime: the virtualenv + the app, as a non-root user
FROM python:3.12-slim
ENV PATH=/opt/venv/bin:$PATH PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN useradd --create-home --uid 10001 forecast
WORKDIR /app
COPY --from=build /opt/venv /opt/venv
COPY app ./app
USER forecast
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
