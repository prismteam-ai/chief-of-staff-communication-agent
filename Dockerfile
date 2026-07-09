FROM python:3.11-slim

WORKDIR /app

# deps first for layer caching
COPY pyproject.toml README.md ./
COPY cos ./cos
RUN pip install --no-cache-dir -e ".[ui,agents]"

# bake the generated fixtures into the image so the mock has data on start
RUN python -m cos.fixtures.generate

EXPOSE 8900 7860

# default: the provider mock (compose overrides the command for the UI service)
CMD ["uvicorn", "cos.mocks.app:app", "--host", "0.0.0.0", "--port", "8900"]
